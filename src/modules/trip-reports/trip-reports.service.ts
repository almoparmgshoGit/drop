import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TripReportCategory, TripReportStatus, TripReportType } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { CREW_WINDOW_SELECT, crewWindow } from '../../common/utils/crew-window.util';
import { cleanFileName } from '../cash/cash.service';
import { CreateReportDto, CrewReportUpdateDto, OfficeReportUpdateDto, ReportsQuery } from './trip-reports.dto';

export interface ReportActor {
  userId: string;
  role: string;
  name?: string | null;
  permissions: string[];
}

export interface UploadedReportFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export const MAX_REPORT_FILES = 5;
// A request is held in memory until it is stored, so these bound what one upload can cost the server.
export const MAX_REPORT_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_REPORT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_REPORT = 10;
const PAGE_SIZE = 50;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const LIVE_FOR_MS = 5 * 60 * 1000;
const TRAVELING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;

const TYPE_LABELS: Record<TripReportType, string> = {
  DELAY: 'تأخير',
  BREAKDOWN: 'عطل في الحافلة',
  ACCIDENT: 'حادث',
  PASSENGER: 'مشكلة مع مسافر',
  OTHER: 'أخرى',
};
const CATEGORY_LABELS: Record<TripReportCategory, string> = { STATUS: 'بلاغ حالة', HELP: 'طلب مساعدة', SOS: 'استغاثة' };
const STATUS_LABELS: Record<TripReportStatus, string> = { OPEN: 'جديد', IN_PROGRESS: 'قيد المعالجة', RESOLVED: 'تم الحل' };

export const reportCode = (number: number) => `BL-${String(number).padStart(4, '0')}`;

// The declared type comes from the client, so the stored type is decided by the file's own bytes.
const fileTypeOf = (file: Buffer): { mimeType: string; isVideo: boolean } | null => {
  if (file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return { mimeType: 'image/jpeg', isVideo: false };
  if (file.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return { mimeType: 'image/png', isVideo: false };
  if (file.subarray(0, 4).toString('latin1') === 'RIFF' && file.subarray(8, 12).toString('latin1') === 'WEBP') return { mimeType: 'image/webp', isVideo: false };
  if (file.subarray(0, 4).toString('hex') === '1a45dfa3') return { mimeType: 'video/webm', isVideo: true };
  if (file.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = file.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return { mimeType: 'video/quicktime', isVideo: true };
    if (brand.startsWith('3g')) return { mimeType: 'video/3gpp', isVideo: true };
    if (/^(isom|iso\d|mp4\d|avc1|M4V |MSNV|dash)/.test(brand)) return { mimeType: 'video/mp4', isVideo: true };
  }
  return null;
};

const ATTACHMENT_FIELDS = { id: true, fileName: true, mimeType: true, size: true, createdAt: true } satisfies Prisma.TripReportAttachmentSelect;

@Injectable()
export class TripReportsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  private async assertAssigned(actor: ReportActor, tripId: string) {
    if (actor.role === 'ADMIN') return;
    const assigned = await this.prisma.trip.count({
      where: { id: tripId, OR: [{ drivers: { some: { userId: actor.userId } } }, { supervisors: { some: { userId: actor.userId } } }] },
    });
    if (assigned === 0) throw new ForbiddenException('هذه الرحلة غير مسندة إليك');
  }

  private async nameOf(actor: ReportActor) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return user?.name ?? null;
  }

  // ---------------------------------------------------------------- the crew

  async create(actor: ReportActor, tripId: string, dto: CreateReportDto) {
    await this.assertAssigned(actor, tripId);
    const category = dto.category ?? 'STATUS';
    if ((dto.lat === undefined) !== (dto.lng === undefined)) throw new BadRequestException('الموقع غير مكتمل');

    const idempotencyKey = dto.idempotencyKey ? `${actor.userId}:${dto.idempotencyKey}` : null;
    if (idempotencyKey) {
      const repeated = await this.prisma.tripReport.findUnique({ where: { idempotencyKey } });
      if (repeated) return { ...repeated, code: reportCode(repeated.number) };
    }

    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { liveStatus: true, busId: true, tripCode: true, currentBoardingPoint: { select: { name: true } }, ...CREW_WINDOW_SELECT },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    // Someone in danger is never told to wait for the trip's opening time.
    if (category !== 'SOS' && actor.role !== 'ADMIN' && !crewWindow(trip).isTripOpen) throw new ConflictException('لم تُفتح هذه الرحلة لك بعد');

    const reporterName = await this.nameOf(actor);
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tripReport.create({
        data: {
          tripId,
          category,
          type: dto.type,
          details: dto.details,
          lat: dto.lat,
          lng: dto.lng,
          accuracy: dto.accuracy,
          liveStatusAtReport: trip.liveStatus,
          pointNameAtReport: trip.currentBoardingPoint?.name,
          idempotencyKey,
          createdById: actor.userId,
          createdByName: reporterName,
        },
      });
      const values = {
        reporterName,
        reportType: TYPE_LABELS[dto.type],
        reportDetails: dto.details,
        reportCode: reportCode(created.number),
        reportCategory: CATEGORY_LABELS[category],
      };
      await this.notifications.toStaff(tx, category === 'SOS' ? 'STAFF_TRIP_SOS' : 'STAFF_TRIP_REPORT', ['manifests.view', 'reports.view'], values, { exceptUserId: actor.userId, tripId, reportId: created.id });
      await this.notifications.toTripCrew(tx, 'CREW_COLLEAGUE_REPORT', tripId, { exceptUserId: actor.userId, reportId: created.id, extra: values });
      // A breakdown opens an entry in the bus's maintenance log, so the repair is followed after the trip too.
      if (dto.type === 'BREAKDOWN' && trip.busId) {
        await tx.busMaintenanceLog.create({
          data: {
            busId: trip.busId,
            tripId,
            tripCode: trip.tripCode,
            reportId: created.id,
            type: 'BREAKDOWN',
            description: dto.details,
            reportedAt: created.createdAt,
            createdById: actor.userId,
            createdByName: reporterName,
          },
        });
      }
      if (category === 'SOS') this.realtime.sosChanged(created.id, 'created');
      return created;
    }, TX_OPTIONS);
    return { ...report, code: reportCode(report.number) };
  }

  async listForTrip(actor: ReportActor, tripId: string) {
    await this.assertAssigned(actor, tripId);
    const reports = await this.prisma.tripReport.findMany({
      where: { tripId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { attachments: true, updates: true } } },
    });
    return reports.map(({ _count, idempotencyKey: _unused, ...report }) => ({ ...report, code: reportCode(report.number), attachmentCount: _count.attachments, updateCount: _count.updates }));
  }

  private async readReport(reportId: string) {
    const report = await this.prisma.tripReport.findUnique({
      where: { id: reportId },
      include: {
        attachments: { select: ATTACHMENT_FIELDS, orderBy: { createdAt: 'asc' } },
        updates: { orderBy: { createdAt: 'asc' } },
        trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true } },
        maintenanceLog: { select: { id: true, busId: true, status: true } },
      },
    });
    if (!report) throw new NotFoundException('البلاغ غير موجود');
    const { idempotencyKey: _unused, ...rest } = report;
    return { ...rest, code: reportCode(report.number) };
  }

  async detailsForCrew(actor: ReportActor, reportId: string) {
    const report = await this.readReport(reportId);
    await this.assertAssigned(actor, report.tripId);
    return report;
  }

  async addCrewUpdate(actor: ReportActor, reportId: string, dto: CrewReportUpdateDto) {
    const report = await this.prisma.tripReport.findUnique({ where: { id: reportId }, select: { id: true, tripId: true, number: true } });
    if (!report) throw new NotFoundException('البلاغ غير موجود');
    await this.assertAssigned(actor, report.tripId);
    const actorName = await this.nameOf(actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.tripReportUpdate.create({ data: { reportId, note: dto.note, actorId: actor.userId, actorName } });
      await tx.tripReport.update({ where: { id: reportId }, data: { updatedAt: new Date() } });
      await this.notifyUpdate(tx, report, actor.userId, { reportStatus: null, updateNote: dto.note, senderName: actorName });
      await this.notifications.toStaff(tx, 'STAFF_REPORT_UPDATED', ['reports.view'], { reportCode: reportCode(report.number), updateNote: dto.note, senderName: actorName }, { exceptUserId: actor.userId, tripId: report.tripId, reportId });
    }, TX_OPTIONS);
    return this.detailsForCrew(actor, reportId);
  }

  async addAttachments(actor: ReportActor, reportId: string, files: UploadedReportFile[]) {
    if (!files?.length) throw new BadRequestException('لم يصل أي ملف');
    const report = await this.prisma.tripReport.findUnique({ where: { id: reportId }, select: { tripId: true } });
    if (!report) throw new NotFoundException('البلاغ غير موجود');
    await this.assertAssigned(actor, report.tripId);
    if (files.length > MAX_ATTACHMENTS_PER_REPORT) throw new BadRequestException(`الحد الأقصى ${MAX_ATTACHMENTS_PER_REPORT} مرفقات لكل بلاغ`);

    const rows = files.map((file) => {
      const type = fileTypeOf(file.buffer);
      const name = cleanFileName(file.originalname);
      if (!type) throw new BadRequestException(`الملف "${name}" ليس صورة أو فيديو`);
      if (!type.isVideo && file.size > MAX_REPORT_IMAGE_BYTES) throw new BadRequestException(`الصورة "${name}" أكبر من 10 ميجابايت`);
      return { reportId, fileName: name, mimeType: type.mimeType, size: file.size, data: file.buffer, uploadedById: actor.userId };
    });
    await this.prisma.$transaction(async (tx) => {
      // Two uploads at once must not both count the same attachments and pass the cap together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`trip-report-attachments:${reportId}`}))`;
      const existing = await tx.tripReportAttachment.count({ where: { reportId } });
      if (existing + rows.length > MAX_ATTACHMENTS_PER_REPORT) throw new BadRequestException(`الحد الأقصى ${MAX_ATTACHMENTS_PER_REPORT} مرفقات لكل بلاغ`);
      await tx.tripReportAttachment.createMany({ data: rows });
    }, TX_OPTIONS);
    return this.prisma.tripReportAttachment.findMany({ where: { reportId }, select: ATTACHMENT_FIELDS, orderBy: { createdAt: 'asc' } });
  }

  async attachmentForCrew(actor: ReportActor, id: string) {
    const file = await this.prisma.tripReportAttachment.findUnique({ where: { id }, include: { report: { select: { tripId: true } } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    await this.assertAssigned(actor, file.report.tripId);
    return file;
  }

  // ---------------------------------------------------------------- the office

  async list(query: ReportsQuery) {
    const page = query.page ?? 1;
    const where: Prisma.TripReportWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.category && { category: query.category }),
    };
    if (query.search) {
      const number = /^(?:BL-)?0*(\d{1,9})$/i.exec(query.search)?.[1];
      where.OR = [
        { trip: { tripCode: { contains: query.search, mode: 'insensitive' } } },
        { createdByName: { contains: query.search, mode: 'insensitive' } },
        { details: { contains: query.search, mode: 'insensitive' } },
        ...(number ? [{ number: Number(number) }] : []),
      ];
    }
    const [items, total, groups, unacknowledgedSos] = await Promise.all([
      this.prisma.tripReport.findMany({
        where,
        // Enum order puts what still needs someone first; among those, the newest.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, liveStatus: true, currentBoardingPoint: { select: { name: true } } } },
          _count: { select: { attachments: true, updates: true } },
        },
      }),
      this.prisma.tripReport.count({ where }),
      this.prisma.tripReport.groupBy({ by: ['status', 'category'], _count: true }),
      this.prisma.tripReport.count({ where: { category: 'SOS', status: { not: 'RESOLVED' }, acknowledgedAt: null } }),
    ]);
    const count = (match: (row: (typeof groups)[number]) => boolean) => groups.filter(match).reduce((sum, row) => sum + row._count, 0);
    return {
      summary: {
        open: count((row) => row.status === 'OPEN'),
        inProgress: count((row) => row.status === 'IN_PROGRESS'),
        resolved: count((row) => row.status === 'RESOLVED'),
        activeSos: count((row) => row.category === 'SOS' && row.status !== 'RESOLVED'),
        unacknowledgedSos,
      },
      items: items.map(({ _count, idempotencyKey: _unused, ...report }) => ({ ...report, code: reportCode(report.number), attachmentCount: _count.attachments, updateCount: _count.updates })),
      total,
      page,
    };
  }

  /** A report and everything the person handling it needs to know about the trip it came from. */
  async detailsForOffice(reportId: string) {
    const report = await this.readReport(reportId);
    const crewMember = { orderBy: { isPrimary: 'desc' }, select: { isPrimary: true, user: { select: { id: true, name: true, phone: true } } } } as const;
    const [reporter, trip, tickets, statusHistory, otherReports, notices] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: report.createdById }, select: { id: true, name: true, phone: true, role: true, rank: { select: { name: true, job: { select: { name: true } } } } } }),
      this.prisma.trip.findUniqueOrThrow({
        where: { id: report.tripId },
        select: {
          id: true,
          tripCode: true,
          title: true,
          origin: true,
          destination: true,
          departureTime: true,
          arrivalTime: true,
          hijriDate: true,
          bookingType: true,
          busType: true,
          tripStatus: true,
          totalSeats: true,
          availableSeats: true,
          liveStatus: true,
          liveStatusAt: true,
          currentBoardingPointId: true,
          bus: { select: { plateNumber: true, model: true, color: true } },
          location: { select: { lat: true, lng: true, speed: true, recordedAt: true } },
          boardingPoints: { select: { id: true, name: true, time: true, address: true, lat: true, lng: true } },
          drivers: crewMember,
          supervisors: crewMember,
        },
      }),
      this.prisma.ticket.findMany({
        where: { booking: { tripId: report.tripId, status: { in: [...TRAVELING_STATUSES] } } },
        select: { isBoarded: true, noShowAt: true, booking: { select: { boardingPointId: true, boardingPointName: true } } },
      }),
      this.prisma.tripStatusUpdate.findMany({ where: { tripId: report.tripId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.tripReport.findMany({
        where: { tripId: report.tripId, id: { not: reportId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, number: true, category: true, type: true, status: true, details: true, createdByName: true, createdAt: true },
      }),
      this.prisma.bookingEvent.findMany({
        where: { action: 'CREW_NOTICE', booking: { tripId: report.tripId } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { actorName: true, after: true, createdAt: true },
      }),
    ]);

    // One notice is written once per booking, so the copies are folded back into one.
    const seen = new Set<string>();
    const latestNotices = notices
      .map((row) => ({ message: (row.after as { message?: string } | null)?.message ?? '', actorName: row.actorName, createdAt: row.createdAt }))
      .filter((row) => {
        const key = `${row.createdAt.getTime() - (row.createdAt.getTime() % 60000)}|${row.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);

    const visited = new Set(statusHistory.flatMap((row) => (row.status === 'AT_POINT' && row.boardingPointId ? [row.boardingPointId] : [])));
    const onPoint = (point: { id: string; name: string }) => tickets.filter((ticket) => ticket.booking.boardingPointId === point.id || ticket.booking.boardingPointName === point.name);
    const { location, boardingPoints, drivers, supervisors, currentBoardingPointId, ...tripFields } = trip;
    const toMember = ({ isPrimary, user }: { isPrimary: boolean; user: { id: string; name: string | null; phone: string } }) => ({ ...user, isPrimary });

    return {
      ...report,
      reporter: reporter && { id: reporter.id, name: reporter.name, phone: reporter.phone, role: reporter.role, rankName: reporter.rank?.name ?? null, jobName: reporter.rank?.job?.name ?? null },
      tripInfo: {
        ...tripFields,
        drivers: drivers.map(toMember),
        supervisors: supervisors.map(toMember),
        currentPoint: boardingPoints.find((point) => point.id === currentBoardingPointId) ?? null,
        location: location && { ...location, isLive: Date.now() - location.recordedAt.getTime() <= LIVE_FOR_MS },
        passengerCount: tickets.length,
        boardedCount: tickets.filter((ticket) => ticket.isBoarded).length,
        noShowCount: tickets.filter((ticket) => ticket.noShowAt && !ticket.isBoarded).length,
        points: [...boardingPoints]
          .sort((a, b) => a.time.localeCompare(b.time))
          .map((point) => {
            const passengers = onPoint(point);
            return { ...point, isCurrent: point.id === currentBoardingPointId, visited: visited.has(point.id), passengerCount: passengers.length, boardedCount: passengers.filter((ticket) => ticket.isBoarded).length };
          }),
      },
      statusHistory,
      otherReports: otherReports.map((row) => ({ ...row, code: reportCode(row.number) })),
      notices: latestNotices,
    };
  }

  async addOfficeUpdate(actor: ReportActor, reportId: string, dto: OfficeReportUpdateDto) {
    const note = dto.note || null;
    const report = await this.prisma.tripReport.findUnique({ where: { id: reportId }, select: { id: true, tripId: true, number: true, status: true, category: true, acknowledgedAt: true } });
    if (!report) throw new NotFoundException('البلاغ غير موجود');
    const changed = dto.status && dto.status !== report.status ? dto.status : null;
    if (!changed && !note) throw new BadRequestException('غيّر الحالة أو اكتب ملاحظة');

    const actorName = await this.nameOf(actor);
    await this.prisma.$transaction(async (tx) => {
      // Answering a report shows it was received, so the alarm stops and nobody is escalated for it.
      if (!report.acknowledgedAt) await this.acknowledgeIn(tx, report, actor.userId, actorName);
      await tx.tripReportUpdate.create({ data: { reportId, status: changed, note, actorId: actor.userId, actorName, fromOffice: true } });
      await tx.tripReport.update({ where: { id: reportId }, data: { updatedAt: new Date(), ...(changed && { status: changed }) } });
      await this.notifyUpdate(tx, report, actor.userId, { reportStatus: changed && STATUS_LABELS[changed], updateNote: note, senderName: actorName });
      if (report.category === 'SOS' && changed === 'RESOLVED') this.realtime.sosChanged(reportId, 'resolved');
    }, TX_OPTIONS);
    return this.detailsForOffice(reportId);
  }

  /** Someone in the office says "we have it": the crew sees who, and the alarm and the escalation stop. Repeating it changes nothing. */
  async acknowledge(actor: ReportActor, reportId: string) {
    const report = await this.prisma.tripReport.findUnique({ where: { id: reportId }, select: { id: true, tripId: true, number: true, category: true, acknowledgedAt: true } });
    if (!report) throw new NotFoundException('البلاغ غير موجود');
    if (!report.acknowledgedAt) {
      const actorName = await this.nameOf(actor);
      await this.prisma.$transaction((tx) => this.acknowledgeIn(tx, report, actor.userId, actorName), TX_OPTIONS);
    }
    return this.detailsForOffice(reportId);
  }

  /** The claim on acknowledgedAt makes two people pressing at once record one acknowledgement. */
  private async acknowledgeIn(tx: Prisma.TransactionClient, report: { id: string; tripId: string; number: number; category: TripReportCategory }, actorId: string, actorName: string | null) {
    const now = new Date();
    const claimed = await tx.tripReport.updateMany({
      where: { id: report.id, acknowledgedAt: null },
      data: { acknowledgedAt: now, acknowledgedById: actorId, acknowledgedByName: actorName, updatedAt: now },
    });
    if (claimed.count === 0) return false;
    const senderName = actorName ?? 'المكتب';
    await tx.tripReportUpdate.create({ data: { reportId: report.id, note: `تم استلام البلاغ من المكتب (${senderName})`, actorId, actorName, fromOffice: true } });
    if (report.category === 'SOS') {
      await this.notifications.toTripCrew(tx, 'CREW_SOS_ACKNOWLEDGED', report.tripId, { exceptUserId: actorId, reportId: report.id, extra: { reportCode: reportCode(report.number), senderName } });
      this.realtime.sosChanged(report.id, 'acknowledged');
    }
    const crew = await tx.trip.findUnique({ where: { id: report.tripId }, select: { drivers: { select: { userId: true } }, supervisors: { select: { userId: true } } } });
    const crewIds = crew ? [...crew.drivers, ...crew.supervisors].map((member) => member.userId) : [];
    this.realtime.reportChanged(crewIds, { reportId: report.id, tripId: report.tripId, acknowledgedAt: now, acknowledgedByName: actorName });
    return true;
  }

  /** Every SOS still open, for the dashboard's alarm and banner, split by whether someone acknowledged it. */
  async activeSos() {
    const rows = await this.prisma.tripReport.findMany({
      where: { category: 'SOS', status: { not: 'RESOLVED' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        details: true,
        createdByName: true,
        createdAt: true,
        acknowledgedAt: true,
        acknowledgedByName: true,
        escalatedAt: true,
        trip: { select: { id: true, tripCode: true, origin: true, destination: true } },
      },
    });
    const items = rows.map((row) => ({ ...row, code: reportCode(row.number) }));
    return { unacknowledged: items.filter((row) => !row.acknowledgedAt), acknowledged: items.filter((row) => row.acknowledgedAt) };
  }

  async attachmentForOffice(id: string) {
    const file = await this.prisma.tripReportAttachment.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  async openCount() {
    const [open, sos, unacknowledgedSos] = await Promise.all([
      this.prisma.tripReport.count({ where: { status: 'OPEN' } }),
      this.prisma.tripReport.count({ where: { category: 'SOS', status: { not: 'RESOLVED' } } }),
      this.prisma.tripReport.count({ where: { category: 'SOS', status: { not: 'RESOLVED' }, acknowledgedAt: null } }),
    ]);
    return { open, sos, unacknowledgedSos };
  }

  /** Whoever filed it and the rest of the trip's crew hear about every change. */
  private notifyUpdate(tx: Prisma.TransactionClient, report: { id: string; tripId: string; number: number }, actorId: string, values: { reportStatus: string | null; updateNote: string | null; senderName: string | null }) {
    return this.notifications.toTripCrew(tx, 'CREW_REPORT_UPDATED', report.tripId, {
      exceptUserId: actorId,
      reportId: report.id,
      extra: { reportCode: reportCode(report.number), ...values },
    });
  }
}

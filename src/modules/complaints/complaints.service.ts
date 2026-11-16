import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ComplaintMessageKind, CustomerComplaintCategory, Prisma, SupportTicketPriority } from '@prisma/client';
import { permissionsOf } from '../../common/permissions';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { cleanFileName } from '../cash/cash.service';
import { complaintReference, hotelBookingReference } from '../hotels/hotels.service';
import { CreateCustomerComplaintDto, ListCustomerComplaintsQuery, ListHotelComplaintsQuery, TicketView } from './complaints.dto';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const MAX_OPEN_COMPLAINTS = 5;
const MAX_BOOKING_CHOICES = 30;
/** Images per message, per ticket, and per image; a request is held in memory until it is stored. */
export const MAX_COMPLAINT_FILES = 5;
export const MAX_COMPLAINT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TICKET = 30;
const MAX_MESSAGES_PER_TICKET = 300;

/** Arabic, since staff read it and it also fills the notification. The app shows its own translated label. */
export const COMPLAINT_CATEGORY_LABELS: Record<CustomerComplaintCategory, string> = {
  APP: 'التطبيق',
  TRIP: 'رحلة',
  SUPERVISOR: 'المشرف',
  BUS: 'الباص',
  OTHER: 'أخرى',
};
export const PRIORITY_LABELS: Record<SupportTicketPriority, string> = { LOW: 'منخفضة', NORMAL: 'عادية', HIGH: 'مرتفعة', URGENT: 'عاجلة' };
/** A bus changes from trip to trip, so a complaint about one has to say which trip it was. */
const NEEDS_BOOKING: CustomerComplaintCategory[] = ['TRIP', 'SUPERVISOR', 'BUS'];
const MISSING_BOOKING: Partial<Record<CustomerComplaintCategory, string>> = {
  SUPERVISOR: 'اختر الرحلة التي كان عليها المشرف',
  BUS: 'اختر الرحلة التي كان عليها الباص',
};

export const customerComplaintReference = (number: number) => `C-${number}`;

/** The signed-in employee as the auth guard gives it. */
export interface SupportStaff {
  userId: string;
  role: string;
  name?: string | null;
  permissions: string[];
}

export interface UploadedComplaintFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

// The declared type comes from the client, so the stored type is decided by the file's own bytes.
const IMAGE_TYPES: { mimeType: string; matches: (file: Buffer) => boolean }[] = [
  { mimeType: 'image/jpeg', matches: (f) => f[0] === 0xff && f[1] === 0xd8 && f[2] === 0xff },
  { mimeType: 'image/png', matches: (f) => f.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n' },
  { mimeType: 'image/webp', matches: (f) => f.subarray(0, 4).toString('latin1') === 'RIFF' && f.subarray(8, 12).toString('latin1') === 'WEBP' },
];

const readImages = (files: UploadedComplaintFile[] | undefined, uploadedById: string | null) => {
  const list = files ?? [];
  if (list.length > MAX_COMPLAINT_FILES) throw new BadRequestException(`الحد الأقصى ${MAX_COMPLAINT_FILES} صور في الرسالة الواحدة`);
  return list.map((file) => {
    const name = cleanFileName(file.originalname);
    const type = IMAGE_TYPES.find((candidate) => candidate.matches(file.buffer));
    if (!type) throw new BadRequestException(`الملف "${name}" ليس صورة (JPG أو PNG أو WEBP)`);
    if (file.size > MAX_COMPLAINT_IMAGE_BYTES) throw new BadRequestException(`الصورة "${name}" أكبر من 10 ميجابايت`);
    return { fileName: name, mimeType: type.mimeType, size: file.size, data: file.buffer, uploadedById };
  });
};

const BOOKING_CHOICE_SELECT = {
  id: true,
  bookingReference: true,
  trip: {
    select: {
      id: true,
      tripCode: true,
      origin: true,
      destination: true,
      departureTime: true,
      bus: { select: { plateNumber: true } },
      supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.BookingSelect;

type BookingChoice = Prisma.BookingGetPayload<{ select: typeof BOOKING_CHOICE_SELECT }>;

const supervisorNamesOf = (booking: BookingChoice) =>
  booking.trip.supervisors.map((s) => s.user.name).filter((name): name is string => !!name);

/** What the customer may see of their own complaint: never who on staff answered it. */
const CUSTOMER_VIEW_SELECT = {
  id: true,
  number: true,
  category: true,
  status: true,
  details: true,
  tripCode: true,
  supervisorNames: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  lastActivityAt: true,
  customerUnread: true,
  booking: { select: { bookingReference: true } },
} satisfies Prisma.CustomerComplaintSelect;

const ATTACHMENT_FIELDS = { id: true, fileName: true, mimeType: true, size: true } satisfies Prisma.ComplaintAttachmentSelect;
const MESSAGE_FIELDS = {
  id: true,
  kind: true,
  body: true,
  authorId: true,
  authorName: true,
  createdAt: true,
  attachments: { select: ATTACHMENT_FIELDS, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ComplaintMessageSelect;

/** What a ticket action needs to decide and to notify. */
const ACTION_SELECT = {
  id: true,
  number: true,
  status: true,
  category: true,
  userId: true,
  customerName: true,
  customerPhone: true,
  assignedToId: true,
  assignedToName: true,
  priority: true,
} satisfies Prisma.CustomerComplaintSelect;
type ActionTicket = Prisma.CustomerComplaintGetPayload<{ select: typeof ACTION_SELECT }>;

const supervises = (staff: SupportStaff) => staff.permissions.includes('complaints.assign');

@Injectable()
export class ComplaintsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------- the customer

  /** The customer's complaints, and the bookings a complaint about a trip or a supervisor can name. */
  async mine(userId: string) {
    const [complaints, bookings] = await Promise.all([
      this.prisma.customerComplaint.findMany({ where: { userId }, orderBy: { lastActivityAt: 'desc' }, select: CUSTOMER_VIEW_SELECT }),
      // An unpaid booking never travelled, so there is nothing to complain about on it.
      this.prisma.booking.findMany({
        where: { userId, status: { not: 'PENDING' } },
        orderBy: { trip: { departureTime: 'desc' } },
        take: MAX_BOOKING_CHOICES,
        select: BOOKING_CHOICE_SELECT,
      }),
    ]);
    return {
      complaints: complaints.map(({ number, booking, ...complaint }) => ({
        ...complaint,
        reference: customerComplaintReference(number),
        bookingReference: booking?.bookingReference ?? null,
      })),
      bookings: bookings.map((booking) => ({
        id: booking.id,
        bookingReference: booking.bookingReference,
        tripCode: booking.trip.tripCode,
        origin: booking.trip.origin,
        destination: booking.trip.destination,
        departureTime: booking.trip.departureTime,
        supervisors: supervisorNamesOf(booking),
        // Lets the customer recognise the bus they mean when complaining about it.
        busPlate: booking.trip.bus?.plateNumber ?? null,
      })),
    };
  }

  async create(userId: string, dto: CreateCustomerComplaintDto, files?: UploadedComplaintFile[]) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true, blockedAt: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.blockedAt) throw new ForbiddenException('حسابك موقوف، تواصل مع خدمة العملاء');
    const images = readImages(files, userId);

    if (NEEDS_BOOKING.includes(dto.category) && !dto.bookingId) {
      throw new BadRequestException(MISSING_BOOKING[dto.category] ?? 'اختر الرحلة التي تشتكي منها');
    }
    // Someone else's booking looks like it does not exist.
    const booking = dto.bookingId
      ? await this.prisma.booking.findFirst({ where: { id: dto.bookingId, userId, status: { not: 'PENDING' } }, select: BOOKING_CHOICE_SELECT })
      : null;
    if (dto.bookingId && !booking) throw new BadRequestException('هذا الحجز ليس ضمن حجوزاتك');
    const supervisors = booking ? supervisorNamesOf(booking) : [];
    if (dto.category === 'SUPERVISOR' && supervisors.length === 0) throw new BadRequestException('لم يُحدد مشرف لهذه الرحلة بعد');

    const open = await this.prisma.customerComplaint.count({ where: { userId, status: 'OPEN' } });
    if (open >= MAX_OPEN_COMPLAINTS) throw new ConflictException('لديك شكاوى قيد المراجعة، وسنرد عليها قريبًا');

    const created = await this.prisma.$transaction(async (tx) => {
      const complaint = await tx.customerComplaint.create({
        data: {
          userId,
          category: dto.category,
          details: dto.details,
          bookingId: booking?.id ?? null,
          tripId: booking?.trip.id ?? null,
          tripCode: booking?.trip.tripCode ?? null,
          supervisorNames: dto.category === 'SUPERVISOR' ? supervisors.join('، ') : null,
          customerName: user.name,
          customerPhone: user.phone,
          messages: {
            create: {
              kind: 'CUSTOMER',
              body: dto.details,
              authorId: userId,
              authorName: user.name,
              ...(images.length > 0 && { attachments: { create: images } }),
            },
          },
        },
        select: { id: true, number: true },
      });
      const reference = customerComplaintReference(complaint.number);
      await this.notifications.toStaff(tx, 'STAFF_CUSTOMER_COMPLAINT', ['complaints.view'], {
        complaintReference: reference,
        complaintCategory: COMPLAINT_CATEGORY_LABELS[dto.category],
        customerName: user.name || user.phone,
        customerPhone: user.phone,
      });
      return { id: complaint.id, reference };
    }, TX_OPTIONS);
    this.realtime.complaintChanged(created.id);
    return created;
  }

  /** The customer's own ticket with the conversation; internal notes, events and staff names stay hidden. */
  async customerThread(userId: string, id: string) {
    const complaint = await this.prisma.customerComplaint.findFirst({
      where: { id, userId },
      select: {
        ...CUSTOMER_VIEW_SELECT,
        messages: { where: { kind: { in: ['CUSTOMER', 'STAFF'] } }, orderBy: { createdAt: 'asc' }, select: MESSAGE_FIELDS },
      },
    });
    if (!complaint) throw new NotFoundException('الشكوى غير موجودة');
    if (complaint.customerUnread > 0) await this.prisma.customerComplaint.update({ where: { id }, data: { customerUnread: 0 } });
    const { number, booking, messages, ...rest } = complaint;
    return {
      ...rest,
      customerUnread: 0,
      reference: customerComplaintReference(number),
      bookingReference: booking?.bookingReference ?? null,
      messages: messages.map(({ authorId: _authorId, authorName, ...message }) => ({
        ...message,
        authorName: message.kind === 'CUSTOMER' ? authorName : null,
      })),
    };
  }

  /** A reply on a closed complaint opens it again, since the customer is still waiting for something. */
  async customerReply(userId: string, id: string, body: string | undefined, files?: UploadedComplaintFile[]) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true, blockedAt: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.blockedAt) throw new ForbiddenException('حسابك موقوف، تواصل مع خدمة العملاء');
    const text = body?.trim() ?? '';
    const images = readImages(files, userId);
    if (!text && images.length === 0) throw new BadRequestException('اكتب ردك أو أرفق صورة');

    const ticket = await this.prisma.customerComplaint.findFirst({ where: { id, userId }, select: ACTION_SELECT });
    if (!ticket) throw new NotFoundException('الشكوى غير موجودة');

    await this.prisma.$transaction(async (tx) => {
      await this.assertRoom(tx, id, images.length);
      const now = new Date();
      if (ticket.status === 'RESOLVED') {
        await tx.complaintMessage.create({ data: { complaintId: id, kind: 'EVENT', body: 'أعاد العميل فتح الشكوى برد جديد', createdAt: now } });
      }
      await tx.complaintMessage.create({
        data: {
          complaintId: id,
          kind: 'CUSTOMER',
          body: text,
          authorId: userId,
          authorName: user.name,
          createdAt: new Date(now.getTime() + 1),
          ...(images.length > 0 && { attachments: { create: images } }),
        },
      });
      await tx.customerComplaint.update({
        where: { id },
        data: {
          awaitingReply: true,
          lastActivityAt: now,
          ...(ticket.status === 'RESOLVED' && { status: 'OPEN', resolution: null, resolvedAt: null, resolvedById: null, resolvedByName: null }),
        },
      });
      if (ticket.assignedToId) {
        await this.notifications.toUser(tx, 'COMPLAINT_CUSTOMER_REPLIED', ticket.assignedToId, {
          complaintReference: customerComplaintReference(ticket.number),
          complaintCategory: COMPLAINT_CATEGORY_LABELS[ticket.category],
          customerName: user.name || user.phone,
        });
      }
    }, TX_OPTIONS);
    this.realtime.complaintChanged(id, userId);
    return this.customerThread(userId, id);
  }

  async customerAttachment(userId: string, attachmentId: string) {
    const file = await this.prisma.complaintAttachment.findFirst({
      where: { id: attachmentId, message: { kind: { in: ['CUSTOMER', 'STAFF'] }, complaint: { userId } } },
    });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  // ---------------------------------------------------------------- support staff

  /**
   * A supervisor (complaints.assign) sees every ticket. Everyone else sees what waits for someone to take it and what
   * they hold or closed themselves, so each employee works their own queue.
   */
  private scopeFor(staff: SupportStaff): Prisma.CustomerComplaintWhereInput {
    if (supervises(staff)) return {};
    return { OR: [{ status: 'OPEN', assignedToId: null }, { assignedToId: staff.userId }, { resolvedById: staff.userId }] };
  }

  private viewWhere(staff: SupportStaff, view: TicketView): Prisma.CustomerComplaintWhereInput {
    switch (view) {
      case 'new':
        return { status: 'OPEN', assignedToId: null };
      case 'mine':
        return { status: 'OPEN', assignedToId: staff.userId };
      case 'closed':
        return { AND: [{ status: 'RESOLVED' }, this.scopeFor(staff)] };
      default:
        return { AND: [{ status: 'OPEN' }, this.scopeFor(staff)] };
    }
  }

  private orderFor(view: TicketView | undefined): Prisma.CustomerComplaintOrderByWithRelationInput[] {
    // The queue is served oldest first within each priority; a held ticket the customer answered rises to the top.
    if (view === 'new') return [{ priority: 'desc' }, { createdAt: 'asc' }];
    if (view === 'closed') return [{ resolvedAt: 'desc' }];
    if (view) return [{ awaitingReply: 'desc' }, { priority: 'desc' }, { lastActivityAt: 'desc' }];
    return [{ status: 'asc' }, { createdAt: 'desc' }];
  }

  async list(staff: SupportStaff, query: ListCustomerComplaintsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    const number = search && /^c-?\d+$/i.test(search) ? Number(search.replace(/\D/g, '')) : null;
    const view = query.view;
    // Without a view this is the older list (and the sidebar's count), limited to what this employee may see.
    const base: Prisma.CustomerComplaintWhereInput = view
      ? this.viewWhere(staff, view)
      : { AND: [this.scopeFor(staff), ...(query.status ? [{ status: query.status }] : [])] };
    const assignee: Prisma.CustomerComplaintWhereInput =
      query.assignee && supervises(staff) ? { assignedToId: query.assignee === 'none' ? null : query.assignee } : {};
    const filters: Prisma.CustomerComplaintWhereInput = {
      ...(query.priority && { priority: query.priority }),
      ...(search && {
        OR: number !== null
          ? [{ number }]
          : [
              { customerName: { contains: search, mode: 'insensitive' } },
              { customerPhone: { contains: search } },
              { tripCode: { contains: search, mode: 'insensitive' } },
              { supervisorNames: { contains: search, mode: 'insensitive' } },
              { details: { contains: search, mode: 'insensitive' } },
            ],
      }),
    };
    const where: Prisma.CustomerComplaintWhereInput = { AND: [base, assignee, filters, ...(query.category ? [{ category: query.category }] : [])] };
    const countOf = (v: TicketView) => this.prisma.customerComplaint.count({ where: { AND: [this.viewWhere(staff, v), assignee] } });

    const [items, total, byCategory, counts] = await Promise.all([
      this.prisma.customerComplaint.findMany({
        where,
        orderBy: this.orderFor(view),
        skip: (page - 1) * limit,
        take: limit,
        include: {
          booking: { select: { id: true, bookingReference: true } },
          messages: { where: { kind: { in: ['CUSTOMER', 'STAFF'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { kind: true, body: true, createdAt: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.customerComplaint.count({ where }),
      // The category badges count what this tab holds (open ones for the older list), before the category filter.
      this.prisma.customerComplaint.groupBy({
        by: ['category'],
        where: view ? { AND: [base, assignee, filters] } : { AND: [this.scopeFor(staff), { status: 'OPEN' }] },
        _count: { _all: true },
      }),
      Promise.all((['new', 'mine', 'all', 'closed'] as const).map(countOf)),
    ]);
    return {
      items: items.map(({ number: n, messages, _count, ...complaint }) => ({
        ...complaint,
        reference: customerComplaintReference(n),
        lastMessage: messages[0] ?? null,
        messageCount: _count.messages,
      })),
      total,
      page,
      limit,
      openByCategory: Object.fromEntries(byCategory.map((row) => [row.category, row._count._all])),
      counts: { new: counts[0], mine: counts[1], all: counts[2], closed: counts[3] },
      canSupervise: supervises(staff),
    };
  }

  async detail(staff: SupportStaff, id: string) {
    const complaint = await this.prisma.customerComplaint.findFirst({
      where: { AND: [{ id }, this.scopeFor(staff)] },
      include: {
        booking: { select: { id: true, bookingReference: true, status: true, trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true } } } },
        messages: { orderBy: { createdAt: 'asc' }, select: MESSAGE_FIELDS },
      },
    });
    if (!complaint) {
      const exists = await this.prisma.customerComplaint.findUnique({ where: { id }, select: { assignedToName: true } });
      if (!exists) throw new NotFoundException('الشكوى غير موجودة');
      throw new ForbiddenException(`هذه التذكرة مسندة إلى ${exists.assignedToName ?? 'موظف آخر'}`);
    }
    const { number, ...rest } = complaint;
    return { ...rest, reference: customerComplaintReference(number) };
  }

  async staffAttachment(staff: SupportStaff, attachmentId: string) {
    const file = await this.prisma.complaintAttachment.findFirst({ where: { id: attachmentId, message: { complaint: this.scopeFor(staff) } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  /** Employees who may answer complaints, for the assignee filter and the transfer picker. */
  async supportStaff() {
    const staff = await this.prisma.user.findMany({
      where: {
        role: { not: 'PASSENGER' },
        blockedAt: null,
        NOT: { driverProfile: { is: { isActive: false } } },
        OR: [{ role: 'ADMIN' }, { rank: { permissions: { has: 'complaints.manage' } } }, { extraPermissions: { has: 'complaints.manage' } }],
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true, role: true, extraPermissions: true, revokedPermissions: true, rank: { select: { name: true, permissions: true } } },
    });
    const open = await this.prisma.customerComplaint.groupBy({ by: ['assignedToId'], where: { status: 'OPEN', assignedToId: { in: staff.map((user) => user.id) } }, _count: { _all: true } });
    const load = new Map(open.map((row) => [row.assignedToId, row._count._all]));
    return staff
      .filter((user) => permissionsOf(user).includes('complaints.manage'))
      .map((user) => ({ id: user.id, name: user.name || user.phone, rankName: user.rank?.name ?? null, openTickets: load.get(user.id) ?? 0 }));
  }

  private async ticketFor(staff: SupportStaff, id: string) {
    const ticket = await this.prisma.customerComplaint.findUnique({ where: { id }, select: ACTION_SELECT });
    if (!ticket) throw new NotFoundException('الشكوى غير موجودة');
    return ticket;
  }

  /** The holder works a ticket, anyone may start one nobody holds, and a supervisor may step into any. */
  private assertHandles(staff: SupportStaff, ticket: ActionTicket) {
    if (supervises(staff) || !ticket.assignedToId || ticket.assignedToId === staff.userId) return;
    throw new ForbiddenException(`هذه التذكرة مع ${ticket.assignedToName ?? 'موظف آخر'}، اطلب منه تحويلها إليك`);
  }

  private async assertRoom(tx: Prisma.TransactionClient, complaintId: string, newImages: number) {
    // Two messages at once must not both pass the caps together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`complaint-thread:${complaintId}`}))`;
    const messages = await tx.complaintMessage.count({ where: { complaintId } });
    if (messages >= MAX_MESSAGES_PER_TICKET) throw new BadRequestException('وصلت هذه الشكوى إلى الحد الأقصى من الرسائل، افتح شكوى جديدة');
    if (newImages > 0) {
      const images = await tx.complaintAttachment.count({ where: { message: { complaintId } } });
      if (images + newImages > MAX_ATTACHMENTS_PER_TICKET) throw new BadRequestException(`الحد الأقصى ${MAX_ATTACHMENTS_PER_TICKET} صورة لكل شكوى`);
    }
  }

  private event(tx: Prisma.TransactionClient, complaintId: string, staff: SupportStaff, body: string) {
    return tx.complaintMessage.create({ data: { complaintId, kind: 'EVENT', body, authorId: staff.userId, authorName: staff.name ?? null } });
  }

  /** «استلام»: takes a ticket from «جديدة». Conditional, so two employees taking it together cannot both get it. */
  async claim(staff: SupportStaff, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.customerComplaint.updateMany({
        where: { id, status: 'OPEN', assignedToId: null },
        data: { assignedToId: staff.userId, assignedToName: staff.name ?? null, assignedAt: new Date(), lastActivityAt: new Date() },
      });
      if (count === 0) {
        const ticket = await tx.customerComplaint.findUnique({ where: { id }, select: { status: true, assignedToId: true, assignedToName: true } });
        if (!ticket) throw new NotFoundException('الشكوى غير موجودة');
        if (ticket.assignedToId === staff.userId) return;
        if (ticket.status !== 'OPEN') throw new ConflictException('هذه الشكوى مغلقة');
        throw new ConflictException(`استلم ${ticket.assignedToName ?? 'موظف آخر'} هذه التذكرة قبلك`);
      }
      await this.event(tx, id, staff, `استلم ${staff.name ?? 'موظف'} التذكرة`);
    }, TX_OPTIONS);
    this.realtime.complaintChanged(id);
    return this.detail(staff, id);
  }

  /** Hands the ticket to a colleague, or (assigneeId null) back to «جديدة». */
  async assign(staff: SupportStaff, id: string, assigneeId: string | null) {
    const ticket = await this.ticketFor(staff, id);
    this.assertHandles(staff, ticket);
    if (ticket.status !== 'OPEN') throw new ConflictException('أعد فتح الشكوى قبل إسنادها');
    if (assigneeId === ticket.assignedToId) throw new ConflictException(assigneeId ? 'التذكرة مسندة إلى هذا الموظف بالفعل' : 'التذكرة غير مسندة لأحد');
    const assignee = assigneeId ? (await this.supportStaff()).find((user) => user.id === assigneeId) : null;
    if (assigneeId && !assignee) throw new BadRequestException('هذا الموظف لا يملك صلاحية الرد على الشكاوى');

    await this.prisma.$transaction(async (tx) => {
      // Conditional on the holder it was read with, so a claim in between is never silently overwritten.
      const { count } = await tx.customerComplaint.updateMany({
        where: { id, status: 'OPEN', assignedToId: ticket.assignedToId },
        data: { assignedToId: assignee?.id ?? null, assignedToName: assignee?.name ?? null, assignedAt: assignee ? new Date() : null, lastActivityAt: new Date() },
      });
      if (count === 0) throw new ConflictException('تغيّر مسؤول التذكرة للتو، حدّث الصفحة وحاول مجددًا');
      const actor = staff.name ?? 'موظف';
      await this.event(
        tx,
        id,
        staff,
        assignee
          ? assignee.id === staff.userId
            ? `استلم ${actor} التذكرة`
            : `أسند ${actor} التذكرة إلى ${assignee.name}`
          : `أعاد ${actor} التذكرة إلى الجديدة`,
      );
      // Taking a ticket yourself needs no notice; a colleague's transfer does, or the customer waits unseen.
      if (assignee && assignee.id !== staff.userId) {
        await this.notifications.toUser(tx, 'COMPLAINT_ASSIGNED', assignee.id, {
          assignedBy: actor,
          customerName: ticket.customerName || ticket.customerPhone || 'عميل',
          complaintReference: customerComplaintReference(ticket.number),
          complaintCategory: COMPLAINT_CATEGORY_LABELS[ticket.category],
        });
      }
    }, TX_OPTIONS);
    this.realtime.complaintChanged(id);
    return { success: true };
  }

  async setPriority(staff: SupportStaff, id: string, priority: SupportTicketPriority) {
    const ticket = await this.ticketFor(staff, id);
    this.assertHandles(staff, ticket);
    if (ticket.priority === priority) return { success: true };
    await this.prisma.$transaction(async (tx) => {
      await tx.customerComplaint.update({ where: { id }, data: { priority } });
      await this.event(tx, id, staff, `غيّر ${staff.name ?? 'موظف'} الأولوية من ${PRIORITY_LABELS[ticket.priority]} إلى ${PRIORITY_LABELS[priority]}`);
    }, TX_OPTIONS);
    this.realtime.complaintChanged(id);
    return { success: true };
  }

  /**
   * A reply reaches the customer as a notification; an internal note stays with staff. Writing on a ticket nobody holds
   * takes it, as answering a chat does.
   */
  async addStaffMessage(staff: SupportStaff, id: string, body: string | undefined, internal: boolean, files?: UploadedComplaintFile[]) {
    const ticket = await this.ticketFor(staff, id);
    this.assertHandles(staff, ticket);
    const text = body?.trim() ?? '';
    const images = readImages(files, staff.userId);
    if (!text && images.length === 0) throw new BadRequestException('اكتب الرسالة أو أرفق صورة');
    if (!internal && ticket.status !== 'OPEN') throw new ConflictException('الشكوى مغلقة، أعد فتحها قبل مراسلة العميل');
    const kind: ComplaintMessageKind = internal ? 'NOTE' : 'STAFF';

    await this.prisma.$transaction(async (tx) => {
      await this.assertRoom(tx, id, images.length);
      const now = new Date();
      const takes = !ticket.assignedToId && ticket.status === 'OPEN';
      if (takes) {
        const { count } = await tx.customerComplaint.updateMany({
          where: { id, assignedToId: null },
          data: { assignedToId: staff.userId, assignedToName: staff.name ?? null, assignedAt: now },
        });
        if (count === 0) throw new ConflictException('استلم موظف آخر هذه التذكرة للتو، حدّث الصفحة');
        await this.event(tx, id, staff, `استلم ${staff.name ?? 'موظف'} التذكرة`);
      }
      await tx.complaintMessage.create({
        data: {
          complaintId: id,
          kind,
          body: text,
          authorId: staff.userId,
          authorName: staff.name ?? null,
          createdAt: new Date(now.getTime() + 1),
          ...(images.length > 0 && { attachments: { create: images } }),
        },
      });
      await tx.customerComplaint.update({
        where: { id },
        data: { lastActivityAt: now, ...(kind === 'STAFF' && { awaitingReply: false, customerUnread: { increment: 1 } }) },
      });
      if (kind === 'STAFF' && ticket.userId) {
        await this.notifications.toUser(tx, 'CUSTOMER_COMPLAINT_REPLY', ticket.userId, {
          complaintReference: customerComplaintReference(ticket.number),
          complaintCategory: COMPLAINT_CATEGORY_LABELS[ticket.category],
          complaintResolution: text || 'أرسلنا لك صورة، افتح الشكوى لرؤيتها',
        });
      }
    }, TX_OPTIONS);
    this.realtime.complaintChanged(id, kind === 'STAFF' ? ticket.userId : null);
    return this.detail(staff, id);
  }

  async resolve(staff: SupportStaff, complaintId: string, resolution: string) {
    const ticket = await this.ticketFor(staff, complaintId);
    this.assertHandles(staff, ticket);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Conditional on the status, so two employees answering together cannot overwrite each other's reply.
      const { count } = await tx.customerComplaint.updateMany({
        where: { id: complaintId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolution,
          resolvedAt: now,
          resolvedById: staff.userId,
          resolvedByName: staff.name ?? null,
          awaitingReply: false,
          lastActivityAt: now,
          customerUnread: { increment: 1 },
          // Whoever closes a ticket nobody held becomes its handler, so it shows in their closed list.
          ...(!ticket.assignedToId && { assignedToId: staff.userId, assignedToName: staff.name ?? null, assignedAt: now }),
        },
      });
      if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مغلقة مسبقًا');
      await tx.complaintMessage.create({ data: { complaintId, kind: 'STAFF', body: resolution, authorId: staff.userId, authorName: staff.name ?? null, createdAt: now } });
      await tx.complaintMessage.create({
        data: { complaintId, kind: 'EVENT', body: `أغلق ${staff.name ?? 'موظف'} التذكرة`, authorId: staff.userId, authorName: staff.name ?? null, createdAt: new Date(now.getTime() + 1) },
      });
      if (ticket.userId) {
        await this.notifications.toUser(tx, 'CUSTOMER_COMPLAINT_RESOLVED', ticket.userId, {
          complaintReference: customerComplaintReference(ticket.number),
          complaintCategory: COMPLAINT_CATEGORY_LABELS[ticket.category],
          complaintResolution: resolution,
        });
      }
    }, TX_OPTIONS);
    this.realtime.complaintChanged(complaintId, ticket.userId);
    return { success: true };
  }

  async reopen(staff: SupportStaff, complaintId: string) {
    const ticket = await this.ticketFor(staff, complaintId);
    this.assertHandles(staff, ticket);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.customerComplaint.updateMany({
        where: { id: complaintId, status: 'RESOLVED' },
        data: { status: 'OPEN', resolution: null, resolvedAt: null, resolvedById: null, resolvedByName: null, lastActivityAt: new Date() },
      });
      if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مفتوحة بالفعل');
      await this.event(tx, complaintId, staff, `أعاد ${staff.name ?? 'موظف'} فتح التذكرة`);
    }, TX_OPTIONS);
    this.realtime.complaintChanged(complaintId, ticket.userId);
    return { success: true };
  }

  /**
   * Hotel complaints keep their own table and their own reply and reopen endpoints under /hotels, which notify the traveler;
   * this only gathers every hotel's into one list, so nobody has to open each hotel to find what is waiting.
   */
  async listHotelComplaints(query: ListHotelComplaintsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    const number = search && /^hc-?\d+$/i.test(search) ? Number(search.replace(/\D/g, '')) : null;
    const where: Prisma.HotelComplaintWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.source && { source: query.source }),
      ...(search && {
        OR: number !== null
          ? [{ number }]
          : [
              { hotel: { name: { contains: search, mode: 'insensitive' } } },
              { subject: { contains: search, mode: 'insensitive' } },
              { travelerName: { contains: search, mode: 'insensitive' } },
              { roomNumber: { contains: search } },
              { hotelBooking: { trip: { tripCode: { contains: search, mode: 'insensitive' } } } },
            ],
      }),
    };
    const [items, total, open] = await Promise.all([
      this.prisma.hotelComplaint.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          hotel: { select: { id: true, name: true, city: true } },
          hotelBooking: { select: { number: true, trip: { select: { tripCode: true } } } },
        },
      }),
      this.prisma.hotelComplaint.count({ where }),
      this.prisma.hotelComplaint.count({ where: { status: 'OPEN' } }),
    ]);
    return {
      items: items.map(({ number, hotelBooking, ...complaint }) => ({
        ...complaint,
        reference: complaintReference(number),
        hotelBookingReference: hotelBooking ? hotelBookingReference(hotelBooking.number) : null,
        tripCode: hotelBooking?.trip.tripCode ?? null,
      })),
      total,
      page,
      limit,
      open,
    };
  }
}

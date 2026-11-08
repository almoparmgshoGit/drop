import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LeaveStatus, LeaveType, Prisma } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { HrActor, HrCoreService, TX_OPTIONS } from './hr-core.service';
import { addDays, Day, daysBetween, fromDbDate, leaveCode, parseDay, serviceMonths, toDbDate, today } from './hr.util';

export const MAX_LEAVE_FILES = 3;

type Tx = Prisma.TransactionClient;

export interface LeaveInput {
  typeId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}

const REQUEST_SELECT = {
  id: true,
  number: true,
  startDate: true,
  endDate: true,
  plannedEndDate: true,
  days: true,
  reason: true,
  status: true,
  fullPayDays: true,
  partialPayDays: true,
  partialPayPercent: true,
  unpaidDays: true,
  crewConflictNote: true,
  createdByName: true,
  createdAt: true,
  reviewedByName: true,
  reviewedAt: true,
  reviewNote: true,
  cancelledAt: true,
  cancelledByName: true,
  cancelReason: true,
  type: { select: { id: true, name: true, kind: true, requiresAttachment: true } },
  user: { select: { id: true, name: true, phone: true, branch: { select: { name: true } }, rank: { select: { name: true } } } },
  attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.LeaveRequestSelect;

const out = <T extends { startDate: Date; endDate: Date; plannedEndDate: Date | null; partialPayPercent: Prisma.Decimal; number: number }>(row: T) => ({
  ...row,
  code: leaveCode(row.number),
  startDate: fromDbDate(row.startDate),
  endDate: fromDbDate(row.endDate),
  plannedEndDate: row.plannedEndDate && fromDbDate(row.plannedEndDate),
  partialPayPercent: Number(row.partialPayPercent),
});

const period = (start: Day, end: Day) => (start === end ? `يوم ${start}` : `من ${start} إلى ${end}`);

type Split = { days: number; fullPayDays: number; partialPayDays: number; partialPayPercent: number; unpaidDays: number };

@Injectable()
export class LeavesService {
  constructor(
    private core: HrCoreService,
    private notifications: NotificationsService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  // ---------------------------------------------------------------- types

  types(includeInactive = false) {
    return this.prisma.leaveType.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async saveType(id: string | null, data: Partial<Pick<LeaveType, 'name' | 'paid' | 'maxDaysPerYear' | 'maxDaysPerRequest' | 'oncePerService' | 'requiresAttachment' | 'gender' | 'minServiceMonths' | 'isActive' | 'sortOrder'>>) {
    if (!id) {
      if (!data.name?.trim()) throw new BadRequestException('اكتب اسم نوع الإجازة');
      const code = `CUSTOM_${Date.now().toString(36).toUpperCase()}`;
      return this.prisma.leaveType.create({ data: { ...data, name: data.name.trim(), code, kind: 'OTHER' } });
    }
    const type = await this.prisma.leaveType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('نوع الإجازة غير موجود');
    // The kinds the law defines carry the balance and pay rules, so they cannot be switched off or made unpaid.
    if (type.isSystem && (data.isActive === false || data.paid !== undefined)) throw new BadRequestException('هذا النوع أساسي في النظام ولا يُوقف ولا تُغيّر طريقة دفعه');
    return this.prisma.leaveType.update({ where: { id }, data: { ...data, ...(data.name && { name: data.name.trim() }) } });
  }

  // ---------------------------------------------------------------- the rules

  /**
   * Checks a leave against every rule of its type and works out how its days are paid. Shared by the preview,
   * the request and the approval, so what the employee was shown is what is decided.
   */
  private async evaluate(db: Tx | HrCoreService['db'], user: { id: string; gender: string | null; employeeProfile: { hireDate: Date; status: string } }, typeId: string, start: Day, end: Day, excludeId?: string): Promise<Split & { type: LeaveType }> {
    if (end < start) throw new BadRequestException('تاريخ نهاية الإجازة قبل بدايتها');
    const type = await db.leaveType.findUnique({ where: { id: typeId } });
    if (!type || !type.isActive) throw new BadRequestException('نوع الإجازة غير متاح');
    const hire = fromDbDate(user.employeeProfile.hireDate);
    if (start < hire) throw new BadRequestException(`الإجازة تبدأ قبل تاريخ التعيين (${hire})`);
    if (user.employeeProfile.status === 'TERMINATED') throw new ConflictException('انتهت خدمة هذا الموظف');

    const days = daysBetween(start, end);
    if (type.maxDaysPerRequest && days > type.maxDaysPerRequest) throw new BadRequestException(`${type.name} لا تتجاوز ${type.maxDaysPerRequest} يوم في الطلب الواحد`);
    if (type.minServiceMonths && serviceMonths(hire, start) < type.minServiceMonths) throw new BadRequestException(`${type.name} تُستحق بعد ${type.minServiceMonths} شهرًا من الخدمة`);
    if (type.gender) {
      if (!user.gender) throw new BadRequestException('حدد جنس الموظف في ملفه أولًا');
      if (user.gender !== type.gender) throw new BadRequestException(`${type.name} لا تنطبق على هذا الموظف`);
    }

    const others = { userId: user.id, status: { in: ['PENDING', 'APPROVED'] as LeaveStatus[] }, ...(excludeId && { id: { not: excludeId } }) };
    const overlap = await db.leaveRequest.findFirst({ where: { ...others, startDate: { lte: toDbDate(end) }, endDate: { gte: toDbDate(start) } }, select: { number: true } });
    if (overlap) throw new ConflictException(`تتداخل مع الإجازة ${leaveCode(overlap.number)}`);

    if (type.oncePerService && (await db.leaveRequest.count({ where: { ...others, typeId } }))) throw new ConflictException(`${type.name} تُمنح مرة واحدة طوال الخدمة`);
    if (type.maxDaysPerYear) {
      const year = start.slice(0, 4);
      const used = await db.leaveRequest.aggregate({ where: { ...others, typeId, startDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }, _sum: { days: true } });
      const left = type.maxDaysPerYear - (used._sum.days ?? 0);
      if (days > left) throw new BadRequestException(`المتبقي من ${type.name} هذا العام ${Math.max(left, 0)} يوم`);
    }

    const split: Split = { days, fullPayDays: days, partialPayDays: 0, partialPayPercent: 0, unpaidDays: 0 };
    if (type.kind === 'ANNUAL') {
      const balance = (await this.core.annualBalance(user.id, start, db))!;
      const mine = excludeId ? await db.leaveRequest.findUnique({ where: { id: excludeId }, select: { status: true, days: true } }) : null;
      const available = balance.available + (mine?.status === 'PENDING' ? mine.days : 0);
      const { annualLeaveMaxNegativeDays } = await this.core.numbers('annualLeaveMaxNegativeDays');
      if (days > available + annualLeaveMaxNegativeDays) throw new BadRequestException(`رصيد الإجازة السنوية المتاح ${Math.max(Math.floor(available * 100) / 100, 0)} يوم`);
    } else if (type.kind === 'SICK') {
      const tiers = await this.core.numbers('sickFullPayDays', 'sickPartialPayDays', 'sickPartialPayPercent', 'sickUnpaidDays');
      // The law counts sick leave within one year, so the year before this leave decides which tier it falls in.
      const prior = await db.leaveRequest.aggregate({
        where: { userId: user.id, status: 'APPROVED', type: { kind: 'SICK' }, startDate: { gte: toDbDate(addDays(start, -365)), lt: toDbDate(start) }, ...(excludeId && { id: { not: excludeId } }) },
        _sum: { days: true },
      });
      const before = prior._sum.days ?? 0;
      const cap = tiers.sickFullPayDays + tiers.sickPartialPayDays + tiers.sickUnpaidDays;
      if (before + days > cap) throw new BadRequestException(`تجاوزت الإجازات المرضية الحد السنوي (${cap} يوم، استُخدم منها ${before})`);
      const full = Math.max(0, Math.min(days, tiers.sickFullPayDays - before));
      const partial = Math.max(0, Math.min(days - full, tiers.sickFullPayDays + tiers.sickPartialPayDays - before - full));
      Object.assign(split, { fullPayDays: full, partialPayDays: partial, partialPayPercent: tiers.sickPartialPayPercent, unpaidDays: days - full - partial });
    } else if (type.kind === 'UNPAID' || !type.paid) {
      Object.assign(split, { fullPayDays: 0, unpaidDays: days });
    }
    return { ...split, type };
  }

  /** What a leave would be before asking for it: its days, how they are paid, the balance and any trips it clashes with. */
  async preview(userId: string, input: LeaveInput) {
    const start = parseDay(input.startDate, 'تاريخ البداية');
    const end = parseDay(input.endDate, 'تاريخ النهاية');
    const user = await this.withProfile(userId);
    const split = await this.evaluate(this.prisma, user, input.typeId, start, end);
    const [balance, trips] = await Promise.all([this.core.annualBalance(userId, start), this.core.crewTripsBetween(userId, start, end)]);
    const { type, ...figures } = split;
    return { ...figures, typeName: type.name, requiresAttachment: type.requiresAttachment, annualBalance: balance, crewTrips: trips };
  }

  private async withProfile(userId: string, db: Tx | HrCoreService['db'] = this.prisma) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, gender: true, role: true, employeeProfile: { select: { hireDate: true, status: true } } } });
    if (!user || user.role === 'PASSENGER') throw new NotFoundException('الموظف غير موجود');
    if (!user.employeeProfile) throw new ConflictException('لم يُنشأ الملف الوظيفي بعد، راجع الموارد البشرية');
    return { ...user, employeeProfile: user.employeeProfile };
  }

  // ---------------------------------------------------------------- requesting

  /** The employee asks; holders of leaves.approve are told. */
  async request(actor: HrActor, input: LeaveInput, files: UploadedInvoice[] = []) {
    const attachments = readInvoiceFiles(files.slice(0, MAX_LEAVE_FILES), actor.userId);
    const start = parseDay(input.startDate, 'تاريخ البداية');
    const end = parseDay(input.endDate, 'تاريخ النهاية');
    const created = await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, actor.userId);
      const user = await this.withProfile(actor.userId, tx);
      if (user.employeeProfile.status !== 'ACTIVE') throw new ConflictException('حسابك الوظيفي موقوف، راجع الموارد البشرية');
      await this.core.assertRangeOpen(start, end, tx);
      const split = await this.evaluate(tx, user, input.typeId, start, end);
      const row = await tx.leaveRequest.create({
        data: { userId: actor.userId, typeId: input.typeId, startDate: toDbDate(start), endDate: toDbDate(end), days: split.days, reason: input.reason?.trim() || null, createdById: actor.userId, createdByName: actor.name ?? null },
        select: { id: true },
      });
      if (attachments.length) await tx.leaveAttachment.createMany({ data: attachments.map((file) => ({ ...file, requestId: row.id })) });
      await this.notifications.toStaff(tx, 'STAFF_LEAVE_REQUESTED', ['leaves.approve'], { employeeName: user.name ?? user.phone, leaveType: split.type.name, leavePeriod: period(start, end), leaveDays: split.days }, { exceptUserId: actor.userId });
      return row;
    }, TX_OPTIONS);
    return this.detail(created.id);
  }

  /** Recorded by the office for an employee, and approved at once by whoever records it. */
  async recordFor(actor: HrActor, userId: string, input: LeaveInput & { crewConflictNote?: string }, files: UploadedInvoice[] = []) {
    this.core.assertNotSelf(actor, userId, 'تسجيل إجازة');
    await this.core.activeEmployee(actor, userId);
    const attachments = readInvoiceFiles(files.slice(0, MAX_LEAVE_FILES), actor.userId);
    const start = parseDay(input.startDate, 'تاريخ البداية');
    const end = parseDay(input.endDate, 'تاريخ النهاية');
    const id = await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, userId);
      const user = await this.withProfile(userId, tx);
      const row = await tx.leaveRequest.create({
        data: { userId, typeId: input.typeId, startDate: toDbDate(start), endDate: toDbDate(end), days: daysBetween(start, end), reason: input.reason?.trim() || null, createdById: actor.userId, createdByName: actor.name ?? null },
        select: { id: true },
      });
      if (attachments.length) await tx.leaveAttachment.createMany({ data: attachments.map((file) => ({ ...file, requestId: row.id })) });
      await this.approveInside(tx, actor, row.id, user, { note: undefined, crewConflictNote: input.crewConflictNote });
      return row.id;
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async addAttachments(actor: HrActor, id: string, files: UploadedInvoice[], own: boolean) {
    if (!files.length) throw new BadRequestException('أرفق ملفًا واحدًا على الأقل');
    const request = await this.prisma.leaveRequest.findUnique({ where: { id }, select: { userId: true, status: true, _count: { select: { attachments: true } } } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (own && request.userId !== actor.userId) throw new NotFoundException('الطلب غير موجود');
    if (!own) await this.core.employee(actor, request.userId);
    if (request.status === 'REJECTED' || request.status === 'CANCELLED') throw new ConflictException('هذا الطلب مغلق');
    if (request._count.attachments + files.length > MAX_LEAVE_FILES) throw new BadRequestException(`لا تتجاوز المرفقات ${MAX_LEAVE_FILES} ملفات`);
    const attachments = readInvoiceFiles(files, actor.userId);
    await this.prisma.leaveAttachment.createMany({ data: attachments.map((file) => ({ ...file, requestId: id })) });
    return this.detail(id);
  }

  // ---------------------------------------------------------------- deciding

  async decide(actor: HrActor, id: string, dto: { decision: 'APPROVE' | 'REJECT'; note?: string; crewConflictNote?: string }) {
    const request = await this.prisma.leaveRequest.findUnique({ where: { id }, select: { userId: true } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    this.core.assertNotSelf(actor, request.userId, 'البت في إجازة');
    await this.core.employee(actor, request.userId);
    if (dto.decision === 'REJECT' && !dto.note?.trim()) throw new BadRequestException('اكتب سبب الرفض ليصل إلى الموظف');

    await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, request.userId);
      const current = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: { type: true } });
      if (current.status !== 'PENDING') throw new ConflictException('تم البت في هذا الطلب أو إلغاؤه');
      if (dto.decision === 'REJECT') {
        await tx.leaveRequest.update({ where: { id }, data: { status: 'REJECTED', reviewedById: actor.userId, reviewedByName: actor.name ?? null, reviewedAt: new Date(), reviewNote: dto.note!.trim() } });
        await this.notifications.toUser(tx, 'LEAVE_REJECTED', current.userId, { leaveType: current.type.name, leavePeriod: period(fromDbDate(current.startDate), fromDbDate(current.endDate)), decisionNote: dto.note!.trim() });
        return;
      }
      const user = await this.withProfile(current.userId, tx);
      await this.approveInside(tx, actor, id, user, dto);
    }, TX_OPTIONS);
    return this.detail(id);
  }

  private async approveInside(tx: Tx, actor: HrActor, id: string, user: Awaited<ReturnType<LeavesService['withProfile']>>, dto: { note?: string; crewConflictNote?: string }) {
    const current = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: { type: true, _count: { select: { attachments: true } } } });
    const start = fromDbDate(current.startDate);
    const end = fromDbDate(current.endDate);
    await this.core.assertRangeOpen(start, end, tx);
    const split = await this.evaluate(tx, user, current.typeId, start, end, id);
    if (current.type.requiresAttachment && current._count.attachments === 0) throw new BadRequestException(`${current.type.name} تحتاج مستندًا مرفقًا قبل الموافقة`);

    const trips = await this.core.crewTripsBetween(current.userId, start, end, tx);
    if (trips.length && !dto.crewConflictNote?.trim()) {
      throw new ConflictException(`الموظف مسند إلى ${trips.map((trip) => trip.tripCode).join('، ')} خلال الإجازة. أسند بديلًا أو اكتب ملاحظة التعارض للموافقة رغم ذلك`);
    }

    await tx.leaveRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        fullPayDays: split.fullPayDays,
        partialPayDays: split.partialPayDays,
        partialPayPercent: split.partialPayPercent,
        unpaidDays: split.unpaidDays,
        crewConflictNote: trips.length ? dto.crewConflictNote!.trim() : null,
        reviewedById: actor.userId,
        reviewedByName: actor.name ?? null,
        reviewedAt: new Date(),
        reviewNote: dto.note?.trim() || null,
      },
    });
    await this.core.markRangeStale(start, end, tx);
    await this.notifications.toUser(tx, 'LEAVE_APPROVED', current.userId, { leaveType: current.type.name, leavePeriod: period(start, end), leaveDays: split.days, decisionNote: dto.note?.trim() ?? '' });
  }

  // ---------------------------------------------------------------- changing

  /** The employee takes back a request nobody has decided yet. */
  async withdraw(actor: HrActor, id: string) {
    const { count } = await this.prisma.leaveRequest.updateMany({
      where: { id, userId: actor.userId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name ?? null, cancelReason: 'سحبه الموظف' },
    });
    if (!count) throw new NotFoundException('لا يوجد طلب قائم لسحبه');
    return this.detail(id);
  }

  /** A leave that has not started yet; one already running is ended with a return instead. */
  async cancel(actor: HrActor, id: string, reason: string) {
    const request = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { type: true } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    await this.core.employee(actor, request.userId);
    if (!reason?.trim()) throw new BadRequestException('اكتب سبب الإلغاء');
    const start = fromDbDate(request.startDate);
    const end = fromDbDate(request.endDate);
    if (request.status === 'APPROVED' && start <= today()) throw new ConflictException('بدأت الإجازة، سجّل عودة الموظف بدلًا من إلغائها');
    if (request.status !== 'APPROVED' && request.status !== 'PENDING') throw new ConflictException('هذا الطلب مغلق');

    await this.prisma.$transaction(async (tx) => {
      if (request.status === 'APPROVED') await this.core.assertRangeOpen(start, end, tx);
      const { count } = await tx.leaveRequest.updateMany({
        where: { id, status: request.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name ?? null, cancelReason: reason.trim() },
      });
      if (!count) throw new ConflictException('تغيّر الطلب للتو، حدّث الصفحة');
      if (request.status === 'APPROVED') {
        await this.core.markRangeStale(start, end, tx);
        await this.notifications.toUser(tx, 'LEAVE_CHANGED', request.userId, { leaveType: request.type.name, leavePeriod: 'ملغاة', decisionNote: reason.trim() });
      }
    }, TX_OPTIONS);
    return this.detail(id);
  }

  /** The employee came back early: the leave ends the day before, and the days after return to the balance. */
  async returnEarly(actor: HrActor, id: string, returnDate: string) {
    const back = parseDay(returnDate, 'تاريخ العودة');
    const request = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { type: true } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    await this.core.employee(actor, request.userId);
    if (request.status !== 'APPROVED') throw new ConflictException('تُسجّل العودة على إجازة معتمدة فقط');
    const start = fromDbDate(request.startDate);
    const end = fromDbDate(request.endDate);
    const newEnd = addDays(back, -1);
    if (newEnd < start) throw new BadRequestException('العودة قبل بدء الإجازة، ألغِ الإجازة بدلًا من ذلك');
    if (newEnd >= end) throw new BadRequestException(`الإجازة تنتهي أصلًا يوم ${end}`);

    const days = daysBetween(start, newEnd);
    // The days kept are the first ones, so they keep the pay they had; the cut comes off the end.
    const full = Math.min(request.fullPayDays, days);
    const partial = Math.min(request.partialPayDays, days - full);
    await this.prisma.$transaction(async (tx) => {
      await this.core.assertRangeOpen(back, end, tx);
      await tx.leaveRequest.update({
        where: { id },
        data: { endDate: toDbDate(newEnd), plannedEndDate: request.plannedEndDate ?? request.endDate, days, fullPayDays: full, partialPayDays: partial, unpaidDays: days - full - partial },
      });
      await this.core.markRangeStale(back, end, tx);
      await this.notifications.toUser(tx, 'LEAVE_CHANGED', request.userId, { leaveType: request.type.name, leavePeriod: period(start, newEnd), decisionNote: `سُجّلت عودتك يوم ${back}` });
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async adjustBalance(actor: HrActor, dto: { userId: string; typeId: string; days: number; reason: string }) {
    this.core.assertNotSelf(actor, dto.userId, 'تعديل رصيد إجازات');
    await this.core.activeEmployee(actor, dto.userId);
    if (!dto.days) throw new BadRequestException('حدد عدد الأيام');
    const type = await this.prisma.leaveType.findUnique({ where: { id: dto.typeId } });
    if (type?.kind !== 'ANNUAL') throw new BadRequestException('يُعدَّل رصيد الإجازة السنوية فقط، بقية الأنواع حدودها من إعداداتها');
    await this.prisma.leaveAdjustment.create({ data: { userId: dto.userId, typeId: dto.typeId, days: dto.days, reason: dto.reason.trim(), createdById: actor.userId, createdByName: actor.name ?? null } });
    return this.core.annualBalance(dto.userId);
  }

  // ---------------------------------------------------------------- reading

  async detail(id: string) {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, select: REQUEST_SELECT });
    if (!row) throw new NotFoundException('الطلب غير موجود');
    return out(row);
  }

  async list(actor: HrActor, query: { status?: LeaveStatus; userId?: string; from?: string; to?: string; typeId?: string }) {
    const from = query.from ? parseDay(query.from) : null;
    const to = query.to ? parseDay(query.to) : null;
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        user: await this.core.scopeWhere(actor),
        ...(query.status && { status: query.status }),
        ...(query.userId && { userId: query.userId }),
        ...(query.typeId && { typeId: query.typeId }),
        ...(to && { startDate: { lte: toDbDate(to) } }),
        ...(from && { endDate: { gte: toDbDate(from) } }),
      },
      orderBy: query.status === 'PENDING' ? { startDate: 'asc' } : { createdAt: 'desc' },
      take: 300,
      select: REQUEST_SELECT,
    });
    return rows.map(out);
  }

  async pendingCount(actor: HrActor) {
    return this.prisma.leaveRequest.count({ where: { status: 'PENDING', user: await this.core.scopeWhere(actor) } });
  }

  /** Who is away today, for the office's overview. */
  async awayToday(actor: HrActor) {
    const day = toDbDate(today());
    const rows = await this.prisma.leaveRequest.findMany({
      where: { status: 'APPROVED', startDate: { lte: day }, endDate: { gte: day }, user: await this.core.scopeWhere(actor) },
      select: REQUEST_SELECT,
      orderBy: { endDate: 'asc' },
    });
    return rows.map(out);
  }

  async balancesOf(userId: string) {
    const [annual, types, used] = await Promise.all([
      this.core.annualBalance(userId),
      this.types(),
      this.prisma.leaveRequest.groupBy({
        by: ['typeId'],
        where: { userId, status: 'APPROVED', startDate: { gte: toDbDate(`${today().slice(0, 4)}-01-01`) } },
        _sum: { days: true },
      }),
    ]);
    const usedOf = new Map(used.map((row) => [row.typeId, row._sum.days ?? 0]));
    return {
      annual,
      types: types.map((type) => ({ id: type.id, name: type.name, kind: type.kind, maxDaysPerYear: type.maxDaysPerYear, usedThisYear: usedOf.get(type.id) ?? 0 })),
    };
  }

  async mine(userId: string) {
    const rows = await this.prisma.leaveRequest.findMany({ where: { userId }, orderBy: { startDate: 'desc' }, take: 50, select: REQUEST_SELECT });
    return rows.map(out);
  }

  async attachment(actor: HrActor, attachmentId: string, own: boolean) {
    const file = await this.prisma.leaveAttachment.findUnique({ where: { id: attachmentId }, include: { request: { select: { userId: true } } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    if (own) {
      if (file.request.userId !== actor.userId) throw new NotFoundException('الملف غير موجود');
    } else {
      await this.core.employee(actor, file.request.userId);
    }
    return file;
  }

  /** Approved leave of these people that touches the window, for the trip screens. */
  onLeaveBetween(userIds: string[], start: Date, end: Date) {
    if (!userIds.length) return Promise.resolve([]);
    return this.prisma.leaveRequest.findMany({
      where: { userId: { in: userIds }, status: 'APPROVED', startDate: { lte: end }, endDate: { gte: new Date(start.getTime() - 86_400_000) } },
      select: { userId: true, startDate: true, endDate: true, user: { select: { name: true } } },
    });
  }
}

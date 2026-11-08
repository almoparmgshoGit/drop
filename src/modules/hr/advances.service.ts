import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AdvanceStatus, Prisma, SalaryPaymentMethod } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { CashService } from '../cash/cash.service';
import { HrActor, HrCoreService, TX_OPTIONS } from './hr-core.service';
import { addMonths, advanceCode, currentMonth, formatRiyals, fromDbDate, halalas, Month, nextMonth, parseMonth, riyals, serviceMonths, today, wageTotal } from './hr.util';

type Tx = Prisma.TransactionClient;
const OPEN_STATUSES: AdvanceStatus[] = ['PENDING', 'APPROVED', 'DISBURSED'];

export interface AdvanceInput {
  amount: number;
  installments: number;
  firstMonth?: string;
  reason: string;
}

const ADVANCE_SELECT = {
  id: true,
  number: true,
  userId: true,
  amount: true,
  installments: true,
  installmentAmount: true,
  firstMonth: true,
  skippedMonths: true,
  reason: true,
  status: true,
  createdByName: true,
  createdAt: true,
  reviewedByName: true,
  reviewedAt: true,
  reviewNote: true,
  disbursedAt: true,
  disbursedByName: true,
  disbursedMethod: true,
  bankReference: true,
  settledAt: true,
  user: { select: { id: true, name: true, phone: true, branch: { select: { name: true } }, rank: { select: { name: true } } } },
  repayments: { select: { id: true, amount: true, source: true, payrollRunId: true, createdByName: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SalaryAdvanceSelect;

type AdvanceRow = Prisma.SalaryAdvanceGetPayload<{ select: typeof ADVANCE_SELECT }>;

/** What is left, and the months still to come at one installment each, skipped months moving the schedule on. */
export function advanceSchedule(advance: { amount: Prisma.Decimal; installmentAmount: Prisma.Decimal; firstMonth: string; skippedMonths: string[]; repayments: { amount: Prisma.Decimal }[] }) {
  const repaid = advance.repayments.reduce((sum, row) => sum + halalas(row.amount), 0);
  const remaining = Math.max(halalas(advance.amount) - repaid, 0);
  const installment = halalas(advance.installmentAmount);
  const upcoming: { month: Month; amount: number }[] = [];
  let left = remaining;
  let month = advance.firstMonth > currentMonth() ? advance.firstMonth : currentMonth();
  while (left > 0 && upcoming.length < 120) {
    if (!advance.skippedMonths.includes(month)) {
      const amount = Math.min(installment, left);
      upcoming.push({ month, amount: riyals(amount) });
      left -= amount;
    }
    month = nextMonth(month);
  }
  return { repaid: riyals(repaid), remaining: riyals(remaining), upcoming };
}

/** The installment a payroll of this month takes, before any cap; null when this month takes none. */
export function installmentDue(advance: { status: AdvanceStatus; installmentAmount: Prisma.Decimal; firstMonth: string; skippedMonths: string[] }, remaining: number, month: Month) {
  if (advance.status !== 'DISBURSED' || remaining <= 0) return null;
  if (month < advance.firstMonth || advance.skippedMonths.includes(month)) return null;
  return Math.min(halalas(advance.installmentAmount), remaining);
}

const out = (row: AdvanceRow) => ({
  ...row,
  code: advanceCode(row.number),
  amount: Number(row.amount),
  installmentAmount: Number(row.installmentAmount),
  repayments: row.repayments.map((repayment) => ({ ...repayment, amount: Number(repayment.amount) })),
  ...advanceSchedule(row),
});

const installmentText = (row: { installments: number; installmentAmount: number | Prisma.Decimal; firstMonth: string }) =>
  `${row.installments} ${row.installments > 2 && row.installments < 11 ? 'أقساط' : 'قسطًا'} شهرية بمبلغ ${formatRiyals(halalas(row.installmentAmount))} تبدأ من ${row.firstMonth}`;

@Injectable()
export class AdvancesService {
  constructor(
    private core: HrCoreService,
    private cash: CashService,
    private notifications: NotificationsService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  /** Every rule an advance has to meet, checked again when it is approved because the salary may have changed. */
  private async check(db: Tx, userId: string, input: AdvanceInput, excludeId?: string) {
    const profile = await db.employeeProfile.findUnique({ where: { userId } });
    if (!profile) throw new ConflictException('لم يُنشأ الملف الوظيفي بعد، راجع الموارد البشرية');
    if (profile.status !== 'ACTIVE') throw new ConflictException('لا تُصرف سلفة لموظف موقوف أو منتهية خدمته');
    const rules = await this.core.numbers('advanceMaxSalaryMonths', 'advanceMaxInstallments', 'advanceMinServiceMonths', 'advanceMaxInstallmentPercent');

    if (serviceMonths(fromDbDate(profile.hireDate), today()) < rules.advanceMinServiceMonths) {
      throw new ConflictException(`تُستحق السلفة بعد ${rules.advanceMinServiceMonths} أشهر من الخدمة`);
    }
    const open = await db.salaryAdvance.findFirst({ where: { userId, status: { in: OPEN_STATUSES }, ...(excludeId && { id: { not: excludeId } }) }, select: { number: true } });
    if (open) throw new ConflictException(`لدى الموظف سلفة قائمة (${advanceCode(open.number)})، تُسدد أولًا`);

    const wage = await this.core.wageOn(userId, today(), db);
    if (!wage) throw new ConflictException('لم يُسجل راتب للموظف بعد');
    const amount = halalas(input.amount);
    const installments = Math.trunc(input.installments);
    if (amount <= 0) throw new BadRequestException('حدد مبلغ السلفة');
    if (installments < 1 || installments > rules.advanceMaxInstallments) throw new BadRequestException(`عدد الأقساط من 1 إلى ${rules.advanceMaxInstallments}`);
    const maxAmount = Math.round(wage.basic * rules.advanceMaxSalaryMonths);
    if (amount > maxAmount) throw new BadRequestException(`أعلى سلفة مسموحة ${formatRiyals(maxAmount)} (${rules.advanceMaxSalaryMonths} من الراتب الأساسي)`);
    const installmentAmount = Math.ceil(amount / installments);
    const maxInstallment = Math.floor((wageTotal(wage) * rules.advanceMaxInstallmentPercent) / 100);
    if (installmentAmount > maxInstallment) {
      const needed = Math.ceil(amount / Math.max(maxInstallment, 1));
      throw new BadRequestException(`القسط ${formatRiyals(installmentAmount)} يتجاوز ${rules.advanceMaxInstallmentPercent}% من الأجر (${formatRiyals(maxInstallment)}). زِد الأقساط إلى ${needed} على الأقل أو قلّل المبلغ`);
    }
    const firstMonth = input.firstMonth ? parseMonth(input.firstMonth, 'شهر أول قسط') : nextMonth(currentMonth());
    if (firstMonth < currentMonth()) throw new BadRequestException('شهر أول قسط لا يكون في الماضي');
    if (firstMonth > addMonths(currentMonth(), 6)) throw new BadRequestException('يبدأ السداد خلال ستة أشهر على الأكثر');
    await this.core.assertMonthsOpen([firstMonth], db);
    return { amount: riyals(amount), installments, installmentAmount: riyals(installmentAmount), firstMonth };
  }

  // ---------------------------------------------------------------- requesting

  async request(actor: HrActor, input: AdvanceInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, actor.userId);
      const terms = await this.check(tx, actor.userId, input);
      const me = await tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, phone: true } });
      const row = await tx.salaryAdvance.create({ data: { userId: actor.userId, ...terms, reason: input.reason.trim(), createdById: actor.userId, createdByName: actor.name ?? null }, select: { id: true } });
      await this.notifications.toStaff(tx, 'STAFF_ADVANCE_REQUESTED', ['advances.approve'], { employeeName: me.name ?? me.phone, amount: formatRiyals(halalas(terms.amount)), installmentText: installmentText(terms) }, { exceptUserId: actor.userId });
      return row.id;
    }, TX_OPTIONS);
    return this.detail(id);
  }

  /** Recorded by the office for an employee, and approved by whoever records it. */
  async recordFor(actor: HrActor, userId: string, input: AdvanceInput) {
    this.core.assertNotSelf(actor, userId, 'تسجيل سلفة');
    await this.core.activeEmployee(actor, userId);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, userId);
      const terms = await this.check(tx, userId, input);
      const row = await tx.salaryAdvance.create({
        data: { userId, ...terms, reason: input.reason.trim(), status: 'APPROVED', createdById: actor.userId, createdByName: actor.name ?? null, reviewedById: actor.userId, reviewedByName: actor.name ?? null, reviewedAt: new Date() },
        select: { id: true, number: true },
      });
      await this.notifications.toUser(tx, 'ADVANCE_APPROVED', userId, { advanceNumber: advanceCode(row.number), amount: formatRiyals(halalas(terms.amount)), installmentText: installmentText(terms), decisionNote: '' });
      return row.id;
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async withdraw(actor: HrActor, id: string) {
    const { count } = await this.prisma.salaryAdvance.updateMany({ where: { id, userId: actor.userId, status: 'PENDING' }, data: { status: 'CANCELLED', reviewNote: 'سحبه الموظف' } });
    if (!count) throw new NotFoundException('لا يوجد طلب قائم لسحبه');
    return this.detail(id);
  }

  // ---------------------------------------------------------------- deciding

  async decide(actor: HrActor, id: string, dto: { decision: 'APPROVE' | 'REJECT'; note?: string; installments?: number; firstMonth?: string }) {
    const advance = await this.prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('الطلب غير موجود');
    this.core.assertNotSelf(actor, advance.userId, 'البت في سلفة');
    await this.core.employee(actor, advance.userId);
    if (dto.decision === 'REJECT' && !dto.note?.trim()) throw new BadRequestException('اكتب سبب الرفض ليصل إلى الموظف');

    await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, advance.userId);
      const current = await tx.salaryAdvance.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'PENDING') throw new ConflictException('تم البت في هذا الطلب أو سحبه');
      const review = { reviewedById: actor.userId, reviewedByName: actor.name ?? null, reviewedAt: new Date(), reviewNote: dto.note?.trim() || null };
      if (dto.decision === 'REJECT') {
        await tx.salaryAdvance.update({ where: { id }, data: { status: 'REJECTED', ...review } });
        await this.notifications.toUser(tx, 'ADVANCE_REJECTED', current.userId, { amount: formatRiyals(halalas(current.amount)), decisionNote: dto.note!.trim() });
        return;
      }
      // The approver may spread it differently from what was asked; the rules are checked on what is approved.
      const terms = await this.check(tx, current.userId, { amount: Number(current.amount), installments: dto.installments ?? current.installments, firstMonth: dto.firstMonth ?? current.firstMonth, reason: current.reason }, id);
      await tx.salaryAdvance.update({ where: { id }, data: { status: 'APPROVED', ...terms, ...review } });
      await this.notifications.toUser(tx, 'ADVANCE_APPROVED', current.userId, { advanceNumber: advanceCode(current.number), amount: formatRiyals(halalas(terms.amount)), installmentText: installmentText(terms), decisionNote: dto.note?.trim() ?? '' });
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async cancel(actor: HrActor, id: string, reason: string) {
    const advance = await this.prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('السلفة غير موجودة');
    await this.core.employee(actor, advance.userId);
    if (!reason?.trim()) throw new BadRequestException('اكتب سبب الإلغاء');
    const { count } = await this.prisma.salaryAdvance.updateMany({ where: { id, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED', reviewNote: reason.trim() } });
    if (!count) throw new ConflictException('لا تُلغى إلا سلفة لم تُصرف بعد');
    return this.detail(id);
  }

  // ---------------------------------------------------------------- money

  async disburse(actor: HrActor, id: string, dto: { method: SalaryPaymentMethod; branchId?: string; bankReference?: string }) {
    const advance = await this.prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('السلفة غير موجودة');
    this.core.assertNotSelf(actor, advance.userId, 'صرف سلفة');
    await this.core.employee(actor, advance.userId);
    if (dto.method === 'CASH' && !dto.branchId) throw new BadRequestException('اختر الفرع الذي يُصرف من صندوقه');
    if (dto.method === 'BANK' && !dto.bankReference?.trim()) throw new BadRequestException('اكتب مرجع التحويل البنكي');

    await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, advance.userId);
      const current = await tx.salaryAdvance.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'APPROVED') throw new ConflictException('تُصرف السلفة بعد الموافقة عليها ومرة واحدة فقط');
      // The schedule may have been set months ago; the first installment never lands in a closed month.
      let firstMonth = current.firstMonth;
      while (await tx.payrollRun.findFirst({ where: { month: firstMonth, status: { not: 'DRAFT' } }, select: { id: true } })) firstMonth = nextMonth(firstMonth);
      if (dto.method === 'CASH') await this.cash.hrMovement(tx, actor, dto.branchId!, 'ADVANCE_ISSUE', Number(current.amount), { advanceId: id, employeeId: current.userId });
      await tx.salaryAdvance.update({
        where: { id },
        data: { status: 'DISBURSED', firstMonth, disbursedAt: new Date(), disbursedByName: actor.name ?? null, disbursedMethod: dto.method, bankReference: dto.bankReference?.trim() || null },
      });
      await this.core.markStaleFrom(firstMonth, tx);
      await this.notifications.toUser(tx, 'ADVANCE_DISBURSED', current.userId, { advanceNumber: advanceCode(current.number), amount: formatRiyals(halalas(current.amount)), installmentText: installmentText({ ...current, firstMonth }) });
    }, TX_OPTIONS);
    return this.detail(id);
  }

  /** The employee is allowed to skip one month's installment; the schedule moves on by a month. */
  async skipMonth(actor: HrActor, id: string, month: string) {
    const target = parseMonth(month);
    const advance = await this.prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('السلفة غير موجودة');
    this.core.assertNotSelf(actor, advance.userId, 'تأجيل قسط');
    await this.core.employee(actor, advance.userId);
    if (advance.status !== 'DISBURSED') throw new ConflictException('يُؤجل القسط على سلفة مصروفة لم تُسدد');
    if (target < currentMonth() || target < advance.firstMonth) throw new BadRequestException('اختر شهرًا قادمًا من أشهر السداد');
    if (advance.skippedMonths.includes(target)) throw new ConflictException('هذا الشهر مؤجل مسبقًا');
    await this.prisma.$transaction(async (tx) => {
      await this.core.assertMonthsOpen([target], tx);
      await tx.salaryAdvance.update({ where: { id }, data: { skippedMonths: { push: target } } });
      await this.core.markStale([target], tx);
    });
    return this.detail(id);
  }

  /** Cash the employee brings back into a drawer to pay off what is left, in part or in full. */
  async repayCash(actor: HrActor, id: string, dto: { amount: number; branchId: string }) {
    const advance = await this.prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('السلفة غير موجودة');
    this.core.assertNotSelf(actor, advance.userId, 'استلام سداد سلفة');
    await this.core.employee(actor, advance.userId);
    await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, advance.userId);
      const current = await tx.salaryAdvance.findUniqueOrThrow({ where: { id }, include: { repayments: true } });
      if (current.status !== 'DISBURSED') throw new ConflictException('هذه السلفة غير قائمة');
      const { remaining } = advanceSchedule(current);
      const amount = halalas(dto.amount);
      if (amount <= 0) throw new BadRequestException('حدد المبلغ');
      if (amount > halalas(remaining)) throw new BadRequestException(`المتبقي من السلفة ${formatRiyals(halalas(remaining))}`);
      await this.cash.hrMovement(tx, actor, dto.branchId, 'ADVANCE_REPAYMENT', riyals(amount), { advanceId: id, employeeId: current.userId });
      await tx.advanceRepayment.create({ data: { advanceId: id, amount: riyals(amount), source: 'CASH', createdById: actor.userId, createdByName: actor.name ?? null } });
      if (amount === halalas(remaining)) await tx.salaryAdvance.update({ where: { id }, data: { status: 'SETTLED', settledAt: new Date() } });
      await this.core.markStaleFrom(currentMonth(), tx);
    }, TX_OPTIONS);
    return this.detail(id);
  }

  // ---------------------------------------------------------------- reading

  async detail(id: string) {
    const row = await this.prisma.salaryAdvance.findUnique({ where: { id }, select: ADVANCE_SELECT });
    if (!row) throw new NotFoundException('السلفة غير موجودة');
    return out(row);
  }

  async detailFor(actor: HrActor, id: string) {
    const row = await this.detail(id);
    await this.core.employee(actor, row.userId);
    return row;
  }

  async list(actor: HrActor, query: { status?: AdvanceStatus; userId?: string }) {
    const rows = await this.prisma.salaryAdvance.findMany({
      where: { user: await this.core.scopeWhere(actor), ...(query.status && { status: query.status }), ...(query.userId && { userId: query.userId }) },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: ADVANCE_SELECT,
    });
    return rows.map(out);
  }

  async pendingCount(actor: HrActor) {
    return this.prisma.salaryAdvance.count({ where: { status: { in: ['PENDING', 'APPROVED'] }, user: await this.core.scopeWhere(actor) } });
  }

  async mine(userId: string) {
    const rows = await this.prisma.salaryAdvance.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30, select: ADVANCE_SELECT });
    return rows.map(out);
  }

  /** What the employee may ask for right now, so the app can show the limits before they fill the form. */
  async limitsFor(userId: string) {
    const [wage, rules, open] = await Promise.all([
      this.core.wageOn(userId, today()),
      this.core.numbers('advanceMaxSalaryMonths', 'advanceMaxInstallments', 'advanceMaxInstallmentPercent', 'advanceMinServiceMonths'),
      this.prisma.salaryAdvance.findFirst({ where: { userId, status: { in: OPEN_STATUSES } }, select: { number: true } }),
    ]);
    if (!wage) return { available: false, reason: 'لم يُسجل راتبك بعد' };
    if (open) return { available: false, reason: `لديك سلفة قائمة (${advanceCode(open.number)})` };
    return {
      available: true,
      maxAmount: riyals(Math.round(wage.basic * rules.advanceMaxSalaryMonths)),
      maxInstallments: rules.advanceMaxInstallments,
      maxInstallment: riyals(Math.floor((wageTotal(wage) * rules.advanceMaxInstallmentPercent) / 100)),
      minServiceMonths: rules.advanceMinServiceMonths,
    };
  }

  assertOwnerOf(actor: HrActor, row: { userId: string }) {
    if (row.userId !== actor.userId) throw new ForbiddenException();
  }
}

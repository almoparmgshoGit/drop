import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SalaryPaymentMethod, TerminationReason } from '@prisma/client';
import { RealtimeService } from '../../common/services/realtime.service';
import { CashService, custodyCode } from '../cash/cash.service';
import { adjustmentProgress } from './adjustments.service';
import { advanceSchedule } from './advances.service';
import { Db, HrActor, HrCoreService, riyadhInstant, TX_OPTIONS } from './hr-core.service';
import {
  ADJUSTMENT_LABELS,
  addDays,
  addMonths,
  advanceCode,
  daysBetween,
  endOfServiceAward,
  fromDbDate,
  halalas,
  monthOf,
  monthsFrom,
  nextMonth,
  parseDay,
  riyals,
  settlementCode,
  TERMINATION_LABELS,
  toDbDate,
  today,
  wageTotal,
} from './hr.util';
import { PayrollService } from './payroll.service';

type Tx = Prisma.TransactionClient;

export interface SettlementInput {
  terminationDate: string;
  reason: TerminationReason;
  fullAwardOverride?: boolean;
  note?: string;
}

@Injectable()
export class SettlementsService {
  constructor(
    private core: HrCoreService,
    private payroll: PayrollService,
    private cash: CashService,
    private realtime: RealtimeService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  /**
   * Everything owed both ways on the last day: salary since the last approved payroll, the end-of-service award,
   * unused annual leave, pending additions; less social insurance, what is left of advances, pending deductions
   * and anything a payroll already paid beyond the last day. Final dues are not held to the monthly cap.
   */
  async compute(db: Db, userId: string, input: SettlementInput) {
    const end = parseDay(input.terminationDate, 'تاريخ انتهاء الخدمة');
    const profile = await db.employeeProfile.findUnique({ where: { userId }, include: { user: { select: { rank: { select: { tripAllowance: true } } } } } });
    if (!profile) throw new ConflictException('لم يُنشأ الملف الوظيفي بعد');
    const hire = fromDbDate(profile.hireDate);
    if (end < hire) throw new BadRequestException('تاريخ انتهاء الخدمة قبل تاريخ التعيين');
    if (monthOf(end) > addMonths(monthOf(today()), 3)) throw new BadRequestException('تاريخ انتهاء الخدمة بعيد جدًا، أعدّ المخالصة قرب موعدها');
    const wage = await this.core.wageOn(userId, end, db);
    if (!wage) throw new ConflictException('لم يُسجل راتب للموظف');
    const monthlyWage = wageTotal(wage);

    const serviceDays = daysBetween(hire, end);
    const award = endOfServiceAward(monthlyWage, serviceDays, input.reason, !!input.fullAwardOverride);

    const leave = (await this.core.annualBalance(userId, end, db))!;
    const leaveDays = leave.balance;
    const leaveEncashment = Math.round((leaveDays * monthlyWage) / 30);

    // Salary for the months no approved payroll paid, up to the last day.
    const lastPaid = await this.payroll.lastPaidMonth(db, userId);
    const firstUnpaid = lastPaid ? nextMonth(lastPaid) : monthOf(hire);
    const salaryMonths: { month: string; workedDays: number; earnings: number; leaveDeduction: number; gosi: number; tripCount: number; tripAllowance: number }[] = [];
    if (firstUnpaid <= monthOf(end)) {
      for (const month of monthsFrom(firstUnpaid, monthOf(end))) {
        const pay = await this.payroll.earnings(db, userId, month, end);
        if (!pay) continue;
        const trips = await this.payroll.tripAllowanceFor(db, userId, profile.user.rank?.tripAllowance, pay.from, pay.to);
        salaryMonths.push({
          month,
          workedDays: pay.workedDays,
          earnings: pay.basic + pay.housing + pay.transport + pay.other + trips.amount,
          leaveDeduction: pay.leaveDeduction,
          gosi: pay.gosiEmployee,
          tripCount: trips.count,
          tripAllowance: trips.amount,
        });
      }
    }

    // A payroll approved for days after the last one paid for days not worked.
    let overpaid = 0;
    for (const line of await this.payroll.approvedLinesFrom(db, userId, monthOf(end))) {
      const actual = line.run.month === monthOf(end) ? await this.payroll.earnings(db, userId, line.run.month, end) : null;
      const earned = actual ? actual.basic + actual.housing + actual.transport + actual.other - actual.leaveDeduction : 0;
      const paid = halalas(line.basic) + halalas(line.housing) + halalas(line.transport) + halalas(line.other) - halalas(line.leaveDeduction);
      overpaid += Math.max(paid - earned, 0);
    }

    const adjustments = await db.payrollAdjustment.findMany({
      where: { userId, status: 'PENDING' },
      include: { items: { where: { line: { run: { status: { not: 'DRAFT' } } } }, select: { amount: true } } },
    });
    const pending = adjustments.map((row) => {
      const remaining = row.category === 'ABSENCE' && row.amount === null ? Math.round((Number(row.days) * monthlyWage) / 30) : adjustmentProgress(row).remaining ?? 0;
      return { id: row.id, kind: row.kind, label: `${ADJUSTMENT_LABELS[row.category]}: ${row.reason}`, amount: remaining };
    });
    const additions = pending.filter((row) => row.kind === 'EARNING').reduce((sum, row) => sum + row.amount, 0);
    const pendingDeductions = pending.filter((row) => row.kind === 'DEDUCTION').reduce((sum, row) => sum + row.amount, 0);

    const advances = await db.salaryAdvance.findMany({ where: { userId, status: 'DISBURSED' }, include: { repayments: { select: { amount: true } } } });
    const advanceRows = advances.map((advance) => ({ id: advance.id, code: advanceCode(advance.number), remaining: halalas(advanceSchedule(advance).remaining) })).filter((row) => row.remaining > 0);
    const advanceBalance = advanceRows.reduce((sum, row) => sum + row.remaining, 0);

    const salaryEarnings = salaryMonths.reduce((sum, row) => sum + row.earnings, 0);
    const salaryLeave = salaryMonths.reduce((sum, row) => sum + row.leaveDeduction, 0);
    const gosi = salaryMonths.reduce((sum, row) => sum + row.gosi, 0);
    const salaryDue = salaryEarnings - salaryLeave;
    const salaryDays = salaryMonths.reduce((sum, row) => sum + row.workedDays, 0);

    const totalDue = Math.max(salaryDue, 0) + award.award + Math.max(leaveEncashment, 0) + additions;
    const totalDeductions = gosi + advanceBalance + pendingDeductions + overpaid + Math.max(-leaveEncashment, 0);

    return {
      serviceDays,
      monthlyWage: riyals(monthlyWage),
      awardShare: Math.round(award.share * 10_000) / 10_000,
      eosAward: riyals(award.award),
      leaveDays,
      leaveEncashment: riyals(leaveEncashment),
      salaryDays,
      salaryDue: riyals(salaryDue),
      additions: riyals(additions),
      advanceBalance: riyals(advanceBalance),
      pendingDeductions: riyals(pendingDeductions),
      totalDue: riyals(totalDue),
      totalDeductions: riyals(totalDeductions),
      net: riyals(totalDue - totalDeductions),
      details: {
        serviceYears: Math.round(award.years * 100) / 100,
        reasonLabel: TERMINATION_LABELS[input.reason],
        fullAward: riyals(award.full),
        leave: { earned: leave.earned, adjustments: leave.adjustments, taken: leave.taken },
        salaryMonths: salaryMonths.map((row) => ({ ...row, earnings: riyals(row.earnings), leaveDeduction: riyals(row.leaveDeduction), gosi: riyals(row.gosi), tripAllowance: riyals(row.tripAllowance) })),
        gosi: riyals(gosi),
        overpaid: riyals(overpaid),
        adjustments: pending.map((row) => ({ ...row, amount: riyals(row.amount) })),
        advances: advanceRows.map((row) => ({ ...row, remaining: riyals(row.remaining) })),
      } as Prisma.InputJsonObject,
    };
  }

  async create(actor: HrActor, userId: string, input: SettlementInput) {
    this.core.assertNotSelf(actor, userId, 'إعداد مخالصة');
    await this.core.activeEmployee(actor, userId);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, userId);
      const open = await tx.finalSettlement.findFirst({ where: { userId, status: { in: ['DRAFT', 'APPROVED'] } }, select: { number: true } });
      if (open) throw new ConflictException(`توجد مخالصة قائمة لهذا الموظف (${settlementCode(open.number)})`);
      const figures = await this.compute(tx, userId, input);
      const row = await tx.finalSettlement.create({
        data: { userId, terminationDate: toDbDate(input.terminationDate), reason: input.reason, fullAwardOverride: !!input.fullAwardOverride, note: input.note?.trim() || null, ...figures, createdById: actor.userId, createdByName: actor.name ?? null },
        select: { id: true },
      });
      return row.id;
    }, TX_OPTIONS);
    return this.detail(id);
  }

  /** Works a draft out again, with new terms or with what changed since. */
  async update(actor: HrActor, id: string, input: SettlementInput) {
    const current = await this.prisma.finalSettlement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('المخالصة غير موجودة');
    await this.core.employee(actor, current.userId);
    if (current.status !== 'DRAFT') throw new ConflictException('المخالصة معتمدة ولا تُعدّل');
    await this.prisma.$transaction(async (tx) => {
      const figures = await this.compute(tx, current.userId, input);
      await tx.finalSettlement.update({ where: { id }, data: { terminationDate: toDbDate(input.terminationDate), reason: input.reason, fullAwardOverride: !!input.fullAwardOverride, note: input.note?.trim() || null, ...figures } });
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async remove(actor: HrActor, id: string) {
    const current = await this.prisma.finalSettlement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('المخالصة غير موجودة');
    await this.core.employee(actor, current.userId);
    if (current.status !== 'DRAFT') throw new ConflictException('المخالصة المعتمدة لا تُحذف');
    await this.prisma.finalSettlement.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Ends the employment on these figures. Works them out once more first and refuses if anything moved since the
   * draft was read, then closes advances and adjustments, ends the account's access and frees the branch.
   */
  async approve(actor: HrActor, id: string) {
    const current = await this.prisma.finalSettlement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('المخالصة غير موجودة');
    await this.core.employee(actor, current.userId);
    this.core.assertNotSelf(actor, current.userId, 'اعتماد مخالصة');
    if (current.createdById === actor.userId && actor.role !== 'ADMIN') throw new ForbiddenException('من أعدّ المخالصة لا يعتمدها، يعتمدها موظف آخر');
    const end = fromDbDate(current.terminationDate);
    if (current.status !== 'DRAFT') throw new ConflictException('المخالصة معتمدة مسبقًا');

    const custodies = await this.prisma.custody.findMany({ where: { recipientId: current.userId, status: 'OPEN' }, select: { number: true } });
    if (custodies.length) throw new ConflictException(`على الموظف عهد مفتوحة (${custodies.map((custody) => custodyCode(custody.number)).join('، ')})، سوّها أولًا`);
    const dayAfter = riyadhInstant(addDays(end, 1));
    const later = (await this.core.crewTripsBetween(current.userId, end, '2999-12-31')).filter((trip) => trip.departureTime >= dayAfter);
    if (later.length) throw new ConflictException(`الموظف مسند إلى رحلات بعد آخر يوم عمل (${later.map((trip) => trip.tripCode).join('، ')})، أسند بديلًا أولًا`);
    const leaveAfter = await this.prisma.leaveRequest.findFirst({ where: { userId: current.userId, status: 'APPROVED', endDate: { gt: toDbDate(end) } }, select: { number: true } });
    if (leaveAfter) throw new ConflictException('للموظف إجازة معتمدة تمتد بعد آخر يوم عمل، سجّل عودته أو ألغها أولًا');

    // Saved outside the approval, so the refreshed draft survives the refusal and the next look shows it.
    const fresh = await this.compute(this.prisma, current.userId, { terminationDate: end, reason: current.reason, fullAwardOverride: current.fullAwardOverride });
    if (halalas(fresh.net) !== halalas(current.net)) {
      await this.prisma.finalSettlement.updateMany({ where: { id, status: 'DRAFT' }, data: fresh });
      throw new ConflictException(`تغيّرت أرقام المخالصة منذ إعدادها (الصافي الآن ${fresh.net} ر.س)، راجعها ثم اعتمدها`);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.core.lockEmployee(tx, current.userId);
      const settlement = await tx.finalSettlement.findUniqueOrThrow({ where: { id } });
      if (settlement.status !== 'DRAFT' || halalas(settlement.net) !== halalas(fresh.net)) throw new ConflictException('تغيّرت المخالصة للتو، حدّث الصفحة');

      const now = new Date();
      await tx.finalSettlement.update({ where: { id }, data: { status: 'APPROVED', approvedAt: now, approvedById: actor.userId, approvedByName: actor.name ?? null } });
      for (const advance of (fresh.details as { advances: { id: string; remaining: number }[] }).advances) {
        await tx.advanceRepayment.create({ data: { advanceId: advance.id, amount: advance.remaining, source: 'SETTLEMENT', settlementId: id, createdById: actor.userId, createdByName: actor.name ?? null } });
        await tx.salaryAdvance.update({ where: { id: advance.id }, data: { status: 'SETTLED', settledAt: now } });
      }
      await tx.payrollAdjustment.updateMany({ where: { userId: current.userId, status: 'PENDING' }, data: { status: 'APPLIED' } });
      await tx.salaryAdvance.updateMany({ where: { userId: current.userId, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED', reviewNote: 'انتهت الخدمة' } });
      await tx.leaveRequest.updateMany({ where: { userId: current.userId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now, cancelledByName: actor.name ?? null, cancelReason: 'انتهت الخدمة' } });
      await tx.employeeProfile.update({ where: { userId: current.userId }, data: { status: 'TERMINATED', terminationDate: settlement.terminationDate, terminationReason: settlement.reason } });
      // The account stays for the records but can no longer sign in, and no longer manages a branch.
      await tx.user.update({ where: { id: current.userId }, data: { blockedAt: now, blockedReason: `انتهت الخدمة: ${TERMINATION_LABELS[settlement.reason]}` } });
      await tx.refreshToken.updateMany({ where: { userId: current.userId, revoked: false }, data: { revoked: true } });
      await tx.appPresence.deleteMany({ where: { userId: current.userId } });
      await tx.branch.updateMany({ where: { managerId: current.userId }, data: { managerId: null } });
      await this.core.markStaleFrom(monthOf(end), tx);
      if (halalas(settlement.net) === 0) await tx.finalSettlement.update({ where: { id }, data: { status: 'PAID', paidAt: now, paidByName: actor.name ?? null } });
    }, TX_OPTIONS);
    this.realtime.disconnectUser(current.userId);
    return this.detail(id);
  }

  /** What the company pays out, or, when the employee owes, the reference of what was collected from them. */
  async pay(actor: HrActor, id: string, dto: { method: SalaryPaymentMethod; branchId?: string; bankReference?: string }) {
    const current = await this.prisma.finalSettlement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('المخالصة غير موجودة');
    await this.core.employee(actor, current.userId);
    this.core.assertNotSelf(actor, current.userId, 'صرف مخالصة');
    if (current.status !== 'APPROVED') throw new ConflictException(current.status === 'DRAFT' ? 'اعتمد المخالصة قبل صرفها' : 'صُرفت المخالصة مسبقًا');
    const owed = halalas(current.net) < 0;
    if (dto.method === 'CASH' && owed) throw new BadRequestException('المبلغ مستحق على الموظف، حصّله وسجّل مرجع التحصيل');
    if (dto.method === 'CASH' && !dto.branchId) throw new BadRequestException('اختر الفرع الذي يُصرف من صندوقه');
    if (dto.method === 'BANK' && !dto.bankReference?.trim()) throw new BadRequestException(owed ? 'اكتب مرجع تحصيل المبلغ من الموظف' : 'اكتب مرجع التحويل البنكي');
    await this.prisma.$transaction(async (tx) => {
      const session = dto.method === 'CASH' ? await this.cash.hrMovement(tx, actor, dto.branchId!, 'SALARY_PAYMENT', Number(current.net), { employeeId: current.userId }) : null;
      const { count } = await tx.finalSettlement.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'PAID', paidAt: new Date(), paidByName: actor.name ?? null, paidMethod: dto.method, bankReference: dto.bankReference?.trim() || null, cashSessionId: session?.id ?? null },
      });
      if (!count) throw new ConflictException('صُرفت المخالصة للتو');
    }, TX_OPTIONS);
    return this.detail(id);
  }

  async detail(id: string) {
    const row = await this.prisma.finalSettlement.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, phone: true, nationality: true, branch: { select: { name: true } }, rank: { select: { name: true, job: { select: { name: true } } } }, employeeProfile: { select: { employeeNumber: true, hireDate: true } } } } },
    });
    if (!row) throw new NotFoundException('المخالصة غير موجودة');
    return out(row);
  }

  async list(actor: HrActor, status?: string) {
    const rows = await this.prisma.finalSettlement.findMany({
      where: { user: await this.core.scopeWhere(actor), ...(status && { status: status as never }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true, phone: true, nationality: true, branch: { select: { name: true } }, rank: { select: { name: true, job: { select: { name: true } } } }, employeeProfile: { select: { employeeNumber: true, hireDate: true } } } } },
    });
    return rows.map(out);
  }
}

type FullRow = Prisma.FinalSettlementGetPayload<{
  include: { user: { select: { id: true; name: true; phone: true; nationality: true; branch: { select: { name: true } }; rank: { select: { name: true; job: { select: { name: true } } } }; employeeProfile: { select: { employeeNumber: true; hireDate: true } } } } };
}>;

const MONEY_FIELDS = ['monthlyWage', 'awardShare', 'eosAward', 'leaveDays', 'leaveEncashment', 'salaryDays', 'salaryDue', 'additions', 'advanceBalance', 'pendingDeductions', 'totalDue', 'totalDeductions', 'net'] as const;

const out = (row: FullRow) => ({
  ...row,
  ...(Object.fromEntries(MONEY_FIELDS.map((field) => [field, Number(row[field])])) as Record<(typeof MONEY_FIELDS)[number], number>),
  code: settlementCode(row.number),
  terminationDate: fromDbDate(row.terminationDate),
  reasonLabel: TERMINATION_LABELS[row.reason],
  user: { ...row.user, employeeProfile: row.user.employeeProfile && { ...row.user.employeeProfile, hireDate: fromDbDate(row.user.employeeProfile.hireDate) } },
});

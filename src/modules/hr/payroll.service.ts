import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PayrollItemKind, Prisma, SalaryPaymentMethod } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { csvFile } from '../../common/utils/csv.util';
import { CashService } from '../cash/cash.service';
import { adjustmentProgress } from './adjustments.service';
import { advanceSchedule, installmentDue } from './advances.service';
import { Db, HrActor, HrCoreService, riyadhInstant, TX_OPTIONS } from './hr-core.service';
import {
  ADJUSTMENT_LABELS,
  addDays,
  advanceCode,
  currentMonth,
  Day,
  daysBetween,
  dayWeight,
  formatRiyals,
  fromDbDate,
  halalas,
  isSaudi,
  maxDay,
  minDay,
  Month,
  monthEnd,
  monthStart,
  parseMonth,
  riyals,
  toDbDate,
  wageTotal,
} from './hr.util';

type Tx = Prisma.TransactionClient;
type PayInput = { lineIds: string[]; method: SalaryPaymentMethod; branchId?: string; bankReference?: string };
/** Approval walks every line of the month, so it is given longer than an ordinary write. */
const APPROVE_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 };

type Item = { kind: PayrollItemKind; code: string; label: string; amount: number; adjustmentId?: string; advanceId?: string; leaveRequestId?: string };

/** One employee's pay for the days of a month they were employed, before any deduction but social insurance. */
export interface MonthEarnings {
  from: Day;
  to: Day;
  workedDays: number;
  basic: number;
  housing: number;
  transport: number;
  other: number;
  dailyWage: number;
  leaveDeduction: number;
  gosiEmployee: number;
  gosiEmployer: number;
  items: Item[];
}

const DEDUCTION_ORDER = ['PENALTY', 'ABSENCE', 'CASH_SHORTAGE', 'DAMAGE', 'OTHER_DEDUCTION'];

const RUN_SELECT = {
  id: true,
  month: true,
  status: true,
  stale: true,
  employeeCount: true,
  totalGross: true,
  totalDeductions: true,
  totalNet: true,
  totalEmployerGosi: true,
  calculatedAt: true,
  calculatedByName: true,
  approvedAt: true,
  approvedByName: true,
  paidAt: true,
  note: true,
  createdAt: true,
} satisfies Prisma.PayrollRunSelect;

const decimals = <T extends Record<string, unknown>>(row: T) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Prisma.Decimal ? Number(value) : value])) as {
    [K in keyof T]: T[K] extends Prisma.Decimal ? number : T[K] extends Prisma.Decimal | null ? number | null : T[K];
  };

@Injectable()
export class PayrollService {
  constructor(
    private core: HrCoreService,
    private cash: CashService,
    private notifications: NotificationsService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  // ---------------------------------------------------------------- the engine

  /**
   * Pay for one month on the 30-day basis: each salary row in force pays its share of the days it covers,
   * unpaid and partly paid leave days come off at the daily wage of their own day, and social insurance is
   * worked out on basic plus housing up to the ceiling. `until` ends the period early, for a final settlement.
   */
  async earnings(db: Db, userId: string, month: Month, until?: Day): Promise<MonthEarnings | null> {
    const profile = await db.employeeProfile.findUnique({ where: { userId }, include: { user: { select: { nationality: true } } } });
    if (!profile) return null;
    const end = [monthEnd(month), until, profile.terminationDate && fromDbDate(profile.terminationDate)].filter(Boolean).reduce((a, b) => minDay(a!, b!))!;
    const from = maxDay(fromDbDate(profile.hireDate), monthStart(month));
    if (from > end) return null;

    const segments = await this.core.wageSegments(userId, from, end, db);
    if (!segments.length) return null;
    const weight = dayWeight(month, from === monthStart(month) && end === monthEnd(month));
    const totals = { basic: 0, housing: 0, transport: 0, other: 0, days: 0 };
    for (const segment of segments) {
      const days = daysBetween(segment.from, segment.to) * weight;
      totals.days += days;
      totals.basic += (segment.wage.basic * days) / 30;
      totals.housing += (segment.wage.housing * days) / 30;
      totals.transport += (segment.wage.transport * days) / 30;
      totals.other += (segment.wage.other * days) / 30;
    }
    const workedDays = Math.min(30, Math.round(totals.days * 100) / 100);
    const last = segments[segments.length - 1].wage;
    const wageOnDay = (day: Day) => (segments.find((segment) => segment.from <= day && day <= segment.to) ?? segments[segments.length - 1]).wage;

    const items: Item[] = [];
    let leaveDeduction = 0;
    const leaves = await db.leaveRequest.findMany({
      where: { userId, status: 'APPROVED', startDate: { lte: toDbDate(end) }, endDate: { gte: toDbDate(from) } },
      include: { type: { select: { name: true } } },
      orderBy: { startDate: 'asc' },
    });
    for (const leave of leaves) {
      const start = fromDbDate(leave.startDate);
      const percent = Number(leave.partialPayPercent) / 100;
      let amount = 0;
      let unpaidEquivalent = 0;
      for (let index = 0; index < leave.days; index++) {
        const day = addDays(start, index);
        if (day < from || day > end) continue;
        const factor = index < leave.fullPayDays ? 1 : index < leave.fullPayDays + leave.partialPayDays ? percent : 0;
        if (factor >= 1) continue;
        unpaidEquivalent += (1 - factor) * weight;
        amount += (1 - factor) * (wageTotal(wageOnDay(day)) / 30) * weight;
      }
      if (amount > 0) {
        leaveDeduction += Math.round(amount);
        items.push({ kind: 'DEDUCTION', code: 'LEAVE', label: `${leave.type.name} (${Math.round(unpaidEquivalent * 100) / 100} يوم دون أجر كامل)`, amount: Math.round(amount), leaveRequestId: leave.id });
      }
    }

    let gosiEmployee = 0;
    let gosiEmployer = 0;
    if (profile.gosiRegistered) {
      const rates = await this.core.numbers('gosiSaudiEmployeePercent', 'gosiSaudiEmployerPercent', 'gosiNonSaudiEmployeePercent', 'gosiNonSaudiEmployerPercent', 'gosiMaxWage');
      const saudi = isSaudi(profile.user.nationality);
      const base = Math.min(last.basic + last.housing, rates.gosiMaxWage * 100) * (workedDays / 30);
      gosiEmployee = Math.round((base * (saudi ? rates.gosiSaudiEmployeePercent : rates.gosiNonSaudiEmployeePercent)) / 100);
      gosiEmployer = Math.round((base * (saudi ? rates.gosiSaudiEmployerPercent : rates.gosiNonSaudiEmployerPercent)) / 100);
    }

    return {
      from,
      to: end,
      workedDays,
      basic: Math.round(totals.basic),
      housing: Math.round(totals.housing),
      transport: Math.round(totals.transport),
      other: Math.round(totals.other),
      dailyWage: Math.round(wageTotal(last) / 30),
      leaveDeduction,
      gosiEmployee,
      gosiEmployer,
      items,
    };
  }

  /** Trips the employee crewed that left within the period and have already left, at their rank's allowance. */
  async tripAllowanceFor(db: Db, userId: string, rate: Prisma.Decimal | null | undefined, from: Day, to: Day) {
    if (!rate || halalas(rate) <= 0) return { count: 0, amount: 0 };
    const now = new Date();
    const endInstant = riyadhInstant(addDays(to, 1));
    const count = await db.trip.count({
      where: {
        tripStatus: { not: 'CANCELLED' },
        departureTime: { gte: riyadhInstant(from), lt: endInstant < now ? endInstant : now },
        OR: [{ drivers: { some: { userId } } }, { supervisors: { some: { userId } } }],
      },
    });
    return { count, amount: count * halalas(rate) };
  }

  // ---------------------------------------------------------------- runs

  async create(actor: HrActor, month: string) {
    const target = parseMonth(month);
    if (target > currentMonth()) throw new BadRequestException('لا يُعد مسيّر لشهر لم يبدأ');
    const existing = await this.prisma.payrollRun.findUnique({ where: { month: target }, select: { id: true } });
    if (existing) throw new ConflictException(`مسيّر شهر ${target} موجود`);
    const run = await this.prisma.payrollRun.create({ data: { month: target }, select: { id: true } });
    return this.calculate(actor, run.id);
  }

  /** Works the whole month out again from scratch; only a draft can be. */
  async calculate(actor: HrActor, runId: string) {
    const warnings: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.core.lockPayroll(tx);
      const run = await tx.payrollRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException('المسيّر غير موجود');
      if (run.status !== 'DRAFT') throw new ConflictException('المسيّر معتمد ولا يُعاد حسابه');
      await tx.payrollLine.deleteMany({ where: { runId } });

      const month = run.month;
      const start = toDbDate(monthStart(month));
      const end = toDbDate(monthEnd(month));
      const profiles = await tx.employeeProfile.findMany({
        where: {
          hireDate: { lte: end },
          OR: [{ terminationDate: null }, { terminationDate: { gte: start } }],
          // A settlement pays the month the service ended in.
          user: { finalSettlements: { none: { status: { in: ['APPROVED', 'PAID'] }, terminationDate: { lte: end } } } },
        },
        include: {
          user: { select: { id: true, name: true, phone: true, nationality: true, branchId: true, branch: { select: { name: true } }, rank: { select: { name: true, tripAllowance: true, job: { select: { name: true } } } } } },
        },
        orderBy: { employeeNumber: 'asc' },
      });
      const settings = await this.core.numbers('payrollMaxDeductionPercent', 'penaltyMaxDaysPerMonth');

      const totals = { gross: 0, deductions: 0, net: 0, employer: 0, count: 0 };
      for (const profile of profiles) {
        const user = profile.user;
        const name = user.name ?? user.phone;
        const pay = await this.earnings(tx, user.id, month);
        if (!pay) {
          warnings.push(`${name}: لا يوجد راتب مسجل يسري في هذا الشهر`);
          continue;
        }
        if (profile.status === 'SUSPENDED') warnings.push(`${name}: موقوف عن العمل، سجّل أيام الإيقاف إجازة دون راتب إن لم تكن مدفوعة`);
        if (profile.paymentMethod === 'BANK' && !profile.iban) warnings.push(`${name}: يُصرف بالتحويل ولا يوجد له آيبان`);

        const items: Item[] = [
          { kind: 'EARNING', code: 'BASIC', label: 'الراتب الأساسي', amount: pay.basic },
          { kind: 'EARNING', code: 'HOUSING', label: 'بدل السكن', amount: pay.housing },
          { kind: 'EARNING', code: 'TRANSPORT', label: 'بدل النقل', amount: pay.transport },
          { kind: 'EARNING', code: 'OTHER', label: 'بدلات أخرى', amount: pay.other },
        ].filter((item) => item.amount > 0) as Item[];

        const trips = await this.tripAllowanceFor(tx, user.id, user.rank?.tripAllowance, pay.from, pay.to);
        if (trips.amount) items.push({ kind: 'EARNING', code: 'TRIPS', label: `بدل رحلات (${trips.count} رحلة)`, amount: trips.amount });

        const adjustments = await tx.payrollAdjustment.findMany({
          where: { userId: user.id, status: 'PENDING', month: { lte: month } },
          include: { items: { where: { line: { run: { status: { not: 'DRAFT' } } } }, select: { amount: true } } },
          orderBy: { createdAt: 'asc' },
        });
        let additions = 0;
        for (const adjustment of adjustments.filter((row) => row.kind === 'EARNING')) {
          const remaining = adjustmentProgress(adjustment).remaining ?? 0;
          if (remaining <= 0) continue;
          additions += remaining;
          items.push({ kind: 'EARNING', code: adjustment.category, label: `${ADJUSTMENT_LABELS[adjustment.category]}: ${adjustment.reason}`, amount: remaining, adjustmentId: adjustment.id });
        }

        const gross = pay.basic + pay.housing + pay.transport + pay.other + trips.amount + additions;
        items.push(...pay.items);
        const payable = Math.max(gross - pay.leaveDeduction, 0);

        // Social insurance is due whatever else is owed; the cap then decides how much of the rest this month bears.
        let room = Math.floor((payable * settings.payrollMaxDeductionPercent) / 100) - pay.gosiEmployee;
        let deferred = 0;
        let advanceDeduction = 0;
        let otherDeductions = 0;
        if (pay.gosiEmployee) items.push({ kind: 'DEDUCTION', code: 'GOSI', label: 'التأمينات الاجتماعية (حصة الموظف)', amount: pay.gosiEmployee });
        if (pay.gosiEmployer) items.push({ kind: 'EMPLOYER', code: 'GOSI_EMPLOYER', label: 'التأمينات الاجتماعية (حصة الشركة)', amount: pay.gosiEmployer });

        const take = (due: number) => {
          const taken = Math.max(Math.min(due, room), 0);
          room -= taken;
          deferred += due - taken;
          return taken;
        };

        const advances = await tx.salaryAdvance.findMany({ where: { userId: user.id, status: 'DISBURSED' }, include: { repayments: { select: { amount: true } } }, orderBy: { createdAt: 'asc' } });
        for (const advance of advances) {
          const due = installmentDue(advance, halalas(advanceSchedule(advance).remaining), month);
          if (!due) continue;
          const taken = take(due);
          advanceDeduction += taken;
          if (taken) items.push({ kind: 'DEDUCTION', code: 'ADVANCE', label: `قسط السلفة ${advanceCode(advance.number)}`, amount: taken, advanceId: advance.id });
        }

        // The labour law also caps what penalties take in one month, apart from the overall cap.
        let penaltyRoom = pay.dailyWage * settings.penaltyMaxDaysPerMonth;
        const deductions = adjustments
          .filter((row) => row.kind === 'DEDUCTION')
          .sort((a, b) => DEDUCTION_ORDER.indexOf(a.category) - DEDUCTION_ORDER.indexOf(b.category) || a.createdAt.getTime() - b.createdAt.getTime());
        for (const adjustment of deductions) {
          let value = adjustment.amount;
          // An absence is priced at this month's daily wage until a payroll has taken part of it.
          if (adjustment.category === 'ABSENCE' && adjustment.items.length === 0) {
            const priced = Math.round(Number(adjustment.days) * pay.dailyWage);
            value = new Prisma.Decimal(riyals(priced));
            await tx.payrollAdjustment.update({ where: { id: adjustment.id }, data: { amount: value } });
          }
          const remaining = adjustmentProgress({ amount: value, items: adjustment.items }).remaining ?? 0;
          if (remaining <= 0) continue;
          let due = remaining;
          if (adjustment.category === 'PENALTY') {
            const allowed = Math.max(Math.min(due, penaltyRoom), 0);
            deferred += due - allowed;
            penaltyRoom -= allowed;
            due = allowed;
          }
          const taken = take(due);
          otherDeductions += taken;
          if (taken) items.push({ kind: 'DEDUCTION', code: adjustment.category, label: `${ADJUSTMENT_LABELS[adjustment.category]}: ${adjustment.reason}`, amount: taken, adjustmentId: adjustment.id });
        }

        const totalDeductions = pay.leaveDeduction + pay.gosiEmployee + advanceDeduction + otherDeductions;
        const net = Math.max(gross - totalDeductions, 0);
        await tx.payrollLine.create({
          data: {
            runId,
            userId: user.id,
            employeeNumber: profile.employeeNumber,
            name,
            jobName: user.rank?.job.name ?? null,
            rankName: user.rank?.name ?? null,
            branchId: user.branchId,
            branchName: user.branch?.name ?? null,
            isSaudi: isSaudi(user.nationality),
            iban: profile.iban,
            bankName: profile.bankName,
            paymentMethod: profile.paymentMethod,
            workedDays: pay.workedDays,
            basic: riyals(pay.basic),
            housing: riyals(pay.housing),
            transport: riyals(pay.transport),
            other: riyals(pay.other),
            tripCount: trips.count,
            tripAllowance: riyals(trips.amount),
            additions: riyals(additions),
            gross: riyals(gross),
            leaveDeduction: riyals(pay.leaveDeduction),
            gosiEmployee: riyals(pay.gosiEmployee),
            gosiEmployer: riyals(pay.gosiEmployer),
            advanceDeduction: riyals(advanceDeduction),
            otherDeductions: riyals(otherDeductions),
            deferred: riyals(deferred),
            totalDeductions: riyals(totalDeductions),
            net: riyals(net),
            items: { create: items.map((item) => ({ ...item, amount: riyals(item.amount) })) },
          },
        });
        totals.gross += gross;
        totals.deductions += totalDeductions;
        totals.net += net;
        totals.employer += pay.gosiEmployer;
        totals.count += 1;
      }

      await tx.payrollRun.update({
        where: { id: runId },
        data: {
          stale: false,
          employeeCount: totals.count,
          totalGross: riyals(totals.gross),
          totalDeductions: riyals(totals.deductions),
          totalNet: riyals(totals.net),
          totalEmployerGosi: riyals(totals.employer),
          calculatedAt: new Date(),
          calculatedById: actor.userId,
          calculatedByName: actor.name ?? null,
          note: warnings.length ? warnings.join('\n') : null,
        },
      });
    }, { maxWait: 15_000, timeout: 120_000 });
    return this.detail(runId);
  }

  async remove(runId: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id: runId }, select: { status: true } });
    if (!run) throw new NotFoundException('المسيّر غير موجود');
    if (run.status !== 'DRAFT') throw new ConflictException('المسيّر المعتمد لا يُحذف');
    await this.prisma.payrollRun.delete({ where: { id: runId } });
    return { success: true };
  }

  /**
   * Freezes the month. Whoever worked it out does not approve it, except the owner who has nobody above them.
   * Advance installments are recorded as repaid and fully taken adjustments are closed in the same step.
   */
  async approve(actor: HrActor, runId: string) {
    const lines = await this.prisma.$transaction((tx) => this.approveIn(tx, actor, runId), APPROVE_TX_OPTIONS);
    return { ...(await this.detail(runId)), approvedLines: lines };
  }

  /**
   * Approval and payment in one step and one transaction: if a salary cannot be paid (no open drawer, say),
   * nothing is approved either. Each salary goes the way the employee is paid — transfer or cash — and the
   * approver's own salary is left for someone else to pay, as with paying one by one.
   * Cash goes out at once; transfers only when the reference is given, otherwise they wait for the bank file.
   */
  async approveAndPay(actor: HrActor, runId: string, dto: { branchId?: string; bankReference?: string }) {
    if (!actor.permissions?.includes('payroll.pay')) throw new ForbiddenException('الاعتماد والصرف معًا يحتاج صلاحية صرف الرواتب أيضًا');
    const result = await this.prisma.$transaction(async (tx) => {
      const approvedLines = await this.approveIn(tx, actor, runId);
      const unpaid = await tx.payrollLine.findMany({ where: { runId, paidAt: null }, select: { id: true, userId: true, paymentMethod: true } });
      const own = unpaid.filter((line) => line.userId === actor.userId && actor.role !== 'ADMIN');
      const payable = unpaid.filter((line) => !own.includes(line));
      const bank = payable.filter((line) => line.paymentMethod === 'BANK').map((line) => line.id);
      const cash = payable.filter((line) => line.paymentMethod !== 'BANK').map((line) => line.id);
      // Transfers are recorded only with the bank's reference: until then they stay unpaid, so the bank (Mudad) file still lists them.
      const transferDone = !!dto.bankReference?.trim();
      if (bank.length && transferDone) await this.payIn(tx, actor, runId, { lineIds: bank, method: 'BANK', bankReference: dto.bankReference });
      if (cash.length) await this.payIn(tx, actor, runId, { lineIds: cash, method: 'CASH', branchId: dto.branchId });
      return { approvedLines, paidLines: (transferDone ? bank.length : 0) + cash.length, bankPending: transferDone ? 0 : bank.length, leftForOthers: own.length };
    }, APPROVE_TX_OPTIONS);
    return { ...(await this.detail(runId)), ...result };
  }

  /** What "approve and pay" will need, so the dialog asks only for a transfer reference or a drawer when some salary uses one. */
  async paymentNeeds(runId: string) {
    const lines = await this.prisma.payrollLine.findMany({ where: { runId, paidAt: null, net: { gt: 0 } }, select: { paymentMethod: true, net: true, iban: true } });
    const bank = lines.filter((line) => line.paymentMethod === 'BANK');
    const cash = lines.filter((line) => line.paymentMethod !== 'BANK');
    const total = (rows: typeof lines) => riyals(rows.reduce((sum, row) => sum + halalas(row.net), 0));
    return { bank: { count: bank.length, total: total(bank), missingIban: bank.filter((line) => !line.iban).length }, cash: { count: cash.length, total: total(cash) } };
  }

  private async approveIn(tx: Tx, actor: HrActor, runId: string) {
    await this.core.lockPayroll(tx);
    const run = await tx.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('المسيّر غير موجود');
    if (run.status !== 'DRAFT') throw new ConflictException('المسيّر معتمد مسبقًا');
    if (run.stale) throw new ConflictException('تغيّرت بيانات بعد حساب المسيّر، أعد حسابه ثم اعتمده');
    if (!run.calculatedAt || run.employeeCount === 0) throw new ConflictException('لا يوجد موظفون في المسيّر');
    if (run.month > currentMonth()) throw new ConflictException('لا يُعتمد مسيّر شهر لم يبدأ');
    if (run.calculatedById === actor.userId && actor.role !== 'ADMIN') throw new ForbiddenException('من أعدّ المسيّر لا يعتمده، يعتمده موظف آخر');
    const earlier = await tx.payrollRun.findFirst({ where: { month: { lt: run.month }, status: 'DRAFT' }, select: { month: true } });
    if (earlier) throw new ConflictException(`اعتمد مسيّر شهر ${earlier.month} أولًا`);

    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: actor.userId, approvedByName: actor.name ?? null } });
    const lines = await tx.payrollLine.findMany({ where: { runId }, include: { items: true } });

    for (const item of lines.flatMap((line) => line.items)) {
      if (item.advanceId) {
        await tx.advanceRepayment.create({ data: { advanceId: item.advanceId, amount: item.amount, source: 'PAYROLL', payrollRunId: runId, createdById: actor.userId, createdByName: actor.name ?? null } });
        const advance = await tx.salaryAdvance.findUniqueOrThrow({ where: { id: item.advanceId }, include: { repayments: { select: { amount: true } } } });
        if (halalas(advanceSchedule(advance).remaining) === 0) await tx.salaryAdvance.update({ where: { id: advance.id }, data: { status: 'SETTLED', settledAt: new Date() } });
      }
      if (item.adjustmentId) {
        const adjustment = await tx.payrollAdjustment.findUniqueOrThrow({ where: { id: item.adjustmentId }, include: { items: { where: { line: { run: { status: { not: 'DRAFT' } } } }, select: { amount: true } } } });
        if (adjustmentProgress(adjustment).remaining === 0) await tx.payrollAdjustment.update({ where: { id: adjustment.id }, data: { status: 'APPLIED' } });
      }
    }
    // A line with nothing to pay is settled the moment it is approved.
    await tx.payrollLine.updateMany({ where: { runId, net: 0 }, data: { paidAt: new Date(), paidByName: actor.name ?? null } });
    await this.closeIfPaid(tx, runId);
    for (const line of lines) {
      await this.notifications.toUser(tx, 'PAYSLIP_READY', line.userId, { payrollMonth: run.month, netSalary: formatRiyals(halalas(line.net)) });
    }
    return lines.length;
  }

  private async closeIfPaid(tx: Tx, runId: string) {
    const unpaid = await tx.payrollLine.count({ where: { runId, paidAt: null } });
    if (unpaid === 0) await tx.payrollRun.update({ where: { id: runId }, data: { status: 'PAID', paidAt: new Date() } });
  }

  /** Records salaries as paid: by bank transfer with its reference, or in cash out of a branch's drawer one by one. */
  async pay(actor: HrActor, runId: string, dto: PayInput) {
    await this.prisma.$transaction((tx) => this.payIn(tx, actor, runId, dto), TX_OPTIONS);
    return this.detail(runId);
  }

  private async payIn(tx: Tx, actor: HrActor, runId: string, dto: PayInput) {
    if (!dto.lineIds.length) throw new BadRequestException('اختر الرواتب المراد تسجيل صرفها');
    if (dto.method === 'CASH' && !dto.branchId) throw new BadRequestException('اختر الفرع الذي يُصرف من صندوقه رواتب الصرف النقدي');
    if (dto.method === 'BANK' && !dto.bankReference?.trim()) throw new BadRequestException('اكتب مرجع التحويل البنكي');
    const run = await tx.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('المسيّر غير موجود');
    if (run.status !== 'APPROVED') throw new ConflictException(run.status === 'DRAFT' ? 'اعتمد المسيّر قبل صرف الرواتب' : 'صُرفت رواتب هذا المسيّر كلها');
    const lines = await tx.payrollLine.findMany({ where: { runId, id: { in: dto.lineIds }, paidAt: null } });
    if (lines.length !== new Set(dto.lineIds).size) throw new ConflictException('بعض الرواتب المختارة صُرفت مسبقًا أو ليست في هذا المسيّر');
    if (lines.some((line) => line.userId === actor.userId) && actor.role !== 'ADMIN') throw new ForbiddenException('لا تسجّل صرف راتبك بنفسك');
    for (const line of lines) {
      const session = dto.method === 'CASH' ? await this.cash.hrMovement(tx, actor, dto.branchId!, 'SALARY_PAYMENT', Number(line.net), { employeeId: line.userId }) : null;
      await tx.payrollLine.update({
        where: { id: line.id },
        data: { paidAt: new Date(), paidByName: actor.name ?? null, paidMethod: dto.method, bankReference: dto.bankReference?.trim() || null, cashSessionId: session?.id ?? null },
      });
      await this.notifications.toUser(tx, 'SALARY_PAID', line.userId, { payrollMonth: run.month, netSalary: formatRiyals(halalas(line.net)) });
    }
    await this.closeIfPaid(tx, runId);
  }

  /** The transfers still to make, for the bank's bulk upload or the Mudad wage file. */
  async bankFile(runId: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id: runId }, select: { month: true, status: true } });
    if (!run) throw new NotFoundException('المسيّر غير موجود');
    if (run.status === 'DRAFT') throw new ConflictException('اعتمد المسيّر قبل تصدير ملف البنك');
    const lines = await this.prisma.payrollLine.findMany({ where: { runId, paidAt: null, paymentMethod: 'BANK', net: { gt: 0 } }, orderBy: { employeeNumber: 'asc' } });
    const rows = lines.map((line) => [line.employeeNumber, line.name, line.bankName ?? '', line.iban ?? '', Number(line.basic), Number(line.housing), Number(line.gross) - Number(line.basic) - Number(line.housing), Number(line.totalDeductions), Number(line.net), run.month]);
    return {
      fileName: `payroll-${run.month}-bank.csv`,
      content: csvFile(['الرقم الوظيفي', 'الاسم', 'البنك', 'الآيبان', 'الأساسي', 'السكن', 'بدلات أخرى', 'الاستقطاعات', 'الصافي', 'الشهر'], rows),
      missingIban: lines.filter((line) => !line.iban).map((line) => line.name),
    };
  }

  // ---------------------------------------------------------------- reading

  async list() {
    const runs = await this.prisma.payrollRun.findMany({ orderBy: { month: 'desc' }, take: 36, select: { ...RUN_SELECT, _count: { select: { lines: { where: { paidAt: null } } } } } });
    return runs.map(({ _count, ...run }) => ({ ...decimals(run), unpaidLines: _count.lines }));
  }

  async detail(runId: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: runId },
      select: {
        ...RUN_SELECT,
        lines: {
          orderBy: { employeeNumber: 'asc' },
          select: {
            id: true,
            userId: true,
            employeeNumber: true,
            name: true,
            jobName: true,
            rankName: true,
            branchId: true,
            branchName: true,
            isSaudi: true,
            paymentMethod: true,
            iban: true,
            workedDays: true,
            basic: true,
            housing: true,
            transport: true,
            other: true,
            tripCount: true,
            tripAllowance: true,
            additions: true,
            gross: true,
            leaveDeduction: true,
            gosiEmployee: true,
            gosiEmployer: true,
            advanceDeduction: true,
            otherDeductions: true,
            deferred: true,
            totalDeductions: true,
            net: true,
            paidAt: true,
            paidByName: true,
            paidMethod: true,
            bankReference: true,
          },
        },
      },
    });
    if (!run) throw new NotFoundException('المسيّر غير موجود');
    const { lines, ...rest } = run;
    return { ...decimals(rest), warnings: rest.note ? rest.note.split('\n') : [], lines: lines.map(decimals) };
  }

  /** A payslip: the line with every item behind it. */
  async payslip(lineId: string) {
    const line = await this.prisma.payrollLine.findUnique({
      where: { id: lineId },
      include: { run: { select: { month: true, status: true, approvedAt: true } }, items: { orderBy: { id: 'asc' } } },
    });
    if (!line) throw new NotFoundException('القسيمة غير موجودة');
    const { items, run, ...rest } = line;
    // The kind first, then the order the payroll wrote them in.
    const order: Record<PayrollItemKind, number> = { EARNING: 0, DEDUCTION: 1, EMPLOYER: 2 };
    return {
      ...decimals(rest),
      month: run.month,
      runStatus: run.status,
      approvedAt: run.approvedAt,
      items: items.sort((a, b) => order[a.kind] - order[b.kind]).map((item) => ({ ...item, amount: Number(item.amount) })),
    };
  }

  async myPayslip(userId: string, lineId: string) {
    const slip = await this.payslip(lineId);
    // A draft is the office's working copy, not the employee's pay yet.
    if (slip.userId !== userId || slip.runStatus === 'DRAFT') throw new NotFoundException('القسيمة غير موجودة');
    return slip;
  }

  async payslipsOf(userId: string, includeDrafts = false) {
    const lines = await this.prisma.payrollLine.findMany({
      where: { userId, ...(includeDrafts ? {} : { run: { status: { not: 'DRAFT' } } }) },
      orderBy: { run: { month: 'desc' } },
      take: 24,
      select: { id: true, gross: true, totalDeductions: true, net: true, paidAt: true, paidMethod: true, paymentMethod: true, run: { select: { id: true, month: true, status: true } } },
    });
    return lines.map(({ run, ...line }) => ({ ...decimals(line), month: run.month, runStatus: run.status, runId: run.id }));
  }

  /** The last month an approved payroll paid this employee, so a settlement starts the day after. */
  async lastPaidMonth(db: Db, userId: string) {
    const line = await db.payrollLine.findFirst({ where: { userId, run: { status: { not: 'DRAFT' } } }, orderBy: { run: { month: 'desc' } }, select: { run: { select: { month: true } } } });
    return line?.run.month ?? null;
  }

  approvedLinesFrom(db: Db, userId: string, month: Month) {
    return db.payrollLine.findMany({ where: { userId, run: { status: { not: 'DRAFT' }, month: { gte: month } } }, include: { run: { select: { month: true } } } });
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PayrollAdjustmentCategory, PayrollAdjustmentStatus, Prisma } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { HrActor, HrCoreService } from './hr-core.service';
import { ADJUSTMENT_LABELS, adjustmentCode, currentMonth, EARNING_CATEGORIES, formatRiyals, halalas, nextMonth, parseMonth, riyals, today, wageTotal } from './hr.util';

type Tx = Prisma.TransactionClient;

export interface AdjustmentInput {
  userId: string;
  category: PayrollAdjustmentCategory;
  amount?: number;
  days?: number;
  month?: string;
  reason: string;
}

const ADJUSTMENT_SELECT = {
  id: true,
  number: true,
  userId: true,
  kind: true,
  category: true,
  amount: true,
  days: true,
  month: true,
  reason: true,
  status: true,
  penaltyId: true,
  createdByName: true,
  createdAt: true,
  cancelledAt: true,
  cancelledByName: true,
  cancelReason: true,
  user: { select: { id: true, name: true, phone: true, branch: { select: { name: true } } } },
  items: { where: { line: { run: { status: { not: 'DRAFT' } } } }, select: { amount: true, line: { select: { run: { select: { month: true } } } } } },
} satisfies Prisma.PayrollAdjustmentSelect;

type Row = Prisma.PayrollAdjustmentGetPayload<{ select: typeof ADJUSTMENT_SELECT }>;

/** What approved payrolls already took from it, and what is still owed. An absence has no value until a payroll prices it. */
export function adjustmentProgress(row: { amount: Prisma.Decimal | null; items: { amount: Prisma.Decimal }[] }) {
  const applied = row.items.reduce((sum, item) => sum + halalas(item.amount), 0);
  return { applied, remaining: row.amount === null ? null : Math.max(halalas(row.amount) - applied, 0) };
}

const out = ({ items, ...row }: Row) => {
  const progress = adjustmentProgress({ amount: row.amount, items });
  return {
    ...row,
    code: adjustmentCode(row.number),
    label: ADJUSTMENT_LABELS[row.category],
    amount: row.amount === null ? null : Number(row.amount),
    days: row.days === null ? null : Number(row.days),
    applied: riyals(progress.applied),
    remaining: progress.remaining === null ? null : riyals(progress.remaining),
    appliedIn: [...new Set(items.map((item) => item.line.run.month))],
  };
};

const isEarning = (category: PayrollAdjustmentCategory) => (EARNING_CATEGORIES as readonly string[]).includes(category);

@Injectable()
export class AdjustmentsService {
  constructor(
    private core: HrCoreService,
    private notifications: NotificationsService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  async create(actor: HrActor, input: AdjustmentInput) {
    this.core.assertNotSelf(actor, input.userId, 'تسجيل إضافة أو خصم على راتبك');
    await this.core.activeEmployee(actor, input.userId);
    if (input.category === 'PENALTY') throw new BadRequestException('خصومات الجزاءات تُسجَّل من صفحة الجزاءات');
    const month = input.month ? parseMonth(input.month) : currentMonth();
    if (month < currentMonth()) throw new BadRequestException('لا تُسجَّل إضافة أو خصم على شهر مضى');
    if (input.category === 'ABSENCE') {
      if (!(input.days && input.days > 0 && input.days <= 30)) throw new BadRequestException('حدد أيام الغياب (من نصف يوم إلى 30)');
    } else if (!(input.amount && input.amount > 0)) {
      throw new BadRequestException('حدد المبلغ');
    }
    if (!input.reason?.trim()) throw new BadRequestException('اكتب السبب');

    const created = await this.prisma.$transaction(async (tx) => {
      await this.core.assertMonthsOpen([month], tx);
      const row = await tx.payrollAdjustment.create({
        data: {
          userId: input.userId,
          kind: isEarning(input.category) ? 'EARNING' : 'DEDUCTION',
          category: input.category,
          amount: input.category === 'ABSENCE' ? null : input.amount,
          days: input.category === 'ABSENCE' ? input.days : null,
          month,
          reason: input.reason.trim(),
          createdById: actor.userId,
          createdByName: actor.name ?? null,
        },
        select: { id: true },
      });
      await this.core.markStaleFrom(month, tx);
      const value = input.category === 'ABSENCE' ? `${input.days} يوم` : formatRiyals(halalas(input.amount));
      await this.notifications.toUser(tx, 'SALARY_ADJUSTMENT_ADDED', input.userId, {
        adjustmentLabel: ADJUSTMENT_LABELS[input.category],
        adjustmentDetails: `${value} على راتب شهر ${month}. السبب: ${input.reason.trim()}`,
      });
      return row;
    });
    return this.detail(created.id);
  }

  /**
   * A salary-deduction penalty becomes a deduction here, in the same transaction as the penalty, so the two
   * cannot part. The labour law caps one penalty at a number of days of wage.
   */
  /** Checked before anything else changes, so a refused amount never leaves a decision half made. */
  async assertPenaltyWithinCap(userId: string, amount: number, db: Tx | HrCoreService['db'] = this.prisma) {
    const { penaltyMaxDaysPerMonth } = await this.core.numbers('penaltyMaxDaysPerMonth');
    const wage = await this.core.wageOn(userId, today(), db);
    if (!wage) return;
    const cap = Math.floor((wageTotal(wage) / 30) * penaltyMaxDaysPerMonth);
    if (halalas(amount) > cap) throw new BadRequestException(`خصم الجزاء لا يتجاوز أجر ${penaltyMaxDaysPerMonth} أيام (${formatRiyals(cap)})`);
  }

  async fromPenalty(tx: Tx, penalty: { id: string; userId: string; amount: number; reason: string }, createdBy: { userId: string; name?: string | null }) {
    await this.assertPenaltyWithinCap(penalty.userId, penalty.amount, tx);
    // A penalty recorded after this month's payroll was approved is taken from the next one.
    let month = currentMonth();
    while (await tx.payrollRun.findFirst({ where: { month, status: { not: 'DRAFT' } }, select: { id: true } })) month = nextMonth(month);
    await tx.payrollAdjustment.create({
      data: { userId: penalty.userId, kind: 'DEDUCTION', category: 'PENALTY', amount: penalty.amount, month, reason: penalty.reason, penaltyId: penalty.id, createdById: createdBy.userId, createdByName: createdBy.name ?? null },
    });
    await this.core.markStaleFrom(month, tx);
  }

  /** What no approved payroll has taken yet is dropped; what was taken stays on the payslips it is on. */
  async cancel(actor: HrActor, id: string, reason: string) {
    const row = await this.prisma.payrollAdjustment.findUnique({ where: { id }, select: ADJUSTMENT_SELECT });
    if (!row) throw new NotFoundException('السجل غير موجود');
    await this.core.employee(actor, row.userId);
    this.core.assertNotSelf(actor, row.userId, 'إلغاء خصم أو إضافة على راتبك');
    if (!reason?.trim()) throw new BadRequestException('اكتب سبب الإلغاء');
    if (row.status !== 'PENDING') throw new ConflictException('لا يُلغى إلا ما لم يُطبَّق كاملًا');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollAdjustment.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name ?? null, cancelReason: reason.trim() },
      });
      if (!count) throw new ConflictException('تغيّر السجل للتو، حدّث الصفحة');
      await this.core.markStaleFrom(row.month, tx);
    });
    return this.detail(id);
  }

  async detail(id: string) {
    const row = await this.prisma.payrollAdjustment.findUnique({ where: { id }, select: ADJUSTMENT_SELECT });
    if (!row) throw new NotFoundException('السجل غير موجود');
    return out(row);
  }

  async list(actor: HrActor, query: { status?: PayrollAdjustmentStatus; userId?: string; month?: string; kind?: 'EARNING' | 'DEDUCTION' }) {
    const rows = await this.prisma.payrollAdjustment.findMany({
      where: {
        user: await this.core.scopeWhere(actor),
        ...(query.status && { status: query.status }),
        ...(query.userId && { userId: query.userId }),
        ...(query.month && { month: parseMonth(query.month) }),
        ...(query.kind && { kind: query.kind }),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: ADJUSTMENT_SELECT,
    });
    return rows.map(out);
  }

  async mine(userId: string) {
    const rows = await this.prisma.payrollAdjustment.findMany({ where: { userId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 50, select: ADJUSTMENT_SELECT });
    return rows.map(out);
  }
}

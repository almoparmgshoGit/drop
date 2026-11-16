import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FixedExpenseCycle, FixedPaymentSource, GeneralExpenseCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { halalas } from '../../common/utils/payment.util';
import { riyadhDate } from '../../common/utils/time.util';
import { toHalalas, toSar } from '../bookings/bookings.service';
import { CashActor, CashService, readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { EXPENSE_CATEGORY_LABELS } from './general-expenses.service';
import { assertPeriodOpen } from './period-lock';
import { RecordPaymentDto, SaveFixedExpenseDto } from './settlement.dto';

type Db = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const PAGE_SIZE = 30;
const DAY_MS = 86_400_000;
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

export const CYCLE_MONTHS: Record<FixedExpenseCycle, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, VARIABLE: 1 };
export const CYCLE_LABELS: Record<FixedExpenseCycle, string> = { MONTHLY: 'شهريًا', QUARTERLY: 'كل 3 أشهر', SEMIANNUAL: 'كل 6 أشهر', ANNUAL: 'سنويًا', VARIABLE: 'حسب الفاتورة' };
export const SOURCE_LABELS: Record<FixedPaymentSource, string> = { BANK_TRANSFER: 'تحويل بنكي', BRANCH_CASH: 'نقدًا من صندوق الفرع', OWNER_PERSONAL: 'دفعها المالك' };

export const paymentCode = (number: number) => `PAY-${String(number).padStart(4, '0')}`;
export const monthName = (month: string) => `${MONTHS_AR[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const dayName = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS_AR[Number(day.slice(5, 7)) - 1]}`;

/** The month `count` months after `month` (YYYY-MM). */
export const addMonths = (month: string, count: number) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + count, 1)).toISOString().slice(0, 7);
};
const monthsFrom = (first: string, last: string) => {
  const months: string[] = [];
  for (let month = first; month <= last; month = addMonths(month, 1)) months.push(month);
  return months;
};
const dateOf = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const daysUntil = (day: string, today: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

type Contract = Prisma.FixedExpenseGetPayload<{ include: { branch: { select: { name: true } } } }>;

/** Where a contract stops charging: its stop day, else its end, else never. */
const lastDayOf = (contract: Pick<Contract, 'endDate' | 'stoppedAt'>) => {
  const days = [dateOf(contract.endDate), dateOf(contract.stoppedAt)].filter(Boolean) as string[];
  return days.length ? days.sort()[0] : null;
};

/** The month's share of a contract, in halalas: a yearly rent paid once still costs every month its twelfth. */
export const monthlyShare = (contract: Pick<Contract, 'amount' | 'cycle'>) => Math.round(halalas(contract.amount) / CYCLE_MONTHS[contract.cycle]);

/**
 * Rents and other recurring expenses (المصاريف الثابتة), entered once. Posting (الترحيل) charges a month its share on the
 * 1st, whenever the money is actually paid; paying (السداد) is the money leaving, recorded against a due with its receipt.
 * A variable bill has no share of its own: the month is charged what its bill came to.
 */
@Injectable()
export class FixedExpensesService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
  ) {}

  // ───────────────────────────── posting ─────────────────────────────

  /**
   * Writes every month's share due up to `month`, once. Posting starts from the month the contract was entered, so a
   * contract entered late does not reach back into months whose rent was already recorded another way, and it never
   * writes into a month already closed.
   */
  async ensurePostings(month = riyadhDate(new Date()).slice(0, 7), db: Db = this.prisma) {
    const contracts = await db.fixedExpense.findMany({ where: { cycle: { not: 'VARIABLE' } }, select: { id: true, amount: true, cycle: true, startDate: true, endDate: true, stoppedAt: true, createdAt: true } });
    const closed = await db.accountClosing.findMany({ where: { voidedAt: null, kind: 'COMPREHENSIVE', period: { not: 'TRIP' } }, select: { fromDate: true, toDate: true } });
    const isClosed = (key: string) => closed.some((row) => dateOf(row.fromDate)!.slice(0, 7) <= key && key <= dateOf(row.toDate)!.slice(0, 7));
    const rows: Prisma.FixedExpensePostingCreateManyInput[] = [];
    for (const contract of contracts) {
      const first = [dateOf(contract.startDate)!.slice(0, 7), riyadhDate(contract.createdAt).slice(0, 7)].sort()[1];
      const end = lastDayOf(contract);
      const last = [month, ...(end ? [end.slice(0, 7)] : [])].sort()[0];
      for (const key of monthsFrom(first, last)) if (!isClosed(key)) rows.push({ expenseId: contract.id, month: key, amount: toSar(monthlyShare(contract)) });
    }
    if (rows.length) await db.fixedExpensePosting.createMany({ data: rows, skipDuplicates: true });
  }

  /**
   * What fixed expenses cost the given months, row by row: the posted shares, and the variable bills paid for those months.
   * Each row keeps its branch, or says it is shared by every branch or belongs to the head office.
   */
  async monthsExpense(months: string[]) {
    await this.ensurePostings(months[months.length - 1] > riyadhDate(new Date()).slice(0, 7) ? riyadhDate(new Date()).slice(0, 7) : months[months.length - 1]);
    const [postings, bills] = await Promise.all([
      this.prisma.fixedExpensePosting.findMany({
        where: { month: { in: months } },
        select: { month: true, amount: true, expense: { select: { id: true, title: true, category: true, branchId: true, allBranches: true, branch: { select: { name: true } } } } },
      }),
      this.prisma.fixedExpensePayment.findMany({
        where: { voidedAt: null, period: { in: months }, expense: { cycle: 'VARIABLE' } },
        select: { period: true, amount: true, expense: { select: { id: true, title: true, category: true, branchId: true, allBranches: true, branch: { select: { name: true } } } } },
      }),
    ]);
    return [
      ...postings.map((row) => ({ month: row.month, amount: halalas(row.amount), ...row.expense })),
      ...bills.map((row) => ({ month: row.period, amount: halalas(row.amount), ...row.expense })),
    ].map(({ branch, ...row }) => ({ ...row, branchName: branch?.name ?? null, categoryLabel: EXPENSE_CATEGORY_LABELS[row.category] }));
  }

  // ───────────────────────────── contracts ─────────────────────────────

  async list() {
    const today = riyadhDate(new Date());
    await this.ensurePostings();
    const [contracts, payments, ownerDebt] = await Promise.all([
      this.prisma.fixedExpense.findMany({
        orderBy: [{ stoppedAt: { sort: 'asc', nulls: 'first' } }, { category: 'asc' }, { number: 'asc' }],
        include: { branch: { select: { name: true } }, attachments: { select: { id: true, fileName: true, size: true }, orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.fixedExpensePayment.findMany({ where: { voidedAt: null }, select: { expenseId: true, period: true, amount: true, paidOn: true } }),
      this.prisma.fixedExpensePayment.aggregate({ where: { voidedAt: null, source: 'OWNER_PERSONAL' }, _sum: { amount: true } }),
    ]);
    const active = (contract: Contract) => {
      const end = lastDayOf(contract);
      return dateOf(contract.startDate)! <= today && (!end || end >= today);
    };
    const items = contracts.map((contract) => {
      const end = lastDayOf(contract);
      const left = end ? daysUntil(end, today) : null;
      const status = contract.stoppedAt && dateOf(contract.stoppedAt)! < today
        ? 'STOPPED'
        : end && end < today
          ? 'ENDED'
          : dateOf(contract.startDate)! > today
            ? 'UPCOMING'
            : contract.cycle === 'VARIABLE'
              ? 'VARIABLE'
              : !contract.branchId && !contract.allBranches
                ? 'SHARE'
                : left !== null && left <= 60
                  ? 'ENDING'
                  : 'ACTIVE';
      return {
        id: contract.id,
        number: contract.number,
        category: contract.category,
        categoryLabel: EXPENSE_CATEGORY_LABELS[contract.category],
        title: contract.title,
        branchId: contract.branchId,
        branchName: contract.branch?.name ?? null,
        allBranches: contract.allBranches,
        scopeLabel: contract.branch?.name ?? (contract.allBranches ? 'كل الفروع' : 'الإدارة العامة'),
        lessorName: contract.lessorName,
        lessorPhone: contract.lessorPhone,
        amount: Number(contract.amount),
        cycle: contract.cycle,
        cycleLabel: CYCLE_LABELS[contract.cycle],
        monthlyShare: toSar(monthlyShare(contract)),
        dueDay: contract.dueDay,
        startDate: dateOf(contract.startDate),
        endDate: dateOf(contract.endDate),
        stoppedAt: dateOf(contract.stoppedAt),
        stopReason: contract.stopReason,
        notes: contract.notes,
        status,
        daysLeft: left,
        paid: toSar(payments.filter((row) => row.expenseId === contract.id).reduce((sum, row) => sum + halalas(row.amount), 0)),
        attachments: contract.attachments,
        createdByName: contract.createdByName,
      };
    });
    const live = contracts.filter(active);
    const rents = live.filter((contract) => contract.category === 'OFFICE_RENT');
    const dues = await this.dues();
    const soon = dues.items.filter((due) => due.kind !== 'RENEWAL' && due.daysLeft !== null && due.daysLeft <= 30);
    const ending = items.filter((item) => item.status === 'ENDING').sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    return {
      items,
      summary: {
        monthly: toSar(live.reduce((sum, contract) => sum + monthlyShare(contract), 0)),
        rents: toSar(rents.reduce((sum, contract) => sum + monthlyShare(contract), 0)),
        offices: new Set(rents.map((contract) => contract.branchId ?? 'hq')).size,
        dueSoon: { amount: toSar(soon.reduce((sum, due) => sum + toHalalas(due.remaining), 0)), first: soon[0] ? `${soon[0].title} · ${dayName(soon[0].dueDate)}` : null },
        ending: { count: ending.length, first: ending[0] ? `${ending[0].title} · ${dayName(ending[0].stoppedAt ?? ending[0].endDate!)}` : null },
        ownerDebt: Number(ownerDebt._sum.amount ?? 0),
      },
      categories: Object.entries(EXPENSE_CATEGORY_LABELS).map(([key, label]) => ({ key, label })),
      cycles: Object.entries(CYCLE_LABELS).map(([key, label]) => ({ key, label })),
      // Every branch, so whoever manages the contracts can pick one without holding the drawers' permissions.
      branches: await this.prisma.branch.findMany({ select: { id: true, name: true, isActive: true }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
    };
  }

  private async assertBranch(branchId?: string) {
    if (!branchId) return;
    if (!(await this.prisma.branch.count({ where: { id: branchId } }))) throw new BadRequestException('الفرع غير موجود');
  }

  private validate(dto: SaveFixedExpenseDto) {
    if (dto.endDate && dto.endDate < dto.startDate) throw new BadRequestException('نهاية العقد قبل بدايته');
    if (dto.branchId && dto.allBranches) throw new BadRequestException('اختر فرعًا أو كل الفروع');
  }

  async create(actor: CashActor, dto: SaveFixedExpenseDto, files: UploadedInvoice[] = []) {
    this.validate(dto);
    await this.assertBranch(dto.branchId);
    const contract = readInvoiceFiles(files, actor.userId);
    const saved = await this.prisma.fixedExpense.create({
      data: {
        category: dto.category,
        title: dto.title,
        branchId: dto.branchId ?? null,
        allBranches: !dto.branchId && !!dto.allBranches,
        lessorName: dto.lessorName || null,
        lessorPhone: dto.lessorPhone || null,
        amount: dto.amount,
        cycle: dto.cycle,
        dueDay: dto.dueDay,
        startDate: new Date(`${dto.startDate}T00:00:00Z`),
        endDate: dto.endDate ? new Date(`${dto.endDate}T00:00:00Z`) : null,
        notes: dto.notes || null,
        createdById: actor.userId,
        createdByName: actor.name ?? null,
        ...(contract.length && { attachments: { create: contract } }),
      },
    });
    await this.ensurePostings();
    return saved;
  }

  /** Edits apply from now on: a month already posted keeps the share it was charged. */
  async update(id: string, dto: SaveFixedExpenseDto) {
    this.validate(dto);
    await this.assertBranch(dto.branchId);
    const found = await this.prisma.fixedExpense.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('البند غير موجود');
    const saved = await this.prisma.fixedExpense.update({
      where: { id },
      data: {
        category: dto.category,
        title: dto.title,
        branchId: dto.branchId ?? null,
        allBranches: !dto.branchId && !!dto.allBranches,
        lessorName: dto.lessorName || null,
        lessorPhone: dto.lessorPhone || null,
        amount: dto.amount,
        cycle: dto.cycle,
        dueDay: dto.dueDay,
        startDate: new Date(`${dto.startDate}T00:00:00Z`),
        endDate: dto.endDate ? new Date(`${dto.endDate}T00:00:00Z`) : null,
        notes: dto.notes || null,
      },
    });
    await this.ensurePostings();
    return saved;
  }

  async stop(actor: CashActor, id: string, reason: string, stopOn = riyadhDate(new Date())) {
    const updated = await this.prisma.fixedExpense.updateMany({
      where: { id, stoppedAt: null },
      data: { stoppedAt: new Date(`${stopOn}T00:00:00Z`), stoppedByName: actor.name ?? null, stopReason: reason },
    });
    if (updated.count === 0) {
      if (!(await this.prisma.fixedExpense.count({ where: { id } }))) throw new NotFoundException('البند غير موجود');
      throw new ConflictException('هذا البند موقوف مسبقًا');
    }
    return { success: true };
  }

  async attach(actor: CashActor, id: string, files: UploadedInvoice[] = []) {
    if (!files.length) throw new BadRequestException('اختر ملف العقد');
    if (!(await this.prisma.fixedExpense.count({ where: { id } }))) throw new NotFoundException('البند غير موجود');
    const rows = readInvoiceFiles(files, actor.userId);
    await this.prisma.fixedExpenseAttachment.createMany({ data: rows.map((row) => ({ ...row, expenseId: id })) });
    return { success: true };
  }

  async attachment(id: string) {
    const file = await this.prisma.fixedExpenseAttachment.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  // ───────────────────────────── dues and schedule ─────────────────────────────

  /**
   * What falls due, contract by contract: each cycle's payment on its due day, from the month the contract was entered up to
   * 90 days ahead, less what was already paid against it, and a contract's renewal once its end is near.
   */
  async dues() {
    const today = riyadhDate(new Date());
    const horizon = riyadhDate(new Date(Date.now() + 90 * DAY_MS));
    const [contracts, payments] = await Promise.all([
      this.prisma.fixedExpense.findMany({ where: { OR: [{ stoppedAt: null }, { stoppedAt: { gte: new Date(`${today}T00:00:00Z`) } }] }, include: { branch: { select: { name: true } } } }),
      this.prisma.fixedExpensePayment.findMany({ where: { voidedAt: null }, select: { expenseId: true, period: true, amount: true } }),
    ]);
    const paidFor = (id: string, period: string) => payments.filter((row) => row.expenseId === id && row.period === period).reduce((sum, row) => sum + halalas(row.amount), 0);
    const items: {
      key: string;
      expenseId: string;
      title: string;
      branchName: string;
      lessorName: string | null;
      period: string;
      periodLabel: string;
      dueDate: string;
      amount: number;
      paid: number;
      remaining: number;
      kind: 'DUE' | 'BILL' | 'RENEWAL';
      /** When the contract ends, for its renewal. */
      endDate: string | null;
      daysLeft: number | null;
      cycle: FixedExpenseCycle;
      branchId: string | null;
    }[] = [];
    for (const contract of contracts) {
      const step = CYCLE_MONTHS[contract.cycle];
      const start = dateOf(contract.startDate)!.slice(0, 7);
      const entered = riyadhDate(contract.createdAt).slice(0, 7);
      const end = lastDayOf(contract);
      const scope = contract.branch?.name ?? (contract.allBranches ? 'كل الفروع' : 'الإدارة العامة');
      for (let index = 0; ; index += 1) {
        const period = addMonths(start, index * step);
        const dueDate = `${period}-${String(contract.dueDay).padStart(2, '0')}`;
        if (dueDate > horizon) break;
        // A due after the contract's end is its renewal, shown once and only when the end is close.
        if (end && period > end.slice(0, 7)) {
          if (contract.stoppedAt === null && daysUntil(end, today) <= 90) {
            items.push({
              key: `${contract.id}:${period}`,
              expenseId: contract.id,
              title: contract.title,
              branchName: scope,
              lessorName: contract.lessorName,
              period,
              periodLabel: step === 12 ? period.slice(0, 4) : step > 1 ? `${monthName(period)} – ${monthName(addMonths(period, step - 1))}` : monthName(period),
              dueDate,
              amount: Number(contract.amount),
              paid: 0,
              remaining: Number(contract.amount),
              kind: 'RENEWAL',
              endDate: end,
              daysLeft: daysUntil(end, today),
              cycle: contract.cycle,
              branchId: contract.branchId,
            });
          }
          break;
        }
        if (period < entered && addMonths(period, step) <= entered) continue;
        const paid = paidFor(contract.id, period);
        const amount = halalas(contract.amount);
        // A variable bill counts as settled once anything was paid for it: its amount is whatever the bill said.
        const settled = contract.cycle === 'VARIABLE' ? paid > 0 : paid >= amount;
        if (settled) continue;
        items.push({
          key: `${contract.id}:${period}`,
          expenseId: contract.id,
          title: contract.title,
          branchName: scope,
          lessorName: contract.lessorName,
          period,
          periodLabel: step === 12 ? period.slice(0, 4) : step > 1 ? `${monthName(period)} – ${monthName(addMonths(period, step - 1))}` : monthName(period),
          dueDate,
          amount: toSar(amount),
          paid: toSar(paid),
          remaining: toSar(Math.max(0, amount - paid)),
          kind: contract.cycle === 'VARIABLE' ? 'BILL' : 'DUE',
          endDate: end,
          daysLeft: daysUntil(dueDate, today),
          cycle: contract.cycle,
          branchId: contract.branchId,
        });
      }
    }
    return { items: items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)), sources: Object.entries(SOURCE_LABELS).map(([key, label]) => ({ key, label })) };
  }

  /** Posting and paying side by side for the office rents, this month and the two after it. */
  async schedule(from = riyadhDate(new Date()).slice(0, 7)) {
    await this.ensurePostings();
    const months = [from, addMonths(from, 1), addMonths(from, 2)];
    const contracts = await this.prisma.fixedExpense.findMany({
      where: { category: 'OFFICE_RENT', stoppedAt: null },
      orderBy: { number: 'asc' },
      include: {
        branch: { select: { name: true } },
        postings: { where: { month: { in: months } }, select: { month: true, postedAt: true } },
        payments: { where: { voidedAt: null }, select: { period: true, amount: true, paidOn: true } },
      },
    });
    return {
      months: months.map((month) => ({ key: month, label: MONTHS_AR[Number(month.slice(5, 7)) - 1] })),
      rows: contracts.map((contract) => {
        const step = CYCLE_MONTHS[contract.cycle];
        const start = dateOf(contract.startDate)!.slice(0, 7);
        const end = lastDayOf(contract);
        return {
          expenseId: contract.id,
          title: contract.title,
          branchName: contract.branch?.name ?? 'الإدارة العامة',
          cells: months.map((month) => {
            const offset = (Number(month.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(month.slice(5, 7)) - Number(start.slice(5, 7));
            const dueHere = offset >= 0 && offset % step === 0;
            const paid = dueHere ? contract.payments.filter((row) => row.period === month).reduce((sum, row) => sum + halalas(row.amount), 0) : 0;
            const lastPaid = contract.payments.filter((row) => row.period === month).sort((a, b) => b.paidOn.getTime() - a.paidOn.getTime())[0];
            const posting = contract.postings.find((row) => row.month === month);
            return {
              month,
              /** The contract has run out by this month: renew it or let it go. */
              afterEnd: !!end && month > end.slice(0, 7),
              posted: posting ? riyadhDate(posting.postedAt) : null,
              postsOn: `${month}-01`,
              due: dueHere ? { amount: Number(contract.amount), dueDate: `${month}-${String(contract.dueDay).padStart(2, '0')}`, paid: toSar(paid), paidOn: lastPaid ? dateOf(lastPaid.paidOn) : null } : null,
              /** A share already covered by an earlier payment of a longer cycle. */
              coveredByEarlier: !dueHere && step > 1,
            };
          }),
        };
      }),
    };
  }

  // ───────────────────────────── payments ─────────────────────────────

  async payments(page = 1) {
    const [rows, total] = await Promise.all([
      this.prisma.fixedExpensePayment.findMany({
        orderBy: { number: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          expense: { select: { title: true, cycle: true } },
          branch: { select: { name: true } },
          attachments: { select: { id: true, fileName: true, size: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
      this.prisma.fixedExpensePayment.count(),
    ]);
    return {
      page,
      pageSize: PAGE_SIZE,
      total,
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        code: paymentCode(row.number),
        expenseId: row.expenseId,
        title: row.expense.title,
        period: row.period,
        periodLabel: row.expense.cycle === 'ANNUAL' ? `${row.period.slice(0, 4)} كاملة` : monthName(row.period),
        amount: Number(row.amount),
        paidOn: dateOf(row.paidOn),
        source: row.source,
        sourceLabel: row.source === 'BRANCH_CASH' && row.branch ? `نقدًا من صندوق ${row.branch.name}` : SOURCE_LABELS[row.source],
        note: row.note,
        createdByName: row.createdByName,
        createdAt: row.createdAt,
        voidedAt: row.voidedAt,
        voidedByName: row.voidedByName,
        voidReason: row.voidReason,
        attachments: row.attachments,
      })),
    };
  }

  async record(actor: CashActor, dto: RecordPaymentDto, files: UploadedInvoice[] = []) {
    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;
    const repeated = await this.prisma.fixedExpensePayment.findUnique({ where: { idempotencyKey } });
    if (repeated) return repeated;
    // Nothing leaves the company's money without the paper behind it.
    if (files.length === 0) throw new BadRequestException('ارفع سند القبض أو إيصال التحويل');
    const receipts = readInvoiceFiles(files, actor.userId);
    const today = riyadhDate(new Date());
    if (dto.paidOn > today) throw new BadRequestException('لا يمكن تسجيل دفعة بتاريخ لاحق');

    const contract = await this.prisma.fixedExpense.findUnique({ where: { id: dto.expenseId }, select: { id: true, branchId: true, startDate: true } });
    if (!contract) throw new NotFoundException('البند غير موجود');
    if (dto.period < dateOf(contract.startDate)!.slice(0, 7)) throw new BadRequestException('الفترة قبل بداية العقد');

    let branchId: string | null = null;
    if (dto.source === 'BRANCH_CASH') {
      if (!actor.permissions.includes('cash.operate')) throw new ForbiddenException('الصرف من الصندوق يحتاج صلاحية تشغيل الصندوق');
      branchId = dto.branchId ?? contract.branchId;
      if (!branchId) throw new BadRequestException('اختر الفرع الذي يُصرف من صندوقه');
      await this.cash.assertBranchAccess(actor, branchId);
      // Cash leaves today's drawer, so it is paid today.
      if (dto.paidOn !== today) throw new BadRequestException('الدفع النقدي من الصندوق يُسجَّل بتاريخ اليوم');
    }
    await assertPeriodOpen(this.prisma, dto.paidOn);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const payment = await tx.fixedExpensePayment.create({
          data: {
            expenseId: dto.expenseId,
            period: dto.period,
            amount: dto.amount,
            paidOn: new Date(`${dto.paidOn}T00:00:00Z`),
            source: dto.source,
            branchId,
            note: dto.note || null,
            idempotencyKey,
            createdById: actor.userId,
            createdByName: actor.name ?? null,
            attachments: { create: receipts },
          },
        });
        if (branchId) await this.cash.ledgerMovement(tx, actor, branchId, 'EXPENSE_PAYMENT', dto.amount, { fixedPaymentId: payment.id });
        return payment;
      }, TX_OPTIONS);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.fixedExpensePayment.findUnique({ where: { idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** A payment is never deleted: it is voided with its reason, and cash taken from a drawer goes back in by a reversing entry. */
  async void(actor: CashActor, id: string, reason: string) {
    const payment = await this.prisma.fixedExpensePayment.findUnique({ where: { id }, select: { voidedAt: true, paidOn: true, source: true, branchId: true, amount: true } });
    if (!payment) throw new NotFoundException('الدفعة غير موجودة');
    if (payment.voidedAt) throw new ConflictException('هذه الدفعة ملغاة مسبقًا');
    await assertPeriodOpen(this.prisma, dateOf(payment.paidOn)!);
    if (payment.source === 'BRANCH_CASH' && payment.branchId) {
      if (!actor.permissions.includes('cash.operate')) throw new ForbiddenException('إرجاع المبلغ إلى الصندوق يحتاج صلاحية تشغيل الصندوق');
      await this.cash.assertBranchAccess(actor, payment.branchId);
    }
    return this.prisma.$transaction(async (tx) => {
      const voided = await tx.fixedExpensePayment.updateMany({ where: { id, voidedAt: null }, data: { voidedAt: new Date(), voidedByName: actor.name ?? null, voidReason: reason } });
      if (voided.count === 0) throw new ConflictException('هذه الدفعة ملغاة مسبقًا');
      if (payment.source === 'BRANCH_CASH' && payment.branchId) {
        await this.cash.ledgerMovement(tx, actor, payment.branchId, 'EXPENSE_REVERSAL', Number(payment.amount), { fixedPaymentId: id });
      }
      return { success: true };
    }, TX_OPTIONS);
  }

  /** What the owner paid from his own pocket and the company now owes him. */
  async ownerDebt() {
    const total = await this.prisma.fixedExpensePayment.aggregate({ where: { voidedAt: null, source: 'OWNER_PERSONAL' }, _sum: { amount: true } });
    return Number(total._sum.amount ?? 0);
  }

  categoryLabel(category: GeneralExpenseCategory) {
    return EXPENSE_CATEGORY_LABELS[category];
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneralExpenseCategory, Prisma } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { vatInside } from '../../common/utils/invoice.util';
import { halalas, netBookingFigures } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDaysRange } from '../../common/utils/time.util';
import { toSar } from '../bookings/bookings.service';
import { CashActor, CashService, custodyCode as custodyCodeOf } from '../cash/cash.service';
import { columnOf, SHARED_COLUMN, TripAccountsService } from '../invoices/trip-accounts.service';
import { ClosingsService } from './closings.service';
import { addMonths, FixedExpensesService, monthName } from './fixed-expenses.service';
import { remittanceCode, RemittancesService } from './remittances.service';

const DAY_MS = 86_400_000;
/** The month is settled by the 5th of the month after it. */
export const SETTLEMENT_DUE_DAY = 5;
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const QUARTERS_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع'];
const sar = (value: number) => Math.round(value) / 100;
const dayName = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS_AR[Number(day.slice(5, 7)) - 1]}`;
const lastDayOf = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};
const monthsFrom = (first: string, last: string) => {
  const months: string[] = [];
  for (let month = first; month <= last; month = addMonths(month, 1)) months.push(month);
  return months;
};

/** A column of the branch statement: a branch, the app's own bookings, or the head office's sales without a branch. */
type ColumnKind = 'BRANCH' | 'APP' | 'HQ';
type Column = { key: string; name: string; kind: ColumnKind; isActive: boolean };

/** One column's money for a period, in halalas. */
type Figures = {
  revenue: number;
  vat: number;
  tripCosts: number;
  rent: number;
  utilities: number;
  salaries: number;
  commissions: number;
  other: number;
  adminShare: number;
  bookings: number;
  passengers: number;
  cancellations: number;
  collected: number;
  remaining: number;
  cashDifferences: number;
};
const zero = (): Figures => ({ revenue: 0, vat: 0, tripCosts: 0, rent: 0, utilities: 0, salaries: 0, commissions: 0, other: 0, adminShare: 0, bookings: 0, passengers: 0, cancellations: 0, collected: 0, remaining: 0, cashDifferences: 0 });
const costsOf = (f: Figures) => f.tripCosts + f.rent + f.utilities + f.salaries + f.commissions + f.other + f.adminShare;
const expensesOf = (f: Figures) => f.vat + costsOf(f);
const netOf = (f: Figures) => f.revenue - expensesOf(f);

const APP_KEY = 'APP';
const HQ_KEY = 'HQ';

/** Where an office expense lands on the statement. */
const lineOf = (category: GeneralExpenseCategory): 'rent' | 'utilities' | 'commissions' | 'other' =>
  category === 'OFFICE_RENT' ? 'rent' : category === 'UTILITIES' || category === 'TELECOM' ? 'utilities' : category === 'MARKETER_COMMISSION' ? 'commissions' : 'other';

/** The statement's rows, in order: revenue, then every cost, then the branch's net. */
const STATEMENT_ROWS: { key: keyof Figures | 'net'; label: string; sign: 1 | -1; emphasis?: boolean }[] = [
  { key: 'revenue', label: 'إجمالي الإيراد (شامل الضريبة)', sign: 1, emphasis: true },
  { key: 'vat', label: 'ضريبة القيمة المضافة', sign: -1 },
  { key: 'tripCosts', label: 'تكاليف الرحلات (باص · فنادق · سائق)', sign: -1 },
  { key: 'rent', label: 'إيجار المكتب', sign: -1 },
  { key: 'utilities', label: 'كهرباء واتصالات', sign: -1 },
  { key: 'salaries', label: 'رواتب موظفي الفرع', sign: -1 },
  { key: 'commissions', label: 'عمولات المسوّقين', sign: -1 },
  { key: 'other', label: 'مصاريف تشغيلية أخرى', sign: -1 },
  { key: 'adminShare', label: 'حصة المصاريف الإدارية العامة', sign: -1 },
  { key: 'net', label: 'صافي ربح الفرع', sign: 1, emphasis: true },
];

type StepState = 'done' | 'auto' | 'todo' | 'review' | 'na';
type Step = { key: string; title: string; detail: string; state: StepState; badge: string; link: string; linkLabel: string };

/**
 * The monthly settlement (التصفية الشهرية): every branch's profit after all its costs, where the month's cash went, and the
 * eight checks that must pass before the accountant approves the month and the owner closes it for good. Branch
 * performance and the owner's phone page read the same figures.
 */
@Injectable()
export class SettlementService {
  constructor(
    private prisma: PrismaService,
    private accounts: TripAccountsService,
    private fixed: FixedExpensesService,
    private remittances: RemittancesService,
    private cash: CashService,
    private ledger: InvoiceLedgerService,
    private notifications: NotificationsService,
    private closings: ClosingsService,
  ) {}

  // ───────────────────────────── the figures ─────────────────────────────

  /**
   * Each column's revenue and costs over a period. A trip's revenue and its costs reach the columns whose bookings sold it,
   * by their share of its tickets, as posted when the trip's account was closed (TripProfitPosting): a trip not closed yet
   * adds nothing. Head-office costs are then shared by every column's share of the revenue.
   */
  async figures(from: string, to: string) {
    const range = riyadhDaysRange(from, to);
    if (!range) throw new BadRequestException('التاريخ غير صحيح');
    const days = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
    const months = monthsFrom(from.slice(0, 7), to.slice(0, 7));

    const [trips, branches, vatRate] = await Promise.all([
      this.accounts.list({ view: 'month', date: from, from, to }),
      this.prisma.branch.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } }),
      this.ledger.vatRate(this.prisma),
    ]);
    const legOf = new Map<string, string>();
    for (const item of trips.items) for (const leg of item.legs) legOf.set(leg.id, item.id);

    const columns = new Map<string, Column>(branches.map((branch) => [branch.id, { key: branch.id, name: branch.name, kind: 'BRANCH' as const, isActive: branch.isActive }]));
    columns.set(APP_KEY, { key: APP_KEY, name: 'التطبيق', kind: 'APP', isActive: true });
    const figures = new Map<string, Figures>();
    const of = (key: string) => figures.get(key) ?? figures.set(key, zero()).get(key)!;
    // What belongs to no branch: head-office expenses and salaries, shared out by revenue at the end.
    let pool = 0;

    // Accounts closed before profits were posted are posted now, dated when they were closed.
    await this.accounts.postMissing();
    const [postings, bookings, generals, custodies, fixedRows, runs, settlements, sessions] = await Promise.all([
      this.prisma.tripProfitPosting.findMany({ where: { postedAt: range }, select: { columnKey: true, revenue: true, costs: true } }),
      legOf.size
        ? this.prisma.booking.findMany({
            where: { tripId: { in: [...legOf.keys()] } },
            select: {
              tripId: true,
              source: true,
              branchId: true,
              status: true,
              totalPrice: true,
              vatAmount: true,
              refundAmount: true,
              externalRefunded: true,
              payment: { select: { amount: true, walletAmount: true, status: true } },
              collections: { select: { amount: true } },
              cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
              _count: { select: { passengers: { where: { cancelled: false } } } },
            },
          })
        : [],
      this.prisma.generalExpense.findMany({ where: { voidedAt: null, spentOn: days }, select: { category: true, amount: true, branchId: true } }),
      this.prisma.custody.findMany({ where: { tripId: null, status: 'SETTLED', settledAt: range }, select: { branchId: true, spentAmount: true } }),
      this.fixed.monthsExpense(months),
      this.prisma.payrollRun.findMany({ where: { month: { in: months }, status: { not: 'DRAFT' } }, select: { lines: { select: { branchName: true, gross: true, gosiEmployer: true } } } }),
      this.prisma.finalSettlement.findMany({ where: { status: 'PAID', paidAt: range }, select: { net: true, user: { select: { branchId: true } } } }),
      this.prisma.cashSession.findMany({ where: { businessDate: days, status: 'CLOSED' }, select: { branchId: true, difference: true } }),
    ]);

    // Booking counts, VAT and cash are each column's by the trips that left in the period. The trips' profit is not: it reaches
    // a column only through the postings made when each trip's account was closed (below).
    for (const booking of bookings) {
      const key = columnOf(booking);
      const f = of(key);
      const net = netBookingFigures(booking);
      const sold = booking.status === 'CANCELLED' ? net.held : halalas(booking.totalPrice);
      // The VAT priced into the booking, or what is inside the money kept from a cancelled one.
      f.vat += booking.status === 'CANCELLED' ? vatInside(net.held, vatRate) : halalas(booking.vatAmount) > 0 ? halalas(booking.vatAmount) : vatInside(sold, vatRate);
      f.collected += net.held;
      f.remaining += net.remaining;
      if (booking.status === 'CANCELLED') f.cancellations += 1;
      else {
        f.bookings += 1;
        f.passengers += booking._count.passengers;
      }
    }
    // Each closed trip's profit as posted to the columns when its account closed, and any adjustment since, in the month
    // it was posted: so a trip counts once, and a change after reopening counts only by its difference.
    for (const posting of postings) {
      const revenue = halalas(posting.revenue);
      const costs = halalas(posting.costs);
      if (posting.columnKey === SHARED_COLUMN) {
        // Nothing was sold on it: what it earned or cost is the company's, shared like the head office.
        pool += costs - revenue;
        continue;
      }
      const f = of(posting.columnKey);
      f.revenue += revenue;
      f.tripCosts += costs;
    }
    if (figures.has(HQ_KEY)) columns.set(HQ_KEY, { key: HQ_KEY, name: 'الإدارة العامة', kind: 'HQ', isActive: true });

    const activeBranches = [...columns.values()].filter((column) => column.kind === 'BRANCH' && column.isActive);
    const charge = (branchId: string | null, line: keyof Figures, amount: number, everyBranch = false) => {
      if (branchId && columns.has(branchId)) of(branchId)[line] += amount;
      else if (everyBranch && activeBranches.length) {
        // Shared equally, with the halalas left over on the first branch so nothing is lost to rounding.
        const each = Math.floor(amount / activeBranches.length);
        activeBranches.forEach((column, index) => (of(column.key)[line] += each + (index === 0 ? amount - each * activeBranches.length : 0)));
      } else pool += amount;
    };
    for (const row of generals) charge(row.branchId, lineOf(row.category), halalas(row.amount));
    for (const row of custodies) charge(row.branchId, 'other', halalas(row.spentAmount ?? 0));
    for (const row of fixedRows) charge(row.branchId, lineOf(row.category), row.amount, row.allBranches);
    const branchByName = new Map(branches.map((branch) => [branch.name, branch.id]));
    for (const run of runs) for (const line of run.lines) charge((line.branchName && branchByName.get(line.branchName)) || null, 'salaries', halalas(line.gross) + halalas(line.gosiEmployer));
    for (const row of settlements) charge(row.user.branchId, 'salaries', halalas(row.net));
    for (const row of sessions) if (columns.has(row.branchId)) of(row.branchId).cashDifferences += halalas(row.difference ?? 0);

    // Head-office costs by each column's share of the revenue; with no revenue at all, equally across the branches.
    const earning = [...figures.entries()].filter(([key, f]) => columns.has(key) && f.revenue > 0);
    const revenueTotal = earning.reduce((sum, [, f]) => sum + f.revenue, 0);
    const sharers = revenueTotal > 0 ? earning.map(([key, f]) => ({ key, weight: f.revenue })) : activeBranches.map((column) => ({ key: column.key, weight: 1 }));
    const weightTotal = sharers.reduce((sum, row) => sum + row.weight, 0);
    let given = 0;
    sharers.forEach((row, index) => {
      const share = index === sharers.length - 1 ? pool - given : Math.round((pool * row.weight) / weightTotal);
      given += share;
      of(row.key).adminShare += share;
    });

    // Every active branch and the app show, even on a quiet month; an inactive branch or the head office only with figures.
    const shown = [...columns.values()].filter((column) => column.kind === 'APP' || (column.kind === 'BRANCH' && column.isActive) || figures.has(column.key));
    const order: Record<ColumnKind, number> = { BRANCH: 0, APP: 1, HQ: 2 };
    shown.sort((a, b) => order[a.kind] - order[b.kind] || (figures.get(b.key)?.revenue ?? 0) - (figures.get(a.key)?.revenue ?? 0));
    const total = zero();
    for (const column of shown) {
      const f = of(column.key);
      for (const key of Object.keys(total) as (keyof Figures)[]) total[key] += f[key];
    }
    return { columns: shown, figures, total, trips: trips.items, unshared: shown.length === 0 ? pool : 0 };
  }

  /** The branch profit statement as rows by columns, in riyals. */
  private statement(data: Awaited<ReturnType<SettlementService['figures']>>) {
    const value = (f: Figures, key: keyof Figures | 'net') => (key === 'net' ? netOf(f) : f[key]);
    const rows = STATEMENT_ROWS.map((row) => ({
      key: row.key,
      label: row.label,
      emphasis: !!row.emphasis,
      values: Object.fromEntries(data.columns.map((column) => [column.key, sar(row.sign * value(data.figures.get(column.key) ?? zero(), row.key))])),
      total: sar(row.sign * value(data.total, row.key)),
    }))
      // A cost nobody had stays off the statement, except the lines every branch is expected to carry.
      .filter((row) => ['revenue', 'vat', 'tripCosts', 'rent', 'salaries', 'adminShare', 'net'].includes(row.key) || row.total !== 0);
    return { columns: data.columns.map(({ key, name, kind }) => ({ key, name, kind })), rows };
  }

  /** Where the period's money went, branch by branch: cash into drawers, cards straight to the bank, remitted, and still waiting. */
  private async cashFlow(columns: Column[], range: { gte: Date; lt: Date }, withWaiting: boolean) {
    const [collections, online, remitted] = await Promise.all([
      this.prisma.bookingCollection.groupBy({ by: ['branchId', 'method'], where: { createdAt: range }, _sum: { amount: true } }),
      this.prisma.paymentTransaction.aggregate({ where: { type: 'CHARGE', status: 'SUCCEEDED', processedById: null, createdAt: range }, _sum: { amount: true } }),
      this.remittances.periodFigures(range),
    ]);
    const waiting = new Map<string, number>();
    if (withWaiting) {
      for (const column of columns.filter((row) => row.kind === 'BRANCH')) {
        waiting.set(column.key, (await this.cash.unremittedSessions(this.prisma, column.key)).reduce((sum, row) => sum + row.net, 0));
      }
    }
    const branchCols = columns.filter((column) => column.kind !== 'HQ');
    const sumOf = (branchId: string, methods: string[]) =>
      collections.filter((row) => row.branchId === branchId && methods.includes(row.method)).reduce((sum, row) => sum + halalas(row._sum.amount ?? 0), 0);
    const cell = (column: Column, key: 'cash' | 'bank' | 'remitted' | 'waiting'): number | null => {
      if (column.kind === 'APP') return key === 'bank' ? halalas(online._sum.amount ?? 0) : null;
      if (key === 'cash') return sumOf(column.key, ['CASH']);
      if (key === 'bank') return sumOf(column.key, ['NETWORK', 'TRANSFER']);
      if (key === 'remitted') return remitted.byBranch.get(column.key) ?? 0;
      return waiting.get(column.key) ?? 0;
    };
    const rows = (
      [
        { key: 'cash', label: 'النقد المحصّل في الصناديق' },
        { key: 'bank', label: 'شبكة ومدى وحوالات (يدخل البنك مباشرة)' },
        { key: 'remitted', label: 'المورَّد للمالك أو البنك' },
        ...(withWaiting ? [{ key: 'waiting', label: 'نقد لم يُورَّد بعد', emphasis: true }] : []),
      ] as { key: 'cash' | 'bank' | 'remitted' | 'waiting'; label: string; emphasis?: boolean }[]
    ).map((row) => {
      const values = Object.fromEntries(branchCols.map((column) => [column.key, cell(column, row.key)]));
      return {
        key: row.key,
        label: row.label,
        emphasis: !!row.emphasis,
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : sar(value)])),
        total: sar(Object.values(values).reduce<number>((sum, value) => sum + (value ?? 0), 0)),
      };
    });
    return { columns: branchCols.map(({ key, name, kind }) => ({ key, name, kind })), rows, pending: { count: remitted.pending.count, amount: sar(remitted.pending.amount) }, unexplained: remitted.unexplained };
  }

  // ───────────────────────────── the monthly settlement ─────────────────────────────

  private async standing(month: string) {
    const closing = await this.prisma.accountClosing.findFirst({
      where: { voidedAt: null, kind: 'COMPREHENSIVE', period: 'MONTH', fromDate: new Date(`${month}-01T00:00:00Z`), toDate: new Date(`${lastDayOf(month)}T00:00:00Z`) },
      select: { id: true, number: true, createdAt: true, createdByName: true, note: true, report: true },
    });
    const approval = closing ? await this.prisma.monthSettlementApproval.findUnique({ where: { closingId: closing.id } }) : null;
    return { closing, approval };
  }

  async monthly(month = riyadhDate(new Date()).slice(0, 7)) {
    const today = riyadhDate(new Date());
    const from = `${month}-01`;
    const to = lastDayOf(month);
    const range = riyadhDaysRange(from, to)!;
    const ended = to < today;
    const due = `${addMonths(month, 1)}-${String(SETTLEMENT_DUE_DAY).padStart(2, '0')}`;
    const { closing, approval } = await this.standing(month);

    const saved = (closing?.report as { settlement?: Record<string, unknown> } | null)?.settlement;
    const data = await this.figures(from, to);
    const live = {
      kpis: this.kpis(data, month, today),
      statement: this.statement(data),
      cashFlow: await this.cashFlow(data.columns, range, true),
    };
    const steps = await this.steps(month, data, today);
    const blocking = steps.filter((step) => step.state === 'todo');
    return {
      month,
      label: monthName(month),
      from,
      to: ended ? to : today,
      isCurrent: from <= today && today <= to,
      ended,
      dueDate: due,
      daysLeft: Math.max(0, Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)),
      state: approval ? 'LOCKED' : closing ? 'AWAITING_OWNER' : 'OPEN',
      closing: closing && { id: closing.id, number: closing.number, createdAt: closing.createdAt, createdByName: closing.createdByName, note: closing.note },
      ownerApproval: approval && { approvedByName: approval.approvedByName, approvedAt: approval.approvedAt },
      // Once approved, the month reads as it was approved; the steps stay live so a later change still shows.
      ...(saved ? { kpis: saved.kpis, statement: saved.statement, cashFlow: saved.cashFlow, frozen: true } : { ...live, frozen: false }),
      steps,
      canApprove: ended && !closing && blocking.length === 0,
      blockers: blocking.map((step) => step.title),
      months: [addMonths(month, -1), month, addMonths(month, 1)].map((key) => ({ key, label: monthName(key) })),
    };
  }

  private kpis(data: Awaited<ReturnType<SettlementService['figures']>>, month: string, today: string) {
    const current = today.slice(0, 7) === month;
    return {
      revenue: sar(data.total.revenue),
      revenueNote: `${current ? `حتى ${dayName(today)}` : `شهر ${MONTHS_AR[Number(month.slice(5, 7)) - 1]}`} · كل الفروع`,
      expenses: sar(expensesOf(data.total)),
      expensesNote: 'الضريبة والتشغيلية والثابتة والرواتب',
      net: sar(netOf(data.total)),
      netNote: current ? 'الشهر لم يكتمل · الإيجار يُحسب كاملًا' : netOf(data.total) >= 0 ? 'ربح الشهر' : 'خسارة الشهر',
    };
  }

  /** The eight checks of the month. A "todo" step holds the approval back; a "review" step is shown but does not. */
  private async steps(month: string, data: Awaited<ReturnType<SettlementService['figures']>>, today: string): Promise<Step[]> {
    const from = `${month}-01`;
    const to = lastDayOf(month);
    const range = riyadhDaysRange(from, to)!;
    const days = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
    const lastCountable = [to, riyadhDate(new Date(Date.now() - DAY_MS))].sort()[0];
    const branches = await this.prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true } });

    const [sessions, lastClosed, openCustodies, lastSettled, run, staff, unprofiled, bankWaiting, remittanceWaiting, unremittedHere, fixedCount, online] = await Promise.all([
      this.prisma.cashSession.findMany({ where: { businessDate: days }, select: { branchId: true, status: true, businessDate: true } }),
      Promise.all(branches.map((branch) => this.prisma.cashSession.findFirst({ where: { branchId: branch.id, status: 'CLOSED', businessDate: { lte: days.lte } }, orderBy: { businessDate: 'desc' }, select: { businessDate: true, difference: true, closeNote: true } }).then((row) => ({ branch, row })))),
      this.prisma.custody.findMany({ where: { status: 'OPEN', issuedAt: { lt: range.lt } }, select: { number: true } }),
      this.prisma.custody.findFirst({ where: { status: 'SETTLED', settledAt: range }, orderBy: { settledAt: 'desc' }, select: { number: true } }),
      this.prisma.payrollRun.findUnique({ where: { month }, select: { status: true } }),
      this.prisma.user.count({ where: { role: 'STAFF' } }),
      this.prisma.user.count({ where: { role: 'STAFF', employeeProfile: null } }),
      this.prisma.cashRemittance.count({ where: { method: 'BANK_DEPOSIT', status: { in: ['PENDING', 'RECEIVED'] }, createdAt: { lt: range.lt } } }),
      this.prisma.cashRemittance.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      Promise.all(branches.map((branch) => this.cash.unremittedSessions(this.prisma, branch.id))).then((lists) => lists.flat().filter((row) => row.businessDate <= to)),
      this.prisma.fixedExpense.count({ where: { startDate: { lte: days.lte }, OR: [{ stoppedAt: null }, { stoppedAt: { gte: days.gte } }] } }),
      this.prisma.paymentTransaction.aggregate({ where: { type: 'CHARGE', status: 'SUCCEEDED', processedById: null, createdAt: range }, _sum: { amount: true } }),
    ]);
    const unexplained = await this.prisma.cashRemittance.count({ where: { status: { in: ['DIFFERENCE', 'REJECTED'] }, justifiedAt: null } });
    const steps: Step[] = [];

    // 1. Drawers.
    const stale = sessions.filter((row) => row.status === 'OPEN' && riyadhDate(row.businessDate) < today);
    let missing = 0;
    if (from <= lastCountable) {
      for (const branch of branches) {
        const seen = new Set(sessions.filter((row) => row.branchId === branch.id).map((row) => row.businessDate.toISOString().slice(0, 10)));
        for (let day = from; day <= lastCountable; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) if (!seen.has(day)) missing += 1;
      }
    }
    const closings = lastClosed
      .filter((row) => row.row)
      .slice(0, 2)
      .map(({ branch, row }) => {
        const difference = halalas(row!.difference ?? 0);
        return `آخر إقفال ل${branch.name} ${dayName(row!.businessDate.toISOString().slice(0, 10))}${difference ? ` · الفرق ${difference > 0 ? '+' : '−'}${sar(Math.abs(difference))} ر.س${row!.closeNote ? ' بسبب مكتوب' : ''}` : ''}`;
      });
    steps.push({
      key: 'drawers',
      title: 'إقفال صناديق الفروع اليومية',
      detail: stale.length ? `${stale.length} صندوق من أيام سابقة ما زال مفتوحًا` : closings.join(' · ') || 'لم يُفتح صندوق في هذا الشهر',
      state: stale.length ? 'todo' : missing ? 'review' : 'done',
      badge: stale.length ? 'صندوق مفتوح' : missing ? `ناقص ${missing} ${missing > 10 ? 'يومًا' : 'أيام'}` : 'مكتمل',
      link: '/cash',
      linkLabel: 'فتح الصندوق والعهد',
    });

    // 2. Trips.
    const awaiting = data.trips.filter((trip) => trip.closing === 'AWAITING_CLOSE').length;
    const notRun = data.trips.filter((trip) => trip.closing === 'OPEN' && riyadhDate(new Date(trip.departureTime)) < today).length;
    steps.push({
      key: 'trips',
      title: 'الإغلاق المالي للرحلات المنفذة',
      detail: awaiting ? `${awaiting} رحلة منفذة بانتظار الإغلاق المالي، ولا يدخل ربحها في التصفية قبل الإغلاق` : notRun ? `${notRun} رحلة مضى موعدها ولم تُنفذ` : data.trips.length ? 'كل رحلات الشهر المنفذة مغلقة ماليًا' : 'لا توجد رحلات في هذا الشهر',
      state: awaiting || notRun ? 'todo' : 'done',
      badge: awaiting ? `${awaiting} رحلات` : notRun ? `${notRun} لم تُنفذ` : 'مكتمل',
      link: '/trip-accounts',
      linkLabel: 'فتح حساب الرحلات',
    });

    // 3. Custodies.
    steps.push({
      key: 'custodies',
      title: 'تسوية العُهد',
      detail: openCustodies.length
        ? `${openCustodies.length} عهدة مفتوحة: ${openCustodies.slice(0, 3).map((row) => custodyCodeOf(row.number)).join('، ')}`
        : `لا توجد عهد مفتوحة${lastSettled ? ` · ${custodyCodeOf(lastSettled.number)} مسوّاة` : ''}`,
      state: openCustodies.length ? 'todo' : 'done',
      badge: openCustodies.length ? `${openCustodies.length} مفتوحة` : 'مكتمل',
      link: '/cash',
      linkLabel: 'فتح العهد',
    });

    // 4. What customers still owe.
    const owing = data.trips.filter((trip) => trip.remaining > 0 && riyadhDate(new Date(trip.departureTime)) < today);
    const owed = owing.reduce((sum, trip) => sum + halalas(trip.remaining), 0);
    steps.push({
      key: 'remaining',
      title: 'مراجعة المتبقي والتحصيل',
      detail: owed ? `${sar(owed)} ر.س متبقٍ على حجوزات ${owing.length} رحلة مضت` : 'لا متبقٍ على رحلات مضت',
      state: owed ? 'review' : 'done',
      badge: owed ? 'تحتاج قرار' : 'مكتمل',
      link: '/collections',
      linkLabel: 'فتح المتبقي',
    });

    // 5. Fixed expenses.
    steps.push({
      key: 'fixed',
      title: 'ترحيل المصاريف الثابتة',
      detail: fixedCount ? 'إيجارات المكاتب والكهرباء والاتصالات · تُرحَّل تلقائيًا يوم 1' : 'لم تُسجَّل مصاريف ثابتة ولا عقود إيجار بعد',
      state: fixedCount ? 'auto' : 'review',
      badge: fixedCount ? 'مُرحّلة تلقائيًا' : 'غير مسجلة',
      link: '/fixed-expenses',
      linkLabel: 'فتح المصاريف الثابتة',
    });

    // 6. Payroll.
    const payrollReady = run && run.status !== 'DRAFT';
    steps.push({
      key: 'payroll',
      title: 'اعتماد مسيّر الرواتب والعمولات',
      detail: !run
        ? 'لم يُنشأ مسيّر رواتب هذا الشهر'
        : run.status === 'DRAFT'
          ? 'مسيّر الشهر مسودة لم يُعتمد'
          : unprofiled
            ? `${unprofiled} من ${staff} موظفين بلا ملف وظيفي · لا يمكن احتساب رواتبهم`
            : run.status === 'PAID'
              ? 'المسيّر معتمد ومصروف'
              : 'المسيّر معتمد',
      state: !payrollReady ? 'todo' : unprofiled ? 'review' : 'done',
      badge: !run ? 'غير منشأ' : run.status === 'DRAFT' ? 'مسودة' : unprofiled ? 'ناقص' : 'مكتمل',
      link: '/hr/payroll',
      linkLabel: 'فتح الموارد البشرية',
    });

    // 7. Bank and gateway.
    const gatewayLive = this.remittances.gatewayLive();
    const appMoney = sar(halalas(online._sum.amount ?? 0));
    steps.push({
      key: 'bank',
      title: 'مطابقة البنك والبوابة',
      detail: bankWaiting
        ? `${bankWaiting} إيداع بنكي بانتظار المطابقة مع كشف البنك`
        : gatewayLive
          ? `طابق ${appMoney} ر.س من التطبيق مع كشف البنك`
          : `بوابة الدفع غير مربوطة · ${appMoney} ر.س من التطبيق «محاكاة»`,
      state: bankWaiting ? 'todo' : gatewayLive ? 'review' : 'na',
      badge: bankWaiting ? `${bankWaiting} للمطابقة` : gatewayLive ? 'راجِع' : 'غير مربوطة',
      link: bankWaiting ? '/remittances' : '/payments',
      linkLabel: bankWaiting ? 'فتح التوريدات' : 'فتح المدفوعات',
    });

    // 8. Cash to the owner.
    const waitingCash = unremittedHere.reduce((sum, row) => sum + row.net, 0);
    const parts = [
      remittanceWaiting._count ? `${remittanceWaiting._count} توريد بانتظار تأكيدك · ${sar(halalas(remittanceWaiting._sum.amount ?? 0))} ر.س` : null,
      waitingCash > 0 ? `${sar(waitingCash)} ر.س في صناديق مقفلة لم تُورَّد` : null,
      unexplained ? `${unexplained} فرق توريد لم يُبرَّر` : null,
    ].filter(Boolean);
    steps.push({
      key: 'remittances',
      title: 'توريد النقد للمالك وتأكيد الاستلام',
      detail: parts.join(' · ') || 'كل نقد الشهر مورَّد ومؤكد',
      state: parts.length ? 'todo' : 'done',
      badge: remittanceWaiting._count ? 'بانتظارك' : parts.length ? 'ناقص' : 'مكتمل',
      link: '/remittances',
      linkLabel: 'فتح التوريدات',
    });
    return steps;
  }

  /** The accountant approves the month: its comprehensive closing is saved with this statement, and the owner is asked to close it. */
  async approve(actor: CashActor, month: string, note?: string) {
    const view = await this.monthly(month);
    if (!view.ended) throw new ConflictException('لا تُعتمد تصفية شهر لم ينتهِ بعد');
    if (view.closing) throw new ConflictException('تصفية هذا الشهر معتمدة مسبقًا');
    if (view.blockers.length) throw new ConflictException(`لا يُقفل الشهر حتى تكتمل الخطوات: ${view.blockers.join('، ')}`);
    const settlement = { kpis: view.kpis, statement: view.statement, cashFlow: view.cashFlow, steps: view.steps };
    const saved = await this.closings.approve({ userId: actor.userId, name: actor.name }, { kind: 'COMPREHENSIVE', period: 'MONTH', month, note }, { settlement });
    await this.notifications.toStaff(this.prisma, 'MONTH_SETTLEMENT_AWAITING_OWNER', ['owner.confirm'], { senderName: actor.name ?? 'المحاسب', monthName: monthName(month) }, { exceptUserId: actor.userId });
    return saved;
  }

  /** The owner's final approval: the month is closed, and its statement is his to download. */
  async ownerApprove(actor: CashActor, month: string) {
    const { closing, approval } = await this.standing(month);
    if (!closing) throw new ConflictException('لم يعتمد المحاسب تصفية هذا الشهر بعد');
    if (approval) throw new ConflictException('أُقفل هذا الشهر مسبقًا');
    try {
      await this.prisma.monthSettlementApproval.create({ data: { closingId: closing.id, month, approvedById: actor.userId, approvedByName: actor.name ?? null } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('أُقفل هذا الشهر مسبقًا');
      throw err;
    }
    await this.notifications.toStaff(this.prisma, 'MONTH_SETTLEMENT_LOCKED', ['owner.confirm', 'closings.approve'], { senderName: actor.name ?? 'المالك', monthName: monthName(month) });
    return { success: true, closingId: closing.id };
  }

  // ───────────────────────────── branch performance ─────────────────────────────

  private periodOf(period: 'MONTH' | 'QUARTER' | 'YEAR', month: string) {
    const year = Number(month.slice(0, 4));
    if (period === 'YEAR') return { from: `${year}-01-01`, to: `${year}-12-31`, label: `سنة ${year}`, previous: `${year - 1}-${month.slice(5, 7)}`, lastYear: `${year - 1}-${month.slice(5, 7)}` };
    if (period === 'QUARTER') {
      const quarter = Math.ceil(Number(month.slice(5, 7)) / 3);
      const first = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}`;
      return { from: `${first}-01`, to: lastDayOf(addMonths(first, 2)), label: `الربع ${QUARTERS_AR[quarter - 1]} ${year}`, previous: addMonths(first, -3), lastYear: addMonths(first, -12) };
    }
    return { from: `${month}-01`, to: lastDayOf(month), label: monthName(month), previous: addMonths(month, -1), lastYear: addMonths(month, -12) };
  }

  async performance(period: 'MONTH' | 'QUARTER' | 'YEAR' = 'MONTH', month = riyadhDate(new Date()).slice(0, 7)) {
    const current = this.periodOf(period, month);
    const previous = this.periodOf(period, current.previous);
    const lastYear = this.periodOf(period, current.lastYear);
    const [now, before, yearAgo, closings] = await Promise.all([
      this.figures(current.from, current.to),
      this.figures(previous.from, previous.to),
      this.figures(lastYear.from, lastYear.to),
      this.prisma.accountClosing.findMany({
        where: { voidedAt: null, kind: 'COMPREHENSIVE', period: 'MONTH', fromDate: { gte: new Date(`${current.from}T00:00:00Z`), lte: new Date(`${current.to}T00:00:00Z`) } },
        select: { fromDate: true },
      }),
    ]);
    const closedMonths = new Set(closings.map((row) => row.fromDate.toISOString().slice(0, 7)));
    const estimated = monthsFrom(current.from.slice(0, 7), current.to.slice(0, 7)).filter((key) => key <= riyadhDate(new Date()).slice(0, 7) && !closedMonths.has(key));
    const seats = await this.seatsOffered(now.trips);
    const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);
    const rows = now.columns.map((column) => {
      const f = now.figures.get(column.key) ?? zero();
      const prior = before.figures.get(column.key);
      return {
        key: column.key,
        name: column.name,
        kind: column.kind,
        revenue: sar(f.revenue),
        bookings: f.bookings,
        occupancy: percent(f.passengers, seats),
        expenses: sar(expensesOf(f)),
        net: sar(netOf(f)),
        margin: percent(netOf(f), f.revenue),
        collectionRate: percent(f.collected, f.collected + f.remaining),
        cashDifferences: sar(f.cashDifferences),
        cancellations: f.cancellations,
        change: prior && prior.revenue > 0 ? percent(f.revenue - prior.revenue, prior.revenue) : null,
        isNew: !prior || prior.revenue === 0,
      };
    });
    const top = rows.filter((row) => row.kind === 'BRANCH').sort((a, b) => b.revenue - a.revenue)[0];
    return {
      period,
      month,
      label: current.label,
      previousLabel: previous.label,
      lastYearLabel: lastYear.label,
      kpis: {
        revenue: sar(now.total.revenue),
        expenses: sar(expensesOf(now.total)),
        net: sar(netOf(now.total)),
        topBranch: top && top.revenue > 0 ? top.name : null,
        revenueChange: percent(now.total.revenue - before.total.revenue, before.total.revenue),
        yearChange: percent(now.total.revenue - yearAgo.total.revenue, yearAgo.total.revenue),
      },
      rows,
      estimated: estimated.map((key) => ({ key, label: monthName(key) })),
    };
  }

  /** Seats the period's trips offered, both ways, for occupancy. */
  private async seatsOffered(trips: { legs: { id: string; tripStatus: string }[] }[]) {
    const ids = trips.flatMap((trip) => trip.legs.filter((leg) => leg.tripStatus !== 'CANCELLED').map((leg) => leg.id));
    if (!ids.length) return 0;
    const total = await this.prisma.trip.aggregate({ where: { id: { in: ids } }, _sum: { totalSeats: true } });
    return total._sum.totalSeats ?? 0;
  }

  // ───────────────────────────── the owner's phone ─────────────────────────────

  async ownerHome(actor: CashActor) {
    const month = riyadhDate(new Date()).slice(0, 7);
    const [summary, pending, statements, ownerDebt] = await Promise.all([
      this.remittances.summary(actor, month),
      this.prisma.cashRemittance.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          number: true,
          method: true,
          amount: true,
          fromDate: true,
          toDate: true,
          note: true,
          createdByName: true,
          createdAt: true,
          branch: { select: { name: true } },
          attachments: { select: { id: true, fileName: true, mimeType: true } },
        },
      }),
      this.prisma.accountClosing.findMany({
        where: { voidedAt: null, kind: 'COMPREHENSIVE', period: 'MONTH' },
        orderBy: { fromDate: 'desc' },
        take: 3,
        select: { id: true, fromDate: true, createdByName: true },
      }),
      this.fixed.ownerDebt(),
    ]);
    const approvals = await this.prisma.monthSettlementApproval.findMany({ where: { closingId: { in: statements.map((row) => row.id) } }, select: { closingId: true, approvedAt: true } });
    return {
      month,
      monthLabel: monthName(month),
      received: summary.received,
      unremitted: summary.unremitted,
      codeRequired: summary.codeRequired,
      ownerDebt,
      pending: pending.map((row) => ({
        id: row.id,
        code: remittanceCode(row.number),
        method: row.method,
        amount: Number(row.amount),
        branchName: row.branch.name,
        fromDate: row.fromDate.toISOString().slice(0, 10),
        toDate: row.toDate.toISOString().slice(0, 10),
        note: row.note,
        createdByName: row.createdByName,
        createdAt: row.createdAt,
        attachments: row.attachments,
      })),
      statements: statements.map((row) => {
        const key = row.fromDate.toISOString().slice(0, 7);
        const approval = approvals.find((item) => item.closingId === row.id);
        return { closingId: row.id, month: key, label: monthName(key), createdByName: row.createdByName, ownerApproved: !!approval, ownerApprovedAt: approval?.approvedAt ?? null };
      }),
    };
  }

  /** The owner statement for printing: the saved one for an approved month, otherwise worked out now. */
  async ownerStatement(month: string) {
    const view = await this.monthly(month);
    if (!view) throw new NotFoundException('الشهر غير موجود');
    return view;
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClosingKind, ClosingPeriod, CollectionMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { halalas } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDaysRange } from '../../common/utils/time.util';
import { journeyCodeOf } from '../../common/utils/trip-code.util';
import { BusAccountsService } from '../buses/bus-accounts.service';
import { TripAccountsService } from '../invoices/trip-accounts.service';
import { ApproveClosingDto, ClosingQuery, ClosingsListQuery } from './closings.dto';
import { FixedExpensesService } from './fixed-expenses.service';
import { EXPENSE_CATEGORY_LABELS } from './general-expenses.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PERIOD_DAYS = 366;
const PAGE_SIZE = 30;
const sar = (value: number) => Math.round(value) / 100;
const money = (value: Prisma.Decimal | number | null | undefined) => halalas(value ?? 0);

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const QUARTERS_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع'];
export const KIND_LABELS: Record<ClosingKind, string> = { TRIPS: 'تقفيل الرحلات', EMPLOYEES: 'تقفيل حساب الموظفين', COMPREHENSIVE: 'التقفيل الشامل' };
const METHOD_LABELS: Record<CollectionMethod | 'ONLINE', string> = { CASH: 'نقدًا (الصندوق)', NETWORK: 'الشبكة', TRANSFER: 'الحوالات البنكية', ONLINE: 'الدفع الإلكتروني (التطبيق)' };

/** Every month YYYY-MM from `first` to `last`, both included. */
const monthsBetween = (first: string, last: string) => {
  const [year, month] = first.split('-').map(Number);
  const months: string[] = [];
  for (let index = 0; ; index += 1) {
    const key = new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 7);
    if (key > last) return months;
    months.push(key);
  }
};
const lastDayOf = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};

type Scope = {
  kind: ClosingKind;
  period: ClosingPeriod;
  from: string;
  to: string;
  label: string;
  /** Instants of the period, for timestamps. */
  range: { gte: Date; lt: Date };
  /** Days of the period, for date-only columns. */
  days: { gte: Date; lte: Date };
  trip: { id: string; tripCode: string; journeyCode: string | null } | null;
};

type Line = { key: string; label: string; amount: number };

@Injectable()
export class ClosingsService {
  constructor(
    private prisma: PrismaService,
    private accounts: TripAccountsService,
    private buses: BusAccountsService,
    private fixed: FixedExpensesService,
  ) {}

  /** The period (or trip) a closing covers, worked out on the server so the same period always has the same bounds. */
  async scopeOf(query: ClosingQuery): Promise<Scope> {
    const { kind, period } = query;
    let from: string;
    let to: string;
    let label: string;
    let trip: Scope['trip'] = null;
    if (period === 'TRIP') {
      if (kind !== 'TRIPS') throw new BadRequestException('تقفيل الرحلة الواحدة يكون من تقفيل الرحلات');
      if (!query.tripId) throw new BadRequestException('اختر الرحلة');
      const select = { id: true, tripCode: true, codeNumber: true, codePeriod: true, departureTime: true, tripStatus: true } as const;
      const found = await this.prisma.trip.findUnique({ where: { id: query.tripId }, select: { ...select, reverseOf: { select } } });
      if (!found) throw new NotFoundException('الرحلة غير موجودة');
      // Either leg opens the same DR journey.
      const outbound = found.reverseOf ?? found;
      if (outbound.tripStatus === 'DRAFT') throw new ConflictException('هذه الرحلة ما زالت مسودة');
      from = to = riyadhDate(outbound.departureTime);
      const journeyCode = journeyCodeOf(outbound);
      trip = { id: outbound.id, tripCode: outbound.tripCode, journeyCode };
      label = `رحلة ${journeyCode ?? outbound.tripCode}`;
    } else if (period === 'MONTH') {
      if (!query.month) throw new BadRequestException('اختر الشهر');
      from = `${query.month}-01`;
      to = lastDayOf(query.month);
      label = `شهر ${MONTHS_AR[Number(query.month.slice(5, 7)) - 1]} ${query.month.slice(0, 4)}`;
    } else if (period === 'QUARTER') {
      if (!query.year || !query.quarter) throw new BadRequestException('اختر السنة والربع');
      const first = (query.quarter - 1) * 3 + 1;
      from = `${query.year}-${String(first).padStart(2, '0')}-01`;
      to = lastDayOf(`${query.year}-${String(first + 2).padStart(2, '0')}`);
      label = `الربع ${QUARTERS_AR[query.quarter - 1]} ${query.year}`;
    } else if (period === 'YEAR') {
      if (!query.year) throw new BadRequestException('اختر السنة');
      from = `${query.year}-01-01`;
      to = `${query.year}-12-31`;
      label = `سنة ${query.year}`;
    } else {
      if (!query.from || !query.to) throw new BadRequestException('حدد بداية الفترة ونهايتها');
      [from, to] = query.from <= query.to ? [query.from, query.to] : [query.to, query.from];
      label = `من ${from} إلى ${to}`;
    }
    const range = riyadhDaysRange(from, to);
    if (!range) throw new BadRequestException('التاريخ غير صحيح');
    if (range.lt.getTime() - range.gte.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw new BadRequestException('الفترة أطول من سنة');
    return { kind, period, from, to, label, range, days: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, trip };
  }

  /** The closing as it stands now, every section worked out from the live records. */
  async preview(query: ClosingQuery) {
    const scope = await this.scopeOf(query);
    const report = await this.build(scope);
    const existing = await this.standingClosing(scope);
    return { ...report, approved: existing && { id: existing.id, number: existing.number, createdAt: existing.createdAt, createdByName: existing.createdByName } };
  }

  /** `extra` is saved inside the report beside its sections, such as the monthly settlement's branch statement. */
  async approve(actor: { userId: string; name?: string | null }, dto: ApproveClosingDto, extra: Record<string, unknown> = {}) {
    const scope = await this.scopeOf(dto);
    if (scope.period !== 'TRIP' && scope.to >= riyadhDate(new Date())) throw new ConflictException('لا يُعتمد تقفيل فترة لم تنتهِ بعد');
    if (await this.standingClosing(scope)) throw new ConflictException('يوجد تقفيل معتمد لهذه الفترة، ألغِ اعتماده أولًا لإعادة التقفيل');

    if (scope.trip) {
      const row = (await this.accounts.list({ view: 'month', date: scope.from, from: scope.from, to: scope.to })).items.find((item) => item.id === scope.trip!.id);
      if (!row || row.closing === 'OPEN') throw new ConflictException('لا تُقفل الرحلة قبل تنفيذها');
      // Approving the trip's closing is its financial closing too, so its lines become final.
      if (row.closing === 'AWAITING_CLOSE') await this.accounts.close(actor, scope.trip.id);
    }

    const report = { ...(await this.build(scope)), ...extra };
    try {
      const saved = await this.prisma.accountClosing.create({
        data: {
          kind: scope.kind,
          period: scope.period,
          fromDate: scope.days.gte,
          toDate: scope.days.lte,
          tripId: scope.trip?.id ?? null,
          label: scope.label,
          revenue: report.summary.revenue,
          expenses: report.summary.expenses,
          net: report.summary.net,
          report: report as unknown as Prisma.InputJsonValue,
          note: dto.note || null,
          createdById: actor.userId,
          createdByName: actor.name ?? null,
        },
      });
      return { id: saved.id, number: saved.number };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('يوجد تقفيل معتمد لهذه الفترة');
      throw err;
    }
  }

  async list(query: ClosingsListQuery) {
    const page = query.page ?? 1;
    const where: Prisma.AccountClosingWhereInput = query.kind ? { kind: query.kind } : {};
    const [rows, total] = await Promise.all([
      this.prisma.accountClosing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        // The saved report is large; it is fetched one closing at a time.
        select: {
          id: true,
          number: true,
          kind: true,
          period: true,
          fromDate: true,
          toDate: true,
          tripId: true,
          label: true,
          revenue: true,
          expenses: true,
          net: true,
          note: true,
          createdByName: true,
          createdAt: true,
          voidedAt: true,
          voidedByName: true,
          voidReason: true,
        },
      }),
      this.prisma.accountClosing.count({ where }),
    ]);
    return {
      page,
      pageSize: PAGE_SIZE,
      total,
      items: rows.map((row) => ({
        ...row,
        kindLabel: KIND_LABELS[row.kind],
        fromDate: row.fromDate.toISOString().slice(0, 10),
        toDate: row.toDate.toISOString().slice(0, 10),
        revenue: Number(row.revenue),
        expenses: Number(row.expenses),
        net: Number(row.net),
      })),
    };
  }

  async get(id: string) {
    const row = await this.prisma.accountClosing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('التقفيل غير موجود');
    return {
      ...(row.report as Record<string, unknown>),
      approved: { id: row.id, number: row.number, createdAt: row.createdAt, createdByName: row.createdByName, note: row.note, voidedAt: row.voidedAt, voidedByName: row.voidedByName, voidReason: row.voidReason },
    };
  }

  async void(actor: { name?: string | null; permissions?: string[] }, id: string, reason: string) {
    // A month the owner closed for good is reopened by the owner only.
    if ((await this.prisma.monthSettlementApproval.count({ where: { closingId: id } })) && !actor.permissions?.includes('owner.confirm')) {
      throw new ForbiddenException('أقفل المالك هذا الشهر نهائيًا، ولا يُلغى اعتماده إلا بموافقته');
    }
    const voided = await this.prisma.accountClosing.updateMany({ where: { id, voidedAt: null }, data: { voidedAt: new Date(), voidedByName: actor.name ?? null, voidReason: reason } });
    if (voided.count === 0) {
      const exists = await this.prisma.accountClosing.count({ where: { id } });
      if (!exists) throw new NotFoundException('التقفيل غير موجود');
      throw new ConflictException('اعتماد هذا التقفيل ملغى مسبقًا');
    }
    return { success: true };
  }

  private standingClosing(scope: Scope) {
    return this.prisma.accountClosing.findFirst({
      where: { voidedAt: null, kind: scope.kind, period: scope.period, fromDate: scope.days.gte, toDate: scope.days.lte, tripId: scope.trip?.id ?? null },
      select: { id: true, number: true, createdAt: true, createdByName: true },
    });
  }

  // ───────────────────────────── the report ─────────────────────────────

  private async build(scope: Scope) {
    const { kind } = scope;
    const withTrips = kind !== 'EMPLOYEES';
    const trips = withTrips ? await this.tripsSection(scope) : null;
    const legIds = trips?.legIds ?? [];
    // A trip closing counts what its own bookings brought in, whenever paid; the comprehensive one, the money that moved in the period.
    const [collections, cash, rents, offices, employees, fixed] = await Promise.all([
      withTrips ? this.collectionsSection(kind === 'TRIPS' ? { legIds } : { range: scope.range }) : null,
      kind === 'COMPREHENSIVE' ? this.cashSection(scope) : null,
      withTrips && scope.period !== 'TRIP' ? this.rentsSection(scope, kind === 'COMPREHENSIVE') : null,
      kind === 'COMPREHENSIVE' ? this.officesSection(scope) : null,
      kind !== 'TRIPS' ? this.employeesSection(scope) : null,
      kind === 'COMPREHENSIVE' ? this.fixedSection(scope) : null,
    ]);

    const revenue: Line[] = [];
    const expenses: Line[] = [];
    if (trips) {
      const t = trips.totals;
      revenue.push({ key: 'tickets', label: 'إيرادات التذاكر', amount: t.tickets }, { key: 'otherIncome', label: 'إيرادات أخرى للرحلات', amount: t.otherIncome });
      expenses.push(
        { key: 'hotels', label: 'الفنادق والسكن', amount: t.hotels },
        { key: 'bus', label: 'إيجار الباصات', amount: t.bus },
        { key: 'driver', label: 'أجرة السائقين', amount: t.driver },
        { key: 'admin', label: 'مصاريف إدارية للرحلات', amount: t.admin },
        { key: 'other', label: 'مصاريف أخرى للرحلات', amount: t.other },
      );
    }
    if (rents?.premises) expenses.push({ key: 'premisesRent', label: 'إيجارات المقرات والمكاتب', amount: rents.premises.total });
    if (fixed) expenses.push({ key: 'fixedExpenses', label: 'المصاريف الثابتة المرحّلة (عقود الإيجار والفواتير)', amount: fixed.total });
    if (offices) {
      expenses.push({ key: 'officeExpenses', label: 'مصاريف المكاتب', amount: offices.generalTotal });
      expenses.push({ key: 'officeCustody', label: 'عهد مصروفة على المكاتب', amount: offices.custodyTotal });
    }
    if (employees) {
      expenses.push(
        { key: 'salaries', label: 'الرواتب (الإجمالي)', amount: employees.totals.gross },
        { key: 'gosiEmployer', label: 'حصة الشركة في التأمينات', amount: employees.totals.gosiEmployer },
        { key: 'settlements', label: 'مخالصات نهاية الخدمة', amount: employees.totals.settlements },
      );
    }
    const totalOf = (lines: Line[]) => sar(lines.reduce((sum, line) => sum + money(line.amount), 0));
    const revenueTotal = totalOf(revenue);
    const expensesTotal = totalOf(expenses);

    return {
      kind,
      kindLabel: KIND_LABELS[kind],
      period: scope.period,
      from: scope.from,
      to: scope.to,
      label: scope.label,
      trip: scope.trip,
      generatedAt: new Date(),
      summary: {
        revenueLines: revenue,
        expenseLines: expenses,
        revenue: revenueTotal,
        expenses: expensesTotal,
        net: sar(money(revenueTotal) - money(expensesTotal)),
        cashFlow: collections && {
          received: collections.totals.received,
          refunds: collections.totals.refunds,
          net: collections.totals.net,
          remaining: trips?.totals.remaining ?? 0,
        },
      },
      warnings: await this.warnings(scope, trips, employees),
      sections: {
        trips: trips && { rows: trips.rows, totals: trips.totals },
        collections,
        cash,
        rents,
        offices,
        employees,
        fixed,
      },
    };
  }

  /** The month's share of every rent contract and recurring expense, and the variable bills paid for the period's months. */
  private async fixedSection(scope: Scope) {
    const rows = await this.fixed.monthsExpense(monthsBetween(scope.from.slice(0, 7), scope.to.slice(0, 7)));
    const byContract = new Map<string, { title: string; categoryLabel: string; scope: string; months: number; amount: number }>();
    for (const row of rows) {
      const entry = byContract.get(row.id) ?? { title: row.title, categoryLabel: row.categoryLabel, scope: row.branchName ?? (row.allBranches ? 'كل الفروع' : 'الإدارة العامة'), months: 0, amount: 0 };
      entry.months += 1;
      entry.amount += row.amount;
      byContract.set(row.id, entry);
    }
    const items = [...byContract.values()].map((row) => ({ ...row, amount: sar(row.amount) })).sort((a, b) => b.amount - a.amount);
    return { rows: items, total: sar(rows.reduce((sum, row) => sum + row.amount, 0)) };
  }

  /** Each DR journey that departed in the period, as the trip accounts page works it out. */
  private async tripsSection(scope: Scope) {
    const data = await this.accounts.list({ view: 'month', date: scope.from, from: scope.from, to: scope.to });
    const items = scope.trip ? data.items.filter((item) => item.id === scope.trip!.id) : data.items;
    const keys = ['passengers', 'tickets', 'otherIncome', 'revenue', 'hotels', 'bus', 'driver', 'admin', 'other', 'expenses', 'net', 'collected', 'remaining'] as const;
    const totals = Object.fromEntries(keys.map((key) => [key, key === 'passengers' ? items.reduce((sum, item) => sum + item.passengers, 0) : sar(items.reduce((sum, item) => sum + money(item[key]), 0))])) as Record<
      (typeof keys)[number],
      number
    >;
    return {
      legIds: items.flatMap((item) => item.legs.map((leg) => leg.id)),
      rows: items.map((item) => ({
        id: item.id,
        code: item.journeyCode ?? item.tripCode,
        legs: item.legs.map((leg) => leg.tripCode),
        destination: item.destination,
        departureTime: item.departureTime,
        tripStatus: item.tripStatus,
        closing: item.closing,
        rentMissing: item.rentMissing,
        ...Object.fromEntries(keys.map((key) => [key, item[key]])),
      })),
      totals: { ...totals, count: items.length, awaitingClose: items.filter((item) => item.closing === 'AWAITING_CLOSE').length, open: items.filter((item) => item.closing === 'OPEN').length },
    };
  }

  /** Money taken in by method (drawer, network, transfers, the app) and what went back out, with each branch's share. */
  private async collectionsSection(filter: { legIds: string[] } | { range: { gte: Date; lt: Date } }) {
    const byBooking = 'legIds' in filter;
    if (byBooking && filter.legIds.length === 0) return this.emptyCollections();
    const bookingWhere = byBooking ? { booking: { tripId: { in: filter.legIds } } } : { createdAt: filter.range };
    const [staff, online, refunds, branches] = await Promise.all([
      this.prisma.bookingCollection.groupBy({ by: ['method', 'branchId'], where: bookingWhere, _sum: { amount: true }, _count: true }),
      // Staff collections are written to the register too, with who took them; what the app charged has nobody behind it.
      this.prisma.paymentTransaction.groupBy({ by: ['method'], where: { ...bookingWhere, type: 'CHARGE', status: 'SUCCEEDED', processedById: null }, _sum: { amount: true }, _count: true }),
      this.prisma.paymentTransaction.groupBy({ by: ['destination', 'branchId'], where: { ...bookingWhere, type: 'REFUND', status: 'SUCCEEDED' }, _sum: { amount: true }, _count: true }),
      this.prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));

    const methods: { method: CollectionMethod | 'ONLINE'; label: string; count: number; amount: number }[] = (['CASH', 'NETWORK', 'TRANSFER'] as const).map((method) => {
      const rows = staff.filter((row) => row.method === method);
      return { method, label: METHOD_LABELS[method], count: rows.reduce((sum, row) => sum + row._count, 0), amount: sar(rows.reduce((sum, row) => sum + money(row._sum.amount), 0)) };
    });
    methods.push({ method: 'ONLINE', label: METHOD_LABELS.ONLINE, count: online.reduce((sum, row) => sum + row._count, 0), amount: sar(online.reduce((sum, row) => sum + money(row._sum.amount), 0)) });

    const perBranch = new Map<string, { name: string; cash: number; network: number; transfer: number; count: number }>();
    for (const row of staff) {
      const key = row.branchId ?? 'none';
      const entry = perBranch.get(key) ?? { name: row.branchId ? (branchName.get(row.branchId) ?? '—') : 'بدون فرع', cash: 0, network: 0, transfer: 0, count: 0 };
      const amount = money(row._sum.amount);
      if (row.method === 'CASH') entry.cash += amount;
      if (row.method === 'NETWORK') entry.network += amount;
      if (row.method === 'TRANSFER') entry.transfer += amount;
      entry.count += row._count;
      perBranch.set(key, entry);
    }

    const refundOf = (match: (row: (typeof refunds)[number]) => boolean) => {
      const rows = refunds.filter(match);
      return { count: rows.reduce((sum, row) => sum + row._count, 0), amount: sar(rows.reduce((sum, row) => sum + money(row._sum.amount), 0)) };
    };
    const refundRows = [
      // A refund paid out of a drawer names the branch; one back to a card or an account does not.
      { key: 'cash', label: 'مسترد نقدًا من الصندوق', ...refundOf((row) => row.destination === 'ORIGINAL' && !!row.branchId) },
      { key: 'original', label: 'مسترد إلى البطاقة أو الحساب', ...refundOf((row) => row.destination === 'ORIGINAL' && !row.branchId) },
      { key: 'wallet', label: 'مسترد إلى محفظة العميل', ...refundOf((row) => row.destination === 'WALLET') },
    ];
    const received = methods.reduce((sum, row) => sum + money(row.amount), 0);
    // Wallet credit stays with the company until the customer spends it, so only money that left counts against what came in.
    const refunded = money(refundRows[0].amount) + money(refundRows[1].amount);
    return {
      methods,
      refunds: refundRows,
      branches: [...perBranch.values()]
        .map((row) => ({ name: row.name, count: row.count, cash: sar(row.cash), network: sar(row.network), transfer: sar(row.transfer), total: sar(row.cash + row.network + row.transfer) }))
        .sort((a, b) => b.total - a.total),
      totals: {
        operations: methods.reduce((sum, row) => sum + row.count, 0),
        received: sar(received),
        refunds: sar(refunded),
        walletRefunds: refundRows[2].amount,
        net: sar(received - refunded),
      },
    };
  }

  private emptyCollections() {
    return {
      methods: (['CASH', 'NETWORK', 'TRANSFER', 'ONLINE'] as const).map((method) => ({ method, label: METHOD_LABELS[method], count: 0, amount: 0 })),
      refunds: [],
      branches: [],
      totals: { operations: 0, received: 0, refunds: 0, walletRefunds: 0, net: 0 },
    };
  }

  /** Each branch's drawers over the period: what came in and went out of them, and how their closings counted. */
  private async cashSection(scope: Scope) {
    const sessions = await this.prisma.cashSession.findMany({
      where: { businessDate: scope.days },
      orderBy: [{ businessDate: 'asc' }, { openedAt: 'asc' }],
      select: { id: true, branchId: true, status: true, openingBalance: true, countedCash: true, difference: true, branch: { select: { name: true } } },
    });
    const movements = sessions.length
      ? await this.prisma.cashMovement.groupBy({ by: ['sessionId', 'type'], where: { sessionId: { in: sessions.map((session) => session.id) } }, _sum: { amount: true }, _count: true })
      : [];
    const branches = new Map<string, { name: string; sessions: number; open: number; opening: number; receipts: number; receiptCount: number; refunds: number; custodyIssued: number; custodyReturned: number; advancesIssued: number; advancesRepaid: number; salaries: number; expensesPaid: number; remitted: number; differences: number; lastCounted: number | null }>();
    for (const session of sessions) {
      const entry = branches.get(session.branchId) ?? {
        name: session.branch.name,
        sessions: 0,
        open: 0,
        opening: money(session.openingBalance),
        receipts: 0,
        receiptCount: 0,
        refunds: 0,
        custodyIssued: 0,
        custodyReturned: 0,
        advancesIssued: 0,
        advancesRepaid: 0,
        salaries: 0,
        expensesPaid: 0,
        remitted: 0,
        differences: 0,
        lastCounted: null,
      };
      entry.sessions += 1;
      if (session.status === 'OPEN') entry.open += 1;
      else {
        entry.differences += money(session.difference);
        entry.lastCounted = money(session.countedCash);
      }
      for (const row of movements.filter((movement) => movement.sessionId === session.id)) {
        const amount = money(row._sum.amount);
        if (row.type === 'BOOKING_RECEIPT') {
          entry.receipts += amount;
          entry.receiptCount += row._count;
        }
        if (row.type === 'BOOKING_REFUND') entry.refunds += amount;
        if (row.type === 'CUSTODY_ISSUE') entry.custodyIssued += amount;
        if (row.type === 'CUSTODY_RETURN') entry.custodyReturned += amount;
        if (row.type === 'ADVANCE_ISSUE') entry.advancesIssued += amount;
        if (row.type === 'ADVANCE_REPAYMENT') entry.advancesRepaid += amount;
        if (row.type === 'SALARY_PAYMENT') entry.salaries += amount;
        if (row.type === 'EXPENSE_PAYMENT') entry.expensesPaid += amount;
        if (row.type === 'EXPENSE_REVERSAL') entry.expensesPaid -= amount;
        if (row.type === 'REMITTANCE_OUT') entry.remitted += amount;
        if (row.type === 'REMITTANCE_RETURN') entry.remitted -= amount;
      }
      branches.set(session.branchId, entry);
    }
    const rows = [...branches.values()].map((entry) => {
      const cashIn = entry.receipts + entry.custodyReturned + entry.advancesRepaid;
      // Remitted cash is handed over, not spent, so it stays inside what the drawer handed over.
      const cashOut = entry.refunds + entry.custodyIssued + entry.advancesIssued + entry.salaries + entry.expensesPaid;
      return {
        name: entry.name,
        sessions: entry.sessions,
        open: entry.open,
        opening: sar(entry.opening),
        receipts: sar(entry.receipts),
        receiptCount: entry.receiptCount,
        refunds: sar(entry.refunds),
        custodyIssued: sar(entry.custodyIssued),
        custodyReturned: sar(entry.custodyReturned),
        advancesIssued: sar(entry.advancesIssued),
        advancesRepaid: sar(entry.advancesRepaid),
        salaries: sar(entry.salaries),
        expensesPaid: sar(entry.expensesPaid),
        remitted: sar(entry.remitted),
        cashIn: sar(cashIn),
        cashOut: sar(cashOut),
        /** What the drawer should hand over from the period: everything that came in less everything paid out of it. */
        net: sar(cashIn - cashOut),
        differences: sar(entry.differences),
        lastCounted: entry.lastCounted === null ? null : sar(entry.lastCounted),
      };
    });
    const sum = (key: 'receipts' | 'refunds' | 'custodyIssued' | 'custodyReturned' | 'advancesIssued' | 'advancesRepaid' | 'salaries' | 'expensesPaid' | 'remitted' | 'cashIn' | 'cashOut' | 'net' | 'differences') =>
      sar(rows.reduce((total, row) => total + money(row[key]), 0));
    return {
      rows,
      totals: {
        sessions: rows.reduce((total, row) => total + row.sessions, 0),
        open: rows.reduce((total, row) => total + row.open, 0),
        receiptCount: rows.reduce((total, row) => total + row.receiptCount, 0),
        receipts: sum('receipts'),
        refunds: sum('refunds'),
        custodyIssued: sum('custodyIssued'),
        custodyReturned: sum('custodyReturned'),
        advancesIssued: sum('advancesIssued'),
        advancesRepaid: sum('advancesRepaid'),
        salaries: sum('salaries'),
        expensesPaid: sum('expensesPaid'),
        remitted: sum('remitted'),
        cashIn: sum('cashIn'),
        cashOut: sum('cashOut'),
        net: sum('net'),
        differences: sum('differences'),
      },
    };
  }

  /** Bus rents by office (what each is owed, paid and still owed) and, in the comprehensive closing, the premises rents. */
  private async rentsSection(scope: Scope, withPremises: boolean) {
    const months = monthsBetween(scope.from.slice(0, 7), scope.to.slice(0, 7));
    const [tripOffices, paidOffices] = await Promise.all([
      this.prisma.trip.findMany({
        where: { departureTime: scope.range, tripStatus: { in: ['PUBLISHED', 'COMPLETED'] }, bus: { officeId: { not: null } } },
        distinct: ['busId'],
        select: { bus: { select: { officeId: true } } },
      }),
      this.prisma.busOfficePayment.findMany({ where: { month: { in: months }, voidedAt: null }, distinct: ['officeId'], select: { officeId: true } }),
    ]);
    const officeIds = [...new Set([...tripOffices.map((row) => row.bus!.officeId!), ...paidOffices.map((row) => row.officeId)])];
    const statements = await Promise.all(officeIds.map((id) => this.buses.statement(id, { from: scope.from, to: scope.to })));
    const offices = statements
      .map((statement) => ({
        id: statement.office.id,
        name: statement.office.name,
        trips: statement.summary.trips,
        rental: statement.summary.rental,
        deductions: statement.summary.expenses,
        due: statement.summary.due,
        paid: statement.summary.paid,
        remaining: statement.summary.remaining,
        payments: statement.payments.filter((payment) => !payment.voidedAt).length,
        missingRental: statement.summary.missingRental.length,
      }))
      .sort((a, b) => b.due - a.due);
    const sum = (key: 'rental' | 'deductions' | 'due' | 'paid' | 'remaining') => sar(offices.reduce((total, row) => total + money(row[key]), 0));

    let premises: { rows: { number: number; branchName: string; description: string; supplierName: string | null; spentOn: string; method: CollectionMethod; amount: number }[]; total: number } | null = null;
    if (withPremises) {
      const rows = await this.prisma.generalExpense.findMany({
        where: { voidedAt: null, category: 'OFFICE_RENT', spentOn: scope.days },
        orderBy: { spentOn: 'asc' },
        select: { number: true, description: true, supplierName: true, spentOn: true, method: true, amount: true, branch: { select: { name: true } } },
      });
      premises = {
        rows: rows.map((row) => ({
          number: row.number,
          branchName: row.branch?.name ?? 'الإدارة العامة',
          description: row.description,
          supplierName: row.supplierName,
          spentOn: row.spentOn.toISOString().slice(0, 10),
          method: row.method,
          amount: Number(row.amount),
        })),
        total: sar(rows.reduce((total, row) => total + money(row.amount), 0)),
      };
    }
    return {
      offices,
      officeTotals: { trips: offices.reduce((total, row) => total + row.trips, 0), rental: sum('rental'), deductions: sum('deductions'), due: sum('due'), paid: sum('paid'), remaining: sum('remaining') },
      premises,
    };
  }

  /** What running the offices cost: the general expenses register, and custodies settled without a trip. */
  private async officesSection(scope: Scope) {
    const [expenses, custodies] = await Promise.all([
      this.prisma.generalExpense.findMany({
        where: { voidedAt: null, category: { not: 'OFFICE_RENT' }, spentOn: scope.days },
        orderBy: { spentOn: 'asc' },
        select: { number: true, category: true, description: true, supplierName: true, spentOn: true, method: true, amount: true, vat: true, branchId: true, branch: { select: { name: true } } },
      }),
      this.prisma.custody.findMany({
        where: { tripId: null, status: 'SETTLED', settledAt: scope.range },
        orderBy: { settledAt: 'asc' },
        select: { number: true, purpose: true, recipientName: true, spentAmount: true, settledAt: true, branch: { select: { name: true } } },
      }),
    ]);
    const byCategory = new Map<string, { label: string; count: number; amount: number }>();
    const byBranch = new Map<string, { name: string; amount: number }>();
    for (const row of expenses) {
      const category = byCategory.get(row.category) ?? { label: EXPENSE_CATEGORY_LABELS[row.category], count: 0, amount: 0 };
      category.count += 1;
      category.amount += money(row.amount);
      byCategory.set(row.category, category);
      const key = row.branchId ?? 'none';
      const branch = byBranch.get(key) ?? { name: row.branch?.name ?? 'الإدارة العامة', amount: 0 };
      branch.amount += money(row.amount);
      byBranch.set(key, branch);
    }
    for (const row of custodies) {
      const key = `custody:${row.branch.name}`;
      const branch = byBranch.get(key) ?? { name: `${row.branch.name} (عهد)`, amount: 0 };
      branch.amount += money(row.spentAmount);
      byBranch.set(key, branch);
    }
    const generalTotal = expenses.reduce((total, row) => total + money(row.amount), 0);
    const custodyTotal = custodies.reduce((total, row) => total + money(row.spentAmount), 0);
    return {
      byCategory: [...byCategory.values()].map((row) => ({ ...row, amount: sar(row.amount) })).sort((a, b) => b.amount - a.amount),
      byBranch: [...byBranch.values()].map((row) => ({ ...row, amount: sar(row.amount) })).sort((a, b) => b.amount - a.amount),
      rows: expenses.map((row) => ({
        number: row.number,
        categoryLabel: EXPENSE_CATEGORY_LABELS[row.category],
        branchName: row.branch?.name ?? 'الإدارة العامة',
        description: row.description,
        supplierName: row.supplierName,
        spentOn: row.spentOn.toISOString().slice(0, 10),
        method: row.method,
        amount: Number(row.amount),
        vat: Number(row.vat),
      })),
      custodies: custodies.map((row) => ({ number: row.number, purpose: row.purpose, recipientName: row.recipientName, branchName: row.branch.name, settledAt: row.settledAt, spent: Number(row.spentAmount ?? 0) })),
      generalTotal: sar(generalTotal),
      custodyTotal: sar(custodyTotal),
      total: sar(generalTotal + custodyTotal),
    };
  }

  /** Each employee's account for the period: salary, advances, custodies and what they collected. */
  private async employeesSection(scope: Scope) {
    const months = monthsBetween(scope.from.slice(0, 7), scope.to.slice(0, 7));
    const [runs, advancesGiven, repayments, standingAdvances, custodiesIssued, custodiesSettled, openCustodies, collections, settlements] = await Promise.all([
      this.prisma.payrollRun.findMany({
        where: { month: { in: months } },
        orderBy: { month: 'asc' },
        select: {
          month: true,
          status: true,
          employeeCount: true,
          totalGross: true,
          totalDeductions: true,
          totalNet: true,
          totalEmployerGosi: true,
          lines: { select: { userId: true, name: true, jobName: true, branchName: true, gross: true, totalDeductions: true, net: true, advanceDeduction: true, gosiEmployer: true, paidAt: true } },
        },
      }),
      this.prisma.salaryAdvance.findMany({ where: { disbursedAt: scope.range }, select: { userId: true, amount: true } }),
      this.prisma.advanceRepayment.findMany({ where: { createdAt: scope.range }, select: { amount: true, advance: { select: { userId: true } } } }),
      this.prisma.salaryAdvance.findMany({ where: { status: 'DISBURSED' }, select: { userId: true, amount: true, repayments: { select: { amount: true } } } }),
      this.prisma.custody.findMany({ where: { issuedAt: scope.range }, select: { recipientId: true, recipientName: true, amount: true } }),
      this.prisma.custody.findMany({ where: { status: 'SETTLED', settledAt: scope.range }, select: { recipientId: true, recipientName: true, spentAmount: true, returnedAmount: true } }),
      this.prisma.custody.findMany({ where: { status: 'OPEN' }, select: { recipientId: true, recipientName: true, amount: true } }),
      this.prisma.bookingCollection.groupBy({ by: ['createdById', 'method'], where: { createdAt: scope.range }, _sum: { amount: true }, _count: true }),
      this.prisma.finalSettlement.findMany({ where: { status: 'PAID', paidAt: scope.range }, select: { userId: true, net: true } }),
    ]);
    // Only an approved payroll is final; a draft is listed but its figures are not yet the company's cost.
    const finalRuns = runs.filter((run) => run.status !== 'DRAFT');

    type Account = {
      gross: number;
      deductions: number;
      net: number;
      gosiEmployer: number;
      salaryPaid: boolean | null;
      advanceIssued: number;
      advanceRepaid: number;
      advanceBalance: number;
      custodyIssued: number;
      custodySpent: number;
      custodyReturned: number;
      custodyOpen: number;
      collectedCount: number;
      cash: number;
      network: number;
      transfer: number;
      settlement: number;
      name?: string | null;
      job?: string | null;
      branch?: string | null;
    };
    const accounts = new Map<string, Account>();
    const accountOf = (userId: string, name?: string | null) => {
      let account = accounts.get(userId);
      if (!account) {
        account = { gross: 0, deductions: 0, net: 0, gosiEmployer: 0, salaryPaid: null, advanceIssued: 0, advanceRepaid: 0, advanceBalance: 0, custodyIssued: 0, custodySpent: 0, custodyReturned: 0, custodyOpen: 0, collectedCount: 0, cash: 0, network: 0, transfer: 0, settlement: 0 };
        accounts.set(userId, account);
      }
      if (name && !account.name) account.name = name;
      return account;
    };

    for (const run of finalRuns) {
      for (const line of run.lines) {
        const account = accountOf(line.userId, line.name);
        account.job ??= line.jobName;
        account.branch ??= line.branchName;
        account.gross += money(line.gross);
        account.deductions += money(line.totalDeductions);
        account.net += money(line.net);
        account.gosiEmployer += money(line.gosiEmployer);
        account.salaryPaid = (account.salaryPaid ?? true) && !!line.paidAt;
      }
    }
    for (const row of advancesGiven) accountOf(row.userId).advanceIssued += money(row.amount);
    for (const row of repayments) accountOf(row.advance.userId).advanceRepaid += money(row.amount);
    for (const row of standingAdvances) accountOf(row.userId).advanceBalance += money(row.amount) - row.repayments.reduce((sum, repayment) => sum + money(repayment.amount), 0);
    for (const row of custodiesIssued) accountOf(row.recipientId, row.recipientName).custodyIssued += money(row.amount);
    for (const row of custodiesSettled) {
      const account = accountOf(row.recipientId, row.recipientName);
      account.custodySpent += money(row.spentAmount);
      account.custodyReturned += money(row.returnedAmount);
    }
    for (const row of openCustodies) accountOf(row.recipientId, row.recipientName).custodyOpen += money(row.amount);
    for (const row of collections) {
      const account = accountOf(row.createdById);
      const amount = money(row._sum.amount);
      account.collectedCount += row._count;
      if (row.method === 'CASH') account.cash += amount;
      if (row.method === 'NETWORK') account.network += amount;
      if (row.method === 'TRANSFER') account.transfer += amount;
    }
    for (const row of settlements) accountOf(row.userId).settlement += money(row.net);

    // Names, ranks and branches for everyone the payroll did not already describe.
    const missing = [...accounts.entries()].filter(([, account]) => !account.name || !account.branch).map(([id]) => id);
    if (missing.length) {
      const users = await this.prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, rank: { select: { name: true } }, branch: { select: { name: true } } } });
      for (const user of users) {
        const account = accounts.get(user.id)!;
        account.name ||= user.name;
        account.job ??= user.rank?.name ?? null;
        account.branch ??= user.branch?.name ?? null;
      }
    }

    const rows = [...accounts.entries()]
      .map(([userId, account]) => ({
        userId,
        name: account.name ?? '—',
        job: account.job ?? null,
        branch: account.branch ?? null,
        gross: sar(account.gross),
        deductions: sar(account.deductions),
        net: sar(account.net),
        gosiEmployer: sar(account.gosiEmployer),
        salaryPaid: account.salaryPaid,
        advanceIssued: sar(account.advanceIssued),
        advanceRepaid: sar(account.advanceRepaid),
        advanceBalance: sar(account.advanceBalance),
        custodyIssued: sar(account.custodyIssued),
        custodySpent: sar(account.custodySpent),
        custodyReturned: sar(account.custodyReturned),
        custodyOpen: sar(account.custodyOpen),
        collectedCount: account.collectedCount,
        cash: sar(account.cash),
        network: sar(account.network),
        transfer: sar(account.transfer),
        collected: sar(account.cash + account.network + account.transfer),
        settlement: sar(account.settlement),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const total = (key: Exclude<keyof (typeof rows)[number], 'userId' | 'name' | 'job' | 'branch' | 'salaryPaid' | 'collectedCount'>) => sar(rows.reduce((sum, row) => sum + money(row[key]), 0));
    return {
      payrolls: runs.map((run) => ({
        month: run.month,
        status: run.status,
        employees: run.employeeCount,
        gross: Number(run.totalGross),
        deductions: Number(run.totalDeductions),
        net: Number(run.totalNet),
        gosiEmployer: Number(run.totalEmployerGosi),
      })),
      missingPayrolls: months.filter((month) => !runs.some((run) => run.month === month)),
      rows,
      totals: {
        employees: rows.length,
        gross: total('gross'),
        deductions: total('deductions'),
        net: total('net'),
        gosiEmployer: total('gosiEmployer'),
        advanceIssued: total('advanceIssued'),
        advanceRepaid: total('advanceRepaid'),
        advanceBalance: total('advanceBalance'),
        custodyIssued: total('custodyIssued'),
        custodySpent: total('custodySpent'),
        custodyReturned: total('custodyReturned'),
        custodyOpen: total('custodyOpen'),
        collectedCount: rows.reduce((sum, row) => sum + row.collectedCount, 0),
        cash: total('cash'),
        network: total('network'),
        transfer: total('transfer'),
        collected: total('collected'),
        settlements: total('settlement'),
      },
    };
  }

  /** What still stands open in the period and would make the closing incomplete. */
  private async warnings(
    scope: Scope,
    trips: Awaited<ReturnType<ClosingsService['tripsSection']>> | null,
    employees: Awaited<ReturnType<ClosingsService['employeesSection']>> | null,
  ) {
    const list: string[] = [];
    if (trips) {
      if (trips.totals.open) list.push(`${trips.totals.open} رحلة لم تُنفذ بعد`);
      if (trips.totals.awaitingClose) list.push(`${trips.totals.awaitingClose} رحلة منفذة لم يُغلق حسابها ماليًا`);
      const missingRent = trips.rows.filter((row) => row.rentMissing).length;
      if (missingRent) list.push(`${missingRent} رحلة بدون إيجار باص محدد`);
      if (trips.legIds.length) {
        const [due, openCustody] = await Promise.all([
          this.prisma.tripAccountEntry.count({ where: { tripId: { in: trips.legIds }, voidedAt: null, settlement: 'DUE_MONTH_END' } }),
          this.prisma.custody.count({ where: { tripId: { in: trips.legIds }, status: 'OPEN' } }),
        ]);
        if (due) list.push(`${due} قيد على الرحلات مستحق آخر الشهر ولم يُسدد`);
        if (openCustody) list.push(`${openCustody} عهدة على الرحلات لم تُسوَّ بعد`);
      }
    }
    if (scope.kind === 'COMPREHENSIVE') {
      const [openSessions, openCustodies] = await Promise.all([
        this.prisma.cashSession.count({ where: { status: 'OPEN', businessDate: scope.days } }),
        this.prisma.custody.count({ where: { status: 'OPEN', tripId: null, issuedAt: scope.range } }),
      ]);
      if (openSessions) list.push(`${openSessions} صندوق يومي في الفترة لم يُقفل`);
      if (openCustodies) list.push(`${openCustodies} عهدة مكتبية صُرفت في الفترة ولم تُسوَّ`);
    }
    if (employees) {
      if (employees.missingPayrolls.length) list.push(`لا يوجد مسيّر رواتب لشهر ${employees.missingPayrolls.join('، ')}`);
      const drafts = employees.payrolls.filter((run) => run.status === 'DRAFT').map((run) => run.month);
      if (drafts.length) list.push(`مسيّر رواتب ${drafts.join('، ')} لم يُعتمد بعد ولا يدخل في التقفيل`);
    }
    return list;
  }
}

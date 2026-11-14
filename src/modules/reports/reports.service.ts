import { BadRequestException, Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { PrismaService } from '../../common/services/prisma.service';
import { TripMetricsService } from '../../common/services/trip-metrics.service';
import { includedBedValue } from '../../common/utils/housing-price.util';
import { halalas, netBookingFigures, paymentFigures } from '../../common/utils/payment.util';
import { addDays, riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import { AppEventDto, DateBasis, ReportRangeQuery, ReportRecordsQuery } from './reports.dto';

const MAX_RANGE_DAYS = 366;
/** Longer periods are drawn by month, because a bar per day stops being readable. */
const MAX_DAILY_BARS = 62;
const TOP_ROUTES = 8;
const ACTIVE_WINDOW_DAYS = 30;
const OTHER_ROUTES_LABEL = 'مسارات أخرى';
const DEFAULT_VAT_RATE = 15;
/** What a report shows for a customer field or a hotel nobody recorded. */
export const UNKNOWN_LABEL = 'غير محدد';
const UNKNOWN_KEY = 'none';
/** The drill-down lists at most this many records; the count above them is always the full one. */
const MAX_RECORDS = 300;

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'مؤكد',
  BOARDED: 'صعد الركاب',
  PENDING: 'بانتظار الدفع',
  PENDING_CANCELLATION_REVIEW: 'طلب إلغاء',
  CANCELLED: 'ملغى',
};
const SOURCE_LABELS: Record<string, string> = { APP: 'التطبيق', BRANCH: 'الفروع' };
const CATEGORY_LABELS: Record<string, string> = { FAMILY: 'عائلات', SINGLES: 'أفراد' };
const ROUTE_SUFFIX: Record<string, string> = { WITH_HOTEL: ' (سكن)', WITH_VISITS: ' (معالم)', WITH_HOTEL_VISITS: ' (سكن ومعالم)' };
const GENDER_LABELS: Record<string, string> = { MALE: 'ذكور', FEMALE: 'إناث' };
const HOUSING_SERVICE_TYPES = ['WITH_HOTEL', 'WITH_HOTEL_VISITS'] as const;

/** Ages at the end of the report's period. */
const AGE_GROUPS = [
  { key: 'u18', label: 'أقل من 18', min: 0, max: 18 },
  { key: '18-29', label: '18 – 29', min: 18, max: 30 },
  { key: '30-44', label: '30 – 44', min: 30, max: 45 },
  { key: '45-59', label: '45 – 59', min: 45, max: 60 },
  { key: '60+', label: '60 فأكثر', min: 60, max: 200 },
];

const COLLECTION_METHOD_KEYS: Record<string, string> = { CASH: 'cash', NETWORK: 'network', TRANSFER: 'transfer' };

const sar = (value: number) => Math.round(value) / 100;
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const routeLabel = (origin: string, destination: string) => `${origin} ← ${destination}`;

/** A date-only column is stored as midnight UTC, whatever the time zone of the day it names. */
const dateColumn = (date: string) => new Date(`${date}T00:00:00.000Z`);
const nextDay = (date: string) => addDays(dateColumn(date), 1).toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

/** The same day a year earlier; 29 February becomes the 28th. */
export function lastYear(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year - 1, month - 1, day));
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** An age group's key on the day given, or "none" without a birth date. */
function ageGroupOf(birthDate: Date | null, on: string) {
  if (!birthDate) return UNKNOWN_KEY;
  const [year, month, day] = on.split('-').map(Number);
  let age = year - birthDate.getUTCFullYear();
  if (month - 1 < birthDate.getUTCMonth() || (month - 1 === birthDate.getUTCMonth() && day < birthDate.getUTCDate())) age -= 1;
  return AGE_GROUPS.find((group) => age >= group.min && age < group.max)?.key ?? UNKNOWN_KEY;
}

/** The same day the given number of years earlier, as a date column. */
const yearsBefore = (date: string, years: number) => dateColumn(lastYearBy(date, years));
function lastYearBy(date: string, years: number) {
  let value = date;
  for (let index = 0; index < years; index += 1) value = lastYear(value);
  return value;
}

/**
 * The weeks of a period, Sunday to Saturday, cut at each month's edge so every month has its own weeks: when a month
 * starts on a Friday, its 1st and 2nd are its week 1, and the days before them close the previous month's last week.
 * Numbered within their month, even when the period starts mid-month.
 */
export function monthWeeks(from: string, to: string) {
  const weeks: { month: string; index: number; from: string; to: string }[] = [];
  for (let day = from; day <= to; day = nextDay(day)) {
    const isSunday = dateColumn(day).getUTCDay() === 0;
    const isFirst = day.endsWith('-01');
    const last = weeks[weeks.length - 1];
    if (!last || isSunday || isFirst) {
      // Counted from the month's first day, so a period starting mid-month keeps the month's own numbering.
      let index = 1;
      for (let d = `${day.slice(0, 7)}-02`; d <= day; d = nextDay(d)) if (dateColumn(d).getUTCDay() === 0) index += 1;
      weeks.push({ month: day.slice(0, 7), index, from: day, to: day });
    } else {
      last.to = day;
    }
  }
  return weeks;
}

const CHARGE_SUCCEEDED = { type: 'CHARGE' as const, status: 'SUCCEEDED' as const };

/** What every booking query needs to place a booking on its date, whichever date the report reads by. */
const DATED_SELECT = {
  createdAt: true,
  paymentTransactions: { where: CHARGE_SUCCEEDED, select: { createdAt: true } },
} satisfies Prisma.BookingSelect;

type Dated = { createdAt: Date; trip: { departureTime: Date }; collections: { createdAt: Date }[]; paymentTransactions: { createdAt: Date }[] };

const BOOKING_SELECT = {
  ...DATED_SELECT,
  id: true,
  groupReference: true,
  status: true,
  source: true,
  category: true,
  branchId: true,
  totalPrice: true,
  refundAmount: true,
  externalRefunded: true,
  branch: { select: { name: true } },
  trip: { select: { origin: true, destination: true, bookingType: true, departureTime: true } },
  payment: { select: { amount: true, walletAmount: true, status: true, method: true } },
  collections: { select: { method: true, amount: true, createdAt: true } },
  cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
  _count: { select: { passengers: true } },
} satisfies Prisma.BookingSelect;

type ReportBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>;

/** What the counts need, without the money behind each booking. */
const BOOKING_COUNT_SELECT = {
  ...DATED_SELECT,
  id: true,
  groupReference: true,
  status: true,
  source: true,
  category: true,
  branch: { select: { name: true } },
  trip: { select: { departureTime: true } },
  collections: { select: { createdAt: true } },
  _count: { select: { passengers: true } },
} satisfies Prisma.BookingSelect;

/** What bookingFigures reads from a cancelled booking. */
const CANCELLED_MONEY_SELECT = {
  status: true,
  totalPrice: true,
  refundAmount: true,
  externalRefunded: true,
  payment: { select: { amount: true, walletAmount: true, status: true } },
  collections: { select: { amount: true } },
  cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
} satisfies Prisma.BookingSelect;

const CUSTOMER_BOOKING_SELECT = {
  ...CANCELLED_MONEY_SELECT,
  id: true,
  groupReference: true,
  userId: true,
  user: { select: { city: true, nationality: true, gender: true, birthDate: true } },
} satisfies Prisma.BookingSelect;

const HOTEL_BOOKING_SELECT = {
  ...DATED_SELECT,
  id: true,
  groupReference: true,
  status: true,
  roomChoice: true,
  housingAmount: true,
  stayNights: true,
  stayCheckIn: true,
  stayCheckOut: true,
  stayHotel: { select: { id: true, name: true } },
  collections: { select: { createdAt: true } },
  _count: { select: { passengers: true } },
  trip: {
    select: {
      departureTime: true,
      sharedRoomCapacity: true,
      housingPrice: true,
      privateRoomPrice: true,
      privateRoomCapacity: true,
      housingPriceMode: true,
      privateRoomPriceBasis: true,
      housingPricePeriod: true,
      accommodations: { select: { nights: true }, take: 1 },
      hotelBookings: {
        where: { status: 'CONFIRMED' as const },
        orderBy: { number: 'asc' as const },
        take: 1,
        select: { checkIn: true, checkOut: true, hotel: { select: { id: true, name: true } } },
      },
    },
  },
} satisfies Prisma.BookingSelect;

type HotelRow = Prisma.BookingGetPayload<{ select: typeof HOTEL_BOOKING_SELECT }>;

/**
 * Sold value, matching the trip accounts: a seat sold and not yet collected is revenue, and from a
 * cancelled booking only the money that came in counts. Amounts are in halalas.
 */
function bookingFigures(booking: Prisma.BookingGetPayload<{ select: typeof CANCELLED_MONEY_SELECT }>) {
  const { received, wallet, remaining } = paymentFigures(booking.payment, booking.collections);
  if (booking.status !== 'CANCELLED') {
    const sold = halalas(booking.totalPrice);
    return { sold, refunded: 0, net: sold, uncollected: remaining };
  }
  const { held } = netBookingFigures(booking);
  const paidIn = received + wallet;
  return { sold: paidIn, refunded: paidIn - held, net: held, uncollected: 0 };
}

/** A round trip is one row per leg, but one booking to the customer. Its live leg speaks for it. */
function ordersOf<T extends { id: string; groupReference: string | null; status: string }>(rows: T[]) {
  const orders = new Map<string, T>();
  for (const row of rows) {
    const key = row.groupReference ?? row.id;
    const current = orders.get(key);
    if (!current || (current.status === 'CANCELLED' && row.status !== 'CANCELLED')) orders.set(key, row);
  }
  return [...orders.values()];
}

function shares(counts: Map<string, number>, labels: Record<string, string> = {}) {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: labels[key] ?? key, count, share: percent(count, total) }));
}

const increase = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

type Period = { start: Date; end: Date; days: number };
type Context = { period: Period; basis: DateBasis; factor: number; money: (halalasValue: number) => number; where: Prisma.BookingWhereInput };

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private metrics: TripMetricsService,
  ) {}

  private periodOf(query: ReportRangeQuery): Period {
    const first = riyadhDayRange(query.from);
    const last = riyadhDayRange(query.to);
    if (!first || !last) throw new BadRequestException('التاريخ غير صحيح');
    if (first.start > last.start) throw new BadRequestException('بداية الفترة بعد نهايتها');
    const days = Math.round((last.start.getTime() - first.start.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException('أقصى فترة للتقرير سنة واحدة');
    return { start: first.start, end: last.end, days };
  }

  async vatRate() {
    const setting = await this.prisma.setting.findUnique({ where: { key: 'vatRate' } });
    const rate = setting ? Number(setting.value) : DEFAULT_VAT_RATE;
    return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_VAT_RATE;
  }

  /** The trips the route filter keeps. */
  private tripScope(query: ReportRangeQuery): Prisma.TripWhereInput {
    return { ...(query.origin && { origin: query.origin }), ...(query.destination && { destination: query.destination }) };
  }

  /** The bookings the branch, source and route filters keep, whatever their date. */
  private scopeWhere(query: ReportRangeQuery): Prisma.BookingWhereInput {
    const trip = this.tripScope(query);
    return {
      ...(query.branchId && { branchId: query.branchId }),
      ...(query.source && { source: query.source }),
      ...(Object.keys(trip).length > 0 && { trip }),
    };
  }

  /** The bookings of a period by the chosen date, inside the filters. */
  private bookingWhere(query: ReportRangeQuery, basis: DateBasis, start: Date, end: Date): Prisma.BookingWhereInput {
    const range = { gte: start, lt: end };
    const scope = this.scopeWhere(query);
    if (basis === 'trip') return { ...scope, trip: { ...this.tripScope(query), departureTime: range } };
    if (basis === 'payment') {
      return { ...scope, OR: [{ paymentTransactions: { some: { ...CHARGE_SUCCEEDED, createdAt: range } } }, { collections: { some: { createdAt: range } } }] };
    }
    return { ...scope, createdAt: range };
  }

  private async contextOf(query: ReportRangeQuery, fallback: DateBasis = 'booking'): Promise<Context> {
    const period = this.periodOf(query);
    const basis = query.basis ?? fallback;
    // Every amount in the system is stored with its VAT inside, so the amount without it is the same share of each.
    const factor = query.vat === 'excl' ? 100 / (100 + (await this.vatRate())) : 1;
    return { period, basis, factor, money: (value: number) => sar(value * factor), where: this.bookingWhere(query, basis, period.start, period.end) };
  }

  /** The moment that puts a booking in the period, by the chosen date: for payments, the first money of the period. */
  private atOf(row: Dated, basis: DateBasis, period: Period) {
    if (basis === 'trip') return row.trip.departureTime;
    if (basis === 'payment') {
      const times = [...row.paymentTransactions, ...row.collections]
        .map((item) => item.createdAt)
        .filter((at) => at >= period.start && at < period.end)
        .sort((a, b) => a.getTime() - b.getTime());
      return times[0] ?? row.createdAt;
    }
    return row.createdAt;
  }

  /** Every bucket of the period, including the empty ones, so a quiet day shows as a gap and not as nothing. */
  private series(period: { start: Date; days: number }, values: { at: Date; amount: number }[]) {
    const byMonth = period.days > MAX_DAILY_BARS;
    const keyOf = (date: Date) => (byMonth ? riyadhDate(date).slice(0, 7) : riyadhDate(date));
    const buckets = new Map<string, number>();
    for (let index = 0; index < period.days; index += 1) buckets.set(keyOf(addDays(period.start, index)), 0);
    for (const value of values) {
      const key = keyOf(value.at);
      if (buckets.has(key)) increase(buckets, key, value.amount);
    }
    return [...buckets].map(([key, value]) => ({ key, value }));
  }

  /** Sold value of the bookings given, the same as summing bookingFigures().sold, without loading every live booking. */
  private async soldWhere(where: Prisma.BookingWhereInput) {
    const [live, cancelled] = await Promise.all([
      this.prisma.booking.aggregate({ where: { AND: [where, { status: { not: 'CANCELLED' } }] }, _sum: { totalPrice: true } }),
      this.prisma.booking.findMany({ where: { AND: [where, { status: 'CANCELLED' }] }, select: CANCELLED_MONEY_SELECT }),
    ]);
    return halalas(live._sum.totalPrice ?? 0) + cancelled.reduce((sum, booking) => sum + bookingFigures(booking).sold, 0);
  }

  private tripsDeparting(start: Date, end: Date, query: ReportRangeQuery) {
    return this.prisma.trip.findMany({
      where: { ...this.tripScope(query), departureTime: { gte: start, lt: end }, tripStatus: { not: 'DRAFT' } },
      select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, tripStatus: true, totalSeats: true, availableSeats: true },
      orderBy: { departureTime: 'asc' },
    });
  }

  /** Runs a report, and with compare, again for the same days a year earlier, so its main figures can be set side by side. */
  async withComparison<T extends { totals: Record<string, number> }>(query: ReportRangeQuery, build: (query: ReportRangeQuery) => Promise<T>) {
    const data = await build(query);
    if (!query.compare) return data;
    const previous = { ...query, from: lastYear(query.from), to: lastYear(query.to), compare: undefined };
    const before = await build(previous);
    return { ...data, comparison: { from: previous.from, to: previous.to, totals: before.totals } };
  }

  /** What the filters can choose from. */
  async filterOptions() {
    const [branches, routes, rate] = await Promise.all([
      this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, isActive: true } }),
      this.prisma.trip.groupBy({ by: ['origin', 'destination'], where: { tripStatus: { not: 'DRAFT' } }, _count: true }),
      this.vatRate(),
    ]);
    return {
      branches,
      routes: routes
        .sort((a, b) => b._count - a._count)
        .map((row) => ({ key: `${row.origin}|${row.destination}`, origin: row.origin, destination: row.destination, label: routeLabel(row.origin, row.destination) })),
      vatRate: rate,
    };
  }

  async revenue(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query);
    const { period, money } = ctx;
    const [rows, previousGross, trips, occupancy] = await Promise.all([
      this.prisma.booking.findMany({ where: ctx.where, select: BOOKING_SELECT }),
      this.soldWhere(this.bookingWhere(query, ctx.basis, addDays(period.start, -period.days), period.start)),
      this.tripsDeparting(period.start, period.end, query),
      this.metrics.occupancy(this.tripScope(query), period),
    ]);

    let gross = 0;
    let refunds = 0;
    let uncollected = 0;
    let simulated = 0;
    let liveValue = 0;
    let wallet = 0;
    const routes = new Map<string, number>();
    const types = new Map<string, number>();
    const methods = new Map<string, number>();

    for (const booking of rows) {
      const figures = bookingFigures(booking);
      gross += figures.sold;
      refunds += figures.refunded;
      uncollected += figures.uncollected;
      if (booking.status !== 'CANCELLED') liveValue += figures.sold;
      const suffix = ROUTE_SUFFIX[booking.trip.bookingType] ?? '';
      increase(routes, `${routeLabel(booking.trip.origin, booking.trip.destination)}${suffix}`, figures.net);
      increase(types, booking.trip.bookingType, figures.net);

      const paid = paymentFigures(booking.payment, booking.collections);
      wallet += paid.wallet;
      if (booking.payment?.status === 'SIMULATED') simulated += paid.received;
      let unassigned = paid.received;
      for (const row of booking.collections) {
        const amount = halalas(row.amount);
        increase(methods, COLLECTION_METHOD_KEYS[row.method] ?? row.method.toLowerCase(), amount);
        unassigned -= amount;
      }
      if (unassigned > 0) increase(methods, booking.payment?.method ?? 'other', unassigned);
    }

    const liveOrders = ordersOf(rows).filter((order) => order.status !== 'CANCELLED');
    const seats = liveOrders.reduce((sum, order) => sum + order._count.passengers, 0);

    const running = trips.filter((trip) => trip.tripStatus !== 'CANCELLED');
    const offered = running.reduce((sum, trip) => sum + trip.totalSeats, 0);
    const taken = running.reduce((sum, trip) => sum + Math.max(0, trip.totalSeats - trip.availableSeats), 0);

    const ranked = [...routes].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
    const others = ranked.slice(TOP_ROUTES).reduce((sum, [, amount]) => sum + amount, 0);
    const moneyMethods = [...methods].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
    const moneyTotal = moneyMethods.reduce((sum, [, amount]) => sum + amount, 0);
    const typesTotal = [...types.values()].reduce((sum, amount) => sum + amount, 0);
    const averageBooking = liveOrders.length ? money(liveValue / liveOrders.length) : 0;

    return {
      gross: money(gross),
      net: money(gross - refunds),
      refunds: money(refunds),
      uncollected: money(uncollected),
      simulated: money(simulated),
      changePercent: previousGross > 0 ? Math.round(((gross - previousGross) / previousGross) * 100) : null,
      averageBooking,
      averageSeats: liveOrders.length ? Math.round((seats / liveOrders.length) * 10) / 10 : 0,
      occupancy: percent(taken, offered),
      // The occupancy the panel shows: executed trips of the period and the next 30 days, apart, from the shared metrics.
      occupancyExecuted: occupancy.executed,
      occupancyNext30: occupancy.next30,
      byRoute: [
        ...ranked.slice(0, TOP_ROUTES).map(([label, amount]) => ({ label, amount: money(amount) })),
        ...(others > 0 ? [{ label: OTHER_ROUTES_LABEL, amount: money(others) }] : []),
      ],
      byType: [...types]
        .filter(([, amount]) => amount > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([key, amount]) => ({ key, label: BOOKING_TYPE_LABELS[key] ?? key, amount: money(amount), share: percent(amount, typesTotal) })),
      methods: moneyMethods.map(([method, amount]) => ({ method, amount: money(amount), share: percent(amount, moneyTotal) })),
      wallet: money(wallet),
      basis: ctx.basis,
      totals: {
        gross: money(gross),
        net: money(gross - refunds),
        refunds: money(refunds),
        bookings: liveOrders.length,
        averageBooking,
        occupancy: occupancy.executed.percent,
      },
    };
  }

  async bookings(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query);
    const { period } = ctx;
    const rows = await this.prisma.booking.findMany({ where: ctx.where, select: BOOKING_COUNT_SELECT });
    const orders = ordersOf(rows);

    const statuses = new Map<string, number>();
    const sources = new Map<string, number>();
    const categories = new Map<string, number>();
    const branches = new Map<string, number>();
    for (const order of orders) {
      increase(statuses, order.status);
      increase(sources, order.source);
      increase(categories, order.category);
      if (order.source === 'BRANCH' && order.status !== 'CANCELLED') increase(branches, order.branch?.name ?? 'بدون فرع');
    }

    const live = orders.filter((order) => order.status !== 'CANCELLED');
    const cancelled = orders.length - live.length;
    const passengers = live.reduce((sum, order) => sum + order._count.passengers, 0);
    const appShare = percent(sources.get('APP') ?? 0, orders.length);
    return {
      total: orders.length,
      passengers,
      cancelled,
      cancelRate: percent(cancelled, orders.length),
      appShare,
      series: this.series(period, orders.map((order) => ({ at: this.atOf(order, ctx.basis, period), amount: 1 }))),
      statuses: shares(statuses, STATUS_LABELS),
      sources: shares(sources, SOURCE_LABELS),
      categories: shares(categories, CATEGORY_LABELS),
      branches: shares(branches),
      basis: ctx.basis,
      totals: { total: orders.length, passengers, cancelled, appShare },
    };
  }

  /** The app against each branch. Counts are bookings as the customer sees them; revenue adds up every leg. */
  async sources(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query);
    const rows = await this.prisma.booking.findMany({ where: ctx.where, select: BOOKING_SELECT });
    const channelOf = (row: ReportBooking) => (row.source === 'BRANCH' ? row.branchId ?? UNKNOWN_KEY : row.source);
    const labelOf = (row: ReportBooking) => (row.source === 'BRANCH' ? row.branch?.name ?? 'فرع غير محدد' : SOURCE_LABELS[row.source] ?? row.source);

    const counts = new Map<string, number>();
    const revenue = new Map<string, number>();
    const labels = new Map<string, string>();
    const isApp = new Map<string, boolean>();
    for (const order of ordersOf(rows)) {
      if (order.status === 'CANCELLED') continue;
      increase(counts, channelOf(order));
    }
    for (const row of rows) {
      const channel = channelOf(row);
      increase(revenue, channel, bookingFigures(row).net);
      labels.set(channel, labelOf(row));
      isApp.set(channel, row.source !== 'BRANCH');
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const channels = [...revenue.keys()]
      .map((channel) => {
        const bookings = counts.get(channel) ?? 0;
        const amount = revenue.get(channel) ?? 0;
        return {
          key: channel,
          label: labels.get(channel) ?? channel,
          isApp: !!isApp.get(channel),
          bookings,
          share: percent(bookings, total),
          revenue: ctx.money(amount),
          average: bookings ? ctx.money(Math.round(amount / bookings)) : 0,
        };
      })
      .sort((a, b) => b.bookings - a.bookings);
    const sum = (rowsOf: typeof channels, key: 'bookings' | 'revenue') => Math.round(rowsOf.reduce((value, row) => value + row[key], 0) * 100) / 100;
    const app = channels.filter((row) => row.isApp);
    const branches = channels.filter((row) => !row.isApp);
    return {
      total,
      app: { bookings: sum(app, 'bookings'), revenue: sum(app, 'revenue'), share: percent(sum(app, 'bookings'), total) },
      branches: { bookings: sum(branches, 'bookings'), revenue: sum(branches, 'revenue'), share: percent(sum(branches, 'bookings'), total), count: branches.length },
      channels,
      basis: ctx.basis,
      totals: { appBookings: sum(app, 'bookings'), branchBookings: sum(branches, 'bookings'), appRevenue: sum(app, 'revenue'), branchRevenue: sum(branches, 'revenue') },
    };
  }

  /** Trips are always read by their departure, and only the route filter applies to them: a trip carries every branch and channel. */
  async trips(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const [trips, occupancy] = await Promise.all([this.tripsDeparting(period.start, period.end, query), this.metrics.occupancy(this.tripScope(query), period)]);
    const running = trips.filter((trip) => trip.tripStatus !== 'CANCELLED');
    const takenOf = (trip: { totalSeats: number; availableSeats: number }) => Math.max(0, trip.totalSeats - trip.availableSeats);

    const routes = new Map<string, { label: string; origin: string; destination: string; trips: number; offered: number; taken: number }>();
    for (const trip of running) {
      const label = routeLabel(trip.origin, trip.destination);
      const route = routes.get(label) ?? { label, origin: trip.origin, destination: trip.destination, trips: 0, offered: 0, taken: 0 };
      route.trips += 1;
      route.offered += trip.totalSeats;
      route.taken += takenOf(trip);
      routes.set(label, route);
    }
    const offered = running.reduce((sum, trip) => sum + trip.totalSeats, 0);
    const taken = running.reduce((sum, trip) => sum + takenOf(trip), 0);
    const completed = running.filter((trip) => trip.tripStatus === 'COMPLETED').length;

    return {
      total: running.length,
      completed,
      cancelled: trips.length - running.length,
      offered,
      taken,
      occupancy: percent(taken, offered),
      occupancyExecuted: occupancy.executed,
      occupancyNext30: occupancy.next30,
      series: this.series(period, running.map((trip) => ({ at: trip.departureTime, amount: 1 }))),
      routes: [...routes.values()]
        .sort((a, b) => b.taken - a.taken)
        .slice(0, 10)
        .map((route) => ({ ...route, occupancy: percent(route.taken, route.offered) })),
      lowest: running
        .map((trip) => ({ id: trip.id, tripCode: trip.tripCode, route: routeLabel(trip.origin, trip.destination), departureTime: trip.departureTime, taken: takenOf(trip), offered: trip.totalSeats, occupancy: percent(takenOf(trip), trip.totalSeats) }))
        .sort((a, b) => a.occupancy - b.occupancy)
        .slice(0, 5),
      basis: 'trip' as DateBasis,
      totals: { total: running.length, completed, cancelled: trips.length - running.length, occupancy: occupancy.executed.percent },
    };
  }

  /** The register's rows of a period, by the chosen date: the operation's own date unless the report reads by booking or trip. */
  private paymentWhere(query: ReportRangeQuery, ctx: Context): Prisma.PaymentTransactionWhereInput {
    if (ctx.basis === 'payment') {
      const scope = this.scopeWhere(query);
      return { createdAt: { gte: ctx.period.start, lt: ctx.period.end }, ...(Object.keys(scope).length > 0 && { booking: scope }) };
    }
    return { booking: ctx.where };
  }

  /**
   * The register behind /payments: online charges, branch collections (cash, network, transfer) and refunds.
   * Only the register is summed here, and the revenue tab reads bookings, never this register, so nothing counts twice.
   */
  async payments(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query, 'payment');
    const { period, money } = ctx;
    const where = this.paymentWhere(query, ctx);
    const [groups, charges] = await Promise.all([
      this.prisma.paymentTransaction.groupBy({ by: ['type', 'status', 'destination', 'method', 'simulated'], where, _count: true, _sum: { amount: true } }),
      this.prisma.paymentTransaction.findMany({
        where: { AND: [where, CHARGE_SUCCEEDED] },
        select: { createdAt: true, amount: true, booking: { select: { createdAt: true, trip: { select: { departureTime: true } } } } },
      }),
    ]);

    const figures = (match: (group: (typeof groups)[number]) => boolean) => {
      const rows = groups.filter(match);
      return { count: rows.reduce((sum, row) => sum + row._count, 0), amount: money(rows.reduce((sum, row) => sum + halalas(row._sum.amount ?? 0), 0)) };
    };
    const succeeded = (row: (typeof groups)[number]) => row.type === 'CHARGE' && row.status === 'SUCCEEDED';

    const methods = new Map<string, number>();
    for (const row of groups.filter(succeeded)) increase(methods, row.method ?? 'other', halalas(row._sum.amount ?? 0));
    const methodsTotal = [...methods.values()].reduce((sum, amount) => sum + amount, 0);
    const atOf = (row: (typeof charges)[number]) => (ctx.basis === 'booking' ? row.booking.createdAt : ctx.basis === 'trip' ? row.booking.trip.departureTime : row.createdAt);

    const result = {
      // Until the gateway ships nothing can report a failed attempt, so the page says why those figures are empty.
      gatewayConnected: false,
      succeeded: figures(succeeded),
      simulated: figures((row) => succeeded(row) && row.simulated),
      failed: figures((row) => row.type === 'CHARGE' && (row.status === 'FAILED' || row.status === 'CANCELLED')),
      walletRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'WALLET' && row.status === 'SUCCEEDED'),
      originalRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'ORIGINAL' && row.status === 'SUCCEEDED'),
      pendingRefunds: figures((row) => row.type === 'REFUND' && row.status === 'PENDING'),
      series: this.series(period, charges.map((row) => ({ at: atOf(row), amount: Math.round(Number(row.amount) * ctx.factor) }))),
      methods: [...methods].sort((a, b) => b[1] - a[1]).map(([method, amount]) => ({ method, amount: money(amount), share: percent(amount, methodsTotal) })),
      basis: ctx.basis,
    };
    return {
      ...result,
      totals: {
        succeeded: result.succeeded.amount,
        failed: result.failed.count,
        refunds: Math.round((result.walletRefunds.amount + result.originalRefunds.amount) * 100) / 100,
        pendingRefunds: result.pendingRefunds.amount,
      },
    };
  }

  /** Customers who booked in the period, by city, nationality, and age and gender. A field nobody filled shows as "غير محدد". */
  async customers(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query);
    const rows = await this.prisma.booking.findMany({ where: ctx.where, select: CUSTOMER_BOOKING_SELECT });
    const liveOrders = ordersOf(rows).filter((order) => order.status !== 'CANCELLED');

    type Group = { customers: Set<string>; bookings: number; revenue: number };
    const fresh = (): Group => ({ customers: new Set(), bookings: 0, revenue: 0 });
    const tally = (keyOf: (row: (typeof rows)[number]) => string) => {
      const groups = new Map<string, Group>();
      const of = (key: string) => groups.get(key) ?? groups.set(key, fresh()).get(key)!;
      for (const order of liveOrders) {
        const group = of(keyOf(order));
        group.customers.add(order.userId);
        group.bookings += 1;
      }
      for (const row of rows) of(keyOf(row)).revenue += bookingFigures(row).net;
      return groups;
    };
    const customersTotal = new Set(liveOrders.map((order) => order.userId)).size;
    const table = (groups: Map<string, Group>, labelOf: (key: string) => string) =>
      [...groups]
        .map(([key, group]) => ({
          key,
          label: labelOf(key),
          customers: group.customers.size,
          share: percent(group.customers.size, customersTotal),
          bookings: group.bookings,
          revenue: ctx.money(group.revenue),
        }))
        // The unknown group goes last, whatever its size.
        .sort((a, b) => Number(a.key === UNKNOWN_KEY) - Number(b.key === UNKNOWN_KEY) || b.customers - a.customers || b.revenue - a.revenue);

    const known = (value: string | null) => (value && value.trim() ? value.trim() : UNKNOWN_KEY);
    const label = (key: string) => (key === UNKNOWN_KEY ? UNKNOWN_LABEL : key);
    const ageGroupLabel = (key: string) => AGE_GROUPS.find((group) => group.key === key)?.label ?? UNKNOWN_LABEL;

    const ageOf = (row: (typeof rows)[number]) => ageGroupOf(row.user.birthDate, query.to);
    const genderOf = (row: (typeof rows)[number]) => row.user.gender ?? UNKNOWN_KEY;
    const ages = tally(ageOf);
    const ageGender = tally((row) => `${ageOf(row)}|${genderOf(row)}`);
    const ageOrder = [...AGE_GROUPS.map((group) => group.key), UNKNOWN_KEY];
    const byAgeGender = ageOrder
      .filter((key) => ages.has(key))
      .map((key) => {
        const count = (gender: string) => ageGender.get(`${key}|${gender}`)?.customers.size ?? 0;
        const group = ages.get(key)!;
        return {
          key,
          label: ageGroupLabel(key),
          male: count('MALE'),
          female: count('FEMALE'),
          unknown: count(UNKNOWN_KEY),
          customers: group.customers.size,
          share: percent(group.customers.size, customersTotal),
          bookings: group.bookings,
          revenue: ctx.money(group.revenue),
        };
      });
    const genders = tally(genderOf);
    const revenue = ctx.money(rows.reduce((sum, row) => sum + bookingFigures(row).net, 0));

    return {
      customers: customersTotal,
      bookings: liveOrders.length,
      revenue,
      byCity: table(tally((row) => known(row.user.city)), label),
      byNationality: table(tally((row) => known(row.user.nationality)), label),
      byAgeGender,
      byGender: table(genders, (key) => GENDER_LABELS[key] ?? UNKNOWN_LABEL),
      basis: ctx.basis,
      totals: { customers: customersTotal, bookings: liveOrders.length, revenue },
    };
  }

  /** Bookings that sold a stay, by any of the ways a stay is recorded on a booking. */
  private housedWhere(): Prisma.BookingWhereInput {
    return {
      status: { not: 'CANCELLED' },
      OR: [{ stayHotelId: { not: null } }, { serviceType: { in: [...HOUSING_SERVICE_TYPES] } }, { housingAmount: { gt: 0 } }],
    };
  }

  /** One stay per customer booking: a round trip's legs are merged, the stay being on whichever leg carries the hotel. */
  private stays(rows: HotelRow[], ctx: Context) {
    const groups = new Map<string, HotelRow[]>();
    for (const row of rows) {
      const key = row.groupReference ?? row.id;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((legs) => {
      const main = legs.find((leg) => leg.stayHotel) ?? legs.find((leg) => halalas(leg.housingAmount) > 0) ?? legs[0];
      const tripHotel = main.trip.hotelBookings[0];
      const hotel = main.stayHotel ?? tripHotel?.hotel ?? null;
      const nights =
        main.stayNights ??
        (main.stayCheckIn && main.stayCheckOut ? daysBetween(main.stayCheckIn, main.stayCheckOut) : null) ??
        (tripHotel ? daysBetween(tripHotel.checkIn, tripHotel.checkOut) : null) ??
        main.trip.accommodations[0]?.nights ??
        0;
      const guests = Math.max(...legs.map((leg) => leg._count.passengers));
      // Housing sold on top of the seats, plus its value inside the seat price when the trip includes it.
      const charged = legs.reduce((sum, leg) => sum + halalas(leg.housingAmount), 0);
      const included = Math.round(includedBedValue(main.trip, nights) * 100) * guests;
      // A private room is one room; shared beds are their share of a room of the trip's size.
      const roomNights = main.roomChoice === 'PRIVATE' ? nights : (guests / Math.max(1, main.trip.sharedRoomCapacity)) * nights;
      return {
        id: main.id,
        at: this.atOf(main, ctx.basis, ctx.period),
        hotelId: hotel?.id ?? UNKNOWN_KEY,
        hotelName: hotel?.name ?? UNKNOWN_LABEL,
        nights,
        guests,
        guestNights: guests * nights,
        roomNights,
        sales: charged + included,
      };
    });
  }

  /**
   * Hotel sales by week, Sunday to Saturday, each month with its own weeks: a week across a month's edge is split in two.
   * Per week and per hotel: bookings, nights, room nights and sales, with each month's totals.
   */
  async hotels(query: ReportRangeQuery) {
    const ctx = await this.contextOf(query);
    const rows = await this.prisma.booking.findMany({ where: { AND: [ctx.where, this.housedWhere()] }, select: HOTEL_BOOKING_SELECT });
    const stays = this.stays(rows, ctx);

    type Figures = { bookings: number; nights: number; guestNights: number; roomNights: number; sales: number };
    const zero = (): Figures => ({ bookings: 0, nights: 0, guestNights: 0, roomNights: 0, sales: 0 });
    const add = (into: Figures, stay: (typeof stays)[number]) => {
      into.bookings += 1;
      into.nights += stay.nights;
      into.guestNights += stay.guestNights;
      into.roomNights += stay.roomNights;
      into.sales += stay.sales;
    };
    const out = (figures: Figures) => ({ ...figures, roomNights: Math.round(figures.roomNights * 10) / 10, sales: ctx.money(figures.sales) });
    const hotelNames = new Map(stays.map((stay) => [stay.hotelId, stay.hotelName]));
    const byHotel = (map: Map<string, Figures>) =>
      [...map]
        .map(([hotelId, figures]) => ({ hotelId, hotelName: hotelNames.get(hotelId) ?? UNKNOWN_LABEL, ...out(figures) }))
        .sort((a, b) => Number(a.hotelId === UNKNOWN_KEY) - Number(b.hotelId === UNKNOWN_KEY) || b.sales - a.sales);

    const weeks = monthWeeks(query.from, query.to).map((week) => ({ ...week, figures: zero(), hotels: new Map<string, Figures>() }));
    const total = zero();
    const hotels = new Map<string, Figures>();
    for (const stay of stays) {
      const day = riyadhDate(stay.at);
      const week = weeks.find((row) => row.from <= day && day <= row.to);
      if (!week) continue;
      add(week.figures, stay);
      add(week.hotels.get(stay.hotelId) ?? week.hotels.set(stay.hotelId, zero()).get(stay.hotelId)!, stay);
      add(total, stay);
      add(hotels.get(stay.hotelId) ?? hotels.set(stay.hotelId, zero()).get(stay.hotelId)!, stay);
    }

    const months = [...new Set(weeks.map((week) => week.month))].map((month) => {
      const own = weeks.filter((week) => week.month === month);
      const figures = zero();
      const monthHotels = new Map<string, Figures>();
      for (const week of own) {
        for (const key of Object.keys(figures) as (keyof Figures)[]) figures[key] += week.figures[key];
        for (const [hotelId, row] of week.hotels) {
          const into = monthHotels.get(hotelId) ?? monthHotels.set(hotelId, zero()).get(hotelId)!;
          for (const key of Object.keys(into) as (keyof Figures)[]) into[key] += row[key];
        }
      }
      return {
        month,
        totals: out(figures),
        hotels: byHotel(monthHotels),
        weeks: own.map((week) => ({ index: week.index, from: week.from, to: week.to, ...out(week.figures), hotels: byHotel(week.hotels) })),
      };
    });

    const totals = out(total);
    return { ...totals, hotels: byHotel(hotels), months, basis: ctx.basis, totals };
  }

  /** The records behind a figure: the report's own filters, narrowed by the figure clicked. */
  async records(query: ReportRecordsQuery) {
    if (query.kind === 'trips') return this.tripRecords(query);
    if (query.kind === 'payments') return this.paymentRecords(query);
    return this.bookingRecords(query);
  }

  private async bookingRecords(query: ReportRecordsQuery) {
    const ctx = await this.contextOf(query);
    const and: Prisma.BookingWhereInput[] = [ctx.where];
    const status = query.status;
    if (status === 'live') and.push({ status: { not: 'CANCELLED' } });
    else if (status === 'cancelled') and.push({ status: 'CANCELLED' });
    else if (status && status !== 'all' && (Object.values(BookingStatus) as string[]).includes(status)) and.push({ status: status as BookingStatus });
    if (query.channel) and.push(query.channel === 'APP' ? { source: 'APP' } : { source: 'BRANCH', branchId: query.channel === UNKNOWN_KEY ? null : query.channel });
    const field = (value: string | undefined, column: 'city' | 'nationality') =>
      value && and.push({ user: value === UNKNOWN_KEY ? { OR: [{ [column]: null }, { [column]: '' }] } : { [column]: value } });
    field(query.city, 'city');
    field(query.nationality, 'nationality');
    if (query.gender) and.push({ user: { gender: query.gender === UNKNOWN_KEY ? null : (query.gender as 'MALE' | 'FEMALE') } });
    if (query.ageGroup) {
      const group = AGE_GROUPS.find((row) => row.key === query.ageGroup);
      and.push({ user: group ? { birthDate: { lte: yearsBefore(query.to, group.min), gt: yearsBefore(query.to, group.max) } } : { birthDate: null } });
    }
    if (query.bookingType) and.push({ trip: { bookingType: query.bookingType } });
    if (query.housed || query.hotelId) {
      and.push(this.housedWhere());
      if (query.hotelId === UNKNOWN_KEY) and.push({ stayHotelId: null, trip: { hotelBookings: { none: { status: 'CONFIRMED' } } } });
      else if (query.hotelId) and.push({ OR: [{ stayHotelId: query.hotelId }, { stayHotelId: null, trip: { hotelBookings: { some: { hotelId: query.hotelId, status: 'CONFIRMED' } } } }] });
    }
    const where: Prisma.BookingWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_RECORDS,
        select: {
          ...CANCELLED_MONEY_SELECT,
          id: true,
          bookingReference: true,
          createdAt: true,
          source: true,
          branch: { select: { name: true } },
          user: { select: { name: true, phone: true } },
          trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true } },
          _count: { select: { passengers: true } },
        },
      }),
    ]);
    return {
      kind: 'bookings' as const,
      total,
      rows: rows.map((row) => ({
        id: row.id,
        reference: row.bookingReference,
        customer: row.user.name ?? row.user.phone,
        tripId: row.trip.id,
        tripCode: row.trip.tripCode,
        route: routeLabel(row.trip.origin, row.trip.destination),
        createdAt: row.createdAt,
        departureTime: row.trip.departureTime,
        status: row.status,
        statusLabel: STATUS_LABELS[row.status] ?? row.status,
        channel: row.source === 'BRANCH' ? row.branch?.name ?? 'فرع غير محدد' : SOURCE_LABELS[row.source] ?? row.source,
        passengers: row._count.passengers,
        amount: ctx.money(bookingFigures(row).net),
      })),
    };
  }

  private async tripRecords(query: ReportRecordsQuery) {
    const period = this.periodOf(query);
    const status = query.status;
    const tripStatus: Prisma.TripWhereInput['tripStatus'] =
      status === 'completed' ? 'COMPLETED' : status === 'cancelled' ? 'CANCELLED' : status === 'all' ? { not: 'DRAFT' } : { notIn: ['DRAFT', 'CANCELLED'] };
    const where: Prisma.TripWhereInput = { ...this.tripScope(query), departureTime: { gte: period.start, lt: period.end }, tripStatus };
    const [total, rows] = await Promise.all([
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({
        where,
        orderBy: { departureTime: 'asc' },
        take: MAX_RECORDS,
        select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, tripStatus: true, totalSeats: true, availableSeats: true },
      }),
    ]);
    return {
      kind: 'trips' as const,
      total,
      rows: rows.map((trip) => {
        const taken = Math.max(0, trip.totalSeats - trip.availableSeats);
        return { id: trip.id, tripCode: trip.tripCode, route: routeLabel(trip.origin, trip.destination), departureTime: trip.departureTime, status: trip.tripStatus, taken, offered: trip.totalSeats, occupancy: percent(taken, trip.totalSeats) };
      }),
    };
  }

  private async paymentRecords(query: ReportRecordsQuery) {
    const ctx = await this.contextOf(query, 'payment');
    const matches: Record<string, Prisma.PaymentTransactionWhereInput> = {
      succeeded: CHARGE_SUCCEEDED,
      simulated: { ...CHARGE_SUCCEEDED, simulated: true },
      failed: { type: 'CHARGE', status: { in: ['FAILED', 'CANCELLED'] } },
      refunds: { type: 'REFUND', status: 'SUCCEEDED' },
      walletRefunds: { type: 'REFUND', status: 'SUCCEEDED', destination: 'WALLET' },
      originalRefunds: { type: 'REFUND', status: 'SUCCEEDED', destination: 'ORIGINAL' },
      pendingRefunds: { type: 'REFUND', status: 'PENDING' },
    };
    const where: Prisma.PaymentTransactionWhereInput = { AND: [this.paymentWhere(query, ctx), matches[query.status ?? ''] ?? {}] };
    const [total, rows] = await Promise.all([
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_RECORDS,
        select: {
          id: true,
          number: true,
          type: true,
          status: true,
          method: true,
          destination: true,
          simulated: true,
          amount: true,
          createdAt: true,
          booking: { select: { id: true, bookingReference: true, user: { select: { name: true, phone: true } } } },
        },
      }),
    ]);
    return {
      kind: 'payments' as const,
      total,
      rows: rows.map((row) => ({
        id: row.id,
        number: row.number,
        type: row.type,
        status: row.status,
        method: row.method,
        destination: row.destination,
        simulated: row.simulated,
        amount: ctx.money(halalas(row.amount)),
        createdAt: row.createdAt,
        bookingId: row.booking.id,
        reference: row.booking.bookingReference,
        customer: row.booking.user.name ?? row.booking.user.phone,
      })),
    };
  }

  /** A repeat of today's step for this device and route changes nothing. */
  async recordEvent(dto: AppEventDto) {
    await this.prisma.appEvent.createMany({
      data: [{
        deviceId: dto.deviceId,
        type: dto.type,
        platform: dto.platform,
        day: dateColumn(riyadhDate(new Date())),
        origin: dto.origin?.trim() ?? '',
        destination: dto.destination?.trim() ?? '',
      }],
      skipDuplicates: true,
    });
  }

  async app(days: number) {
    const now = new Date();
    const today = riyadhDate(now);
    const from = riyadhDate(addDays(now, -(days - 1)));
    const activeFrom = riyadhDate(addDays(now, -(ACTIVE_WINDOW_DAYS - 1)));
    const window = { gte: dateColumn(from), lte: dateColumn(today) };

    const [platforms, active, steps, opens, routes, appBookings] = await Promise.all([
      this.prisma.$queryRaw<{ platform: string; count: number }[]>`
        SELECT platform, COUNT(DISTINCT "deviceId")::int AS count FROM "AppEvent" GROUP BY platform`,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT "deviceId")::int AS count FROM "AppEvent" WHERE day >= ${activeFrom}::date`,
      // A device counts once a day at each step, however many routes it looked at.
      this.prisma.$queryRaw<{ type: string; count: number }[]>`
        SELECT type::text AS type, COUNT(DISTINCT ("deviceId", day))::int AS count FROM "AppEvent"
        WHERE day >= ${from}::date AND day <= ${today}::date GROUP BY type`,
      this.prisma.appEvent.groupBy({ by: ['day'], where: { type: 'APP_OPEN', day: window }, _count: true }),
      this.prisma.appEvent.groupBy({
        by: ['origin', 'destination', 'type'],
        where: { type: { in: ['TRIP_SEARCH', 'TRIP_VIEW', 'BOOKING_PAID'] }, day: window, origin: { not: '' } },
        _count: true,
      }),
      this.prisma.booking.count({
        where: { source: 'APP', status: { not: 'CANCELLED' }, createdAt: { gte: riyadhDayRange(from)!.start, lt: riyadhDayRange(today)!.end } },
      }),
    ]);

    const stepCount = (type: string) => steps.find((row) => row.type === type)?.count ?? 0;
    const visits = stepCount('APP_OPEN');
    const paid = stepCount('BOOKING_PAID');

    const perDay = new Map(opens.map((row) => [row.day.toISOString().slice(0, 10), row._count]));
    const daily = Array.from({ length: days }, (_, index) => {
      const key = riyadhDate(addDays(now, index - (days - 1)));
      return { key, value: perDay.get(key) ?? 0 };
    });

    const byRoute = new Map<string, { origin: string; destination: string; searches: number; views: number; bookings: number }>();
    for (const row of routes) {
      const key = routeLabel(row.origin, row.destination);
      const route = byRoute.get(key) ?? { origin: row.origin, destination: row.destination, searches: 0, views: 0, bookings: 0 };
      if (row.type === 'TRIP_SEARCH') route.searches = row._count;
      if (row.type === 'TRIP_VIEW') route.views = row._count;
      if (row.type === 'BOOKING_PAID') route.bookings = row._count;
      byRoute.set(key, route);
    }

    return {
      installs: {
        total: platforms.reduce((sum, row) => sum + row.count, 0),
        ios: platforms.find((row) => row.platform === 'ios')?.count ?? 0,
        android: platforms.find((row) => row.platform === 'android')?.count ?? 0,
      },
      activeUsers: active[0]?.count ?? 0,
      activeWindowDays: ACTIVE_WINDOW_DAYS,
      visits,
      appBookings,
      conversion: percent(paid, visits),
      daily,
      funnel: [
        { key: 'APP_OPEN', label: 'زيارات التطبيق', count: visits, share: visits ? 100 : 0 },
        { key: 'TRIP_SEARCH', label: 'بحث عن رحلة', count: stepCount('TRIP_SEARCH'), share: percent(stepCount('TRIP_SEARCH'), visits) },
        { key: 'TRIP_VIEW', label: 'فتح تفاصيل رحلة', count: stepCount('TRIP_VIEW'), share: percent(stepCount('TRIP_VIEW'), visits) },
        { key: 'BOOKING_START', label: 'بدء الحجز', count: stepCount('BOOKING_START'), share: percent(stepCount('BOOKING_START'), visits) },
        { key: 'BOOKING_PAID', label: 'دفع ناجح', count: paid, share: percent(paid, visits) },
      ],
      topRoutes: [...byRoute.entries()]
        .sort((a, b) => b[1].searches - a[1].searches)
        .slice(0, 5)
        .map(([label, route]) => ({
          label,
          searches: route.searches,
          views: route.views,
          bookings: route.bookings,
          conversion: Math.min(100, percent(route.bookings, route.searches)),
        })),
    };
  }
}

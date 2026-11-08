import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { PrismaService } from '../../common/services/prisma.service';
import { halalas, netBookingFigures, paymentFigures } from '../../common/utils/payment.util';
import { addDays, riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import { AppEventDto, ReportRangeQuery } from './reports.dto';

const MAX_RANGE_DAYS = 366;
/** Longer periods are drawn by month, because a bar per day stops being readable. */
const MAX_DAILY_BARS = 62;
const TOP_ROUTES = 8;
const ACTIVE_WINDOW_DAYS = 30;
const OTHER_ROUTES_LABEL = 'مسارات أخرى';

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

const COLLECTION_METHOD_KEYS: Record<string, string> = { CASH: 'cash', NETWORK: 'network', TRANSFER: 'transfer' };

const sar = (value: number) => Math.round(value) / 100;
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const routeLabel = (origin: string, destination: string) => `${origin} ← ${destination}`;

/** A date-only column is stored as midnight UTC, whatever the time zone of the day it names. */
const dateColumn = (date: string) => new Date(`${date}T00:00:00.000Z`);

const BOOKING_SELECT = {
  id: true,
  groupReference: true,
  status: true,
  source: true,
  category: true,
  createdAt: true,
  totalPrice: true,
  refundAmount: true,
  externalRefunded: true,
  branch: { select: { name: true } },
  trip: { select: { origin: true, destination: true, bookingType: true } },
  payment: { select: { amount: true, walletAmount: true, status: true, method: true } },
  collections: { select: { method: true, amount: true } },
  cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
  _count: { select: { passengers: true } },
} satisfies Prisma.BookingSelect;

type ReportBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>;

/** What the counts need, without the money behind each booking. */
const BOOKING_COUNT_SELECT = {
  id: true,
  groupReference: true,
  status: true,
  source: true,
  category: true,
  createdAt: true,
  branch: { select: { name: true } },
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

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  private periodOf(query: ReportRangeQuery) {
    const first = riyadhDayRange(query.from);
    const last = riyadhDayRange(query.to);
    if (!first || !last) throw new BadRequestException('التاريخ غير صحيح');
    if (first.start > last.start) throw new BadRequestException('بداية الفترة بعد نهايتها');
    const days = Math.round((last.start.getTime() - first.start.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException('أقصى فترة للتقرير سنة واحدة');
    return { start: first.start, end: last.end, days };
  }

  /** Every bucket of the period, including the empty ones, so a quiet day shows as a gap and not as nothing. */
  private series(period: { start: Date; days: number }, values: { at: Date; amount: number }[]) {
    const byMonth = period.days > MAX_DAILY_BARS;
    const keyOf = (date: Date) => (byMonth ? riyadhDate(date).slice(0, 7) : riyadhDate(date));
    const buckets = new Map<string, number>();
    for (let index = 0; index < period.days; index += 1) buckets.set(keyOf(addDays(period.start, index)), 0);
    for (const value of values) increase(buckets, keyOf(value.at), value.amount);
    return [...buckets].map(([key, value]) => ({ key, value }));
  }

  private bookingsBetween(start: Date, end: Date) {
    return this.prisma.booking.findMany({ where: { createdAt: { gte: start, lt: end } }, select: BOOKING_SELECT });
  }

  /** Sold value of a period, the same as summing bookingFigures().sold, without loading every live booking. */
  private async soldBetween(start: Date, end: Date) {
    const createdAt = { gte: start, lt: end };
    const [live, cancelled] = await Promise.all([
      this.prisma.booking.aggregate({ where: { createdAt, status: { not: 'CANCELLED' } }, _sum: { totalPrice: true } }),
      this.prisma.booking.findMany({ where: { createdAt, status: 'CANCELLED' }, select: CANCELLED_MONEY_SELECT }),
    ]);
    return halalas(live._sum.totalPrice ?? 0) + cancelled.reduce((sum, booking) => sum + bookingFigures(booking).sold, 0);
  }

  private tripsDeparting(start: Date, end: Date) {
    return this.prisma.trip.findMany({
      where: { departureTime: { gte: start, lt: end }, tripStatus: { not: 'DRAFT' } },
      select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, tripStatus: true, totalSeats: true, availableSeats: true },
      orderBy: { departureTime: 'asc' },
    });
  }

  async revenue(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const [rows, previousGross, trips] = await Promise.all([
      this.bookingsBetween(period.start, period.end),
      this.soldBetween(addDays(period.start, -period.days), period.start),
      this.tripsDeparting(period.start, period.end),
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

      const money = paymentFigures(booking.payment, booking.collections);
      wallet += money.wallet;
      if (booking.payment?.status === 'SIMULATED') simulated += money.received;
      let unassigned = money.received;
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

    return {
      gross: sar(gross),
      net: sar(gross - refunds),
      refunds: sar(refunds),
      uncollected: sar(uncollected),
      simulated: sar(simulated),
      changePercent: previousGross > 0 ? Math.round(((gross - previousGross) / previousGross) * 100) : null,
      averageBooking: liveOrders.length ? sar(liveValue / liveOrders.length) : 0,
      averageSeats: liveOrders.length ? Math.round((seats / liveOrders.length) * 10) / 10 : 0,
      occupancy: percent(taken, offered),
      byRoute: [
        ...ranked.slice(0, TOP_ROUTES).map(([label, amount]) => ({ label, amount: sar(amount) })),
        ...(others > 0 ? [{ label: OTHER_ROUTES_LABEL, amount: sar(others) }] : []),
      ],
      byType: [...types]
        .filter(([, amount]) => amount > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([key, amount]) => ({ key, label: BOOKING_TYPE_LABELS[key] ?? key, amount: sar(amount), share: percent(amount, typesTotal) })),
      methods: moneyMethods.map(([method, amount]) => ({ method, amount: sar(amount), share: percent(amount, moneyTotal) })),
      wallet: sar(wallet),
    };
  }

  async bookings(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const rows = await this.prisma.booking.findMany({ where: { createdAt: { gte: period.start, lt: period.end } }, select: BOOKING_COUNT_SELECT });
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
    return {
      total: orders.length,
      passengers: live.reduce((sum, order) => sum + order._count.passengers, 0),
      cancelled,
      cancelRate: percent(cancelled, orders.length),
      appShare: percent(sources.get('APP') ?? 0, orders.length),
      series: this.series(period, orders.map((order) => ({ at: order.createdAt, amount: 1 }))),
      statuses: shares(statuses, STATUS_LABELS),
      sources: shares(sources, SOURCE_LABELS),
      categories: shares(categories, CATEGORY_LABELS),
      branches: shares(branches),
    };
  }

  /** The app against each branch. Counts are bookings as the customer sees them; revenue adds up every leg. */
  async sources(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const rows = await this.bookingsBetween(period.start, period.end);
    const channelOf = (row: ReportBooking) => (row.source === 'BRANCH' ? row.branch?.name ?? 'فرع غير محدد' : SOURCE_LABELS[row.source] ?? row.source);

    const counts = new Map<string, number>();
    const revenue = new Map<string, number>();
    const isApp = new Map<string, boolean>();
    for (const order of ordersOf(rows)) {
      if (order.status === 'CANCELLED') continue;
      increase(counts, channelOf(order));
    }
    for (const row of rows) {
      const channel = channelOf(row);
      increase(revenue, channel, bookingFigures(row).net);
      isApp.set(channel, row.source !== 'BRANCH');
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const channels = [...revenue.keys()]
      .map((channel) => {
        const bookings = counts.get(channel) ?? 0;
        const amount = revenue.get(channel) ?? 0;
        return {
          key: channel,
          label: channel,
          isApp: !!isApp.get(channel),
          bookings,
          share: percent(bookings, total),
          revenue: sar(amount),
          average: bookings ? sar(Math.round(amount / bookings)) : 0,
        };
      })
      .sort((a, b) => b.bookings - a.bookings);
    const sum = (rowsOf: typeof channels, key: 'bookings' | 'revenue') => rowsOf.reduce((value, row) => value + row[key], 0);
    const app = channels.filter((row) => row.isApp);
    const branches = channels.filter((row) => !row.isApp);
    return {
      total,
      app: { bookings: sum(app, 'bookings'), revenue: sum(app, 'revenue'), share: percent(sum(app, 'bookings'), total) },
      branches: { bookings: sum(branches, 'bookings'), revenue: sum(branches, 'revenue'), share: percent(sum(branches, 'bookings'), total), count: branches.length },
      channels,
    };
  }

  async trips(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const trips = await this.tripsDeparting(period.start, period.end);
    const running = trips.filter((trip) => trip.tripStatus !== 'CANCELLED');
    const takenOf = (trip: { totalSeats: number; availableSeats: number }) => Math.max(0, trip.totalSeats - trip.availableSeats);

    const routes = new Map<string, { label: string; trips: number; offered: number; taken: number }>();
    for (const trip of running) {
      const label = routeLabel(trip.origin, trip.destination);
      const route = routes.get(label) ?? { label, trips: 0, offered: 0, taken: 0 };
      route.trips += 1;
      route.offered += trip.totalSeats;
      route.taken += takenOf(trip);
      routes.set(label, route);
    }
    const offered = running.reduce((sum, trip) => sum + trip.totalSeats, 0);
    const taken = running.reduce((sum, trip) => sum + takenOf(trip), 0);

    return {
      total: running.length,
      completed: running.filter((trip) => trip.tripStatus === 'COMPLETED').length,
      cancelled: trips.length - running.length,
      offered,
      taken,
      occupancy: percent(taken, offered),
      series: this.series(period, running.map((trip) => ({ at: trip.departureTime, amount: 1 }))),
      routes: [...routes.values()]
        .sort((a, b) => b.taken - a.taken)
        .slice(0, 10)
        .map((route) => ({ ...route, occupancy: percent(route.taken, route.offered) })),
      lowest: running
        .map((trip) => ({ id: trip.id, tripCode: trip.tripCode, route: routeLabel(trip.origin, trip.destination), departureTime: trip.departureTime, taken: takenOf(trip), offered: trip.totalSeats, occupancy: percent(takenOf(trip), trip.totalSeats) }))
        .sort((a, b) => a.occupancy - b.occupancy)
        .slice(0, 5),
    };
  }

  /**
   * The register behind /payments: online charges, branch collections (cash, network, transfer) and refunds.
   * Only the register is summed here, and the revenue tab reads bookings, never this register, so nothing counts twice.
   */
  async payments(query: ReportRangeQuery) {
    const period = this.periodOf(query);
    const where = { createdAt: { gte: period.start, lt: period.end } };
    const [groups, charges] = await Promise.all([
      this.prisma.paymentTransaction.groupBy({ by: ['type', 'status', 'destination', 'method', 'simulated'], where, _count: true, _sum: { amount: true } }),
      this.prisma.paymentTransaction.findMany({ where: { ...where, type: 'CHARGE', status: 'SUCCEEDED' }, select: { createdAt: true, amount: true } }),
    ]);

    const figures = (match: (group: (typeof groups)[number]) => boolean) => {
      const rows = groups.filter(match);
      return { count: rows.reduce((sum, row) => sum + row._count, 0), amount: sar(rows.reduce((sum, row) => sum + halalas(row._sum.amount ?? 0), 0)) };
    };
    const succeeded = (row: (typeof groups)[number]) => row.type === 'CHARGE' && row.status === 'SUCCEEDED';

    const methods = new Map<string, number>();
    for (const row of groups.filter(succeeded)) increase(methods, row.method ?? 'other', halalas(row._sum.amount ?? 0));
    const methodsTotal = [...methods.values()].reduce((sum, amount) => sum + amount, 0);

    return {
      // Until the gateway ships nothing can report a failed attempt, so the page says why those figures are empty.
      gatewayConnected: false,
      succeeded: figures(succeeded),
      simulated: figures((row) => succeeded(row) && row.simulated),
      failed: figures((row) => row.type === 'CHARGE' && (row.status === 'FAILED' || row.status === 'CANCELLED')),
      walletRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'WALLET' && row.status === 'SUCCEEDED'),
      originalRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'ORIGINAL' && row.status === 'SUCCEEDED'),
      pendingRefunds: figures((row) => row.type === 'REFUND' && row.status === 'PENDING'),
      series: this.series(period, charges.map((row) => ({ at: row.createdAt, amount: Number(row.amount) }))),
      methods: [...methods].sort((a, b) => b[1] - a[1]).map(([method, amount]) => ({ method, amount: sar(amount), share: percent(amount, methodsTotal) })),
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

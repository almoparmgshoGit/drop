import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { PrismaService } from '../../common/services/prisma.service';
import { occupancyPercent } from '../../common/services/trip-metrics.service';
import { RIYADH_OFFSET_MS, riyadhDayRange } from '../../common/utils/time.util';
import { TripReportQuery } from './reports.dto';

const MAX_RANGE_DAYS = 366;
/** The heatmap's columns: two hours each, so a day fits on one row of the page. */
export const HOUR_BAND = 2;
const BANDS = 24 / HOUR_BAND;

/** 0 is Sunday, as Postgres and the trips' repeatWeekdays count them. */
export const WEEKDAY_LABELS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const routeLabel = (origin: string, destination: string) => `${origin} ← ${destination}`;
/** A rate to one decimal, as the other reports show theirs. */
const rate = occupancyPercent;

/** Riyadh's wall clock for a timestamp column, which stores UTC. Saudi Arabia keeps no daylight saving. */
const RIYADH = (column: Prisma.Sql) => Prisma.sql`(${column} + ${Prisma.raw(`INTERVAL '${RIYADH_OFFSET_MS / 3_600_000} hours'`)})`;

const likeText = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

type Slot = { trips: number; offered: number; taken: number };
const emptySlot = (): Slot => ({ trips: 0, offered: 0, taken: 0 });
const withOccupancy = <T extends Slot>(slot: T) => ({ ...slot, occupancy: rate(slot.taken, slot.offered) });

/**
 * When trips fill and where they let customers down: occupancy by Riyadh weekday and departure hour, and per route the
 * cancellations and no-shows. Each is a handful of grouped queries over the period, never a query per trip.
 */
@Injectable()
export class TripPatternsService {
  constructor(private prisma: PrismaService) {}

  private periodOf(query: TripReportQuery) {
    const first = riyadhDayRange(query.from);
    const last = riyadhDayRange(query.to);
    if (!first || !last) throw new BadRequestException('التاريخ غير صحيح');
    if (first.start > last.start) throw new BadRequestException('بداية الفترة بعد نهايتها');
    const days = Math.round((last.start.getTime() - first.start.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException('أقصى فترة للتقرير سنة واحدة');
    return { start: first.start, end: last.end };
  }

  /** A branch stands for the trips leaving from its city, as on the trips pages. A branch with no city narrows nothing. */
  private async branchCity(branchId?: string) {
    if (!branchId) return null;
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { city: true } });
    if (!branch) throw new BadRequestException('الفرع غير موجود');
    return branch.city?.trim() || null;
  }

  /** The trips of the period and the filters, as SQL over the trip table under the given alias. Drafts never ran. */
  private async tripScope(query: TripReportQuery) {
    const period = this.periodOf(query);
    const city = await this.branchCity(query.branchId);
    const origin = query.origin?.trim();
    const destination = query.destination?.trim();
    const bookingType = query.bookingType?.trim();
    return (alias: string) => {
      const t = Prisma.raw(alias);
      const conditions = [
        Prisma.sql`${t}."departureTime" >= ${period.start}`,
        Prisma.sql`${t}."departureTime" < ${period.end}`,
        Prisma.sql`${t}."tripStatus" <> 'DRAFT'`,
        // The route filter picks a route the other reports list, so it matches exactly, as they do.
        ...(origin ? [Prisma.sql`${t}.origin = ${origin}`] : []),
        ...(destination ? [Prisma.sql`${t}.destination = ${destination}`] : []),
        ...(bookingType ? [Prisma.sql`${t}."bookingType" = ${bookingType}`] : []),
        ...(city ? [Prisma.sql`${t}.origin ILIKE ${likeText(city)}`] : []),
      ];
      return { sql: Prisma.join(conditions, ' AND '), period };
    };
  }

  /** The source filter, on the bookings counted under alias b. */
  private bookingScope(query: TripReportQuery) {
    return query.source ? Prisma.sql`b.source::text = ${query.source}` : Prisma.sql`TRUE`;
  }

  /** The routes and types that ran in the period, unfiltered, for the page's pickers. */
  private async options(period: { start: Date; end: Date }) {
    const rows = await this.prisma.$queryRaw<{ origin: string; destination: string; bookingType: string }[]>`
      SELECT DISTINCT t.origin, t.destination, t."bookingType" FROM "Trip" t
      WHERE t."departureTime" >= ${period.start} AND t."departureTime" < ${period.end} AND t."tripStatus" <> 'DRAFT'`;
    const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ar'));
    const routes = new Map(rows.map((row) => [`${row.origin}|${row.destination}`, { key: `${row.origin}|${row.destination}`, origin: row.origin, destination: row.destination, label: routeLabel(row.origin, row.destination) }]));
    return {
      routes: [...routes.values()].sort((a, b) => a.label.localeCompare(b.label, 'ar')),
      origins: sorted(rows.map((row) => row.origin)),
      destinations: sorted(rows.map((row) => row.destination)),
      bookingTypes: sorted(rows.map((row) => row.bookingType)).map((key) => ({ key, label: BOOKING_TYPE_LABELS[key] ?? key })),
    };
  }

  /**
   * Seats sold out of seats offered on the trips that ran (published or completed, never cancelled), by the Riyadh
   * weekday and hour they left at, and weekday by two-hour band for the heatmap. Seats sold are the trip's taken seats,
   * the same figure the occupancy everywhere else reads.
   */
  async occupancyMatrix(query: TripReportQuery) {
    const scope = await this.tripScope(query);
    const { sql: where, period } = scope('t');
    const departure = RIYADH(Prisma.sql`t."departureTime"`);
    const [rows, options] = await Promise.all([
      this.prisma.$queryRaw<{ weekday: number; hour: number; trips: number; offered: number; taken: number }[]>`
        SELECT EXTRACT(DOW FROM ${departure})::int AS weekday,
               EXTRACT(HOUR FROM ${departure})::int AS hour,
               COUNT(*)::int AS trips,
               COALESCE(SUM(t."totalSeats"), 0)::int AS offered,
               COALESCE(SUM(GREATEST(t."totalSeats" - t."availableSeats", 0)), 0)::int AS taken
        FROM "Trip" t
        WHERE ${where} AND t."tripStatus" IN ('PUBLISHED', 'COMPLETED')
        GROUP BY 1, 2`,
      this.options(period),
    ]);

    const weekdays = WEEKDAY_LABELS.map(emptySlot);
    const hours = Array.from({ length: 24 }, emptySlot);
    const cells = WEEKDAY_LABELS.map(() => Array.from({ length: BANDS }, emptySlot));
    const total = emptySlot();
    for (const row of rows) {
      const band = Math.floor(row.hour / HOUR_BAND);
      for (const slot of [weekdays[row.weekday], hours[row.hour], cells[row.weekday][band], total]) {
        slot.trips += row.trips;
        slot.offered += row.offered;
        slot.taken += row.taken;
      }
    }

    const heatmap = cells.flatMap((bands, weekday) => bands.map((slot, band) => ({ weekday, band, fromHour: band * HOUR_BAND, ...withOccupancy(slot) })));
    const ran = heatmap.filter((cell) => cell.trips > 0);
    const byOccupancy = [...ran].sort((a, b) => b.occupancy - a.occupancy || b.trips - a.trips);
    return {
      total: withOccupancy(total),
      bandHours: HOUR_BAND,
      byWeekday: weekdays.map((slot, weekday) => ({ weekday, label: WEEKDAY_LABELS[weekday], ...withOccupancy(slot) })),
      byHour: hours.map((slot, hour) => ({ hour, ...withOccupancy(slot) })),
      heatmap,
      best: byOccupancy[0] ?? null,
      worst: byOccupancy.length > 1 ? byOccupancy[byOccupancy.length - 1] : null,
      options,
    };
  }

  /**
   * Per route, over the trips departing in the period:
   * - cancellations: every booking leg on the route's trips, cancelled ones split by who cancelled. A cancelled trip
   *   cancels its bookings; a customer's cancellation went through a request (cancelRequestedAt); the rest were the office's.
   * - no-shows: on executed trips, the passengers who boarded or were marked as not showing up are those expected to
   *   board, and the marked ones are the no-shows. A round trip's return counts on its reverse trip's route.
   * Sorted by the worse of the two rates, worst first.
   */
  async routeReliability(query: TripReportQuery) {
    const scope = await this.tripScope(query);
    const { sql: tripWhere, period } = scope('t');
    const { sql: reverseWhere } = scope('r');
    const executed = Prisma.sql`t."executedAt" IS NOT NULL AND t."tripStatus" <> 'CANCELLED'`;
    const bookingWhere = this.bookingScope(query);

    type Key = { origin: string; destination: string };
    const [trips, bookings, outbound, returns, options] = await Promise.all([
      this.prisma.$queryRaw<(Key & { trips: number; cancelledTrips: number; executed: number })[]>`
        SELECT t.origin, t.destination,
               COUNT(*) FILTER (WHERE t."tripStatus" <> 'CANCELLED')::int AS trips,
               COUNT(*) FILTER (WHERE t."tripStatus" = 'CANCELLED')::int AS "cancelledTrips",
               COUNT(*) FILTER (WHERE ${executed})::int AS executed
        FROM "Trip" t
        WHERE ${tripWhere}
        GROUP BY t.origin, t.destination`,
      this.prisma.$queryRaw<(Key & { bookings: number; cancelled: number; byTrip: number; byCustomer: number; passengers: number })[]>`
        SELECT t.origin, t.destination,
               COUNT(*)::int AS bookings,
               COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled,
               COUNT(*) FILTER (WHERE b.status = 'CANCELLED' AND t."tripStatus" = 'CANCELLED')::int AS "byTrip",
               COUNT(*) FILTER (WHERE b.status = 'CANCELLED' AND t."tripStatus" <> 'CANCELLED' AND b."cancelRequestedAt" IS NOT NULL)::int AS "byCustomer",
               COALESCE(SUM(p.count) FILTER (WHERE b.status <> 'CANCELLED'), 0)::int AS passengers
        FROM "Booking" b
        JOIN "Trip" t ON t.id = b."tripId"
        LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM "BookingPassenger" bp WHERE bp."bookingId" = b.id) p ON true
        WHERE ${tripWhere} AND ${bookingWhere}
        GROUP BY t.origin, t.destination`,
      this.prisma.$queryRaw<(Key & { expected: number; noShows: number })[]>`
        SELECT t.origin, t.destination,
               COUNT(*) FILTER (WHERE tk."isBoarded" OR tk."noShowAt" IS NOT NULL)::int AS expected,
               COUNT(*) FILTER (WHERE tk."noShowAt" IS NOT NULL)::int AS "noShows"
        FROM "Ticket" tk
        JOIN "Booking" b ON b.id = tk."bookingId"
        JOIN "Trip" t ON t.id = b."tripId"
        WHERE ${tripWhere} AND ${executed} AND b.status <> 'CANCELLED' AND ${bookingWhere}
        GROUP BY t.origin, t.destination`,
      this.prisma.$queryRaw<(Key & { expected: number; noShows: number })[]>`
        SELECT r.origin, r.destination,
               COUNT(*) FILTER (WHERE tk."returnBoardedAt" IS NOT NULL OR tk."returnNoShowAt" IS NOT NULL)::int AS expected,
               COUNT(*) FILTER (WHERE tk."returnNoShowAt" IS NOT NULL)::int AS "noShows"
        FROM "Trip" r
        JOIN "Booking" b ON b."tripId" = r."reverseOfTripId"
        JOIN "Ticket" tk ON tk."bookingId" = b.id
        WHERE ${reverseWhere} AND r."executedAt" IS NOT NULL AND r."tripStatus" <> 'CANCELLED' AND b.status <> 'CANCELLED' AND ${bookingWhere}
        GROUP BY r.origin, r.destination`,
      this.options(period),
    ]);

    const routes = new Map<string, Key & {
      trips: number; cancelledTrips: number; executedTrips: number; bookings: number; passengers: number;
      cancelled: number; cancelledByCustomer: number; cancelledByOffice: number; cancelledByTrip: number; expected: number; noShows: number;
    }>();
    const routeOf = ({ origin, destination }: Key) => {
      const key = `${origin}\u0000${destination}`;
      let route = routes.get(key);
      if (!route) {
        route = {
          origin, destination, trips: 0, cancelledTrips: 0, executedTrips: 0, bookings: 0, passengers: 0,
          cancelled: 0, cancelledByCustomer: 0, cancelledByOffice: 0, cancelledByTrip: 0, expected: 0, noShows: 0,
        };
        routes.set(key, route);
      }
      return route;
    };
    for (const row of trips) Object.assign(routeOf(row), { trips: row.trips, cancelledTrips: row.cancelledTrips, executedTrips: row.executed });
    for (const row of bookings) {
      Object.assign(routeOf(row), {
        bookings: row.bookings,
        passengers: row.passengers,
        cancelled: row.cancelled,
        cancelledByTrip: row.byTrip,
        cancelledByCustomer: row.byCustomer,
        cancelledByOffice: Math.max(0, row.cancelled - row.byTrip - row.byCustomer),
      });
    }
    for (const row of [...outbound, ...returns]) {
      const route = routeOf(row);
      route.expected += row.expected;
      route.noShows += row.noShows;
    }

    const rows = [...routes.values()]
      .map((route) => ({
        ...route,
        label: routeLabel(route.origin, route.destination),
        cancelRate: rate(route.cancelled, route.bookings),
        noShowRate: rate(route.noShows, route.expected),
      }))
      .sort((a, b) => Math.max(b.cancelRate, b.noShowRate) - Math.max(a.cancelRate, a.noShowRate) || b.bookings - a.bookings);

    const sum = (key: 'trips' | 'cancelledTrips' | 'executedTrips' | 'bookings' | 'passengers' | 'cancelled' | 'cancelledByCustomer' | 'cancelledByOffice' | 'cancelledByTrip' | 'expected' | 'noShows') =>
      rows.reduce((total, row) => total + row[key], 0);
    const totals = {
      trips: sum('trips'),
      cancelledTrips: sum('cancelledTrips'),
      executedTrips: sum('executedTrips'),
      bookings: sum('bookings'),
      passengers: sum('passengers'),
      cancelled: sum('cancelled'),
      cancelledByCustomer: sum('cancelledByCustomer'),
      cancelledByOffice: sum('cancelledByOffice'),
      cancelledByTrip: sum('cancelledByTrip'),
      expected: sum('expected'),
      noShows: sum('noShows'),
    };
    return {
      totals: { ...totals, cancelRate: rate(totals.cancelled, totals.bookings), noShowRate: rate(totals.noShows, totals.expected) },
      routes: rows,
      options,
    };
  }
}

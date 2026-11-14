import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { PAID_PAYMENT_STATUSES, halalas, netBookingFigures } from '../utils/payment.util';
import { addDays, startOfRiyadhDay } from '../utils/time.util';

/**
 * The one place the panel's shared figures are computed: the dashboard, the trips page and the reports all read them
 * from here, so the same figure for the same period is the same number wherever it shows.
 */

/** Occupancy is measured over executed trips and over the trips of the next 30 days, never mixed. */
export const OCCUPANCY_WINDOW_DAYS = 30;

/** Trips to Makkah are Umrah trips; Madinah trips are told apart by their destination. */
export const UMRAH_PLACES = ['مكة', 'مكه'];
export const MADINAH_PLACES = ['المدينة', 'المدينه'];

export const placeWhere = (names: string[]): Prisma.TripWhereInput => ({ OR: names.map((name) => ({ destination: { contains: name } })) });

/** Seats taken out of seats offered, to one decimal. */
export const occupancyPercent = (taken: number, offered: number) => (offered > 0 ? Math.round((taken / offered) * 1000) / 10 : 0);

export type OccupancyFigures = { trips: number; offered: number; taken: number; percent: number };

const CANCELLED_MONEY_SELECT = {
  tripId: true,
  status: true,
  refundAmount: true,
  externalRefunded: true,
  payment: { select: { amount: true, walletAmount: true, status: true } },
  collections: { select: { amount: true } },
  cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
} satisfies Prisma.BookingSelect;

@Injectable()
export class TripMetricsService {
  constructor(private prisma: PrismaService) {}

  /** Executed: published or completed trips that have already left. Drafts and cancelled trips never run. */
  executedWhere(range: { gte?: Date; lt: Date }): Prisma.TripWhereInput {
    return { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] }, departureTime: { ...(range.gte && { gte: range.gte }), lt: range.lt } };
  }

  /** The next 30 days: published trips leaving from now to the end of the 30th Riyadh day, today included. */
  nextWindowWhere(now = new Date()): Prisma.TripWhereInput {
    return { tripStatus: 'PUBLISHED', departureTime: { gte: now, lt: addDays(startOfRiyadhDay(now), OCCUPANCY_WINDOW_DAYS) } };
  }

  /** The last 30 days: from the start of the Riyadh day 29 days ago until now, the same span a report of the last 30 days covers. */
  lastWindow(now = new Date()) {
    return { gte: addDays(startOfRiyadhDay(now), -(OCCUPANCY_WINDOW_DAYS - 1)), lt: now };
  }

  /** Seats taken out of seats offered on the trips matching both the scope and the window. */
  async seatOccupancy(scope: Prisma.TripWhereInput, window: Prisma.TripWhereInput): Promise<OccupancyFigures> {
    const result = await this.prisma.trip.aggregate({
      where: { AND: [scope, window] },
      _count: { _all: true },
      _sum: { totalSeats: true, availableSeats: true },
    });
    const offered = result._sum.totalSeats ?? 0;
    const taken = Math.max(0, offered - (result._sum.availableSeats ?? 0));
    return { trips: result._count._all, offered, taken, percent: occupancyPercent(taken, offered) };
  }

  /**
   * Occupancy as two separate figures: executed trips (in the period when given, else the last 30 days) and the trips
   * of the next 30 days. A period's end never reaches past now, since a trip that has not left has not been executed.
   */
  async occupancy(scope: Prisma.TripWhereInput = {}, period?: { start: Date; end: Date }, now = new Date()) {
    const executedRange = period ? { gte: period.start, lt: period.end < now ? period.end : now } : this.lastWindow(now);
    const [executed, next30] = await Promise.all([
      this.seatOccupancy(scope, this.executedWhere(executedRange)),
      this.seatOccupancy(scope, this.nextWindowWhere(now)),
    ]);
    return { executed, next30, windowDays: OCCUPANCY_WINDOW_DAYS };
  }

  /**
   * Each trip's expected revenue in halalas, the same figure as the trip account's ticket revenue: the price of every
   * booking still standing, plus whatever a cancelled booking kept after its refund.
   */
  async revenueByTrip(where: Prisma.TripWhereInput) {
    const [live, cancelled] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['tripId'], where: { status: { not: 'CANCELLED' }, trip: where }, _sum: { totalPrice: true } }),
      this.prisma.booking.findMany({ where: { status: 'CANCELLED', trip: where }, select: CANCELLED_MONEY_SELECT }),
    ]);
    const byTrip = new Map<string, number>();
    for (const row of live) byTrip.set(row.tripId, halalas(row._sum.totalPrice ?? 0));
    for (const booking of cancelled) {
      const { held } = netBookingFigures(booking);
      if (held > 0) byTrip.set(booking.tripId, (byTrip.get(booking.tripId) ?? 0) + held);
    }
    return byTrip;
  }

  /**
   * Money actually received on bookings that stand: paid payments in full, and branch collections on bookings not yet
   * paid. Simulated payments are listed apart, because no money came in for them.
   */
  async collected(bookingWhere: Prisma.BookingWhereInput = {}) {
    const [payments, partial] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['method', 'status'],
        // Until a payment is marked paid its amount is only what is owed.
        where: { status: { in: PAID_PAYMENT_STATUSES }, booking: { AND: [bookingWhere, { status: { not: 'CANCELLED' } }] } },
        _sum: { amount: true, walletAmount: true },
      }),
      this.prisma.bookingCollection.groupBy({
        by: ['method'],
        where: { booking: { AND: [bookingWhere, { status: { not: 'CANCELLED' } }, { payment: { status: { notIn: PAID_PAYMENT_STATUSES } } }] } },
        _sum: { amount: true },
      }),
    ]);
    const collected = payments.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0) + partial.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0);
    const walletUsed = payments.reduce((sum, row) => sum + Number(row._sum.walletAmount ?? 0), 0);
    const simulated = payments.filter((row) => row.status === 'SIMULATED').reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0);
    const byMethod = new Map<string, number>();
    for (const row of payments) byMethod.set(row.method ?? 'other', (byMethod.get(row.method ?? 'other') ?? 0) + Number(row._sum.amount ?? 0));
    for (const row of partial) {
      const method = row.method.toLowerCase();
      byMethod.set(method, (byMethod.get(method) ?? 0) + Number(row._sum.amount ?? 0));
    }
    return { collected, simulated, walletUsed, byMethod: Array.from(byMethod, ([method, amount]) => ({ method, amount })) };
  }
}

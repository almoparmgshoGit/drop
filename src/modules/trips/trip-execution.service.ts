import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { returningBookingIds } from '../../common/utils/linked-seats.util';

const MINUTE_MS = 60_000;
const SWEEP_MS = MINUTE_MS;
/** A trip is executed an hour after it leaves at the earliest, and never while its boarding is still open. */
export const EXECUTED_AFTER_DEPARTURE_MINUTES = 60;
/** Startup waits a moment, so the app is serving before the catch-up runs. */
const STARTUP_DELAY_MS = 10_000;
const LOCK_KEY = 'lock:trip-execution';
const LOCK_TTL_SECONDS = 55;
const BATCH = 200;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/** When a trip with these settings counts as executed. */
export function executionDueAt(trip: { departureTime: Date; boardingClosesAfterMinutes: number }) {
  return new Date(trip.departureTime.getTime() + Math.max(EXECUTED_AFTER_DEPARTURE_MINUTES, trip.boardingClosesAfterMinutes) * MINUTE_MS);
}

/**
 * Post-trip states. Once a trip's boarding is over (an hour after departure at the earliest) the trip is executed (منفذة),
 * and every passenger of a confirmed booking who did not board it is a no-show (لم يحضر). The trip then waits on the trip
 * accounts page for its financial closing.
 *
 * Boarding is recorded per passenger on the ticket, so the no-show is too: noShowAt for the way there, returnNoShowAt for a
 * round trip's passengers riding back on its reverse. The booking's status is left as it is, so a no-show still counts as
 * sold and paid everywhere money is added up. Cancelled, unpaid, cancellation-pending and compensated bookings are never touched.
 *
 * tripStatus is not moved here: the crew keeps reporting a trip on the road while it is PUBLISHED, and the existing sweep
 * completes it at arrival. Every step is guarded by the field it sets, so running it twice, or on two servers, changes nothing.
 */
@Injectable()
export class TripExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripExecutionService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  onModuleInit() {
    // Tests run the sweep themselves.
    if (process.env.NODE_ENV === 'test') return;
    // The catch-up: trips that ended while the server was down, or before this existed, are executed on startup.
    const startup = setTimeout(() => this.tick(), STARTUP_DELAY_MS);
    startup.unref();
    const timer = setInterval(() => this.tick(), SWEEP_MS);
    timer.unref();
    this.timers.push(startup, timer);
  }

  onModuleDestroy() {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    let locked = false;
    try {
      // One server sweeps at a time; the claims below keep it safe even if two ever do.
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      if (!locked) return;
      await this.sweep();
    } catch (err) {
      this.logger.error(`Trip execution sweep failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }

  /** Executes every trip whose time has come; returns the trips it executed. */
  async sweep(now = new Date()) {
    const executed: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const trips = await this.prisma.trip.findMany({
        where: {
          executedAt: null,
          tripStatus: { in: ['PUBLISHED', 'COMPLETED'] },
          departureTime: { lte: new Date(now.getTime() - EXECUTED_AFTER_DEPARTURE_MINUTES * MINUTE_MS) },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: { id: true, departureTime: true, boardingClosesAfterMinutes: true },
      });
      for (const trip of trips) {
        if (executionDueAt(trip) > now) continue;
        try {
          if (await this.execute(trip.id, now)) executed.push(trip.id);
        } catch (err) {
          this.logger.error(`Could not execute trip ${trip.id}: ${(err as Error).message}`);
        }
      }
      if (trips.length < BATCH) break;
      cursor = trips[trips.length - 1].id;
    }
    return executed;
  }

  /** Marks one trip executed and its missing passengers as no-shows. False when it was not due or already done. */
  async execute(tripId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({
        where: { id: tripId },
        select: { id: true, departureTime: true, boardingClosesAfterMinutes: true, reverseOfTripId: true, executedAt: true, tripStatus: true },
      });
      if (!trip || trip.executedAt || !['PUBLISHED', 'COMPLETED'].includes(trip.tripStatus)) return false;
      const dueAt = executionDueAt(trip);
      if (dueAt > now) return false;

      // The claim: whoever sets it first does the rest.
      const claimed = await tx.trip.updateMany({ where: { id: tripId, executedAt: null }, data: { executedAt: dueAt } });
      if (claimed.count === 0) return false;

      // The trip's own passengers. A partly boarded booking is still CONFIRMED, so its missing passengers are marked too.
      await tx.ticket.updateMany({
        where: { isBoarded: false, noShowAt: null, booking: { tripId, status: 'CONFIRMED', compensation: { is: null } } },
        data: { noShowAt: dueAt },
      });

      // A round trip's passengers ride back on its reverse under their outbound booking.
      if (trip.reverseOfTripId) {
        const returning = await returningBookingIds(tx, trip.reverseOfTripId);
        if (returning.length > 0) {
          await tx.ticket.updateMany({
            where: {
              bookingId: { in: returning },
              returnBoardedAt: null,
              returnNoShowAt: null,
              booking: { status: { in: ['CONFIRMED', 'BOARDED'] }, compensation: { is: null } },
            },
            data: { returnNoShowAt: dueAt },
          });
        }
      }
      return true;
    }, TX_OPTIONS);
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationEvent, NotificationValues } from '../../common/notification-catalog';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { NotificationsService, tripValues } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { returningBookingIds } from '../../common/utils/linked-seats.util';
import { ensureTrackingToken, mapLinkOf, publicWebUrl, trackingUrl } from './followup.util';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SWEEP_MS = MINUTE_MS;
const STARTUP_DELAY_MS = 15_000;
const LOCK_KEY = 'lock:trip-followup';
const LOCK_TTL_SECONDS = 55;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
/** Statuses of a booking that is going: unpaid (PENDING), cancelled and cancellation-pending bookings are left alone. */
const GOING_STATUSES = ['CONFIRMED', 'BOARDED'] as const;

/**
 * The reminders before departure. Each is sent while the time left is inside its window; a server that was down past
 * the window simply skips it, so nobody is told "your trip is tomorrow" an hour before it leaves.
 */
const REMINDERS: { key: 'REMINDER_24H' | 'REMINDER_2H'; event: NotificationEvent; leadMs: number; minLeftMs: number; bookedAheadMs: number }[] = [
  // Only for bookings made a day ahead (an hour's grace); a later booking gets its confirmation and then the 2-hour one.
  { key: 'REMINDER_24H', event: 'TRIP_REMINDER_24H', leadMs: 24 * HOUR_MS, minLeftMs: 12 * HOUR_MS, bookedAheadMs: 23 * HOUR_MS },
  { key: 'REMINDER_2H', event: 'TRIP_REMINDER_2H', leadMs: 2 * HOUR_MS, minLeftMs: 0, bookedAheadMs: 0 },
];
/** Asked once the bus has arrived, or this long after its arrival time when the crew never said so. */
const RATING_AFTER_ARRIVAL_MS = HOUR_MS;
/** Trips older than this are not asked about, so turning the feature on does not reach every customer of last year. */
const RATING_LOOKBACK_MS = 5 * 24 * HOUR_MS;

export const ratingRequestKey = (bookingId: string) => `${bookingId}:RATING_REQUEST`;

const BOOKING_SELECT = {
  id: true,
  createdAt: true,
  boardingPointId: true,
  boardingPointName: true,
  boardingPointTime: true,
} as const;

type Point = { id: string; name: string; time: string; address: string; lat: number | null; lng: number | null };

/**
 * The customer's reminders around a trip: 24 hours and 2 hours before departure (seats, the gathering point and its map
 * link, the supervisor's phone and, at 2 hours, the family tracking link), and the rating request after arrival.
 * Every message is claimed in TripReminderLog in the transaction that sends it, so a restart or a second server never
 * sends it twice; the Redis lock only saves the second server the work.
 */
@Injectable()
export class TripRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripRemindersService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
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
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      if (!locked) return;
      await this.sweep();
    } catch (err) {
      this.logger.error(`Trip follow-up sweep failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }

  async sweep(now = new Date()) {
    const reminded = await this.sweepReminders(now);
    const asked = await this.sweepRatingRequests(now);
    return { reminded, asked };
  }

  private get webUrl() {
    return publicWebUrl(this.config.get<string>('PUBLIC_WEB_URL'), this.config.get<string>('CORS_ORIGINS'));
  }

  /** Sends every reminder that is due; returns how many went out. */
  async sweepReminders(now = new Date()) {
    const at = now.getTime();
    const trips = await this.prisma.trip.findMany({
      where: { tripStatus: 'PUBLISHED', departureTime: { gt: now, lte: new Date(at + 24 * HOUR_MS) } },
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        departureTime: true,
        hijriDate: true,
        reverseOfTripId: true,
        reminder24hAnnouncedAt: true,
        boardingPoints: { select: { id: true, name: true, time: true, address: true, lat: true, lng: true } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true } } } },
      },
    });
    if (trips.length === 0) return 0;
    const { supervisorContactOpensBeforeHours } = await this.appSettings.numbers('supervisorContactOpensBeforeHours');
    let sent = 0;

    for (const trip of trips) {
      try {
        const left = trip.departureTime.getTime() - at;
        const due = REMINDERS.filter((reminder) => left <= reminder.leadMs && left > reminder.minLeftMs);
        if (due.length === 0) continue;

        const own = await this.prisma.booking.findMany({
          where: { tripId: trip.id, status: { in: [...GOING_STATUSES] }, compensation: { is: null } },
          select: BOOKING_SELECT,
        });
        // A round trip's passengers ride back on its reverse under their outbound booking, with no point of their own there.
        const returningIds = trip.reverseOfTripId ? await returningBookingIds(this.prisma, trip.reverseOfTripId) : [];
        const returning = returningIds.length
          ? await this.prisma.booking.findMany({ where: { id: { in: returningIds }, status: { in: [...GOING_STATUSES] }, compensation: { is: null } }, select: BOOKING_SELECT })
          : [];
        const candidates = [...own.map((booking) => ({ booking, isReturning: false })), ...returning.map((booking) => ({ booking, isReturning: true }))];
        if (candidates.length === 0) continue;

        const supervisor = trip.supervisors.find((row) => row.user.phone)?.user ?? trip.supervisors[0]?.user ?? null;
        const showPhone = left <= supervisorContactOpensBeforeHours * HOUR_MS;
        const firstPoint = [...trip.boardingPoints].sort((a, b) => a.time.localeCompare(b.time))[0] ?? null;

        for (const reminder of due) {
          const departure = trip.departureTime.getTime();
          const eligible = candidates.filter(({ booking }) => {
            if (reminder.key !== 'REMINDER_24H') return true;
            if (booking.createdAt.getTime() > departure - reminder.bookedAheadMs) return false;
            // Trips reminded by the older once-per-trip sweep already told everyone booked by then.
            return !(trip.reminder24hAnnouncedAt && booking.createdAt <= trip.reminder24hAnnouncedAt);
          });
          if (eligible.length === 0) continue;
          const keyOf = (bookingId: string) => `${bookingId}:${trip.id}:${reminder.key}`;
          const done = new Set(
            (await this.prisma.tripReminderLog.findMany({ where: { key: { in: eligible.map(({ booking }) => keyOf(booking.id)) } }, select: { key: true } })).map((row) => row.key),
          );
          for (const { booking, isReturning } of eligible) {
            if (done.has(keyOf(booking.id))) continue;
            const point: Point | null = isReturning
              ? firstPoint
              : trip.boardingPoints.find((row) => row.id === booking.boardingPointId) ?? trip.boardingPoints.find((row) => row.name === booking.boardingPointName) ?? null;
            const values: NotificationValues = {
              // Returning passengers are told about the trip back, not the outbound their booking belongs to.
              ...(isReturning && tripValues(trip)),
              ...(isReturning && firstPoint && { boardingPoint: firstPoint.name, boardingTime: firstPoint.time }),
              supervisorName: supervisor?.name,
              supervisorPhone: showPhone ? supervisor?.phone : null,
              boardingMapLink: mapLinkOf(point ?? (booking.boardingPointName ? { name: booking.boardingPointName } : null)),
            };
            try {
              const claimed = await this.prisma.$transaction(async (tx) => {
                const claim = await tx.tripReminderLog.createMany({ data: [{ key: keyOf(booking.id) }], skipDuplicates: true });
                if (claim.count === 0) return false;
                if (reminder.key === 'REMINDER_2H') {
                  const token = await ensureTrackingToken(tx, booking.id);
                  if (token) values.trackingLink = trackingUrl(this.webUrl, token);
                }
                await this.notifications.toBookingOwnersEach(tx, reminder.event, new Map([[booking.id, values]]));
                return true;
              }, TX_OPTIONS);
              if (claimed) sent++;
            } catch (err) {
              this.logger.error(`${reminder.key} for booking ${booking.id} failed: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        this.logger.error(`Reminders for trip ${trip.id} failed: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  /** Asks each customer who rode a finished trip to rate it, once. Returns how many were asked. */
  async sweepRatingRequests(now = new Date()) {
    const at = now.getTime();
    const settled = new Date(at - RATING_AFTER_ARRIVAL_MS);
    const trips = await this.prisma.trip.findMany({
      where: {
        executedAt: { not: null },
        tripStatus: { in: ['PUBLISHED', 'COMPLETED'] },
        departureTime: { gte: new Date(at - RATING_LOOKBACK_MS) },
        OR: [
          { liveStatus: 'ARRIVED' },
          { tripStatus: 'COMPLETED' },
          { estimatedArrivalAt: { lte: settled } },
          { estimatedArrivalAt: null, arrivalTime: { lte: settled } },
        ],
      },
      select: { id: true },
    });
    let asked = 0;
    for (const trip of trips) {
      try {
        // Only those who boarded: a no-show has nothing to rate.
        const bookings = await this.prisma.booking.findMany({
          where: { tripId: trip.id, status: { in: [...GOING_STATUSES] }, rating: { is: null }, tickets: { some: { isBoarded: true } } },
          select: { id: true },
        });
        if (bookings.length === 0) continue;
        const done = new Set(
          (await this.prisma.tripReminderLog.findMany({ where: { key: { in: bookings.map((booking) => ratingRequestKey(booking.id)) } }, select: { key: true } })).map((row) => row.key),
        );
        for (const booking of bookings) {
          if (done.has(ratingRequestKey(booking.id))) continue;
          const claimed = await this.prisma.$transaction(async (tx) => {
            const claim = await tx.tripReminderLog.createMany({ data: [{ key: ratingRequestKey(booking.id) }], skipDuplicates: true });
            if (claim.count === 0) return false;
            await this.notifications.toBookingOwners(tx, 'TRIP_RATING_REQUEST', [booking.id]);
            return true;
          }, TX_OPTIONS);
          if (claimed) asked++;
        }
      } catch (err) {
        this.logger.error(`Rating requests for trip ${trip.id} failed: ${(err as Error).message}`);
      }
    }
    return asked;
  }
}

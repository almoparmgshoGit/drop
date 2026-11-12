import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NOTIFICATION_CATALOG, NotificationValues, renderTemplate } from '../notification-catalog';
import { isStationRuleKey, MANUAL_STATION_TYPES, ManualStationType, STATION_RULE_KEYS, STATION_RULES, StationRuleKey } from '../station-alert-rules';
import { distanceInMeters } from '../utils/geo.util';
import { returningBookingIds } from '../utils/linked-seats.util';
import { formatRiyadhTime } from '../utils/time.util';
import { markPassedLegs, minutesAfterDeparture, orderRouteLegs } from '../utils/trip-route.util';
import { approvedWhatsAppTemplates, NotificationsService, tripValues } from './notifications.service';
import { PrismaService } from './prisma.service';
import { RoutingService } from './routing.service';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TRAVELING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;
/** A position older than this no longer describes where the bus is now. */
const LIVE_FOR_MS = 2 * MINUTE_MS;
/** Passengers gather hours ahead of departure, and alerts stop soon after the trip ends. */
const WATCH_BEFORE_DEPARTURE_MS = 6 * HOUR_MS;
const WATCH_AFTER_ARRIVAL_MS = 2 * HOUR_MS;
/** Without a routing platform a road's time is only estimated from the straight line: 60 km/h is a kilometre a minute. */
const FALLBACK_METERS_PER_MINUTE = 1000;
/** Someone left standing this long has already spoken to the crew. */
const LATE_REMINDER_STOPS_AFTER_MS = 30 * MINUTE_MS;
const MAX_MANUAL_PER_HOUR = 6;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
export const DESTINATION_KEY = 'destination';
const ROOM_NOT_SET = 'تُحدد عند الوصول';
const HOLD_GRACE_MS = HOUR_MS;
/** How often a reminder repeats until the moment, when neither the trip nor the passenger chose. */
export const DEFAULT_REMINDER_REPEAT_MINUTES = 15;
/** The longest anyone may ask to be reminded ahead, which is also how far ahead the sweep looks. */
export const MAX_REMINDER_LEAD_MINUTES = 24 * 60;

const TRIP_SELECT = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  estimatedArrivalAt: true,
  hijriDate: true,
  tripStatus: true,
  liveStatus: true,
  liveStatusAt: true,
  currentBoardingPointId: true,
  reverseOfTripId: true,
  bus: { select: { plateNumber: true } },
  location: { select: { lat: true, lng: true, recordedAt: true } },
  boardingPoints: { select: { id: true, name: true, time: true, address: true, lat: true, lng: true } },
  itineraryStops: { orderBy: { sortOrder: 'asc' }, select: { id: true, time: true, title: true, desc: true, kind: true } },
  statusUpdates: { orderBy: { createdAt: 'asc' }, select: { status: true, boardingPointId: true, pointName: true, createdAt: true } },
  stationRules: { select: { ruleKey: true, isActive: true } },
  alertLeadMinutes: true,
  alertRepeatMinutes: true,
} satisfies Prisma.TripSelect;

type WatchedTrip = Prisma.TripGetPayload<{ select: typeof TRIP_SELECT }>;
type Db = Prisma.TransactionClient;

export interface ManualAlert {
  stopKey: string;
  type: ManualStationType;
  minutes?: number;
  note?: string;
  channels: ('IN_APP' | 'WHATSAPP')[];
}

const toClock = (date: Date) => formatRiyadhTime(date);
const minutesWord = (minutes: number) => `بعد نحو ${minutes} ${minutes === 1 ? 'دقيقة' : minutes === 2 ? 'دقيقتين' : minutes <= 10 ? 'دقائق' : 'دقيقة'}`;

/** A booking belongs to a point by id or by name, because editing a trip recreates its points. */
const boardsAt = (point: { id: string; name: string }): Prisma.BookingWhereInput => ({ OR: [{ boardingPointId: point.id }, { boardingPointName: point.name }] });

@Injectable()
export class StationAlertsService {
  private readonly logger = new Logger(StationAlertsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private routing: RoutingService,
  ) {}

  async rules() {
    const saved = new Map((await this.prisma.stationAlertRule.findMany()).map((row) => [row.key, row]));
    return STATION_RULE_KEYS.map((key) => {
      const rule = STATION_RULES[key] as (typeof STATION_RULES)[StationRuleKey] & { defaultMinutes?: number };
      const row = saved.get(key);
      return {
        key,
        label: rule.label,
        short: rule.short,
        help: rule.help,
        isActive: row?.isActive ?? rule.defaultActive,
        minutes: rule.defaultMinutes === undefined ? null : row?.minutes ?? rule.defaultMinutes,
        hasMinutes: rule.defaultMinutes !== undefined,
      };
    });
  }

  async updateRule(key: string, input: { isActive: boolean; minutes?: number }) {
    if (!isStationRuleKey(key)) throw new NotFoundException('هذه القاعدة غير موجودة');
    await this.prisma.stationAlertRule.upsert({ where: { key }, create: { key, isActive: input.isActive, minutes: input.minutes ?? null }, update: { isActive: input.isActive, ...(input.minutes !== undefined && { minutes: input.minutes }) } });
    return this.rules();
  }

  /** A null state returns the trip to the company-wide rule. */
  async updateTripRule(tripId: string, key: string, isActive: boolean | null) {
    if (!isStationRuleKey(key)) throw new NotFoundException('هذه القاعدة غير موجودة');
    if ((await this.prisma.trip.count({ where: { id: tripId } })) === 0) throw new NotFoundException('Trip not found');
    if (isActive === null) await this.prisma.tripStationRule.deleteMany({ where: { tripId, ruleKey: key } });
    else await this.prisma.tripStationRule.upsert({ where: { tripId_ruleKey: { tripId, ruleKey: key } }, create: { tripId, ruleKey: key, isActive }, update: { isActive } });
    return this.tripView(tripId);
  }

  /** For the action itself, which runs inside its own transaction. */
  async isEnabled(db: Db, tripId: string, key: StationRuleKey) {
    const override = await db.tripStationRule.findUnique({ where: { tripId_ruleKey: { tripId, ruleKey: key } } });
    if (override) return override.isActive;
    const rule = await db.stationAlertRule.findUnique({ where: { key } });
    return rule?.isActive ?? STATION_RULES[key].defaultActive;
  }

  /** Records what the crew's own status update already told passengers, so the route shows it. */
  async recordMoment(db: Db, tripId: string, key: StationRuleKey, stop: { name: string }, recipients: number) {
    await db.stationAlert.create({ data: { tripId, stopKey: stop.name, stopName: stop.name, ruleKey: key, message: STATION_RULES[key].label, recipients, channels: ['AUTO'] } });
  }

  private async waitingAt(db: Db | PrismaService, trip: { id: string; reverseOfTripId: string | null }, point: { id: string; name: string }) {
    const own = await db.booking.findMany({
      where: { tripId: trip.id, status: { in: [...TRAVELING_STATUSES] }, tickets: { some: { isBoarded: false } }, ...boardsAt(point) },
      select: { id: true },
    });
    const ids = own.map((booking) => booking.id);
    // Passengers riding back have no point of their own on the reverse, so wherever it boards is theirs.
    if (trip.reverseOfTripId) {
      const returning = await returningBookingIds(db, trip.reverseOfTripId);
      const waiting = await db.ticket.findMany({ where: { bookingId: { in: returning }, returnBoardedAt: null }, select: { bookingId: true }, distinct: ['bookingId'] });
      ids.push(...waiting.map((ticket) => ticket.bookingId));
    }
    return ids;
  }

  private async travelling(db: Db | PrismaService, trip: { id: string; reverseOfTripId: string | null }) {
    const own = await db.booking.findMany({ where: { tripId: trip.id, status: { in: [...TRAVELING_STATUSES] } }, select: { id: true } });
    const returning = trip.reverseOfTripId ? await returningBookingIds(db, trip.reverseOfTripId) : [];
    return [...own.map((booking) => booking.id), ...returning];
  }

  /** Claiming the moment and sending share a transaction, so it is announced once or not at all. */
  private async announce(trip: { id: string }, key: StationRuleKey, stop: { name: string }, bookingIds: string[], values: NotificationValues, perBooking?: Map<string, NotificationValues>) {
    const count = perBooking?.size ?? bookingIds.length;
    if (count === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stationAlert.createMany({
        data: [{ tripId: trip.id, stopKey: stop.name, stopName: stop.name, ruleKey: key, message: STATION_RULES[key].label, recipients: count, channels: ['AUTO'], dedupeKey: `${trip.id}:${key}:${stop.name}` }],
        skipDuplicates: true,
      });
      if (claimed.count === 0) return;
      const { event } = STATION_RULES[key];
      if (perBooking) await this.notifications.toBookingOwnersEach(tx, event, perBooking);
      else await this.notifications.toBookingOwners(tx, event, bookingIds, values);
    }, TX_OPTIONS);
  }

  private activeRules(trip: WatchedTrip, rules: Awaited<ReturnType<StationAlertsService['rules']>>) {
    const overrides = new Map(trip.stationRules.map((row) => [row.ruleKey, row.isActive]));
    return new Map(rules.map((rule) => [rule.key, { isActive: overrides.get(rule.key) ?? rule.isActive, minutes: rule.minutes, overridden: overrides.has(rule.key) }]));
  }

  private buildRoute(trip: WatchedTrip) {
    const reached = new Set(trip.statusUpdates.filter((row) => row.status === 'AT_POINT').flatMap((row) => [row.boardingPointId, row.pointName]));
    const points = trip.boardingPoints.map((point) => ({ ...point, isCurrent: point.id === trip.currentBoardingPointId, reached: reached.has(point.id) || reached.has(point.name) }));
    return markPassedLegs(orderRouteLegs(points, trip.itineraryStops, trip.destination, trip.departureTime), trip.liveStatus === 'ARRIVED');
  }

  /** Every due automatic alert on trips on the road. Called on a timer, and safe to run on several servers. */
  async sweep() {
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: { tripStatus: 'PUBLISHED', departureTime: { lte: new Date(now + WATCH_BEFORE_DEPARTURE_MS) }, arrivalTime: { gte: new Date(now - WATCH_AFTER_ARRIVAL_MS) } },
      select: TRIP_SELECT,
    });
    if (trips.length === 0) return;
    const rules = await this.rules();
    for (const trip of trips) {
      try {
        await this.sweepTrip(trip, this.activeRules(trip, rules), now);
      } catch (err) {
        this.logger.error(`Station alerts for trip ${trip.id} failed: ${(err as Error).message}`);
      }
    }
  }

  private async sweepTrip(trip: WatchedTrip, rules: ReturnType<StationAlertsService['activeRules']>, now: number) {
    const route = this.buildRoute(trip);
    const pointById = new Map(trip.boardingPoints.map((point) => [point.id, point]));
    const before = rules.get('BEFORE_STOP');
    const position = trip.location;

    if (before?.isActive && position && now - position.recordedAt.getTime() <= LIVE_FOR_MS && trip.liveStatus !== 'ARRIVED') {
      // The nearest point ahead with someone waiting: a point nobody boards at must not hide the one after it.
      for (const leg of route.filter((row) => row.kind === 'POINT' && !row.isPassed && !row.isCurrent)) {
        const point = pointById.get(leg.id);
        if (!point || point.lat === null || point.lng === null) continue;
        const waiting = await this.waitingAt(this.prisma, trip, point);
        if (waiting.length === 0) continue;
        const minutes = before.minutes ?? 10;
        const coordinates = { lat: point.lat, lng: point.lng };
        const eta = await this.routing.etaToPoint(trip.id, point.id, { lat: position.lat, lng: position.lng }, coordinates);
        const isClose = eta ? eta.minutes <= minutes : distanceInMeters(position, coordinates) <= minutes * FALLBACK_METERS_PER_MINUTE;
        if (isClose) await this.announce(trip, 'BEFORE_STOP', point, waiting, { stopName: point.name, etaText: eta ? minutesWord(eta.minutes) : 'قريبًا' });
        break;
      }
    }

    const late = rules.get('LATE_BOARDING');
    const current = trip.currentBoardingPointId ? pointById.get(trip.currentBoardingPointId) : null;
    if (late?.isActive && trip.liveStatus === 'AT_POINT' && current && trip.liveStatusAt) {
      const stoppedFor = now - trip.liveStatusAt.getTime();
      if (stoppedFor >= (late.minutes ?? 3) * MINUTE_MS && stoppedFor <= LATE_REMINDER_STOPS_AFTER_MS) {
        await this.announce(trip, 'LATE_BOARDING', current, await this.waitingAt(this.prisma, trip, current), { stopName: current.name });
      }
    }

    // The miqat and gathering reminders go to each passenger on their own schedule, in sweepPassengerReminders.

    const destination = rules.get('DESTINATION');
    if (destination?.isActive && trip.liveStatus === 'ARRIVED') {
      const bookings = await this.prisma.booking.findMany({
        where: { id: { in: await this.travelling(this.prisma, trip) }, stayHotelId: { not: null } },
        select: { id: true, stayHotel: { select: { name: true } }, passengers: { select: { hotelRoom: { select: { number: true } } } } },
      });
      const values = new Map<string, NotificationValues>(
        bookings.map((booking) => {
          const rooms = [...new Set(booking.passengers.flatMap((passenger) => (passenger.hotelRoom ? [passenger.hotelRoom.number] : [])))];
          return [booking.id, { hotelName: booking.stayHotel?.name, roomNumber: rooms.join('، ') || ROOM_NOT_SET }];
        }),
      );
      await this.announce(trip, 'DESTINATION', { name: trip.destination }, [], {}, values);
    }
  }

  /**
   * Reminders before the miqat and before each passenger's gathering point, from the trip's schedule rather than the bus's
   * position, so they reach passengers even when the crew has not started the trip in the app. Each starts its lead time
   * ahead and repeats every interval until the moment: the passenger's own choice first, then the trip's, then the company's.
   */
  async sweepPassengerReminders() {
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: 'PUBLISHED',
        liveStatus: { not: 'ARRIVED' },
        departureTime: { lte: new Date(now + MAX_REMINDER_LEAD_MINUTES * MINUTE_MS), gte: new Date(now - 24 * HOUR_MS) },
      },
      select: {
        ...TRIP_SELECT,
        bookings: {
          where: { status: { in: [...TRAVELING_STATUSES] } },
          select: { id: true, boardingPointName: true, boardingPointTime: true, user: { select: { tripAlertsEnabled: true, alertLeadMinutes: true, alertRepeatMinutes: true } } },
        },
      },
    });
    if (trips.length === 0) return;
    const rules = await this.rules();
    for (const trip of trips) {
      try {
        const active = this.activeRules(trip, rules);
        const gathering = active.get('GATHERING');
        const miqat = active.get('MIQAT');
        const momentOf = (time: string) => trip.departureTime.getTime() + minutesAfterDeparture(time, trip.departureTime) * MINUTE_MS;
        const miqatStops = miqat?.isActive ? trip.itineraryStops.filter((stop) => stop.kind === 'MIQAT' && stop.time) : [];
        const remindedOfMiqat = new Map<string, number>();

        for (const booking of trip.bookings) {
          if (!booking.user.tripAlertsEnabled) continue;
          const repeat = booking.user.alertRepeatMinutes ?? trip.alertRepeatMinutes ?? DEFAULT_REMINDER_REPEAT_MINUTES;
          const leadFor = (rule: { minutes: number | null } | undefined) => booking.user.alertLeadMinutes ?? trip.alertLeadMinutes ?? rule?.minutes ?? 30;
          const moments: { key: StationRuleKey; name: string; at: number; lead: number }[] = [];
          // Once the bus is on the road, the crew's live alerts take over at the points.
          if (gathering?.isActive && booking.boardingPointTime && booking.boardingPointName && trip.liveStatus === 'NOT_STARTED') {
            moments.push({ key: 'GATHERING', name: booking.boardingPointName, at: momentOf(booking.boardingPointTime), lead: leadFor(gathering) });
          }
          for (const stop of miqatStops) moments.push({ key: 'MIQAT', name: stop.title, at: momentOf(stop.time), lead: leadFor(miqat) });

          for (const moment of moments) {
            const left = moment.at - now;
            const lead = Math.min(moment.lead, MAX_REMINDER_LEAD_MINUTES) * MINUTE_MS;
            if (left <= 0 || left > lead) continue;
            // Which repeat this is: the first at the lead time, then one every interval until the moment.
            const round = repeat > 0 ? Math.floor((lead - left) / (repeat * MINUTE_MS)) : 0;
            const sent = await this.remind(booking.id, moment.key, moment.name, round, { stopName: moment.name, minutes: Math.max(1, Math.round(left / MINUTE_MS)) });
            if (sent && moment.key === 'MIQAT') remindedOfMiqat.set(moment.name, (remindedOfMiqat.get(moment.name) ?? 0) + 1);
          }
        }
        // The route page shows the miqat reminder as sent once its first round went out.
        for (const [name, count] of remindedOfMiqat) {
          await this.prisma.stationAlert.createMany({
            data: [{ tripId: trip.id, stopKey: name, stopName: name, ruleKey: 'MIQAT', message: STATION_RULES.MIQAT.label, recipients: count, channels: ['AUTO'], dedupeKey: `${trip.id}:MIQAT:${name}` }],
            skipDuplicates: true,
          });
        }
      } catch (err) {
        this.logger.error(`Passenger reminders for trip ${trip.id} failed: ${(err as Error).message}`);
      }
    }
  }

  /** One round of one reminder to one booking, claimed in the transaction it is sent in, so it goes once on any number of servers. */
  private async remind(bookingId: string, key: StationRuleKey, stopName: string, round: number, values: NotificationValues) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tripReminderLog.createMany({ data: [{ key: `${bookingId}:${key}:${stopName}:${round}` }], skipDuplicates: true });
      if (claimed.count === 0) return false;
      await this.notifications.toBookingOwners(tx, STATION_RULES[key].event, [bookingId], values);
      return true;
    }, TX_OPTIONS);
  }

  /** The day-before reminder, told once per trip. */
  async sweepDayBeforeReminders() {
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: { tripStatus: 'PUBLISHED', reminder24hAnnouncedAt: null, departureTime: { gt: new Date(now), lte: new Date(now + 24 * HOUR_MS) } },
      select: { id: true, reverseOfTripId: true },
    });
    for (const trip of trips) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.trip.updateMany({ where: { id: trip.id, reminder24hAnnouncedAt: null }, data: { reminder24hAnnouncedAt: new Date(now) } });
        if (claimed.count === 1) await this.notifications.toBookingOwners(tx, 'TRIP_REMINDER_24H', await this.travelling(tx, trip));
      }, TX_OPTIONS);
    }
  }

  /** Seats a customer chose and never paid for. Clearing the hold is what makes this happen once. */
  async sweepExpiredHolds() {
    const now = new Date();
    const seats = await this.prisma.seat.findMany({ where: { isBooked: false, heldByUserId: { not: null }, heldUntil: { lt: now } }, select: { tripId: true, heldByUserId: true, heldUntil: true }, take: 500 });
    const groups = new Map(seats.map((seat) => [`${seat.tripId}:${seat.heldByUserId}`, seat]));
    for (const { tripId, heldByUserId, heldUntil } of groups.values()) {
      await this.prisma.$transaction(async (tx) => {
        const cleared = await tx.seat.updateMany({ where: { tripId, heldByUserId, isBooked: false, heldUntil: { lt: now } }, data: { heldByUserId: null, heldUntil: null } });
        if (cleared.count === 0 || !heldByUserId) return;
        // Someone who changed their mind about the seats but booked anyway has nothing to be told. Staff holding seats at a branch neither.
        const [user, booked, trip] = await Promise.all([
          tx.user.findUnique({ where: { id: heldByUserId }, select: { role: true } }),
          tx.booking.count({ where: { userId: heldByUserId, createdAt: { gte: new Date(heldUntil!.getTime() - HOLD_GRACE_MS) } } }),
          tx.trip.findUnique({ where: { id: tripId }, select: { tripCode: true, origin: true, destination: true, departureTime: true, hijriDate: true } }),
        ]);
        if (user?.role === 'PASSENGER' && booked === 0 && trip && trip.departureTime.getTime() > now.getTime()) {
          await this.notifications.toUser(tx, 'PAYMENT_INCOMPLETE', heldByUserId, tripValues(trip));
        }
      }, TX_OPTIONS);
    }
  }

  /** Trips someone would be watching: on the road, or about to be. */
  async activeTrips() {
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: { tripStatus: 'PUBLISHED', departureTime: { lte: new Date(now + 3 * 24 * HOUR_MS) }, arrivalTime: { gte: new Date(now - WATCH_AFTER_ARRIVAL_MS) } },
      orderBy: { departureTime: 'asc' },
      take: 100,
      select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, liveStatus: true, location: { select: { recordedAt: true } } },
    });
    return trips.map(({ location, ...trip }) => ({ ...trip, isLive: !!location && now - location.recordedAt.getTime() <= LIVE_FOR_MS }));
  }

  private async loadTrip(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: TRIP_SELECT });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private stopTimes(trip: WatchedTrip, name: string) {
    const updates = trip.statusUpdates;
    const lastAt = updates.reduce((found, row, index) => (row.status === 'AT_POINT' && row.pointName === name ? index : found), -1);
    if (lastAt === -1) return { arrivedAt: null, departedAt: null };
    return { arrivedAt: updates[lastAt].createdAt, departedAt: updates[lastAt + 1]?.createdAt ?? null };
  }

  /** The route as the station alerts page draws it. Only counts leave here: no passenger names or phones. */
  async tripView(tripId: string) {
    const trip = await this.loadTrip(tripId);
    const now = Date.now();
    const rules = await this.rules();
    const active = this.activeRules(trip, rules);
    const alerts = await this.prisma.stationAlert.findMany({ where: { tripId }, orderBy: { createdAt: 'desc' }, take: 300 });
    const tickets = await this.prisma.ticket.findMany({
      where: { booking: { tripId, status: { in: [...TRAVELING_STATUSES] } } },
      select: { isBoarded: true, booking: { select: { boardingPointId: true, boardingPointName: true } } },
    });
    const returning = trip.reverseOfTripId ? await returningBookingIds(this.prisma, trip.reverseOfTripId) : [];
    const returningTickets = returning.length ? await this.prisma.ticket.findMany({ where: { bookingId: { in: returning } }, select: { returnBoardedAt: true } }) : [];
    const position = trip.location;
    const isLive = !!position && now - position.recordedAt.getTime() <= LIVE_FOR_MS && trip.liveStatus !== 'ARRIVED';

    const legs = this.buildRoute(trip);
    const nextLeg = legs.find((leg) => !leg.isPassed && !leg.isCurrent);
    const nextPoint = nextLeg?.kind === 'POINT' ? trip.boardingPoints.find((point) => point.id === nextLeg.id) : undefined;
    const eta = isLive && position && nextPoint && nextPoint.lat !== null && nextPoint.lng !== null ? await this.routing.etaToPoint(trip.id, nextPoint.id, { lat: position.lat, lng: position.lng }, { lat: nextPoint.lat, lng: nextPoint.lng }) : null;

    const sentFor = (key: StationRuleKey, name: string) => alerts.find((row) => row.ruleKey === key && row.stopKey === name);
    const alertState = (key: StationRuleKey, name: string, schedule: { at?: Date | null; label?: string }, isPast: boolean) => {
      const sent = sentFor(key, name);
      const rule = active.get(key)!;
      if (sent) return { key, label: STATION_RULES[key].short, state: 'SENT', at: sent.createdAt, note: null };
      if (!rule.isActive) return { key, label: STATION_RULES[key].short, state: 'OFF', at: null, note: null };
      if (isPast) return { key, label: STATION_RULES[key].short, state: 'SKIPPED', at: null, note: null };
      return { key, label: STATION_RULES[key].short, state: schedule.at ? 'SCHEDULED' : 'AUTO', at: schedule.at ?? null, note: schedule.label ?? null };
    };

    const route = legs.map((leg) => {
      const stage = leg.isPassed ? 'PASSED' : leg.isCurrent ? 'CURRENT' : leg === nextLeg ? 'NEXT' : 'UPCOMING';
      const isPoint = leg.kind === 'POINT';
      const point = isPoint ? trip.boardingPoints.find((row) => row.id === leg.id) : undefined;
      const here = isPoint ? tickets.filter(({ booking }) => booking.boardingPointId === leg.id || booking.boardingPointName === leg.name) : [];
      const { arrivedAt, departedAt } = this.stopTimes(trip, leg.name);
      const lateMinutes = active.get('LATE_BOARDING')?.minutes ?? 3;
      const legAlerts = isPoint
        ? [
            alertState('BEFORE_STOP', leg.name, {}, leg.isPassed || leg.isCurrent),
            alertState('AT_STOP', leg.name, {}, leg.isPassed),
            alertState('LATE_BOARDING', leg.name, leg.isCurrent ? { label: `بعد ${lateMinutes} د` } : {}, leg.isPassed),
            alertState('GATHERING', leg.name, { label: `قبل ${trip.alertLeadMinutes ?? active.get('GATHERING')?.minutes ?? 60} د` }, leg.isPassed || leg.isCurrent || trip.liveStatus !== 'NOT_STARTED'),
          ]
        : leg.kind === 'MIQAT'
          ? [alertState('MIQAT', leg.name, { at: new Date(trip.departureTime.getTime() + (minutesAfterDeparture(leg.time, trip.departureTime) - (trip.alertLeadMinutes ?? active.get('MIQAT')?.minutes ?? 30)) * MINUTE_MS) }, leg.isPassed)]
          : [];
      return {
        key: leg.name,
        id: leg.id,
        kind: leg.kind,
        name: leg.name,
        time: leg.time,
        address: point?.address ?? null,
        desc: trip.itineraryStops.find((stop) => stop.id === leg.id)?.desc ?? null,
        stage,
        passengers: isPoint ? here.length + returningTickets.length : null,
        boarded: isPoint ? here.filter((ticket) => ticket.isBoarded).length + returningTickets.filter((ticket) => ticket.returnBoardedAt).length : null,
        arrivedAt,
        departedAt,
        etaAt: stage === 'NEXT' ? eta?.arrivesAt ?? null : null,
        alerts: legAlerts,
        history: alerts.filter((row) => row.stopKey === leg.name).length,
      };
    });
    const total = tickets.length + returningTickets.length;
    const hasArrived = trip.liveStatus === 'ARRIVED';
    route.push({
      key: DESTINATION_KEY,
      id: DESTINATION_KEY,
      kind: 'DESTINATION',
      name: trip.destination,
      time: toClock(trip.estimatedArrivalAt ?? trip.arrivalTime),
      address: null,
      desc: null,
      stage: hasArrived ? 'CURRENT' : nextLeg ? 'UPCOMING' : 'NEXT',
      passengers: total,
      boarded: null,
      arrivedAt: hasArrived ? trip.liveStatusAt : null,
      departedAt: null,
      etaAt: null,
      alerts: [alertState('DESTINATION', trip.destination, {}, false)],
      history: alerts.filter((row) => row.stopKey === trip.destination).length,
    });

    return {
      trip: { id: trip.id, tripCode: trip.tripCode, origin: trip.origin, destination: trip.destination, departureTime: trip.departureTime, liveStatus: trip.liveStatus, busPlate: trip.bus?.plateNumber ?? null, isLive, positionAt: position?.recordedAt ?? null },
      route,
      rules: rules.map((rule) => ({ ...rule, isActive: active.get(rule.key)!.isActive, companyActive: rule.isActive, overridden: active.get(rule.key)!.overridden })),
      manualTypes: Object.entries(MANUAL_STATION_TYPES).map(([key, { label }]) => ({ key, label })),
    };
  }

  async history(tripId: string, stopKey: string) {
    return this.prisma.stationAlert.findMany({
      where: { tripId, stopKey },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, ruleKey: true, manualType: true, message: true, recipients: true, channels: true, senderName: true, createdAt: true },
    });
  }

  private async manualRecipients(trip: WatchedTrip, stopKey: string) {
    const point = trip.boardingPoints.find((row) => row.name === stopKey);
    if (point) return { stopName: point.name, bookingIds: await this.waitingAt(this.prisma, trip, point) };
    const stop = trip.itineraryStops.find((row) => row.title === stopKey);
    const stopName = stop?.title ?? (stopKey === DESTINATION_KEY ? trip.destination : null);
    if (!stopName) throw new NotFoundException('هذه المحطة ليست على مسار الرحلة');
    return { stopName, bookingIds: await this.travelling(this.prisma, trip) };
  }

  private manualValues(trip: WatchedTrip, stopName: string, alert: ManualAlert): NotificationValues {
    return {
      ...tripValues(trip),
      stopName,
      etaText: alert.minutes ? minutesWord(alert.minutes) : 'قريبًا',
      minutes: alert.minutes,
      newValue: alert.note,
    };
  }

  /** The wording and head count for the panel, with the customer's name left out. */
  async preview(tripId: string, alert: ManualAlert) {
    const trip = await this.loadTrip(tripId);
    const { stopName, bookingIds } = await this.manualRecipients(trip, alert.stopKey);
    const { event } = MANUAL_STATION_TYPES[alert.type];
    const entry = NOTIFICATION_CATALOG[event];
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    const values = this.manualValues(trip, stopName, alert);
    return {
      title: renderTemplate(custom?.title ?? entry.title, values),
      body: renderTemplate(custom?.body ?? entry.body, values),
      recipients: new Set(bookingIds).size,
      whatsappReady: await this.whatsappReady(event),
    };
  }

  private async whatsappReady(event: keyof typeof NOTIFICATION_CATALOG) {
    const entry = NOTIFICATION_CATALOG[event];
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    if (!custom?.whatsappEnabled) return false;
    const approved = await approvedWhatsAppTemplates(this.prisma, event, (language) => (language === 'ar' ? custom.body : (entry as { translations?: Record<string, { body: string }> }).translations?.[language]?.body ?? custom.body));
    return approved.size > 0;
  }

  async sendManual(actor: { userId: string }, tripId: string, alert: ManualAlert) {
    if (alert.type === 'DELAY' && !alert.minutes) throw new BadRequestException('اكتب مدة التأخير بالدقائق');
    if (alert.type === 'LOCATION_CHANGE' && !alert.note) throw new BadRequestException('اكتب موقع المحطة الجديد');
    const trip = await this.loadTrip(tripId);
    if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('لا يمكن إرسال تنبيه إلا لرحلة قائمة');
    const sentLastHour = await this.prisma.stationAlert.count({ where: { tripId, manualType: { not: null }, createdAt: { gte: new Date(Date.now() - HOUR_MS) } } });
    if (sentLastHour >= MAX_MANUAL_PER_HOUR) throw new HttpException(`الحد الأقصى ${MAX_MANUAL_PER_HOUR} تنبيهات يدوية في الساعة لكل رحلة، حاول لاحقًا`, HttpStatus.TOO_MANY_REQUESTS);

    const { event } = MANUAL_STATION_TYPES[alert.type];
    const wantsWhatsapp = alert.channels.includes('WHATSAPP');
    const wantsInApp = alert.channels.includes('IN_APP');
    if (wantsWhatsapp && !(await this.whatsappReady(event))) throw new ConflictException('لا يوجد قالب واتساب معتمد ومفعل لهذا التنبيه');
    if (wantsInApp) {
      const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
      if (custom && !custom.isActive) throw new ConflictException('إشعار التطبيق متوقف لهذا التنبيه من صفحة القوالب');
    }

    const { stopName, bookingIds } = await this.manualRecipients(trip, alert.stopKey);
    const unique = [...new Set(bookingIds)];
    if (unique.length === 0) throw new ConflictException('لا يوجد ركاب بانتظار هذه المحطة');
    const sender = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const values = this.manualValues(trip, stopName, alert);
    const entry = NOTIFICATION_CATALOG[event];

    await this.prisma.$transaction(async (tx) => {
      await this.notifications.toBookingOwners(tx, event, unique, values, { inApp: wantsInApp, whatsapp: wantsWhatsapp });
      await tx.stationAlert.create({
        data: {
          tripId,
          stopKey: alert.stopKey,
          stopName,
          manualType: alert.type,
          message: renderTemplate(entry.body, values),
          recipients: unique.length,
          channels: alert.channels,
          senderId: actor.userId,
          senderName: sender?.name,
        },
      });
    }, TX_OPTIONS);
    return { recipients: unique.length };
  }
}

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, TripCalendar, TripScheduleType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { BookingCancellationService } from '../../common/services/booking-cancellation.service';
import { LoyaltyService } from '../../common/services/loyalty.service';
import { NotificationsService, tripValues } from '../../common/services/notifications.service';
import { TicketAlertsService } from '../../common/services/ticket-alerts.service';
import { TicketCompensationService } from '../../common/services/ticket-compensation.service';
import { RoomAllocationService } from '../../common/services/room-allocation.service';
import { BOOKING_TYPES, includesHousing } from '../../common/utils/booking-types.util';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { HousingTerms, startingSeatPrice } from '../../common/utils/housing-price.util';
import { CREW_WINDOW_SELECT, MAX_CREW_OPENS_BEFORE_MINUTES, crewWindow } from '../../common/utils/crew-window.util';
import { seatLayoutFor, seatNumbersOf, storedSeatLayout, tripSeatLayout } from '../../common/utils/bus-layout.util';
import { assertSinglesFitRange } from '../../common/utils/singles-seats.util';
import { applySeatLayout } from '../../common/utils/trip-seats.util';
import { bookedOnTrips, goOnlyBookings, lockTripsWithLinked, returningBookingIds } from '../../common/utils/linked-seats.util';
import { RIYADH_OFFSET_MS, addDays, formatRiyadhDate, formatRiyadhTime, riyadhDate, riyadhDayRange, riyadhMonth, riyadhMonthRange, startOfRiyadhMonth, toHijriLabel } from '../../common/utils/time.util';
import { bookingOpenedWhere, bookingOpensAtFor, startOfNextRiyadhMonth } from '../../common/utils/booking-opens.util';
import { applyBusServices, busServiceRows } from '../../common/utils/bus-services.util';
import { WEEKLY_HORIZON_DAYS, nextWeeklyDate, nextYearlyDate, riyadhWeekday } from '../../common/utils/recurrence.util';
import { AppSettingsService } from '../../common/services/app-settings.service';

type MonthlySchedule = Awaited<ReturnType<AppSettingsService['monthlySchedule']>>;
import { imageTypeOf } from '../../common/utils/image-type.util';
import { GALLERY_SELECT } from '../../common/utils/gallery.util';
import { CreateTripDto, OpenReverseTripDto, UpdateTripDto } from './trips.dto';
import { assertTripFitsPackage } from '../../common/utils/package-window.util';
import { PACKAGE_PRICE_SELECT, PackagePrices, packagePriceTiers } from '../../common/utils/package-price.util';
import { cityTripWhere, servedCity } from '../../common/utils/branch-city.util';
import { PublicService, SERVICE_SELECT, withHotelServices } from '../../common/utils/services.util';
import { assignTripCode, journeyCodeOf, reverseCodeOf } from '../../common/utils/trip-code.util';

const DEFAULT_TRIP_DURATION_MS = 8 * 60 * 60 * 1000;
const COMPLETION_SWEEP_MS = 5 * 60 * 1000;
const CREW_WINDOW_SWEEP_MS = 60 * 1000;
// Trip writes touch many tables over a remote database, well past Prisma's 5s default.
const TRIP_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const DAY_MS = 24 * 60 * 60 * 1000;

type Schedule = { scheduleType: TripScheduleType; recurrenceCalendar: TripCalendar | null; repeatWeekdays: number[]; repeatUntil: Date | null };

export const MAX_PUBLIC_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PUBLIC_IMAGES_PER_UPLOAD = 10;

export interface UploadedImage {
  buffer: Buffer;
  size: number;
}

export const PUBLIC_TRIP_INCLUDE = {
  boardingPoints: true,
  itineraryStops: { orderBy: { sortOrder: 'asc' } },
  images: true,
  // imageUrl is the gallery's cover, kept for copies of the app from before bus galleries.
  bus: { select: { model: true, color: true, imageUrl: true, images: GALLERY_SELECT, company: true, services: SERVICE_SELECT } },
  package: { select: { id: true, name: true, description: true, ...PACKAGE_PRICE_SELECT, nights: true, type: true, terms: true } },
  services: { include: { service: true } },
  visits: { orderBy: { sortOrder: 'asc' } },
  accommodations: true,
  // The place and its features are all the customer needs; rates and room counts stay with staff.
  hotelBookings: {
    where: { status: 'CONFIRMED' },
    orderBy: { number: 'asc' },
    take: 1,
    select: { hotel: { select: { name: true, city: true, address: true, description: true, services: SERVICE_SELECT, images: GALLERY_SELECT } } },
  },
  supervisors: { select: { isPrimary: true, user: { select: { name: true } } } },
} satisfies Prisma.TripInclude;

const STAFF_USER_SELECT = { select: { id: true, name: true, phone: true, role: true } };

const ADMIN_TRIP_INCLUDE = {
  boardingPoints: true,
  itineraryStops: { orderBy: { sortOrder: 'asc' } },
  images: true,
  bus: true,
  package: true,
  services: { include: { service: true } },
  visits: { orderBy: { sortOrder: 'asc' } },
  accommodations: true,
  hotelBookings: { where: { status: 'CONFIRMED' }, orderBy: { number: 'asc' }, select: { hotelId: true } },
  reverseTrip: { select: { id: true, tripCode: true, tripStatus: true } },
  reverseOf: { select: { id: true, tripCode: true, departureTime: true } },
  drivers: { include: { user: STAFF_USER_SELECT } },
  supervisors: { include: { user: STAFF_USER_SELECT } },
  _count: { select: { bookings: true } },
} satisfies Prisma.TripInclude;

type RentActor = { userId?: string; permissions: string[] };

/** The list reaches many sections through their trip filters, but rent belongs to those who manage trips or see the rates. */
const withoutRentFor = <T extends { busRentalPrice?: unknown }>(actor: RentActor, trip: T) =>
  actor.permissions.includes('buses.rates') || actor.permissions.includes('trips.manage') ? trip : { ...trip, busRentalPrice: undefined };

const INTERNAL_TRIP_FIELDS = [
  'busRentalPrice',
  'reverseEnabled',
  'reverseReadyAnnouncedAt',
  'reverseOpenPercent',
  'reverseDepartureAt',
  'reversePrice',
  'channelBranch',
  'housingPrice',
  'privateRoomPrice',
  'privateRoomCapacity',
  'sharedRoomCapacity',
  'housingPriceMode',
  'privateRoomPriceBasis',
  'housingPricePeriod',
  'crewOpensBeforeMinutes',
  'boardingOpensBeforeMinutes',
  'boardingClosesAfterMinutes',
  'unpaidBoarding',
  'crewOpenAnnouncedAt',
  'boardingOpenAnnouncedAt',
  'boardingCloseAnnouncedAt',
  'boardingOpenedManuallyAt',
  'scheduleType',
  'recurrenceCalendar',
  'recurrenceDoneAt',
  'repeatWeekdays',
  'repeatUntil',
  'seriesId',
  'seatLayout',
] as const;

/** Costs and planning settings stay out of the customer-facing API. */
export const toPublicTrip = <T extends object>(trip: T) => {
  const copy = { ...trip } as unknown as Record<string, unknown>;
  for (const field of INTERNAL_TRIP_FIELDS) delete copy[field];
  // The hotel's services arrive as join rows; customers get the services themselves.
  if (Array.isArray(copy.hotelBookings)) {
    copy.hotelBookings = (copy.hotelBookings as { hotel?: { services: { service: PublicService }[] } }[]).map((row) =>
      row.hotel?.services ? { ...row, hotel: withHotelServices(row.hotel) } : row,
    );
  }
  return copy as unknown as Omit<T, (typeof INTERNAL_TRIP_FIELDS)[number]>;
};

type PricedTrip = HousingTerms & {
  price: Prisma.Decimal;
  bookingType: string;
  package?: ({ price: Prisma.Decimal } & Partial<PackagePrices>) | null;
  accommodations?: { nights: number | null }[];
};

/** A package's totals for one to four people, when the query loaded them. */
const tiersOf = (pkg: PricedTrip['package']) =>
  pkg && pkg.price2 != null && pkg.price3 != null && pkg.price4 != null
    ? packagePriceTiers({ price: pkg.price, price2: pkg.price2, price3: pkg.price3, price4: pkg.price4 })
    : null;

/** A package's price is all-inclusive, so its trips charge nothing more for housing. */
const housingOfferOf = (trip: PricedTrip) => {
  if (trip.package || !includesHousing(trip.bookingType)) return null;
  const added = trip.housingPriceMode === 'ADDED_TO_BASE';
  return {
    addedToBase: added,
    bedPrice: added && trip.housingPrice !== null ? Number(trip.housingPrice) : null,
    privateRoomPrice: trip.privateRoomPrice === null ? null : Number(trip.privateRoomPrice),
    // A private room is always one price per booking, paid by its owner.
    privateRoomPriceBasis: 'PER_BOOKING' as const,
    privateRoomCapacity: trip.privateRoomCapacity,
    period: trip.housingPricePeriod,
  };
};

/** Searching transport alone, a trip with housing is sold as its seat, so neither the stay nor its price shows. */
const withSeatPrice = <T extends PricedTrip>(trip: T, transportOnly = false) => {
  const pricePerSeat = Number(trip.package?.price ?? trip.price);
  const offer = transportOnly ? null : housingOfferOf(trip);
  return {
    ...trip,
    pricePerSeat,
    packagePriceTiers: tiersOf(trip.package),
    housingOffer: offer,
    startingPrice: offer ? startingSeatPrice(pricePerSeat, trip, trip.accommodations?.[0]?.nights ?? 1) : pricePerSeat,
  };
};

interface TripSearchFilters {
  origin?: string;
  destination?: string;
  date?: string;
  busType?: string;
  bookingType?: string;
  packageId?: string;
}

type OutboundTimes = { direction: string; departureTime: Date; arrivalTime: Date; estimatedArrivalAt: Date | null };

/** When the bus reaches the destination. A round trip's arrivalTime is the end of its return, so without an estimate only its departure is known. */
const reachesDestinationAt = (trip: OutboundTimes) =>
  trip.estimatedArrivalAt ?? (trip.direction === 'ONE_WAY' ? trip.arrivalTime : trip.departureTime);

const sameMembers = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Transport alone is sold on every trip whose stay can be left out: plain transport, and trips with a hotel that are not part of a
 * package and price the stay on top of the seat. A seat that already includes the stay has no price without it. Any other type matches itself.
 */
export const bookingTypeWhere = (bookingType: string): Prisma.TripWhereInput =>
  bookingType === 'TRANSPORT_ONLY'
    ? { OR: [{ bookingType: 'TRANSPORT_ONLY' }, { bookingType: 'WITH_HOTEL', packageId: null, housingPriceMode: { not: 'INCLUDED_IN_BASE' } }] }
    : { bookingType };

/** A package's trips go on sale with it: while the package is a draft or archived, its trips stay out of the app. */
const ON_SALE_PACKAGE: Prisma.TripWhereInput = { OR: [{ packageId: null }, { package: { status: 'PUBLISHED' } }] };

/** The trips a customer can find and book in the app, narrowed to what they searched for. */
export function appTripWhere(filters: Pick<TripSearchFilters, 'origin' | 'destination' | 'date'>): Prisma.TripWhereInput {
  const now = new Date();
  // A trip waiting for its booking to open stays out of the app until then: the app has nowhere to show the opening date.
  const where: Prisma.TripWhereInput = { tripStatus: 'PUBLISHED', channelApp: true, departureTime: { gt: now }, AND: [ON_SALE_PACKAGE, bookingOpenedWhere(now)] };
  if (filters.origin) where.origin = { contains: filters.origin, mode: 'insensitive' };
  if (filters.destination) where.destination = { contains: filters.destination, mode: 'insensitive' };
  if (filters.date) {
    const range = riyadhDayRange(filters.date);
    if (!range) throw new BadRequestException('صيغة التاريخ غير صحيحة');
    where.departureTime = { gte: range.start > now ? range.start : now, lt: range.end };
  }
  return where;
}

/** Whoever changed a trip's crew, as the assignment history names them. */
export interface CrewActor {
  userId: string;
  name?: string | null;
}

/** A clock time (HH:mm) moved to keep its distance, within half a day either way, from one departure to another. */
function shiftClock(time: string, from: Date, to: Date) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time;
  const minutesOf = (date: Date) => {
    const [hours, minutes] = formatRiyadhTime(date).split(':').map(Number);
    return hours * 60 + minutes;
  };
  const day = 24 * 60;
  const offset = ((((Number(match[1]) * 60 + Number(match[2]) - minutesOf(from)) % day) + day + day / 2) % day) - day / 2;
  const shifted = (((minutesOf(to) + offset) % day) + day) % day;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

@Injectable()
export class TripsService implements OnModuleInit, OnModuleDestroy {
  private completionTimer: NodeJS.Timeout;
  private crewWindowTimer: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private cancellation: BookingCancellationService,
    private loyalty: LoyaltyService,
    private rooms: RoomAllocationService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
    private ticketAlerts: TicketAlertsService,
    private compensation: TicketCompensationService,
  ) {}

  onModuleInit() {
    this.completionTimer = setInterval(() => {
      this.completeFinishedTrips().catch((err) => console.error('Trip completion sweep failed:', err.message));
    }, COMPLETION_SWEEP_MS);
    this.completionTimer.unref();
    this.crewWindowTimer = setInterval(() => {
      this.announceCrewWindows().catch((err) => console.error('Crew window sweep failed:', err.message));
      // Tests drive this sweep themselves: on a timer it would open ways back that a test means to open by hand.
      if (process.env.NODE_ENV !== 'test') this.openPendingReverses().catch((err) => console.error('Reverse trip sweep failed:', err.message));
    }, CREW_WINDOW_SWEEP_MS);
    this.crewWindowTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.completionTimer);
    clearInterval(this.crewWindowTimer);
  }

  /** Tells the crew when their trip opens and when boarding opens and closes; each moment is announced once per trip. */
  async announceCrewWindows() {
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: 'PUBLISHED',
        departureTime: { lte: new Date(now + MAX_CREW_OPENS_BEFORE_MINUTES * 60_000) },
        OR: [{ crewOpenAnnouncedAt: null }, { boardingOpenAnnouncedAt: null }, { boardingCloseAnnouncedAt: null }],
      },
      select: { id: true, crewOpenAnnouncedAt: true, boardingOpenAnnouncedAt: true, boardingCloseAnnouncedAt: true, ...CREW_WINDOW_SELECT },
    });

    for (const trip of trips) {
      const window = crewWindow(trip, now);
      const hasClosed = now > window.boardingClosesAt.getTime();
      const moments = [
        { flag: 'crewOpenAnnouncedAt', isPending: !trip.crewOpenAnnouncedAt, isDue: window.isTripOpen, event: 'CREW_TRIP_OPENED', stillRelevant: !hasClosed },
        { flag: 'boardingOpenAnnouncedAt', isPending: !trip.boardingOpenAnnouncedAt, isDue: now >= window.boardingOpensAt.getTime(), event: 'CREW_BOARDING_OPENED', stillRelevant: !hasClosed },
        { flag: 'boardingCloseAnnouncedAt', isPending: !trip.boardingCloseAnnouncedAt, isDue: hasClosed, event: 'CREW_BOARDING_CLOSED', stillRelevant: true },
      ] as const;

      for (const moment of moments) {
        if (!moment.isPending || !moment.isDue) continue;
        await this.prisma.$transaction(async (tx) => {
          // Claiming the moment first keeps a second server instance from announcing it again.
          const claimed = await tx.trip.updateMany({ where: { id: trip.id, [moment.flag]: null }, data: { [moment.flag]: new Date(now) } });
          if (claimed.count === 1 && moment.stillRelevant) {
            await this.notifications.toTripCrew(tx, moment.event, trip.id, {
              extra: { boardingClosesTime: formatRiyadhTime(window.boardingClosesAt), boardingOpensTime: formatRiyadhTime(window.boardingOpensAt) },
            });
          }
          // With no word from the crew, the clock is what stops a ticket, so customers hear it from here.
          if (claimed.count === 1 && moment.flag === 'boardingCloseAnnouncedAt') await this.ticketAlerts.announce(tx, trip.id);
        }, TRIP_TX_OPTIONS);
      }
    }
  }

  /**
   * Publishing a DR journey puts both of its legs on sale: the way back (R) opens by itself as soon as the way there (D) is
   * published, even long before it leaves. This sweep catches any that could not open at publishing, such as when the bus
   * or crew was busy at the return time, and tries again once that is sorted out. A return staff cancelled stays cancelled.
   */
  async openPendingReverses() {
    const trips = await this.prisma.trip.findMany({
      where: { reverseEnabled: true, tripStatus: 'PUBLISHED', reverseTrip: null, reverseDepartureAt: { gt: new Date() } },
      select: { id: true },
    });
    for (const trip of trips) await this.autoOpenReverse(trip.id);
  }

  /**
   * Opens the trip's way back on the gathering points and route of the last return on the same road, so staff do not type
   * them again; with none yet, passengers gather at the destination at departure time. Staff edit it afterwards like any
   * trip. When it cannot open, whoever manages trips is told once, and opens it by hand from the return trips screen.
   */
  private async autoOpenReverse(id: string) {
    try {
      const reverse = await this.openReverseTrip(id, await this.defaultReverseOpening(id));
      return { id: reverse.id, tripCode: reverse.tripCode, tripStatus: reverse.tripStatus };
    } catch (err) {
      if (!(err instanceof HttpException)) console.error(`Could not open the return of trip ${id}:`, err.message);
      await this.prisma.$transaction(async (tx) => {
        // Opened by someone else meanwhile: nothing to tell.
        if ((await tx.trip.count({ where: { id, reverseTrip: null } })) === 0) return;
        const claimed = await tx.trip.updateMany({ where: { id, reverseReadyAnnouncedAt: null }, data: { reverseReadyAnnouncedAt: new Date() } });
        if (claimed.count === 1) await this.notifications.toStaff(tx, 'REVERSE_TRIP_READY', ['trips.manage'], {}, { tripId: id });
      }, TRIP_TX_OPTIONS);
      return null;
    }
  }

  private async defaultReverseOpening(id: string): Promise<OpenReverseTripDto> {
    const trip = await this.prisma.trip.findUniqueOrThrow({
      where: { id },
      select: { origin: true, destination: true, reverseDepartureAt: true, channelApp: true, channelBranch: true },
    });
    const departure = trip.reverseDepartureAt ?? new Date();
    const template = await this.prisma.trip.findFirst({
      where: { reverseOfTripId: { not: null }, origin: trip.destination, destination: trip.origin, tripStatus: { not: 'CANCELLED' }, boardingPoints: { some: {} } },
      orderBy: { createdAt: 'desc' },
      select: {
        departureTime: true,
        boardingPoints: { orderBy: { time: 'asc' }, select: { name: true, time: true, address: true, lat: true, lng: true } },
        itineraryStops: { orderBy: { sortOrder: 'asc' }, select: { title: true, time: true, desc: true, kind: true } },
      },
    });
    const channels = { channelApp: trip.channelApp, channelBranch: trip.channelBranch };
    if (!template) return { ...channels, boardingPoints: [{ name: trip.destination, time: formatRiyadhTime(departure) }] };
    // The template's times keep their distance from its departure.
    const clock = (time: string) => shiftClock(time, template.departureTime, departure);
    return {
      ...channels,
      boardingPoints: template.boardingPoints.map((point) => ({ ...point, time: clock(point.time), lat: point.lat ?? undefined, lng: point.lng ?? undefined })),
      itineraryStops: template.itineraryStops.map((stop) => ({ ...stop, time: clock(stop.time) })),
    };
  }

  /** The crew cannot board anyone before the trip is open to them, and boarding needs a moment to be open at all. */
  private assertCrewWindowSettings(settings: { crewOpensBeforeMinutes: number; boardingOpensBeforeMinutes: number; boardingClosesAfterMinutes: number }) {
    if (settings.boardingOpensBeforeMinutes > settings.crewOpensBeforeMinutes) {
      throw new BadRequestException('لا يمكن فتح الصعود قبل فتح الرحلة للطاقم');
    }
    if (settings.boardingOpensBeforeMinutes === 0 && settings.boardingClosesAfterMinutes === 0) {
      throw new BadRequestException('حدد مدة يكون فيها الصعود مفتوحًا');
    }
  }

  async completeFinishedTrips() {
    const now = Date.now();
    const graceHours = await this.appSettings.number('trackingClosesAfterHours');
    // A late bus the crew still reports as moving stays open, so they can still report its arrival; only a bus gone silent long past the limit is closed.
    const completed = await this.prisma.trip.updateMany({
      where: {
        tripStatus: 'PUBLISHED',
        OR: [
          // Arrival completes a trip at once; this also closes any left open from before that rule.
          { liveStatus: 'ARRIVED' },
          { arrivalTime: { lt: new Date(now) }, liveStatus: { notIn: ['AT_POINT', 'ON_ROAD'] } },
          { arrivalTime: { lt: new Date(now - graceHours * 60 * 60 * 1000) } },
        ],
      },
      data: { tripStatus: 'COMPLETED' },
    });
    await this.loyalty.settleCompletedTrips();
    await this.compensation.compensateFinishedTrips();
    await this.draftNextFixedTrips();
    await this.extendWeeklySeries();
    return completed;
  }

  /** Keeps every weekly schedule drafted through its monthly horizon; it also finishes a series whose first drafting was interrupted. */
  async extendWeeklySeries() {
    const rows = await this.prisma.trip.findMany({
      where: { seriesId: { not: null }, repeatWeekdays: { isEmpty: false } },
      distinct: ['seriesId'],
      select: { seriesId: true },
    });
    for (const { seriesId } of rows) {
      try {
        await this.extendSeries(seriesId, true);
      } catch (err) {
        console.error(`Could not extend weekly trips ${seriesId}:`, err.message);
      }
    }
  }

  /**
   * Where the sweep stops drafting weekly schedules (exclusive): the end of this Riyadh month, or of next month once that is
   * generateDaysBefore days away. A month at a time, so each month is copied from the latest edits rather than a year-old plan.
   */
  private async weeklyHorizon(now = new Date()) {
    const { generateDaysBefore } = await this.appSettings.monthlySchedule();
    const nextMonth = startOfNextRiyadhMonth(now);
    return now >= addDays(nextMonth, -generateDaysBefore) ? startOfNextRiyadhMonth(nextMonth) : nextMonth;
  }

  /** This month and next: the furthest a weekly schedule is drafted, by the sweep or by hand. Drafts beyond it date from the old year-ahead rule. */
  private draftWindow(now = new Date()) {
    return { start: startOfRiyadhMonth(now), end: startOfNextRiyadhMonth(startOfNextRiyadhMonth(now)) };
  }

  /**
   * Drafts the series' next departures, one transaction each, up to the monthly horizon, and never past a temporary
   * schedule's last day. The office publishes the drafts. Returns how many were made.
   */
  async extendSeries(seriesId: string, announce = false) {
    const [horizon, schedule] = await Promise.all([this.weeklyHorizon(), this.appSettings.monthlySchedule()]);
    let made = 0;
    for (;;) {
      const draft = await this.prisma.$transaction(async (tx) => {
        // Two runs over one series, from a create and from the sweep, take turns so neither drafts a date twice.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${seriesId}))`;
        const next = await this.draftNextInSeries(tx, seriesId, horizon, schedule);
        if (next && announce && made === 0) await this.notifications.toStaff(tx, 'STAFF_FIXED_TRIP_DRAFTED', ['trips.manage'], {}, { tripId: next.id });
        return next;
      }, TRIP_TX_OPTIONS);
      if (!draft) return made;
      made++;
    }
  }

  /** The day after the series' last trip that falls on its weekdays, copied from its latest trip. */
  private async draftNextInSeries(tx: Prisma.TransactionClient, seriesId: string, horizon: Date, schedule: MonthlySchedule) {
    const latest = await tx.trip.findFirst({ where: { seriesId }, orderBy: { departureTime: 'desc' }, select: { departureTime: true } });
    // Drafts made under the old year-ahead rule already cover the window, so nothing is added after them.
    if (!latest || latest.departureTime >= horizon) return null;
    const template = await this.seriesTemplate(tx, seriesId, horizon);
    if (!template?.repeatWeekdays.length) return null;
    const now = new Date();
    const departure = nextWeeklyDate(latest.departureTime, template.repeatWeekdays, template.departureTime, now);
    if (!departure || departure >= horizon || !this.withinSchedule(template, departure)) return null;
    return this.cloneTrip(tx, template.id, departure, {
      schedule: { scheduleType: template.scheduleType, recurrenceCalendar: null, repeatWeekdays: template.repeatWeekdays, repeatUntil: template.repeatUntil },
      seriesId,
      keepBusAndCrew: true,
      bookingOpensAt: bookingOpensAtFor(departure, schedule, now),
    });
  }

  /** A fixed schedule runs on; a temporary one stops at its last day. */
  private withinSchedule(template: { scheduleType: TripScheduleType; repeatUntil: Date | null }, departure: Date) {
    return template.scheduleType === 'FIXED' || (!!template.repeatUntil && departure <= template.repeatUntil);
  }

  /**
   * The trip a series' copies are made from: its latest trip before `before` that is not cancelled, so an edit to this
   * month's trip carries into next month, weekdays and departure time included. With only cancelled ones, the latest of them.
   */
  private async seriesTemplate(db: Prisma.TransactionClient, seriesId: string, before: Date) {
    const select = { id: true, departureTime: true, scheduleType: true, repeatWeekdays: true, repeatUntil: true, origin: true, destination: true } as const;
    const where = { seriesId, departureTime: { lt: before } };
    return (
      (await db.trip.findFirst({ where: { ...where, tripStatus: { not: 'CANCELLED' } }, orderBy: { departureTime: 'desc' }, select })) ??
      (await db.trip.findFirst({ where, orderBy: { departureTime: 'desc' }, select }))
    );
  }

  /**
   * The series' weekdays in a Riyadh month (YYYY-MM), at its departure time: each day already holding a trip of the series,
   * in any state, is taken; a day before the series began, already past, beyond next month or past a temporary schedule's
   * last day is out of range.
   */
  private async seriesMonthPlan(db: Prisma.TransactionClient, seriesId: string, month: string) {
    const range = riyadhMonthRange(month);
    const [first, template] = await Promise.all([
      db.trip.findFirst({ where: { seriesId }, orderBy: { departureTime: 'asc' }, select: { departureTime: true } }),
      this.seriesTemplate(db, seriesId, range.lt),
    ]);
    if (!first || !template?.repeatWeekdays.length) return null;
    const taken = new Set(
      (await db.trip.findMany({ where: { seriesId, departureTime: { gte: range.gte, lt: range.lt } }, select: { departureTime: true } })).map((trip) =>
        riyadhDate(trip.departureTime),
      ),
    );
    const now = new Date();
    const windowEnd = this.draftWindow(now).end;
    const timeOfDay = (((template.departureTime.getTime() + RIYADH_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
    const days: { departure: Date; state: 'missing' | 'taken' | 'outOfRange' }[] = [];
    for (let dayStart = range.gte.getTime(); dayStart < range.lt.getTime(); dayStart += DAY_MS) {
      const departure = new Date(dayStart + timeOfDay);
      if (!template.repeatWeekdays.includes(riyadhWeekday(departure))) continue;
      const state = taken.has(riyadhDate(departure))
        ? 'taken'
        : departure <= now || departure < first.departureTime || departure >= windowEnd || !this.withinSchedule(template, departure)
          ? 'outOfRange'
          : 'missing';
      days.push({ departure, state });
    }
    return { template, route: `${template.origin} ← ${template.destination}`, days };
  }

  /**
   * Makes sure every running weekly schedule has its drafts on all its weekdays of this month or next, at once, whatever
   * generateDaysBefore says. Each series is first drafted to the monthly horizon as the sweep would, then any day still
   * without a trip of the series, such as one whose draft was deleted, is drafted. A day that has one is skipped, so running
   * it twice adds nothing. With dryRun nothing is written.
   */
  async generateSeriesMonth(month: string, actor: CrewActor & { permissions: string[] }, dryRun = false) {
    const now = new Date();
    const current = riyadhMonth(now);
    const next = riyadhMonth(startOfNextRiyadhMonth(now));
    if (month !== current && month !== next) {
      throw new BadRequestException(`يُولَّد جدول الشهر الحالي (${current}) أو الشهر القادم (${next}) فقط، والأشهر التالية تُولَّد في وقتها`);
    }
    const schedule = await this.appSettings.monthlySchedule();
    // A branch employee works with the schedules of their city's trips, as in the trips list.
    const city = await servedCity(this.prisma, { userId: actor.userId, permissions: actor.permissions });
    const rows = await this.prisma.trip.findMany({
      where: { seriesId: { not: null }, repeatWeekdays: { isEmpty: false }, ...(city && cityTripWhere(city)) },
      distinct: ['seriesId'],
      select: { seriesId: true },
    });
    const series: { seriesId: string; route: string; created: number; skipped: number; outOfRange: number }[] = [];
    const failed: { route: string; date: string; reason: string }[] = [];
    for (const { seriesId } of rows) {
      const plan = await this.seriesMonthPlan(this.prisma, seriesId, month);
      if (!plan) continue;
      const missing = plan.days.filter((day) => day.state === 'missing');
      let created = missing.length;
      if (!dryRun && missing.length) {
        try {
          await this.extendSeries(seriesId);
        } catch (err) {
          console.error(`Could not extend weekly trips ${seriesId}:`, err.message);
        }
        for (const day of missing) {
          try {
            await this.prisma.$transaction(async (tx) => {
              // Takes turns with the sweep on this series, then checks again: the day may have been drafted meanwhile.
              await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${seriesId}))`;
              const { start, end } = riyadhDayRange(riyadhDate(day.departure))!;
              if (await tx.trip.count({ where: { seriesId, departureTime: { gte: start, lt: end } } })) return;
              const template = await this.seriesTemplate(tx, seriesId, day.departure);
              if (!template?.repeatWeekdays.length) throw new ConflictException('توقف الجدول أثناء التوليد');
              await this.cloneTrip(tx, template.id, day.departure, {
                schedule: { scheduleType: template.scheduleType, recurrenceCalendar: null, repeatWeekdays: template.repeatWeekdays, repeatUntil: template.repeatUntil },
                seriesId,
                keepBusAndCrew: true,
                actor,
                crewReason: 'توليد جدول الشهر',
                bookingOpensAt: bookingOpensAtFor(day.departure, schedule),
              });
            }, TRIP_TX_OPTIONS);
          } catch (err) {
            created--;
            if (!(err instanceof HttpException)) console.error(`Could not draft ${riyadhDate(day.departure)} of weekly trips ${seriesId}:`, err.message);
            failed.push({ route: plan.route, date: riyadhDate(day.departure), reason: err instanceof HttpException ? err.message : 'تعذر إنشاء الرحلة' });
          }
        }
      }
      series.push({
        seriesId,
        route: plan.route,
        created,
        skipped: plan.days.filter((day) => day.state === 'taken').length,
        outOfRange: plan.days.filter((day) => day.state === 'outOfRange').length,
      });
    }
    const total = (key: 'created' | 'skipped' | 'outOfRange') => series.reduce((sum, entry) => sum + entry[key], 0);
    return {
      month,
      dryRun,
      series: series.length,
      created: total('created'),
      skipped: total('skipped'),
      outOfRange: total('outOfRange'),
      failed,
      bySeries: series,
      // What the modal explains: the two months it can draft, and from when the sweep drafts next month by itself.
      months: [current, next],
      generateDaysBefore: schedule.generateDaysBefore,
      autoGeneratesFrom: addDays(startOfNextRiyadhMonth(now), -schedule.generateDaysBefore),
      farFutureDrafts: await this.prisma.trip.count({ where: this.farFutureDraftsWhere(now, city) }),
    };
  }

  /** Unpublished weekly copies beyond next month, left by the old year-ahead rule; publishing a series skips them. */
  private farFutureDraftsWhere(now: Date, city?: string | null): Prisma.TripWhereInput {
    return {
      seriesId: { not: null },
      tripStatus: 'DRAFT',
      departureTime: { gte: this.draftWindow(now).end },
      ...(city && cityTripWhere(city)),
    };
  }

  /**
   * Deletes the far-future weekly drafts nobody booked, on an admin's explicit request; nothing does this on its own.
   * A draft with a booking or a reverse trip stays, and is counted as kept.
   */
  async deleteFarFutureDrafts() {
    const drafts = await this.prisma.trip.findMany({
      where: { ...this.farFutureDraftsWhere(new Date()), bookings: { none: {} }, reverseTrip: null },
      select: { id: true },
    });
    let deleted = 0;
    for (const draft of drafts) {
      try {
        await this.deleteTrip(draft.id);
        deleted++;
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;
      }
    }
    return { deleted, kept: await this.prisma.trip.count({ where: this.farFutureDraftsWhere(new Date()) }) };
  }

  /**
   * Copies a trip to a new departure as a one-off draft: its route, stops, gathering points, services, prices, stay and
   * visits, under the new month's next number and with no bookings. The bus and crew come along only when they are free
   * and allowed then, as for a weekly copy; otherwise the office assigns them before publishing.
   */
  async duplicateTrip(id: string, departureTime: string, actor?: CrewActor) {
    const departure = new Date(departureTime);
    if (Number.isNaN(departure.getTime())) throw new BadRequestException('موعد الرحلة غير صالح');
    if (departure <= new Date()) throw new BadRequestException('اختر موعدًا قادمًا للرحلة الجديدة');
    const source = await this.prisma.trip.findUnique({ where: { id }, select: { reverseOfTripId: true, packageId: true } });
    if (!source) throw new NotFoundException('Trip not found');
    if (source.reverseOfTripId) throw new BadRequestException('الرحلة العكسية تُفتح من رحلة الذهاب ولا تُنسخ');
    const draft = await this.prisma.$transaction(async (tx) => {
      if (source.packageId) await assertTripFitsPackage(tx, source.packageId, departure);
      return this.cloneTrip(tx, id, departure, {
        schedule: { scheduleType: 'TEMPORARY', recurrenceCalendar: null, repeatWeekdays: [], repeatUntil: null },
        keepBusAndCrew: true,
        actor,
        crewReason: 'نسخة من رحلة',
      });
    }, TRIP_TX_OPTIONS);
    return { id: draft.id, tripCode: draft.tripCode, tripStatus: draft.tripStatus, departureTime: draft.departureTime, busId: draft.busId };
  }

  /** Whether the bus and crew are free and allowed at that time; a copy that cannot keep them waits for the office to assign. */
  private async canAssign(tx: Prisma.TransactionClient, assignment: { busId: string | null; driverIds: string[]; supervisorIds: string[]; start: Date; end: Date }) {
    try {
      if (assignment.busId) {
        const bus = await tx.bus.findUnique({ where: { id: assignment.busId }, select: { status: true } });
        if (bus?.status !== 'ACTIVE') return false;
      }
      await this.assertAssignableStaff(tx, [...assignment.driverIds, ...assignment.supervisorIds]);
      await this.assertNoScheduleConflict(tx, { ...assignment, leaveCheckIds: [...assignment.driverIds, ...assignment.supervisorIds] });
      return true;
    } catch (err) {
      if (err instanceof ConflictException || err instanceof BadRequestException) return false;
      throw err;
    }
  }

  /**
   * Once a fixed trip's date has passed, next year's copy waits as a draft for an employee to review and publish.
   * A cancelled year still counts, since only that year was called off; changing the trip to temporary ends the series.
   */
  async draftNextFixedTrips() {
    const due = await this.prisma.trip.findMany({
      where: { scheduleType: 'FIXED', recurrenceCalendar: { not: null }, recurrenceDoneAt: null, arrivalTime: { lt: new Date() } },
      select: { id: true },
    });
    for (const { id } of due) {
      try {
        await this.prisma.$transaction((tx) => this.draftNextOccurrence(tx, id), TRIP_TX_OPTIONS);
      } catch (err) {
        // One trip that cannot be copied must not hold back the others; the next sweep tries it again.
        console.error(`Could not draft next year's copy of trip ${id}:`, err.message);
      }
    }
  }

  /** Next year's copy: everything except the bus and crew, which are assigned for each year, and the rent that came with the bus. */
  private async draftNextOccurrence(tx: Prisma.TransactionClient, id: string) {
    // Claiming first keeps a second server instance from drafting the same trip again, and a deleted draft from coming back.
    const claimed = await tx.trip.updateMany({ where: { id, recurrenceDoneAt: null }, data: { recurrenceDoneAt: new Date() } });
    if (claimed.count === 0) return;

    const source = await tx.trip.findUniqueOrThrow({ where: { id }, select: { departureTime: true, recurrenceCalendar: true } });
    let departure = source.departureTime;
    do departure = nextYearlyDate(departure, source.recurrenceCalendar);
    while (departure <= new Date());
    const draft = await this.cloneTrip(tx, id, departure, {
      schedule: { scheduleType: 'FIXED', recurrenceCalendar: source.recurrenceCalendar, repeatWeekdays: [], repeatUntil: null },
      keepBusAndCrew: false,
    });
    await this.notifications.toStaff(tx, 'STAFF_FIXED_TRIP_DRAFTED', ['trips.manage'], {}, { tripId: draft.id });
  }

  /**
   * A draft of the trip at another departure, with every date in it moved by the same amount. A weekly copy keeps the bus
   * and crew when they are free then; otherwise the office assigns them before publishing.
   */
  private async cloneTrip(
    tx: Prisma.TransactionClient,
    sourceId: string,
    departure: Date,
    options: { schedule: Schedule; keepBusAndCrew: boolean; seriesId?: string; actor?: CrewActor; crewReason?: string; bookingOpensAt?: Date | null },
  ) {
    const source = await tx.trip.findUniqueOrThrow({
      where: { id: sourceId },
      include: {
        images: true,
        boardingPoints: true,
        itineraryStops: true,
        services: { where: { fromBus: false } },
        visits: { orderBy: { sortOrder: 'asc' } },
        accommodations: true,
        drivers: true,
        supervisors: true,
        bus: { select: { kind: true, seatCount: true } },
        hotelBookings: { where: { status: 'CONFIRMED' }, orderBy: { number: 'asc' }, include: { hotel: { select: { isActive: true } } } },
      },
    });

    const moved = departure.getTime() - source.departureTime.getTime();
    const shift = <T extends Date | null>(date: T) => (date ? new Date(date.getTime() + moved) : null) as T;
    const primaryFirst = (rows: { userId: string; isPrimary: boolean }[]) => [...rows].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((row) => row.userId);
    let crew = { busId: null as string | null, driverIds: [] as string[], supervisorIds: [] as string[] };
    if (options.keepBusAndCrew) {
      const window = { start: departure, end: shift(source.arrivalTime) };
      const full = { busId: source.busId, driverIds: primaryFirst(source.drivers), supervisorIds: primaryFirst(source.supervisors) };
      const busOnly = { ...full, driverIds: [], supervisorIds: [] };
      if (await this.canAssign(tx, { ...full, ...window })) crew = full;
      else if (await this.canAssign(tx, { ...busOnly, ...window })) crew = busOnly;
    }
    // The copy keeps the source's seats, unless it rides the source's bus, whose seats may have changed since.
    const layout = crew.busId ? seatLayoutFor(source.bus) : tripSeatLayout(source);
    const seatNumbers = seatNumbersOf(layout);
    const busServices = await busServiceRows(tx, crew.busId);

    const draft = await tx.trip.create({
      data: {
        ...(await assignTripCode(tx, departure)),
        title: source.title,
        origin: source.origin,
        destination: source.destination,
        departureStation: source.departureStation,
        departureTime: departure,
        arrivalTime: shift(source.arrivalTime),
        estimatedArrivalAt: shift(source.estimatedArrivalAt),
        hijriDate: toHijriLabel(departure),
        busType: source.busType,
        price: source.price,
        totalSeats: seatNumbers.length,
        availableSeats: seatNumbers.length,
        seatLayout: storedSeatLayout(layout),
        maxSeatsPerBooking: source.maxSeatsPerBooking,
        miqat: source.miqat,
        crewOpensBeforeMinutes: source.crewOpensBeforeMinutes,
        boardingOpensBeforeMinutes: source.boardingOpensBeforeMinutes,
        boardingClosesAfterMinutes: source.boardingClosesAfterMinutes,
        unpaidBoarding: source.unpaidBoarding,
        tripStatus: 'DRAFT',
        ...options.schedule,
        seriesId: options.seriesId ?? null,
        direction: source.direction,
        bookingType: source.bookingType,
        packageId: source.packageId,
        busId: crew.busId,
        busRentalPrice: crew.busId ? source.busRentalPrice : null,
        housingPrice: source.housingPrice,
        privateRoomPrice: source.privateRoomPrice,
        privateRoomCapacity: source.privateRoomCapacity,
        sharedRoomCapacity: source.sharedRoomCapacity,
        alertLeadMinutes: source.alertLeadMinutes,
        alertRepeatMinutes: source.alertRepeatMinutes,
        housingPriceMode: source.housingPriceMode,
        privateRoomPriceBasis: source.privateRoomPriceBasis,
        housingPricePeriod: source.housingPricePeriod,
        reverseEnabled: source.reverseEnabled,
        reverseOpenPercent: source.reverseOpenPercent,
        reverseDepartureAt: shift(source.reverseDepartureAt),
        reversePrice: source.reversePrice,
        channelApp: source.channelApp,
        channelBranch: source.channelBranch,
        // Not the source's: its opening belongs to its own month. A weekly copy gets one from the monthly schedule setting.
        bookingOpensAt: options.bookingOpensAt ?? null,
        seats: { createMany: { data: seatNumbers.map((seatNumber) => ({ seatNumber })) } },
        images: { create: source.images.map(({ url }) => ({ url })) },
        // Clock times keep their distance from the departure, so a copy at another hour gathers at the matching hour.
        boardingPoints: { create: source.boardingPoints.map(({ name, time, address, lat, lng }) => ({ name, time: shiftClock(time, source.departureTime, departure), address, lat, lng })) },
        itineraryStops: {
          create: source.itineraryStops.map(({ title, time, desc, kind, sortOrder }) => ({ title, time: shiftClock(time, source.departureTime, departure), desc, kind, sortOrder })),
        },
        services: {
          create: [
            ...source.services.map(({ serviceId }) => ({ serviceId })),
            ...busServices.filter((row) => !source.services.some((picked) => picked.serviceId === row.serviceId)),
          ],
        },
        visits: {
          create: source.visits.map(({ title, desc, imageUrl, lat, lng, visitDate, expectedTime, duration, sortOrder }) => ({
            title, desc, imageUrl, lat, lng, expectedTime, duration, sortOrder, visitDate: shift(visitDate),
          })),
        },
        accommodations: {
          create: source.accommodations.map(({ name, nights, details, checkInDate, checkOutDate }) => ({
            name, nights, details, checkInDate: shift(checkInDate), checkOutDate: shift(checkOutDate),
          })),
        },
        drivers: { create: crew.driverIds.map((userId, idx) => ({ userId, isPrimary: idx === 0 })) },
        supervisors: { create: crew.supervisorIds.map((userId, idx) => ({ userId, isPrimary: idx === 0 })) },
      },
    });

    for (const stay of source.hotelBookings) {
      if (!stay.hotel.isActive) continue;
      const nights = Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / DAY_MS);
      await this.rooms.openForTrip(tx, draft, stay.hotelId, nights);
    }
    if (crew.driverIds.length || crew.supervisorIds.length) {
      await this.logCrew(
        tx,
        draft.id,
        { drivers: [], supervisors: [] },
        { drivers: crew.driverIds, supervisors: crew.supervisorIds },
        options.actor,
        options.crewReason ?? 'نسخة من جدول الرحلة الأسبوعي',
      );
    }
    return draft;
  }

  /**
   * One-off, temporary weekly until a last day, fixed yearly on a calendar, or fixed weekly drafted a month at a time.
   * Only the weekly kinds keep weekdays, and only the temporary weekly one a last day.
   */
  private resolveSchedule(input: { scheduleType: TripScheduleType; calendar?: TripCalendar | null; weekdays?: number[]; until?: Date | null; departure: Date }): Schedule {
    const weekdays = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
    if (weekdays.length === 0) {
      if (input.scheduleType === 'TEMPORARY') return { scheduleType: 'TEMPORARY', recurrenceCalendar: null, repeatWeekdays: [], repeatUntil: null };
      if (!input.calendar) throw new BadRequestException('حدد تقويم تكرار الرحلة الثابتة: هجري أو ميلادي');
      return { scheduleType: 'FIXED', recurrenceCalendar: input.calendar, repeatWeekdays: [], repeatUntil: null };
    }
    if (input.scheduleType === 'FIXED') return { scheduleType: 'FIXED', recurrenceCalendar: null, repeatWeekdays: weekdays, repeatUntil: null };
    if (!input.until) throw new BadRequestException('حدد آخر يوم تتكرر فيه الرحلة المؤقتة');
    if (input.until <= input.departure) throw new BadRequestException('آخر يوم للتكرار يجب أن يكون بعد موعد الرحلة الأولى');
    if (input.until.getTime() - input.departure.getTime() > WEEKLY_HORIZON_DAYS * DAY_MS) {
      throw new BadRequestException('الرحلة المؤقتة تتكرر سنة على الأكثر، وللأطول اجعلها ثابتة');
    }
    return { scheduleType: 'TEMPORARY', recurrenceCalendar: null, repeatWeekdays: weekdays, repeatUntil: input.until };
  }

  /** Booking can only open before the trip leaves; empty opens it on publish. */
  private resolveBookingOpensAt(value: string | null | undefined, departure: Date) {
    if (!value) return null;
    const opens = new Date(value);
    if (opens >= departure) throw new BadRequestException('موعد فتح الحجز يجب أن يكون قبل موعد انطلاق الرحلة');
    return opens;
  }

  async searchTrips(filters: TripSearchFilters) {
    const where = appTripWhere(filters);
    if (filters.busType) where.busType = filters.busType;
    if (filters.bookingType) (where.AND as Prisma.TripWhereInput[]).push(bookingTypeWhere(filters.bookingType));
    if (filters.packageId) where.packageId = filters.packageId;

    const trips = await this.prisma.trip.findMany({
      where,
      orderBy: { departureTime: 'asc' },
      take: 100,
      include: PUBLIC_TRIP_INCLUDE,
    });
    return trips.map((trip) => toPublicTrip(withSeatPrice(trip, filters.bookingType === 'TRANSPORT_ONLY')));
  }

  /**
   * What the app's search can offer right now, read from the trips on sale: the trip types staff created,
   * whether packages exist, each departure city with where its buses gather, and the routes between cities.
   * Tabs and city lists follow this, so a new type or route appears in the app as soon as a trip uses it.
   */
  async searchOptions() {
    const trips = await this.prisma.trip.findMany({
      where: appTripWhere({}),
      select: { origin: true, destination: true, bookingType: true, packageId: true, boardingPoints: { select: { lat: true, lng: true } } },
      orderBy: { departureTime: 'asc' },
      take: 2000,
    });
    // A package the customer builds runs on transport trips, so its route is on the packages tab though no trip belongs to it.
    const customPackages = await this.prisma.package.findMany({
      where: { kind: 'CUSTOM', status: 'PUBLISHED', origin: { not: null }, destination: { not: null }, hotel: { isActive: true } },
      select: { origin: true, destination: true },
    });
    const typeCounts = new Map<string, number>();
    const origins = new Map<string, { lat: number; lng: number; points: number }>();
    const routes = new Map<string, { origin: string; destination: string; bookingType: string; isPackage: boolean }>();
    for (const trip of trips) {
      typeCounts.set(trip.bookingType, (typeCounts.get(trip.bookingType) ?? 0) + 1);
      const place = origins.get(trip.origin) ?? { lat: 0, lng: 0, points: 0 };
      for (const point of trip.boardingPoints) {
        if (point.lat === null || point.lng === null) continue;
        place.lat += point.lat;
        place.lng += point.lng;
        place.points += 1;
      }
      origins.set(trip.origin, place);
      const isPackage = !!trip.packageId;
      routes.set(`${trip.origin}|${trip.destination}|${trip.bookingType}|${isPackage}`, { origin: trip.origin, destination: trip.destination, bookingType: trip.bookingType, isPackage });
      // A trip with a hotel also sells its seat alone, so its route is on the transport tab too.
      if (trip.bookingType === 'WITH_HOTEL' && !isPackage) {
        routes.set(`${trip.origin}|${trip.destination}|TRANSPORT_ONLY|false`, { origin: trip.origin, destination: trip.destination, bookingType: 'TRANSPORT_ONLY', isPackage: false });
        typeCounts.set('TRANSPORT_ONLY', (typeCounts.get('TRANSPORT_ONLY') ?? 0) + 1);
      }
    }
    for (const pkg of customPackages) {
      routes.set(`${pkg.origin}|${pkg.destination}|CUSTOM|true`, { origin: pkg.origin!, destination: pkg.destination!, bookingType: 'CUSTOM_PACKAGE', isPackage: true });
    }
    return {
      // In the order staff know them, and only the ones a customer can book today.
      types: BOOKING_TYPES.filter((type) => typeCounts.has(type)).map((type) => ({ key: type, label: BOOKING_TYPE_LABELS[type] ?? type, trips: typeCounts.get(type) })),
      hasPackages: trips.some((trip) => trip.packageId) || customPackages.length > 0,
      // The centre of a city's gathering points, so the app can tell which city a customer is in; null when none has a map pin.
      origins: [...origins.entries()].map(([name, place]) => ({
        name,
        lat: place.points ? place.lat / place.points : null,
        lng: place.points ? place.lng / place.points : null,
      })),
      routes: [...routes.values()],
    };
  }

  async getNextAvailableDate(filters: TripSearchFilters & { after?: string }) {
    const after = filters.after ? riyadhDayRange(filters.after)?.end : undefined;
    const now = new Date();
    const trip = await this.prisma.trip.findFirst({
      where: {
        tripStatus: 'PUBLISHED',
        channelApp: true,
        ...ON_SALE_PACKAGE,
        departureTime: { gt: after && after > now ? after : now },
        availableSeats: { gt: 0 },
        ...(filters.origin && { origin: { contains: filters.origin, mode: 'insensitive' as const } }),
        ...(filters.destination && { destination: { contains: filters.destination, mode: 'insensitive' as const } }),
        AND: [bookingOpenedWhere(now), ...(filters.bookingType ? [bookingTypeWhere(filters.bookingType)] : [])],
      },
      orderBy: { departureTime: 'asc' },
      select: { departureTime: true },
    });
    return { departureTime: trip?.departureTime ?? null };
  }

  /** With from=currentMonth, only trips leaving from the 1st of this Riyadh month: the trips page's working view. Every other caller still gets past months. */
  async getAllAdminTrips(actor: RentActor, from?: 'currentMonth') {
    // An employee of a city's branch works with that city's trips.
    const city = actor.userId ? await servedCity(this.prisma, { userId: actor.userId, permissions: actor.permissions }) : null;
    const where: Prisma.TripWhereInput = {
      ...(city && cityTripWhere(city)),
      ...(from === 'currentMonth' && { departureTime: { gte: startOfRiyadhMonth() } }),
    };
    const trips = await this.prisma.trip.findMany({
      where,
      orderBy: { departureTime: 'desc' },
      include: ADMIN_TRIP_INCLUDE,
    });
    return trips.map((trip) => withoutRentFor(actor, withSeatPrice(trip)));
  }

  /**
   * The branches the trips pages filter by, each by its city: a branch shows the trips leaving from its city.
   * An employee limited to their own branch gets only it, locked; whoever works across branches picks any or none.
   */
  async getTripBranchFilter(actor: RentActor) {
    const all = actor.permissions.includes('bookings.all_branches');
    const me = actor.userId
      ? await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branch: { select: { id: true, name: true, city: true } } } })
      : null;
    const own = me?.branch?.city?.trim() ? { id: me.branch.id, name: me.branch.name, city: me.branch.city.trim() } : null;
    if (!all && own) return { branches: [own], ownBranchId: own.id, locked: true };
    const branches = await this.prisma.branch.findMany({
      where: { isActive: true, city: { not: null } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true },
    });
    return {
      branches: branches.filter((b) => b.city?.trim()).map((b) => ({ id: b.id, name: b.name, city: b.city!.trim() })),
      ownBranchId: own?.id ?? null,
      locked: false,
    };
  }

  async getAdminTripById(actor: RentActor, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id }, include: ADMIN_TRIP_INCLUDE });
    if (!trip) throw new NotFoundException('Trip not found');
    return withoutRentFor(actor, withSeatPrice(trip));
  }

  async getTripById(id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, tripStatus: 'PUBLISHED', channelApp: true, ...ON_SALE_PACKAGE },
      include: PUBLIC_TRIP_INCLUDE,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return toPublicTrip(withSeatPrice(trip));
  }

  private async assertAssignableStaff(db: Prisma.TransactionClient, userIds: string[] = []) {
    if (userIds.length === 0) return;
    const staff = await db.user.count({
      where: {
        id: { in: userIds },
        role: { not: 'PASSENGER' },
        blockedAt: null,
        NOT: [{ driverProfile: { is: { isActive: false } } }, { employeeProfile: { is: { status: { in: ['TERMINATED', 'SUSPENDED'] } } } }],
      },
    });
    if (staff !== new Set(userIds).size) {
      throw new BadRequestException('لا يمكن الإسناد إلا لحسابات موظفين أو سائقين نشطين');
    }
  }

  /** The rent agreed with the bus's office for this route, or null when there is no contract price. */
  private async contractRent(db: Prisma.TransactionClient, busId: string | null | undefined, origin: string, destination: string) {
    if (!busId) return null;
    const rate = await db.busOfficeRate.findFirst({
      where: { origin: origin.trim(), destination: destination.trim(), office: { buses: { some: { id: busId } } } },
      select: { price: true },
    });
    return rate?.price ?? null;
  }

  private async assertNoScheduleConflict(
    db: Prisma.TransactionClient,
    window: { busId?: string | null; driverIds: string[]; supervisorIds: string[]; start: Date; end: Date; excludeTripIds?: string[]; leaveCheckIds?: string[] },
  ) {
    const people = [...window.driverIds, ...window.supervisorIds];
    const resources: Prisma.TripWhereInput[] = [];
    if (window.busId) resources.push({ busId: window.busId });
    // A supervisor may look after several trips at once, but a driver is behind one wheel: whoever drives a trip at
    // that time cannot join another, and whoever is to drive this one cannot be on another trip.
    if (people.length > 0) resources.push({ drivers: { some: { userId: { in: people } } } });
    if (window.driverIds.length > 0) resources.push({ supervisors: { some: { userId: { in: window.driverIds } } } });
    if (resources.length === 0) return;

    const clash = await db.trip.findFirst({
      where: {
        id: window.excludeTripIds?.length ? { notIn: window.excludeTripIds } : undefined,
        tripStatus: { in: ['DRAFT', 'PUBLISHED'] },
        departureTime: { lt: window.end },
        arrivalTime: { gt: window.start },
        OR: resources,
      },
      select: { tripCode: true },
    });
    if (clash) {
      throw new ConflictException(`الحافلة أو الطاقم مسند لرحلة أخرى في نفس الوقت (${clash.tripCode})`);
    }

    // Approved leave counts in Riyadh calendar days, so any day the trip touches is a day the person must be at work.
    const checkLeave = window.leaveCheckIds ?? people;
    if (checkLeave.length > 0) {
      const away = await db.leaveRequest.findFirst({
        where: { userId: { in: checkLeave }, status: 'APPROVED', startDate: { lte: new Date(`${riyadhDate(window.end)}T00:00:00.000Z`) }, endDate: { gte: new Date(`${riyadhDate(window.start)}T00:00:00.000Z`) } },
        select: { user: { select: { name: true } }, startDate: true, endDate: true },
      });
      if (away) {
        const range = `${away.startDate.toISOString().slice(0, 10)} إلى ${away.endDate.toISOString().slice(0, 10)}`;
        throw new ConflictException(`${away.user.name ?? 'أحد الطاقم'} في إجازة معتمدة من ${range}، اختر غيره أو عدّل إجازته`);
      }
    }
  }

  private async resolveBus(db: Prisma.TransactionClient, busId?: string | null) {
    if (!busId) return null;
    const bus = await db.bus.findUnique({ where: { id: busId } });
    if (!bus) throw new BadRequestException('الحافلة المحددة غير موجودة');
    if (bus.status !== 'ACTIVE') throw new ConflictException('الحافلة المحددة غير متاحة للتشغيل');
    return bus;
  }

  private assertReverseSettings(
    settings: { enabled: boolean; departureAt?: Date | null; price?: number | Prisma.Decimal | null },
    outbound: OutboundTimes,
  ) {
    if (!settings.enabled) return;
    if (!settings.departureAt) {
      throw new BadRequestException('حدد موعد انطلاق الرحلة العكسية');
    }
    this.assertReverseAfterOutbound(settings.departureAt, outbound);
  }

  /** The bus cannot start back before it has arrived. */
  private assertReverseAfterOutbound(reverseDeparture: Date, outbound: OutboundTimes) {
    if (reverseDeparture <= reachesDestinationAt(outbound)) {
      throw new BadRequestException('موعد الرحلة العكسية يجب أن يكون بعد وصول رحلة الذهاب');
    }
  }

  /** Stores photos by their own bytes, refusing the whole upload if any file is not an image. */
  async saveImages(uploadedById: string, files: UploadedImage[] = []) {
    if (files.length === 0) throw new BadRequestException('اختر صورة واحدة على الأقل');
    const rows = files.map((file) => {
      const mimeType = imageTypeOf(file.buffer);
      if (!mimeType) throw new BadRequestException('الصور المقبولة: JPG أو PNG أو WEBP');
      return { mimeType, size: file.size, data: file.buffer, uploadedById };
    });
    const saved = await this.prisma.$transaction(rows.map((data) => this.prisma.publicImage.create({ data, select: { id: true } })));
    return saved.map(({ id }) => ({ url: `/trips/images/${id}` }));
  }

  async getImage(id: string) {
    const image = await this.prisma.publicImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image not found');
    return image;
  }

  private assertEstimatedArrival(estimate: Date | null, departure: Date, arrival: Date) {
    if (!estimate) return;
    if (estimate <= departure) throw new BadRequestException('وقت الوصول المتوقع يجب أن يكون بعد وقت الانطلاق');
    if (estimate > arrival) throw new BadRequestException('وقت الوصول المتوقع يجب ألا يتجاوز موعد العودة');
  }

  /**
   * Writes who joined and who left a trip's crew in one change, with who made it. The crew tables only hold who is on
   * a trip now; this is the history behind them.
   */
  private async logCrew(
    tx: Prisma.TransactionClient,
    tripId: string,
    before: { drivers: string[]; supervisors: string[] },
    after: { drivers: string[]; supervisors: string[] },
    actor?: CrewActor,
    reason?: string,
  ) {
    const rows: Prisma.CrewAssignmentLogCreateManyInput[] = [];
    const by = { byId: actor?.userId ?? null, byName: actor?.name ?? null, reason: reason ?? null };
    for (const [role, was, now] of [['DRIVER', before.drivers, after.drivers], ['SUPERVISOR', before.supervisors, after.supervisors]] as const) {
      for (const userId of now.filter((id) => !was.includes(id))) rows.push({ tripId, userId, role, action: 'ASSIGNED', ...by });
      for (const userId of was.filter((id) => !now.includes(id))) rows.push({ tripId, userId, role, action: 'UNASSIGNED', ...by });
    }
    if (rows.length) await tx.crewAssignmentLog.createMany({ data: rows });
  }

  async createTrip(dto: CreateTripDto, actor?: CrewActor) {
    const departure = new Date(dto.departureTime);
    const estimatedArrivalAt = dto.estimatedArrivalAt ? new Date(dto.estimatedArrivalAt) : null;
    // A one-way trip is over when the bus gets there, so the bus and crew are not held for longer.
    const arrival = dto.arrivalTime ? new Date(dto.arrivalTime) : estimatedArrivalAt ?? new Date(departure.getTime() + DEFAULT_TRIP_DURATION_MS);
    if (arrival <= departure) {
      throw new BadRequestException('وقت الوصول يجب أن يكون بعد وقت الانطلاق');
    }
    this.assertEstimatedArrival(estimatedArrivalAt, departure, arrival);
    if (dto.tripStatus && !['DRAFT', 'PUBLISHED'].includes(dto.tripStatus)) {
      throw new BadRequestException('تُنشأ الرحلة مسودة أو منشورة فقط');
    }
    if (dto.tripStatus === 'PUBLISHED' && departure <= new Date()) {
      throw new BadRequestException('لا يمكن نشر رحلة موعدها في الماضي');
    }
    if (dto.tripStatus === 'PUBLISHED' && !dto.boardingPoints?.length) {
      throw new BadRequestException('أضف نقطة صعود واحدة على الأقل قبل نشر الرحلة');
    }
    if (dto.origin.trim() === dto.destination.trim()) {
      throw new BadRequestException('نقطة الانطلاق والوجهة يجب أن تكونا مختلفتين');
    }
    const reverseDepartureAt = dto.reverseDepartureAt ? new Date(dto.reverseDepartureAt) : null;
    this.assertReverseSettings(
      { enabled: !!dto.reverseEnabled, departureAt: reverseDepartureAt, price: dto.reversePrice },
      { direction: dto.direction ?? 'ONE_WAY', departureTime: departure, arrivalTime: arrival, estimatedArrivalAt },
    );
    this.assertHousingTerms(dto.bookingType ?? 'TRANSPORT_ONLY', {
      housingPrice: dto.housingPrice ?? null,
      privateRoomPrice: dto.privateRoomPrice ?? null,
      privateRoomCapacity: dto.privateRoomCapacity ?? null,
      housingPriceMode: dto.housingPriceMode ?? 'INCLUDED_IN_BASE',
      privateRoomPriceBasis: dto.privateRoomPriceBasis ?? 'PER_ROOM',
      housingPricePeriod: dto.housingPricePeriod ?? 'PER_STAY',
    });
    const windowDefaults = await this.appSettings.numbers('defaultCrewOpensBeforeMinutes', 'defaultBoardingOpensBeforeMinutes', 'defaultBoardingClosesAfterMinutes');
    const crewWindowSettings = {
      crewOpensBeforeMinutes: dto.crewOpensBeforeMinutes ?? windowDefaults.defaultCrewOpensBeforeMinutes,
      boardingOpensBeforeMinutes: dto.boardingOpensBeforeMinutes ?? windowDefaults.defaultBoardingOpensBeforeMinutes,
      boardingClosesAfterMinutes: dto.boardingClosesAfterMinutes ?? windowDefaults.defaultBoardingClosesAfterMinutes,
      unpaidBoarding: dto.unpaidBoarding ?? 'BLOCK',
    };
    this.assertCrewWindowSettings(crewWindowSettings);
    const schedule = this.resolveSchedule({
      scheduleType: dto.scheduleType ?? 'TEMPORARY',
      calendar: dto.recurrenceCalendar,
      weekdays: dto.repeatWeekdays,
      until: dto.repeatUntil ? new Date(dto.repeatUntil) : null,
      departure,
    });
    const bookingOpensAt = this.resolveBookingOpensAt(dto.bookingOpensAt, departure);
    // The first trip of a weekly schedule names the series, so it can be found from any of its copies.
    const id = randomUUID();
    const seriesId = schedule.repeatWeekdays.length ? id : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const bus = await this.resolveBus(tx, dto.busId);
      const layout = seatLayoutFor(bus);
      const seatNumbers = seatNumbersOf(layout);
      const pkg = dto.packageId ? await assertTripFitsPackage(tx, dto.packageId, departure) : null;
      // A stay with no nights given lasts as long as the package it is sold under.
      const accommodation = dto.accommodation && { ...dto.accommodation, nights: dto.accommodation.nights ?? pkg?.nights ?? undefined };
      await this.assertAssignableStaff(tx, [...(dto.driverIds ?? []), ...(dto.supervisorIds ?? [])]);
      await this.assertNoScheduleConflict(tx, {
        busId: dto.busId,
        driverIds: dto.driverIds ?? [],
        supervisorIds: dto.supervisorIds ?? [],
        start: departure,
        end: arrival,
      });


      const pickedServices = [...new Set(dto.serviceIds ?? [])];
      const serviceRows = [
        ...pickedServices.map((serviceId) => ({ serviceId })),
        ...(await busServiceRows(tx, dto.busId)).filter((row) => !pickedServices.includes(row.serviceId)),
      ];

      const trip = await tx.trip.create({
        data: {
          id,
          seriesId,
          // The number is the system's: the month's next one, whatever the form showed.
          ...(await assignTripCode(tx, departure)),
          title: dto.title || 'رحلة عمرة',
          origin: dto.origin,
          destination: dto.destination,
          departureStation: dto.departureStation?.trim() || null,
          departureTime: departure,
          arrivalTime: arrival,
          estimatedArrivalAt,
          hijriDate: dto.hijriDate || toHijriLabel(departure),
          busType: dto.busType || 'VIP 2+1',
          price: dto.price,
          totalSeats: seatNumbers.length,
          availableSeats: seatNumbers.length,
          seatLayout: storedSeatLayout(layout),
          maxSeatsPerBooking: dto.maxSeatsPerBooking ?? 5,
          ...crewWindowSettings,
          miqat: dto.miqat === undefined ? 'ميقات قرن المنازل' : dto.miqat.trim(),
          tripStatus: dto.tripStatus || 'DRAFT',
          ...schedule,
          direction: dto.direction || 'ONE_WAY',
          bookingType: dto.bookingType || 'TRANSPORT_ONLY',
          busId: dto.busId || null,
          packageId: dto.packageId || null,
          busRentalPrice: dto.busRentalPrice ?? (await this.contractRent(tx, dto.busId, dto.origin, dto.destination)),
          housingPrice: dto.housingPrice ?? null,
          privateRoomPrice: dto.privateRoomPrice ?? null,
          privateRoomCapacity: dto.privateRoomCapacity ?? null,
          sharedRoomCapacity: dto.sharedRoomCapacity,
          alertLeadMinutes: dto.alertLeadMinutes,
          alertRepeatMinutes: dto.alertRepeatMinutes,
          housingPriceMode: dto.housingPriceMode,
          privateRoomPriceBasis: dto.privateRoomPriceBasis,
          housingPricePeriod: dto.housingPricePeriod,
          reverseEnabled: !!dto.reverseEnabled,
          reverseOpenPercent: dto.reverseOpenPercent ?? 80,
          reverseDepartureAt,
          // Coming back only costs the ticket's base price unless the office sets another.
          reversePrice: dto.reverseEnabled ? dto.reversePrice ?? dto.price : dto.reversePrice ?? null,
          channelApp: dto.channelApp ?? true,
          channelBranch: dto.channelBranch ?? true,
          bookingOpensAt,
          seats: {
            createMany: { data: seatNumbers.map((seatNumber) => ({ seatNumber })) },
          },
          images: dto.images?.length ? { create: dto.images.map((url) => ({ url })) } : undefined,
          boardingPoints: dto.boardingPoints?.length
            ? { create: dto.boardingPoints.map((bp) => this.toBoardingPoint(bp)) }
            : undefined,
          itineraryStops: dto.itineraryStops?.length
            ? { create: dto.itineraryStops.map((st, idx) => this.toItineraryStop(st, idx)) }
            : undefined,
          services: serviceRows.length ? { create: serviceRows } : undefined,
          visits: dto.visits?.length ? { create: dto.visits.map((v, idx) => this.toVisit(v, idx)) } : undefined,
          accommodations: accommodation ? { create: this.toAccommodation(accommodation) } : undefined,
          drivers: dto.driverIds?.length
            ? { create: dto.driverIds.map((userId, idx) => ({ userId, isPrimary: idx === 0 })) }
            : undefined,
          supervisors: dto.supervisorIds?.length
            ? { create: dto.supervisorIds.map((userId, idx) => ({ userId, isPrimary: idx === 0 })) }
            : undefined,
        },
        include: ADMIN_TRIP_INCLUDE,
      });
      if (accommodation?.hotelId && includesHousing(trip.bookingType)) {
        await this.rooms.openForTrip(tx, trip, accommodation.hotelId, accommodation.nights ?? 1);
      }
      await this.logCrew(tx, trip.id, { drivers: [], supervisors: [] }, { drivers: dto.driverIds ?? [], supervisors: dto.supervisorIds ?? [] }, actor);
      // Crew only see published trips, so a draft is announced when it is published.
      if (trip.tripStatus === 'PUBLISHED') await this.notifications.toTripCrew(tx, 'CREW_TRIP_ASSIGNED', trip.id);
      return withSeatPrice(trip);
    }, TRIP_TX_OPTIONS);
    if (seriesId) this.extendSeriesLater(seriesId);
    const reverseTrip = created.tripStatus === 'PUBLISHED' && created.reverseEnabled ? await this.autoOpenReverse(created.id) : null;
    return { ...created, ...(reverseTrip && { reverseTrip }), seriesDrafting: !!seriesId };
  }

  /**
   * A year of weekly trips takes a while to copy, so the response does not wait for it. If the server stops halfway,
   * the sweep finishes the series.
   */
  private extendSeriesLater(seriesId: string) {
    this.extendSeries(seriesId).catch((err) => console.error(`Could not draft weekly trips ${seriesId}:`, err.message));
  }

  private toBoardingPoint(bp: CreateTripDto['boardingPoints'][number]) {
    return { name: bp.name, time: bp.time, address: bp.address || '', lat: bp.lat ?? null, lng: bp.lng ?? null };
  }

  private toItineraryStop(st: CreateTripDto['itineraryStops'][number], sortOrder: number) {
    return { title: st.title, time: st.time, desc: st.desc || '', kind: st.kind ?? 'STOP', sortOrder };
  }

  private toVisit(v: CreateTripDto['visits'][number], sortOrder: number) {
    return {
      title: v.title,
      desc: v.desc || '',
      imageUrl: v.imageUrl || null,
      lat: v.lat ?? null,
      lng: v.lng ?? null,
      visitDate: v.visitDate ? new Date(v.visitDate) : null,
      expectedTime: v.expectedTime || null,
      duration: v.duration || null,
      sortOrder,
    };
  }

  private assertHousingTerms(bookingType: string, terms: HousingTerms) {
    if (!includesHousing(bookingType)) return;
    if (terms.housingPriceMode === 'ADDED_TO_BASE' && terms.housingPrice === null && terms.privateRoomPrice === null) {
      throw new BadRequestException('أدخل سعر السكن، لأنه يضاف إلى السعر الأساسي');
    }
  }

  private toAccommodation(a: CreateTripDto['accommodation']) {
    return {
      nights: a.nights ?? 1,
      name: a.name,
      details: a.details || '',
      checkInDate: a.checkInDate ? new Date(a.checkInDate) : null,
      checkOutDate: a.checkOutDate ? new Date(a.checkOutDate) : null,
    };
  }

  /**
   * The only status moves an edit may make. Cancelling has its own action that handles the bookings, and the sweep
   * completes trips on its own once they arrive; an employee may complete one early, but only after it has left.
   */
  private async assertStatusChange(
    existing: { tripStatus: string; departureTime: Date; _count: { boardingPoints: number } },
    dto: UpdateTripDto,
    now: Date,
    hasSales: () => Promise<boolean>,
  ) {
    const from = existing.tripStatus;
    const to = dto.tripStatus ?? from;
    const pointsAfter = dto.boardingPoints ? dto.boardingPoints.length : existing._count.boardingPoints;
    if (to === 'PUBLISHED' && pointsAfter === 0 && (from !== 'PUBLISHED' || dto.boardingPoints)) {
      throw new BadRequestException('أضف نقطة صعود واحدة على الأقل قبل نشر الرحلة');
    }
    if (to === from) return;
    if (from === 'COMPLETED') throw new ConflictException('لا يمكن تغيير حالة رحلة مكتملة');
    if (from === 'DRAFT' && to === 'PUBLISHED') return;
    if (from === 'PUBLISHED' && to === 'DRAFT') {
      if (await hasSales()) throw new ConflictException('لا يمكن إرجاع رحلة لها حجوزات إلى مسودة. ألغِ الرحلة أو أغلق قنوات الحجز بدلًا من ذلك');
      return;
    }
    if (from === 'PUBLISHED' && to === 'COMPLETED') {
      if (existing.departureTime > now) throw new ConflictException('لا يمكن إكمال رحلة قبل انطلاقها');
      return;
    }
    throw new BadRequestException('لا يمكن نقل الرحلة إلى هذه الحالة');
  }

  async updateTrip(id: string, dto: UpdateTripDto, actor?: CrewActor, reason?: string) {
    if (dto.tripStatus === 'CANCELLED') {
      throw new BadRequestException('استخدم إجراء إلغاء الرحلة حتى تُعالج حجوزاتها');
    }

    let startsSeries = false;
    const result = await this.prisma.$transaction(async (tx) => {
      // Bookings take this lock too, so none can be sold between the checks below and the save.
      await lockTripsWithLinked(tx, [id]);
      const existing = await tx.trip.findUnique({
        where: { id },
        include: {
          drivers: true,
          supervisors: true,
          accommodations: true,
          reverseTrip: { include: { drivers: true, supervisors: true } },
          reverseOf: { select: { direction: true, departureTime: true, arrivalTime: true, estimatedArrivalAt: true } },
          _count: { select: { boardingPoints: true } },
        },
      });
      if (!existing) throw new NotFoundException('Trip not found');
      if (existing.tripStatus === 'CANCELLED') {
        throw new ConflictException('لا يمكن تعديل رحلة ملغاة');
      }
      // A cancelled reverse sells nothing, so the outbound is free again: its direction can be corrected and the reverse opened anew.
      const openReverse = existing.reverseTrip && existing.reverseTrip.tripStatus !== 'CANCELLED' ? existing.reverseTrip : null;
      const now = new Date();
      let soldCount: number | undefined;
      const hasSales = async () => (soldCount ??= await tx.booking.count({ where: { tripId: id, status: { not: 'CANCELLED' } } })) > 0;
      await this.assertStatusChange(existing, dto, now, hasSales);
      // What was sold depends on these: a stay that was or was not included, and whether the seats are held for the way back.
      if (dto.bookingType && includesHousing(dto.bookingType) !== includesHousing(existing.bookingType) && (await hasSales())) {
        throw new ConflictException('لا يمكن تغيير نوع الحجز بين سكن وبدون سكن بعد بيع مقاعد في الرحلة');
      }
      if (dto.direction && dto.direction !== existing.direction && (await hasSales())) {
        throw new ConflictException('لا يمكن تغيير اتجاه الرحلة بعد بيع مقاعد فيها');
      }
      // A reverse trip is edited like any other, its bus too. Its seats are linked to the outbound's, so applySeatLayout below
      // still refuses a vehicle with a different seat plan; and once it has its own bus, changes to the outbound's bus no longer reach it.
      // The direction decides whether the two trips share seats, and sales already made depend on that.
      if (openReverse && dto.direction && dto.direction !== existing.direction) {
        throw new ConflictException('لا يمكن تغيير اتجاه رحلة لها رحلة عكسية مفتوحة. ألغِ الرحلة العكسية أولًا ثم غيّر الاتجاه وأعد فتحها');
      }
      if (existing.reverseOfTripId && dto.scheduleType === 'FIXED') {
        throw new BadRequestException('الرحلة العكسية لا يمكن أن تكون ثابتة، فهي تتبع رحلة الذهاب');
      }
      if (existing.reverseOfTripId && dto.repeatWeekdays?.length) {
        throw new BadRequestException('الرحلة العكسية لا تتكرر، فهي تتبع رحلة الذهاب');
      }

      const departure = dto.departureTime ? new Date(dto.departureTime) : existing.departureTime;
      const scheduleTouched = [dto.scheduleType, dto.recurrenceCalendar, dto.repeatWeekdays, dto.repeatUntil].some((value) => value !== undefined);
      const schedule: Partial<Schedule> & { seriesId?: string } = scheduleTouched
        ? this.resolveSchedule({
            scheduleType: dto.scheduleType ?? existing.scheduleType,
            calendar: dto.recurrenceCalendar ?? existing.recurrenceCalendar,
            weekdays: dto.repeatWeekdays ?? existing.repeatWeekdays,
            until: dto.repeatUntil === undefined ? existing.repeatUntil : dto.repeatUntil ? new Date(dto.repeatUntil) : null,
            departure,
          })
        : {};
      // A one-off trip made weekly starts its own series; a trip already in one stays in it.
      if (schedule.repeatWeekdays?.length && !existing.seriesId) {
        schedule.seriesId = id;
        startsSeries = true;
      }
      // A new departure with no new arrival keeps the trip's length, so moving a trip later needs only one date.
      const arrival = dto.arrivalTime
        ? new Date(dto.arrivalTime)
        : new Date(existing.arrivalTime.getTime() + departure.getTime() - existing.departureTime.getTime());
      if (arrival <= departure) {
        throw new BadRequestException('وقت الوصول يجب أن يكون بعد وقت الانطلاق');
      }
      // Like the arrival, a moved departure carries the expected arrival along unless a new one was given.
      const estimatedArrivalAt = dto.estimatedArrivalAt !== undefined
        ? (dto.estimatedArrivalAt ? new Date(dto.estimatedArrivalAt) : null)
        : existing.estimatedArrivalAt && new Date(existing.estimatedArrivalAt.getTime() + departure.getTime() - existing.departureTime.getTime());
      this.assertEstimatedArrival(estimatedArrivalAt, departure, arrival);
      const nextStatus = dto.tripStatus ?? existing.tripStatus;
      // Only publishing or moving a trip into the past is refused. A trip already under way can still get a replacement bus or crew.
      const departureMoved = departure.getTime() !== existing.departureTime.getTime();
      if (nextStatus === 'PUBLISHED' && departure <= now && (existing.tripStatus !== 'PUBLISHED' || departureMoved)) {
        throw new BadRequestException('لا يمكن نشر رحلة موعدها في الماضي');
      }
      if (existing.reverseOf && departureMoved) this.assertReverseAfterOutbound(departure, existing.reverseOf);
      const bookingOpensAt =
        dto.bookingOpensAt !== undefined || departureMoved
          ? this.resolveBookingOpensAt(dto.bookingOpensAt === undefined ? existing.bookingOpensAt?.toISOString() : dto.bookingOpensAt, departure)
          : undefined;
      const crewWindowSettings = {
        crewOpensBeforeMinutes: dto.crewOpensBeforeMinutes ?? existing.crewOpensBeforeMinutes,
        boardingOpensBeforeMinutes: dto.boardingOpensBeforeMinutes ?? existing.boardingOpensBeforeMinutes,
        boardingClosesAfterMinutes: dto.boardingClosesAfterMinutes ?? existing.boardingClosesAfterMinutes,
        unpaidBoarding: dto.unpaidBoarding ?? existing.unpaidBoarding,
      };
      this.assertCrewWindowSettings(crewWindowSettings);
      // New times mean new moments, so the crew hears about them again.
      const crewWindowMoved =
        departure.getTime() !== existing.departureTime.getTime() ||
        crewWindowSettings.crewOpensBeforeMinutes !== existing.crewOpensBeforeMinutes ||
        crewWindowSettings.boardingOpensBeforeMinutes !== existing.boardingOpensBeforeMinutes ||
        crewWindowSettings.boardingClosesAfterMinutes !== existing.boardingClosesAfterMinutes;

      const packageId = dto.packageId !== undefined ? dto.packageId || null : existing.packageId;
      if (packageId && (packageId !== existing.packageId || departureMoved)) await assertTripFitsPackage(tx, packageId, departure);

      const busId = dto.busId !== undefined ? dto.busId || null : existing.busId;
      const bus = dto.busId !== undefined ? await this.resolveBus(tx, busId) : null;
      // The bus may arrive after the trip went on sale, so what it allows is checked against who already booked.
      if (busId !== existing.busId) await assertSinglesFitRange(tx, { id }, await this.appSettings.singlesRange(busId));
      // A van or minibus brings its own seats. Taking the vehicle off leaves the seats as they are until another is chosen.
      if (bus && busId !== existing.busId) await applySeatLayout(tx, id, seatLayoutFor(bus));
      const driverIds = dto.driverIds ?? existing.drivers.map((d) => d.userId);
      const supervisorIds = dto.supervisorIds ?? existing.supervisors.map((s) => s.userId);
      // Only people joining the crew now are checked: someone already on it who was since suspended, or was approved
      // leave knowing of the trip, must not stop every later edit of it.
      const current = new Set([...existing.drivers, ...existing.supervisors].map((member) => member.userId));
      const added = [...(dto.driverIds ?? []), ...(dto.supervisorIds ?? [])].filter((userId) => !current.has(userId));
      await this.assertAssignableStaff(tx, added);
      // A trip and its reverse share the bus and crew by design, so they never clash with each other.
      const excludeTripIds = [id, existing.reverseOfTripId, existing.reverseTrip?.id].filter(Boolean);
      await this.assertNoScheduleConflict(tx, { busId, driverIds, supervisorIds, start: departure, end: arrival, excludeTripIds, leaveCheckIds: added });

      const reverseEnabled = dto.reverseEnabled ?? existing.reverseEnabled;
      const outboundAfter = { direction: dto.direction ?? existing.direction, departureTime: departure, arrivalTime: arrival, estimatedArrivalAt };
      const moved = departure.getTime() - existing.departureTime.getTime();
      // Moving the outbound carries the way back along with it, unless a new time for it was given.
      const reverseDepartureAt = dto.reverseDepartureAt
        ? new Date(dto.reverseDepartureAt)
        : existing.reverseDepartureAt && new Date(existing.reverseDepartureAt.getTime() + moved);
      if (!openReverse) {
        this.assertReverseSettings(
          { enabled: reverseEnabled, departureAt: reverseDepartureAt, price: dto.reversePrice ?? existing.reversePrice },
          outboundAfter,
        );
      }

      this.assertHousingTerms(dto.bookingType ?? existing.bookingType, {
        housingPrice: dto.housingPrice === undefined ? existing.housingPrice : dto.housingPrice,
        privateRoomPrice: dto.privateRoomPrice === undefined ? existing.privateRoomPrice : dto.privateRoomPrice,
        privateRoomCapacity: dto.privateRoomCapacity === undefined ? existing.privateRoomCapacity : dto.privateRoomCapacity,
        housingPriceMode: dto.housingPriceMode ?? existing.housingPriceMode,
        privateRoomPriceBasis: dto.privateRoomPriceBasis ?? existing.privateRoomPriceBasis,
        housingPricePeriod: dto.housingPricePeriod ?? existing.housingPricePeriod,
      });


      await tx.trip.update({
        where: { id },
        data: {
          title: dto.title,
          origin: dto.origin,
          destination: dto.destination,
          departureStation: dto.departureStation === undefined ? undefined : dto.departureStation?.trim() || null,
          departureTime: departure,
          arrivalTime: arrival,
          estimatedArrivalAt,
          ...schedule,
          hijriDate: dto.hijriDate ?? (dto.departureTime ? toHijriLabel(departure) : undefined),
          busType: dto.busType,
          price: dto.price,
          maxSeatsPerBooking: dto.maxSeatsPerBooking,
          ...crewWindowSettings,
          ...(crewWindowMoved && { crewOpenAnnouncedAt: null, boardingOpenAnnouncedAt: null, boardingCloseAnnouncedAt: null }),
          miqat: dto.miqat?.trim(),
          tripStatus: dto.tripStatus,
          direction: dto.direction,
          bookingType: dto.bookingType,
          busId: dto.busId !== undefined ? busId : undefined,
          packageId: dto.packageId !== undefined ? dto.packageId || null : undefined,
          // An empty price picks up the contract when a bus is first chosen; a price already set is never overwritten.
          busRentalPrice:
            dto.busRentalPrice ??
            (dto.busId !== undefined && existing.busRentalPrice === null
              ? (await this.contractRent(tx, busId, dto.origin ?? existing.origin, dto.destination ?? existing.destination)) ?? undefined
              : undefined),
          housingPrice: dto.housingPrice,
          privateRoomPrice: dto.privateRoomPrice,
          privateRoomCapacity: dto.privateRoomCapacity,
          sharedRoomCapacity: dto.sharedRoomCapacity,
          alertLeadMinutes: dto.alertLeadMinutes,
          alertRepeatMinutes: dto.alertRepeatMinutes,
          housingPriceMode: dto.housingPriceMode,
          privateRoomPriceBasis: dto.privateRoomPriceBasis,
          housingPricePeriod: dto.housingPricePeriod,
          reverseEnabled: dto.reverseEnabled,
          reverseOpenPercent: dto.reverseOpenPercent,
          reverseDepartureAt: reverseDepartureAt ?? undefined,
          reversePrice: dto.reversePrice,
          channelApp: dto.channelApp,
          channelBranch: dto.channelBranch,
          bookingOpensAt,
        },
      });

      // The admin's new capacity also governs shared rooms already in use, or the supervisor would stay refused at the old one.
      if (dto.sharedRoomCapacity !== undefined && dto.sharedRoomCapacity !== existing.sharedRoomCapacity) {
        await tx.hotelRoom.updateMany({ where: { type: 'SHARED', hotelBooking: { tripId: id } }, data: { capacity: dto.sharedRoomCapacity } });
      }

      if (dto.boardingPoints) {
        // Recreating the points must not make the crew lose where the bus is standing, or every ticket would start warning.
        const standing = await tx.trip.findUnique({ where: { id }, select: { currentBoardingPoint: { select: { name: true } } } });
        await tx.boardingPoint.deleteMany({ where: { tripId: id } });
        await tx.boardingPoint.createMany({ data: dto.boardingPoints.map((bp) => ({ tripId: id, ...this.toBoardingPoint(bp) })) });
        if (standing?.currentBoardingPoint) {
          const same = await tx.boardingPoint.findFirst({ where: { tripId: id, name: standing.currentBoardingPoint.name } });
          if (same) await tx.trip.update({ where: { id }, data: { currentBoardingPointId: same.id } });
        }
      }
      if (dto.itineraryStops) {
        await tx.itineraryStop.deleteMany({ where: { tripId: id } });
        await tx.itineraryStop.createMany({
          data: dto.itineraryStops.map((st, idx) => ({ tripId: id, ...this.toItineraryStop(st, idx) })),
        });
      }
      if (dto.images) {
        await tx.tripImage.deleteMany({ where: { tripId: id } });
        await tx.tripImage.createMany({ data: dto.images.map((url) => ({ tripId: id, url })) });
      }
      if (busId !== existing.busId) await applyBusServices(tx, id, busId);
      if (dto.serviceIds) {
        // What the bus provides is not the editor's to remove, so only hand-picked services are replaced.
        await tx.tripService.deleteMany({ where: { tripId: id, fromBus: false } });
        await tx.tripService.createMany({ data: dto.serviceIds.map((serviceId) => ({ tripId: id, serviceId })), skipDuplicates: true });
      }
      if (dto.visits) {
        await tx.tripVisit.deleteMany({ where: { tripId: id } });
        await tx.tripVisit.createMany({ data: dto.visits.map((v, idx) => ({ tripId: id, ...this.toVisit(v, idx) })) });
      }
      if (dto.accommodation) {
        await tx.accommodation.deleteMany({ where: { tripId: id } });
        await tx.accommodation.create({ data: { tripId: id, ...this.toAccommodation(dto.accommodation) } });
      }
      await this.syncHotelStay(tx, existing, {
        bookingType: dto.bookingType ?? existing.bookingType,
        departure,
        accommodation: dto.accommodation,
      });
      if (dto.driverIds) {
        await tx.tripDriver.deleteMany({ where: { tripId: id } });
        await tx.tripDriver.createMany({ data: dto.driverIds.map((userId, idx) => ({ tripId: id, userId, isPrimary: idx === 0 })) });
      }
      if (dto.supervisorIds) {
        await tx.tripSupervisor.deleteMany({ where: { tripId: id } });
        await tx.tripSupervisor.createMany({
          data: dto.supervisorIds.map((userId, idx) => ({ tripId: id, userId, isPrimary: idx === 0 })),
        });
      }

      await this.logCrew(
        tx,
        id,
        { drivers: existing.drivers.map((row) => row.userId), supervisors: existing.supervisors.map((row) => row.userId) },
        { drivers: driverIds, supervisors: supervisorIds },
        actor,
        reason,
      );
      await this.notifyTripChanges(tx, existing, { nextStatus, crewIds: [...driverIds, ...supervisorIds] });

      if (openReverse?.tripStatus === 'PUBLISHED' && existing.tripStatus === 'PUBLISHED' && openReverse.departureTime > now) {
        await this.carryOverToReverse(tx, existing, openReverse, { outboundAfter, moved, busId, driverIds, supervisorIds }, actor);
      }

      const updated = await tx.trip.findUniqueOrThrow({ where: { id }, include: ADMIN_TRIP_INCLUDE });
      return withSeatPrice(updated);
    }, TRIP_TX_OPTIONS);
    if (startsSeries) this.extendSeriesLater(id);
    // Publishing the way there opens the way back with it; see openPendingReverses.
    const opensReverse =
      result.tripStatus === 'PUBLISHED' && result.reverseEnabled && !result.reverseOfTripId && !result.reverseTrip && !!result.reverseDepartureAt && result.reverseDepartureAt > new Date();
    const reverseTrip = opensReverse ? await this.autoOpenReverse(id) : null;
    return { ...result, ...(reverseTrip && { reverseTrip }), seriesDrafting: startsSeries };
  }

  /**
   * An open reverse runs on the outbound's bus, so what changes there changes here too: the time moves by the same amount,
   * and the bus and crew follow unless someone picked their own for the way back.
   */
  private async carryOverToReverse(
    tx: Prisma.TransactionClient,
    outbound: { id: string; busId: string | null; drivers: { userId: string }[]; supervisors: { userId: string }[] },
    reverse: Prisma.TripGetPayload<{ include: { drivers: true; supervisors: true } }>,
    change: {
      outboundAfter: OutboundTimes;
      moved: number;
      busId: string | null;
      driverIds: string[];
      supervisorIds: string[];
    },
    actor?: CrewActor,
  ) {
    const departure = new Date(reverse.departureTime.getTime() + change.moved);
    const arrival = new Date(reverse.arrivalTime.getTime() + change.moved);
    const estimatedArrivalAt = reverse.estimatedArrivalAt && new Date(reverse.estimatedArrivalAt.getTime() + change.moved);
    this.assertReverseAfterOutbound(departure, change.outboundAfter);

    const followsCrew =
      sameMembers(reverse.drivers.map((d) => d.userId), outbound.drivers.map((d) => d.userId)) &&
      sameMembers(reverse.supervisors.map((s) => s.userId), outbound.supervisors.map((s) => s.userId));
    const driverIds = followsCrew ? change.driverIds : reverse.drivers.map((d) => d.userId);
    const supervisorIds = followsCrew ? change.supervisorIds : reverse.supervisors.map((s) => s.userId);
    // A way back already moved to its own bus stays on it, like a crew picked for it.
    const busChanged = change.busId !== outbound.busId && reverse.busId === outbound.busId;
    const busId = busChanged ? change.busId : reverse.busId;
    if (busChanged) await assertSinglesFitRange(tx, { id: reverse.id }, await this.appSettings.singlesRange(busId));

    await this.assertNoScheduleConflict(tx, {
      busId,
      driverIds,
      supervisorIds,
      start: departure,
      end: arrival,
      excludeTripIds: [outbound.id, reverse.id],
    });

    const crewChanged = !sameMembers(driverIds, reverse.drivers.map((d) => d.userId)) || !sameMembers(supervisorIds, reverse.supervisors.map((s) => s.userId));
    await tx.trip.update({
      where: { id: reverse.id },
      data: {
        departureTime: departure,
        arrivalTime: arrival,
        estimatedArrivalAt,
        ...(change.moved !== 0 && { hijriDate: toHijriLabel(departure), crewOpenAnnouncedAt: null, boardingOpenAnnouncedAt: null, boardingCloseAnnouncedAt: null }),
        ...(busChanged && {
          busId: change.busId,
          busRentalPrice: reverse.busRentalPrice ?? (await this.contractRent(tx, change.busId, reverse.origin, reverse.destination)) ?? undefined,
        }),
      },
    });
    if (busChanged) await applyBusServices(tx, reverse.id, change.busId);
    if (crewChanged) {
      await tx.tripDriver.deleteMany({ where: { tripId: reverse.id } });
      await tx.tripDriver.createMany({ data: driverIds.map((userId, idx) => ({ tripId: reverse.id, userId, isPrimary: idx === 0 })) });
      await tx.tripSupervisor.deleteMany({ where: { tripId: reverse.id } });
      await tx.tripSupervisor.createMany({ data: supervisorIds.map((userId, idx) => ({ tripId: reverse.id, userId, isPrimary: idx === 0 })) });
      await this.logCrew(
        tx,
        reverse.id,
        { drivers: reverse.drivers.map((row) => row.userId), supervisors: reverse.supervisors.map((row) => row.userId) },
        { drivers: driverIds, supervisors: supervisorIds },
        actor,
        'تبعًا لطاقم رحلة الذهاب',
      );
    }
    await this.notifyTripChanges(tx, reverse, { nextStatus: 'PUBLISHED', crewIds: [...driverIds, ...supervisorIds] });
  }

  /** Keeps the trip's hotel stay in step with an edit. A stay with guests is never dropped: they have to be moved first. */
  private async syncHotelStay(
    tx: Prisma.TransactionClient,
    before: { id: string; departureTime: Date; accommodations: { nights: number }[] },
    after: { bookingType: string; departure: Date; accommodation?: UpdateTripDto['accommodation'] },
  ) {
    const stays = await tx.hotelBooking.findMany({
      where: { tripId: before.id, status: 'CONFIRMED' },
      orderBy: { number: 'asc' },
      include: { hotel: { select: { name: true } }, rooms: { select: { _count: { select: { occupants: true } } } } },
    });
    const release = async (stay: (typeof stays)[number], reason: string) => {
      if (stay.rooms.some((room) => room._count.occupants > 0)) {
        throw new ConflictException(`يوجد نزلاء في ${stay.hotel.name}، انقلهم من شاشة الفنادق أولًا`);
      }
      await tx.hotelRoom.deleteMany({ where: { hotelBookingId: stay.id } });
      await tx.hotelBooking.update({ where: { id: stay.id }, data: { status: 'CANCELLED', cancelReason: reason } });
    };

    if (!includesHousing(after.bookingType)) {
      for (const stay of stays) await release(stay, 'تعديل الرحلة إلى نوع بدون سكن');
      await tx.accommodation.deleteMany({ where: { tripId: before.id } });
      return;
    }

    const nights = after.accommodation?.nights ?? before.accommodations[0]?.nights ?? 1;
    const hotelId = after.accommodation?.hotelId;
    const main = stays[0];
    // Left out means the edit is not about the hotel; null means the trip no longer uses a contracted one.
    if (hotelId !== undefined && main?.hotelId !== hotelId) {
      if (main) await release(main, 'تغيير فندق الرحلة');
      if (hotelId && !stays.some((stay) => stay.hotelId === hotelId)) await this.rooms.openForTrip(tx, { id: before.id, departureTime: after.departure }, hotelId, nights);
    }

    const datesMoved = after.departure.getTime() !== before.departureTime.getTime() || nights !== (before.accommodations[0]?.nights ?? nights);
    const current = hotelId === undefined ? main : stays.find((stay) => stay.hotelId === hotelId);
    if (datesMoved && current) {
      await tx.hotelBooking.update({ where: { id: current.id }, data: this.rooms.stayDates(after.departure, nights) });
    }
  }

  /** Runs after the trip is saved, so the messages carry the new time and the new crew. */
  private async notifyTripChanges(
    tx: Prisma.TransactionClient,
    before: { id: string; tripStatus: string; departureTime: Date; reverseOfTripId: string | null; drivers: { userId: string }[]; supervisors: { userId: string }[] },
    after: { nextStatus: string; crewIds: string[] },
  ) {
    const wasLive = before.tripStatus === 'PUBLISHED';
    const isLive = after.nextStatus === 'PUBLISHED';
    const crewBefore = new Set([...before.drivers, ...before.supervisors].map((member) => member.userId));
    const crewAfter = [...new Set(after.crewIds)];

    const added = isLive ? crewAfter.filter((userId) => !wasLive || !crewBefore.has(userId)) : [];
    const removed = wasLive ? [...crewBefore].filter((userId) => !crewAfter.includes(userId)) : [];
    await this.notifications.toTripCrew(tx, 'CREW_TRIP_ASSIGNED', before.id, { userIds: added });
    await this.notifications.toTripCrew(tx, 'CREW_TRIP_UNASSIGNED', before.id, { userIds: removed });

    const current = await tx.trip.findUniqueOrThrow({ where: { id: before.id }, select: { departureTime: true, tripCode: true, origin: true, destination: true, hijriDate: true } });
    const { departureTime } = current;
    if (!wasLive || !isLive || departureTime.getTime() === before.departureTime.getTime()) return;

    const previous = { oldDepartureDate: formatRiyadhDate(before.departureTime), oldDepartureTime: formatRiyadhTime(before.departureTime) };
    const bookings = await tx.booking.findMany({
      where: { tripId: before.id, status: { in: ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] } },
      select: { id: true },
    });
    await this.notifications.toBookingOwners(tx, 'TRIP_TIME_CHANGED', bookings.map((booking) => booking.id), previous);
    // Passengers riding back hold outbound bookings, so they read this trip's route and time, not their booking's.
    if (before.reverseOfTripId) {
      await this.notifications.toBookingOwners(tx, 'TRIP_TIME_CHANGED', await returningBookingIds(tx, before.reverseOfTripId), { ...tripValues(current), ...previous });
    }
    // Someone just assigned already reads the new time in their assignment message.
    await this.notifications.toTripCrew(tx, 'CREW_TRIP_TIME_CHANGED', before.id, { userIds: crewAfter.filter((userId) => !added.includes(userId)), extra: previous });
  }

  async getReverseTrips(range: 'week' | 'month' | 'all' = 'all', actor?: RentActor) {
    const now = new Date();
    // An employee of a city's branch works with that city's trips, as on the trips page.
    const city = actor?.userId ? await servedCity(this.prisma, { userId: actor.userId, permissions: actor.permissions }) : null;
    const trips = await this.prisma.trip.findMany({
      where: {
        reverseEnabled: true,
        ...(city && { AND: [cityTripWhere(city)] }),
        OR: [
          { tripStatus: 'PUBLISHED', departureTime: { gt: now, ...(range !== 'all' && { lt: addDays(now, range === 'week' ? 7 : 30) }) } },
          // The outbound has left, but its way back is still ahead: selling, or still waiting to be opened.
          {
            tripStatus: { in: ['PUBLISHED', 'COMPLETED'] },
            departureTime: { lte: now },
            OR: [
              { reverseTrip: { tripStatus: 'PUBLISHED', departureTime: { gt: now } } },
              { reverseDepartureAt: { gt: now }, OR: [{ reverseTrip: null }, { reverseTrip: { tripStatus: 'CANCELLED' } }] },
            ],
          },
        ],
      },
      orderBy: { departureTime: 'asc' },
      include: {
        bus: { select: { plateNumber: true } },
        drivers: { where: { isPrimary: true }, select: { user: { select: { name: true } } } },
        itineraryStops: { orderBy: { sortOrder: 'asc' }, select: { title: true, time: true, kind: true } },
        reverseTrip: {
          include: {
            bus: { select: { plateNumber: true } },
            boardingPoints: { select: { name: true, time: true, address: true, lat: true, lng: true }, orderBy: { time: 'asc' } },
            itineraryStops: { orderBy: { sortOrder: 'asc' }, select: { title: true, time: true, kind: true } },
          },
        },
      },
    });

    const { seatsByTrip } = await goOnlyBookings(this.prisma, trips.map((trip) => trip.id));
    const booked = await bookedOnTrips(this.prisma, trips.flatMap((trip) => [trip.id, ...(trip.reverseTrip ? [trip.reverseTrip.id] : [])]));
    const returning = new Map(
      await Promise.all(trips.filter((trip) => trip.direction === 'ROUND_TRIP').map(async (trip) => {
        const bookingIds = await returningBookingIds(this.prisma, trip.id);
        return [trip.id, await this.prisma.bookingPassenger.count({ where: { bookingId: { in: bookingIds } } })] as const;
      })),
    );

    return trips.map((trip) => {
      // A cancelled reverse is out of the picture: this trip can open one again.
      const reverse = trip.reverseTrip?.tripStatus === 'CANCELLED' ? null : trip.reverseTrip;
      // With an open reverse the seat count includes seats closed by the link, so only real passengers count. Before that the two agree.
      const seatsTaken = trip.totalSeats - trip.availableSeats;
      const bookedSeats = reverse ? booked.get(trip.id)?.seats ?? 0 : seatsTaken;
      const occupancyPercent = trip.totalSeats ? Math.round((bookedSeats / trip.totalSeats) * 100) : 0;
      const reachedPercent = trip.totalSeats > 0 && (seatsTaken / trip.totalSeats) * 100 >= trip.reverseOpenPercent;
      const isSelling = reverse?.channelApp || reverse?.channelBranch;
      return {
        id: trip.id,
        tripCode: trip.tripCode,
        journeyCode: journeyCodeOf(trip),
        origin: trip.origin,
        destination: trip.destination,
        bookingType: trip.bookingType,
        departureTime: trip.departureTime,
        totalSeats: trip.totalSeats,
        bookedSeats,
        direction: trip.direction,
        goOnlySeats: seatsByTrip.get(trip.id) ?? 0,
        returningSeats: returning.get(trip.id) ?? 0,
        wasCancelled: trip.reverseTrip?.tripStatus === 'CANCELLED',
        hasDeparted: trip.departureTime <= now,
        // What opening it now would put on sale; see openReverseTrip.
        reverseSeats: trip.direction === 'ONE_WAY' ? trip.totalSeats : trip.availableSeats,
        occupancyPercent,
        openPercent: trip.reverseOpenPercent,
        reachedPercent,
        reverseDepartureAt: trip.reverseDepartureAt,
        reversePrice: Number(trip.reversePrice ?? trip.price),
        busPlate: trip.bus?.plateNumber ?? null,
        driverName: trip.drivers[0]?.user.name ?? null,
        // The way there, stop by stop; the way back runs it the other way round, so the form offers it reversed.
        outboundStops: trip.itineraryStops,
        status: reverse
          ? reverse.tripStatus !== 'PUBLISHED' ? 'CLOSED' : isSelling ? 'OPEN' : 'PAUSED'
          : 'READY',
        reverse: reverse && {
          id: reverse.id,
          tripCode: reverse.tripCode,
          departureTime: reverse.departureTime,
          price: Number(reverse.price),
          totalSeats: reverse.totalSeats,
          availableSeats: reverse.availableSeats,
          bookedSeats: booked.get(reverse.id)?.seats ?? 0,
          bookedRevenue: booked.get(reverse.id)?.revenue ?? 0,
          busPlate: reverse.bus?.plateNumber ?? null,
          rentMissing: reverse.busId !== null && reverse.busRentalPrice === null,
          channelApp: reverse.channelApp,
          channelBranch: reverse.channelBranch,
          boardingPointName: reverse.boardingPoints[0]?.name ?? null,
          boardingPoints: reverse.boardingPoints,
          itineraryStops: reverse.itineraryStops,
        },
      };
    });
  }

  async openReverseTrip(id: string, dto: OpenReverseTripDto, actor?: CrewActor) {
    return this.prisma.$transaction(async (tx) => {
      // A seat sold while this copies them would be on sale on both trips.
      await lockTripsWithLinked(tx, [id]);
      const trip = await tx.trip.findUnique({
        where: { id },
        include: {
          seats: { select: { seatNumber: true, isBooked: true } },
          images: { select: { url: true } },
          drivers: true,
          supervisors: true,
          reverseTrip: { select: { id: true, tripStatus: true, busId: true } },
        },
      });
      if (!trip) throw new NotFoundException('Trip not found');
      if (!trip.reverseEnabled) throw new ConflictException('الرحلة العكسية غير مفعلة لهذه الرحلة');
      if (trip.reverseTrip && trip.reverseTrip.tripStatus !== 'CANCELLED') throw new ConflictException('فُتحت الرحلة العكسية مسبقًا');
      // A completed outbound still counts: the bus has arrived and the way back is ahead of it.
      if (!['PUBLISHED', 'COMPLETED'].includes(trip.tripStatus)) throw new ConflictException('يجب أن تكون رحلة الذهاب منشورة');
      if (dto.channelApp === false && dto.channelBranch === false) throw new BadRequestException('اختر قناة حجز واحدة على الأقل');
      if (!trip.reverseDepartureAt) {
        throw new BadRequestException('حدد موعد انطلاق الرحلة العكسية');
      }
      if (trip.reverseDepartureAt <= new Date()) throw new BadRequestException('موعد الرحلة العكسية قد مضى');
      this.assertReverseAfterOutbound(trip.reverseDepartureAt, trip);

      // The reverse can go on sale as soon as the outbound is published; its percent only decides when staff are reminded.
      // Seats the outbound sells afterwards are closed on the reverse by the seat link.
      // Only a round trip's passengers are still aboard coming back, so only their seats stay closed.
      const seatNumbers = trip.seats.filter((seat) => trip.direction === 'ONE_WAY' || !seat.isBooked).map((seat) => seat.seatNumber);
      if (seatNumbers.length === 0) throw new ConflictException('لا توجد مقاعد متبقية');

      const departure = trip.reverseDepartureAt;
      const route = this.reverseRoute(dto, departure);
      // The road back takes as long as the road there, when that is known.
      const reached = reachesDestinationAt(trip);
      const arrival = new Date(departure.getTime() + (reached > trip.departureTime ? reached.getTime() - trip.departureTime.getTime() : DEFAULT_TRIP_DURATION_MS));
      const driverIds = trip.drivers.map((d) => d.userId);
      const supervisorIds = trip.supervisors.map((s) => s.userId);
      await this.assertNoScheduleConflict(tx, {
        busId: trip.busId,
        driverIds,
        supervisorIds,
        start: departure,
        end: arrival,
        excludeTripIds: [trip.id],
      });

      if (trip.reverseTrip) {
        return this.reopenReverse(tx, trip.reverseTrip, trip, { departure, arrival, seatNumbers, dto, route }, actor);
      }

      const reverse = await tx.trip.create({
        data: {
          ...reverseCodeOf(trip),
          title: 'رحلة عكسية',
          origin: trip.destination,
          destination: trip.origin,
          departureTime: departure,
          arrivalTime: arrival,
          hijriDate: toHijriLabel(departure),
          busType: trip.busType,
          price: trip.reversePrice ?? trip.price,
          totalSeats: seatNumbers.length,
          availableSeats: seatNumbers.length,
          // Same vehicle, so the same plan; the seats on sale are the ones the outbound left free.
          seatLayout: storedSeatLayout(tripSeatLayout(trip)),
          maxSeatsPerBooking: trip.maxSeatsPerBooking,
          crewOpensBeforeMinutes: trip.crewOpensBeforeMinutes,
          boardingOpensBeforeMinutes: trip.boardingOpensBeforeMinutes,
          boardingClosesAfterMinutes: trip.boardingClosesAfterMinutes,
          unpaidBoarding: trip.unpaidBoarding,
          miqat: trip.miqat,
          tripStatus: 'PUBLISHED',
          direction: 'ONE_WAY',
          busId: trip.busId,
          busRentalPrice: await this.contractRent(tx, trip.busId, trip.destination, trip.origin),
          reverseOfTripId: trip.id,
          channelApp: dto.channelApp ?? true,
          channelBranch: dto.channelBranch ?? true,
          seats: { createMany: { data: seatNumbers.map((seatNumber) => ({ seatNumber })) } },
          // Same bus, same photos; the route and gathering points of the way back are the ones given when opening it.
          images: { create: trip.images },
          boardingPoints: { create: route.boardingPoints },
          ...(route.itineraryStops.length && { itineraryStops: { create: route.itineraryStops } }),
          services: { create: await busServiceRows(tx, trip.busId) },
          drivers: { create: trip.drivers.map(({ userId, isPrimary }) => ({ userId, isPrimary })) },
          supervisors: { create: trip.supervisors.map(({ userId, isPrimary }) => ({ userId, isPrimary })) },
        },
        include: ADMIN_TRIP_INCLUDE,
      });
      await this.logCrew(
        tx,
        reverse.id,
        { drivers: [], supervisors: [] },
        { drivers: trip.drivers.map((row) => row.userId), supervisors: trip.supervisors.map((row) => row.userId) },
        actor,
        'فتح الرحلة العكسية بطاقم الذهاب',
      );
      await this.notifications.toTripCrew(tx, 'CREW_TRIP_ASSIGNED', reverse.id);
      return withSeatPrice(reverse);
    }, TRIP_TX_OPTIONS);
  }

  /** The gathering points and route of a reverse being opened. A bare point name gathers at the departure time. */
  private reverseRoute(dto: OpenReverseTripDto, departure: Date) {
    const boardingPoints = dto.boardingPoints?.length
      ? dto.boardingPoints.map((point) => this.toBoardingPoint({ ...point, name: point.name.trim() }))
      : dto.boardingPointName?.trim()
        ? [{ name: dto.boardingPointName.trim(), time: formatRiyadhTime(departure), address: '', lat: null, lng: null }]
        : [];
    if (boardingPoints.length === 0 || boardingPoints.some((point) => !point.name || !point.time)) {
      throw new BadRequestException('أضف نقطة تجمع واحدة على الأقل للرحلة العكسية، باسمها ووقت حضورها');
    }
    const itineraryStops = (dto.itineraryStops ?? []).map((stop, idx) => this.toItineraryStop({ ...stop, title: stop.title.trim() }, idx));
    if (itineraryStops.some((stop) => !stop.title || !stop.time)) throw new BadRequestException('أكمل اسم ووقت كل محطة في مسار الرحلة العكسية');
    return { boardingPoints, itineraryStops };
  }

  /** A cancelled reverse comes back as the same trip, so its code and its history stay in one place. Its seats start over from where the outbound stands today. */
  private async reopenReverse(
    tx: Prisma.TransactionClient,
    cancelled: { id: string; busId: string | null },
    outbound: { busId: string | null; seatLayout: Prisma.JsonValue; price: Prisma.Decimal; reversePrice: Prisma.Decimal | null; destination: string; origin: string; drivers: { userId: string; isPrimary: boolean }[]; supervisors: { userId: string; isPrimary: boolean }[] },
    opening: { departure: Date; arrival: Date; seatNumbers: string[]; dto: OpenReverseTripDto; route: ReturnType<TripsService['reverseRoute']> },
    actor?: CrewActor,
  ) {
    const { departure, arrival, seatNumbers, dto, route } = opening;
    const previous = await tx.trip.findUniqueOrThrow({ where: { id: cancelled.id }, select: { drivers: { select: { userId: true } }, supervisors: { select: { userId: true } } } });
    await tx.seat.deleteMany({ where: { tripId: cancelled.id } });
    await tx.seat.createMany({ data: seatNumbers.map((seatNumber) => ({ tripId: cancelled.id, seatNumber })) });
    await tx.boardingPoint.deleteMany({ where: { tripId: cancelled.id } });
    await tx.boardingPoint.createMany({ data: route.boardingPoints.map((point) => ({ tripId: cancelled.id, ...point })) });
    await tx.itineraryStop.deleteMany({ where: { tripId: cancelled.id } });
    if (route.itineraryStops.length) await tx.itineraryStop.createMany({ data: route.itineraryStops.map((stop) => ({ tripId: cancelled.id, ...stop })) });
    await tx.tripDriver.deleteMany({ where: { tripId: cancelled.id } });
    await tx.tripDriver.createMany({ data: outbound.drivers.map(({ userId, isPrimary }) => ({ tripId: cancelled.id, userId, isPrimary })) });
    await tx.tripSupervisor.deleteMany({ where: { tripId: cancelled.id } });
    await tx.tripSupervisor.createMany({ data: outbound.supervisors.map(({ userId, isPrimary }) => ({ tripId: cancelled.id, userId, isPrimary })) });
    await this.logCrew(
      tx,
      cancelled.id,
      { drivers: previous.drivers.map((row) => row.userId), supervisors: previous.supervisors.map((row) => row.userId) },
      { drivers: outbound.drivers.map((row) => row.userId), supervisors: outbound.supervisors.map((row) => row.userId) },
      actor,
      'إعادة فتح الرحلة العكسية بطاقم الذهاب',
    );
    if (cancelled.busId !== outbound.busId) await applyBusServices(tx, cancelled.id, outbound.busId);

    const reverse = await tx.trip.update({
      where: { id: cancelled.id },
      data: {
        tripStatus: 'PUBLISHED',
        departureTime: departure,
        arrivalTime: arrival,
        hijriDate: toHijriLabel(departure),
        price: outbound.reversePrice ?? outbound.price,
        totalSeats: seatNumbers.length,
        availableSeats: seatNumbers.length,
        seatLayout: storedSeatLayout(tripSeatLayout(outbound)),
        busId: outbound.busId,
        channelApp: dto.channelApp ?? true,
        channelBranch: dto.channelBranch ?? true,
        liveStatus: 'NOT_STARTED',
        liveStatusAt: null,
        currentBoardingPointId: null,
        crewOpenAnnouncedAt: null,
        boardingOpenAnnouncedAt: null,
        boardingCloseAnnouncedAt: null,
      },
      include: ADMIN_TRIP_INCLUDE,
    });
    await this.notifications.toTripCrew(tx, 'CREW_TRIP_ASSIGNED', reverse.id);
    return withSeatPrice(reverse);
  }

  /**
   * Opens boarding on one trip now, whatever its usual window says, or returns it to that window.
   * Closing time stays as set on the trip. The crew hears of it on the spot.
   */
  async setManualBoarding(id: string, open: boolean) {
    const trip = await this.prisma.trip.findUnique({ where: { id }, select: { id: true, tripStatus: true, boardingOpenedManuallyAt: true, ...CREW_WINDOW_SELECT } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (open) {
      if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('يُفتح الصعود للرحلات المنشورة فقط');
      const window = crewWindow(trip);
      if (Date.now() > window.boardingClosesAt.getTime()) throw new ConflictException('انتهى وقت الصعود لهذه الرحلة. لتمديده عدّل «إغلاق الصعود بعد الانطلاق»');
      if (window.isBoardingOpen) throw new ConflictException('الصعود مفتوح بالفعل لهذه الرحلة');
      await this.prisma.trip.update({ where: { id }, data: { boardingOpenedManuallyAt: new Date(), boardingOpenAnnouncedAt: null } });
    } else {
      if (!trip.boardingOpenedManuallyAt) throw new ConflictException('الصعود لم يُفتح يدويًا لهذه الرحلة');
      // Announced again when its usual time comes, unless that time has already passed.
      const usual = crewWindow({ ...trip, boardingOpenedManuallyAt: null });
      await this.prisma.trip.update({
        where: { id },
        data: { boardingOpenedManuallyAt: null, ...(!usual.isBoardingOpen && { boardingOpenAnnouncedAt: null }) },
      });
    }
    await this.announceCrewWindows().catch((err) => console.error('Crew window sweep failed:', err.message));
    return this.getAdminTripWindow(id);
  }

  private async getAdminTripWindow(id: string) {
    const trip = await this.prisma.trip.findUniqueOrThrow({ where: { id }, select: { id: true, ...CREW_WINDOW_SELECT } });
    return { id: trip.id, boardingOpenedManuallyAt: trip.boardingOpenedManuallyAt, ...crewWindow(trip) };
  }

  async cancelTrip(id: string, adminId: string, reason?: string, acknowledgeReturning = false) {
    return this.prisma.$transaction(
      async (tx) => {
        // Bookings take these locks too, so none can confirm after this lists them; it would see the cancelled status instead.
        await lockTripsWithLinked(tx, [id]);
        const trip = await tx.trip.findUnique({ where: { id }, include: { reverseTrip: { select: { id: true, tripStatus: true } } } });
        if (!trip) throw new NotFoundException('Trip not found');
        if (trip.tripStatus === 'CANCELLED') throw new ConflictException('الرحلة ملغاة مسبقًا');
        if (trip.tripStatus === 'COMPLETED') throw new ConflictException('لا يمكن إلغاء رحلة مكتملة');

        // Their money sits in the outbound booking and no rule splits it between the two ways, so nobody is refunded blindly: staff must say they know.
        const returning = trip.reverseOfTripId ? await returningBookingIds(tx, trip.reverseOfTripId) : [];
        if (returning.length > 0 && !acknowledgeReturning) {
          throw new ConflictException(`عليها ${returning.length} حجز ذهاب وعودة يرجع ركابه بها. لإيقاف البيع فقط اقفل قنوات الحجز، وللإلغاء أكّد أن الإدارة ستعالج حجوزاتهم`);
        }

        // The reverse trip runs on the same bus, so it cannot outlive its outbound.
        const tripIds = [id];
        if (trip.reverseTrip && ['DRAFT', 'PUBLISHED'].includes(trip.reverseTrip.tripStatus)) tripIds.push(trip.reverseTrip.id);

        const boarded = await tx.booking.count({ where: { tripId: { in: tripIds }, status: 'BOARDED' } });
        if (boarded > 0) throw new ConflictException('لا يمكن إلغاء رحلة بدأ صعود ركابها');

        // Room assignment locks the stay before its bookings, so the stays are locked here before any booking is.
        await tx.$queryRaw`SELECT "id" FROM "HotelBooking" WHERE "tripId" IN (${Prisma.join(tripIds)}) ORDER BY "id" FOR UPDATE`;

        const bookings = await tx.booking.findMany({
          where: { tripId: { in: tripIds }, status: { in: ['PENDING', 'CONFIRMED', 'PENDING_CANCELLATION_REVIEW'] } },
          select: { id: true },
        });
        for (const booking of bookings) {
          await this.cancellation.cancel(tx, booking.id, { reviewedById: adminId, note: reason || 'إلغاء الرحلة من الإدارة', notifyAs: 'TRIP_CANCELLED' });
        }

        // A draft was never announced to its crew, so there is nothing to take back.
        if (trip.tripStatus === 'PUBLISHED') await this.notifications.toTripCrew(tx, 'CREW_TRIP_CANCELLED', id);
        if (tripIds.length > 1 && trip.reverseTrip.tripStatus === 'PUBLISHED') await this.notifications.toTripCrew(tx, 'CREW_TRIP_CANCELLED', trip.reverseTrip.id);

        await this.notifications.toBookingOwners(tx, 'RETURN_RIDE_CANCELLED', returning, tripValues(trip));

        // The cancelled bookings have left their rooms, so the hotel stays go too and stop counting as the trip's cost.
        const stays = await tx.hotelBooking.findMany({ where: { tripId: { in: tripIds }, status: 'CONFIRMED' }, select: { id: true } });
        if (stays.length > 0) {
          const stayIds = stays.map((stay) => stay.id);
          await tx.bookingPassenger.updateMany({ where: { hotelRoom: { hotelBookingId: { in: stayIds } } }, data: { hotelRoomId: null, roomNote: null } });
          await tx.hotelRoom.deleteMany({ where: { hotelBookingId: { in: stayIds } } });
          await tx.hotelBooking.updateMany({ where: { id: { in: stayIds } }, data: { status: 'CANCELLED', cancelReason: reason || 'إلغاء الرحلة من الإدارة' } });
        }

        await tx.trip.updateMany({ where: { id: { in: tripIds } }, data: { tripStatus: 'CANCELLED' } });
        return { success: true, cancelledBookings: bookings.length, returningBookings: returning.length };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Publishes the series' drafts still ahead within this month and next. Drafts further out, left by the old year-ahead rule,
   * stay drafts so they are not put on sale by accident. One that cannot go out yet is listed with why, and the rest still go.
   */
  async publishSeries(seriesId: string, actor?: CrewActor) {
    const now = new Date();
    const drafts = await this.prisma.trip.findMany({
      where: { seriesId, tripStatus: 'DRAFT', departureTime: { gt: now, lt: this.draftWindow(now).end } },
      orderBy: { departureTime: 'asc' },
      select: { id: true, tripCode: true },
    });
    if (drafts.length === 0) throw new NotFoundException('لا توجد مسودات قادمة في هذا الجدول خلال الشهر الحالي والقادم');
    let published = 0;
    const failed: { tripCode: string; reason: string }[] = [];
    for (const draft of drafts) {
      try {
        await this.updateTrip(draft.id, { tripStatus: 'PUBLISHED' }, actor);
        published++;
      } catch (err) {
        if (!(err instanceof ConflictException || err instanceof BadRequestException)) throw err;
        failed.push({ tripCode: draft.tripCode, reason: err.message });
      }
    }
    return { published, failed };
  }

  /** No more weekly copies are drafted. Trips already made stay; with deleteDrafts, the unpublished ones still ahead go. */
  async stopSeries(seriesId: string, deleteDrafts = false) {
    const stopped = await this.prisma.$transaction(async (tx) => {
      // Waits for a drafting run on this series to finish its current copy.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${seriesId}))`;
      return tx.trip.updateMany({
        where: { seriesId },
        data: { scheduleType: 'TEMPORARY', recurrenceCalendar: null, repeatWeekdays: [], repeatUntil: null },
      });
    }, TRIP_TX_OPTIONS);
    if (stopped.count === 0) throw new NotFoundException('الجدول غير موجود');
    let deleted = 0;
    if (deleteDrafts) {
      const drafts = await this.prisma.trip.findMany({
        where: { seriesId, tripStatus: 'DRAFT', departureTime: { gt: new Date() }, bookings: { none: {} }, reverseTrip: null },
        select: { id: true },
      });
      for (const draft of drafts) {
        await this.deleteTrip(draft.id);
        deleted++;
      }
    }
    return { stopped: true, deleted };
  }

  async deleteTrip(id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    const bookingsCount = await this.prisma.booking.count({ where: { tripId: id } });
    if (bookingsCount > 0) {
      throw new ConflictException('Cannot delete trip with bookings');
    }
    if (trip.reverseOfTripId && trip.tripStatus !== 'CANCELLED' && (await returningBookingIds(this.prisma, trip.reverseOfTripId)).length > 0) {
      throw new ConflictException('لا يمكن حذف رحلة عكسية يرجع بها ركاب ذهاب وعودة');
    }
    const reverseCount = await this.prisma.trip.count({ where: { reverseOfTripId: id } });
    if (reverseCount > 0) {
      throw new ConflictException('لا يمكن حذف رحلة فُتحت لها رحلة عكسية');
    }
    // With no bookings nobody was ever placed in its rooms, so its hotel stays go with it; they would otherwise hold the trip in place.
    await this.prisma.$transaction(async (tx) => {
      await tx.hotelBooking.deleteMany({ where: { tripId: id } });
      await tx.trip.delete({ where: { id } });
    }, TRIP_TX_OPTIONS);
    return { success: true };
  }
}

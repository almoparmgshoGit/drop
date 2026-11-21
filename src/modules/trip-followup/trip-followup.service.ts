import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { IntegrationsService } from '../../common/services/integrations.service';
import { PrismaService } from '../../common/services/prisma.service';
import { returningBookingIds } from '../../common/utils/linked-seats.util';
import { ensureTrackingToken, publicWebUrl, trackingUrl } from './followup.util';
import { RateTripDto, RatingLeg } from './trip-followup.dto';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A position older than this no longer describes where the bus is now. */
const LIVE_FOR_MS = 2 * MINUTE_MS;
/** A trip can be rated for this long after it left. */
const RATING_WINDOW_MS = 60 * DAY_MS;
const SHAREABLE_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];
const RATABLE_STATUSES = ['CONFIRMED', 'BOARDED'];
/** A trip the crew never marked arrived counts as over this long after its arrival time. */
const UNDERWAY_GRACE_MS = 6 * HOUR_MS;

const RATING_SELECT = { rating: true, busRating: true, supervisorRating: true, driverRating: true, comment: true, createdAt: true } satisfies Prisma.TripRatingSelect;
type RatingRow = Prisma.TripRatingGetPayload<{ select: typeof RATING_SELECT }>;

const LEG_TRIP_SELECT = {
  id: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  estimatedArrivalAt: true,
  liveStatus: true,
  tripStatus: true,
  _count: { select: { supervisors: true, drivers: true } },
} satisfies Prisma.TripSelect;
type LegTrip = Prisma.TripGetPayload<{ select: typeof LEG_TRIP_SELECT }>;
type RatingLegOf = { leg: RatingLeg; trip: LegTrip; boarded: boolean };
type RatableBooking = { status: string; ratings: (RatingRow & { tripId: string })[] };

const PUBLIC_TRIP_SELECT = {
  id: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  estimatedArrivalAt: true,
  tripStatus: true,
  liveStatus: true,
  liveStatusAt: true,
  currentBoardingPointId: true,
  boardingPoints: { select: { id: true, name: true, time: true, lat: true, lng: true } },
  location: { select: { lat: true, lng: true, speed: true, recordedAt: true } },
} satisfies Prisma.TripSelect;

type PublicTrip = Prisma.TripGetPayload<{ select: typeof PUBLIC_TRIP_SELECT }>;

/** When the trip the link follows is over: the crew's word first, then the timetable. */
const tripEndsAt = (trip: PublicTrip) => (trip.estimatedArrivalAt ?? trip.arrivalTime).getTime();

@Injectable()
export class TripFollowupService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private integrations: IntegrationsService,
    private config: ConfigService,
  ) {}

  // ─── Sharing the live position ───

  /** The owner's link to send to family. The same link is returned every time, so one already shared keeps working. */
  async shareLink(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { userId: true, status: true, trip: { select: { tripStatus: true, departureTime: true, arrivalTime: true, estimatedArrivalAt: true, liveStatus: true } } },
    });
    if (!booking || booking.userId !== userId) throw new NotFoundException('Booking not found');
    if (!SHAREABLE_STATUSES.includes(booking.status)) throw new ConflictException('لا يمكن مشاركة تتبع حجز غير مؤكد أو ملغى');
    if (booking.trip.tripStatus === 'CANCELLED') throw new ConflictException('هذه الرحلة ملغاة');
    const token = await ensureTrackingToken(this.prisma, bookingId);
    if (!token) throw new NotFoundException('Booking not found');
    return { url: trackingUrl(publicWebUrl(this.config.get<string>('PUBLIC_WEB_URL'), this.config.get<string>('CORS_ORIGINS')), token) };
  }

  /**
   * What anyone holding the link sees: the trip's route and the bus on the map, and nothing about who is travelling.
   * It stops answering once the trip is over (arrived, or past its arrival plus the usual tracking grace) or cancelled.
   */
  async publicTracking(token: string) {
    if (!/^[\w-]{20,64}$/.test(token)) throw new NotFoundException('الرابط غير صالح');
    const booking = await this.prisma.booking.findUnique({
      where: { trackingToken: token },
      select: { id: true, tripId: true, status: true, boardingPointId: true, boardingPointName: true, boardingPointTime: true, trip: { select: { ...PUBLIC_TRIP_SELECT, reverseTrip: { select: PUBLIC_TRIP_SELECT } } } },
    });
    if (!booking || !SHAREABLE_STATUSES.includes(booking.status)) throw new NotFoundException('الرابط غير صالح أو انتهت صلاحيته');

    const now = Date.now();
    const { trackingClosesAfterHours } = await this.appSettings.numbers('trackingClosesAfterHours');
    const grace = trackingClosesAfterHours * HOUR_MS;
    const isOver = (trip: PublicTrip) => trip.tripStatus === 'CANCELLED' || (trip.liveStatus === 'ARRIVED' && !!trip.liveStatusAt && now > trip.liveStatusAt.getTime() + grace) || now > tripEndsAt(trip) + grace;

    // A round trip's passenger is followed on the way back once the outbound is over.
    let trip: PublicTrip = booking.trip;
    let isReturn = false;
    const reverse = booking.trip.reverseTrip;
    if (isOver(trip) && reverse && reverse.tripStatus !== 'CANCELLED' && (await returningBookingIds(this.prisma, booking.tripId)).includes(booking.id)) {
      trip = reverse;
      isReturn = true;
    }
    if (isOver(trip)) throw new NotFoundException('انتهت صلاحية رابط التتبع بانتهاء الرحلة');

    const hasArrived = trip.liveStatus === 'ARRIVED';
    const stage = hasArrived ? 'ARRIVED' : trip.liveStatus === 'STOPPED' ? 'STOPPED' : trip.liveStatus === 'ON_ROAD' || trip.liveStatus === 'AT_POINT' ? 'IN_PROGRESS' : 'NOT_STARTED';
    const position = hasArrived ? null : trip.location;
    const isMine = (point: { id: string; name: string }) => !isReturn && (booking.boardingPointId === point.id || booking.boardingPointName === point.name);
    const map = await this.integrations.mapConfig();

    return {
      trip: {
        origin: isReturn ? trip.origin : booking.trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        arrivalTime: trip.estimatedArrivalAt ?? trip.arrivalTime,
        isReturn,
      },
      stage,
      liveStatus: trip.liveStatus,
      liveStatusAt: trip.liveStatusAt,
      boardingPoint: !isReturn && booking.boardingPointName ? { name: booking.boardingPointName, time: booking.boardingPointTime } : null,
      points: [...trip.boardingPoints]
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((point) => ({ name: point.name, time: point.time, lat: point.lat, lng: point.lng, isMine: isMine(point), isCurrent: point.id === trip.currentBoardingPointId })),
      location: position ? { lat: position.lat, lng: position.lng, speed: position.speed, recordedAt: position.recordedAt, isLive: now - position.recordedAt.getTime() <= LIVE_FOR_MS } : null,
      map: { tilesUrl: map.tilesUrl, attribution: map.attribution },
    };
  }

  // ─── Rating a trip ───

  /**
   * The legs of a booking the customer can rate: its own trip, and on a round trip the reverse it rides back on. Each leg is
   * rated apart, by those who boarded it.
   */
  private async ratableBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        tripId: true,
        status: true,
        bookingReference: true,
        tickets: { select: { isBoarded: true, returnBoardedAt: true } },
        ratings: { select: { tripId: true, ...RATING_SELECT } },
        trip: { select: { ...LEG_TRIP_SELECT, direction: true, reverseTrip: { select: LEG_TRIP_SELECT } } },
      },
    });
    if (!booking || booking.userId !== userId) throw new NotFoundException('Booking not found');
    const { direction, reverseTrip, ...outbound } = booking.trip;
    const legs: RatingLegOf[] = [{ leg: 'OUTBOUND', trip: outbound, boarded: booking.tickets.some((ticket) => ticket.isBoarded) }];
    if (direction === 'ROUND_TRIP' && reverseTrip && reverseTrip.tripStatus !== 'CANCELLED' && (await returningBookingIds(this.prisma, booking.tripId)).includes(booking.id)) {
      legs.push({ leg: 'RETURN', trip: reverseTrip, boarded: booking.tickets.some((ticket) => !!ticket.returnBoardedAt) });
    }
    return { booking, legs };
  }

  /**
   * Over for the customer: the crew said it arrived or it was completed, or its arrival time has passed. A trip the crew
   * left on the road (never marked arrived) is taken as over some hours after its arrival time.
   */
  private isFinished(trip: LegTrip) {
    if (trip.liveStatus === 'ARRIVED' || trip.tripStatus === 'COMPLETED') return true;
    const endsAt = (trip.estimatedArrivalAt ?? trip.arrivalTime).getTime();
    const underway = trip.liveStatus === 'ON_ROAD' || trip.liveStatus === 'AT_POINT' || trip.liveStatus === 'STOPPED';
    return Date.now() >= endsAt + (underway ? UNDERWAY_GRACE_MS : 0);
  }

  /** Why this leg cannot be rated now, or null when it can. Boarding it is what proves the customer rode it. */
  private whyNot(status: string, leg: RatingLegOf, rated: boolean) {
    if (rated) return 'ALREADY_RATED';
    if (!RATABLE_STATUSES.includes(status)) return 'NOT_CONFIRMED';
    if (leg.trip.tripStatus === 'CANCELLED') return 'CANCELLED';
    if (!this.isFinished(leg.trip)) return 'NOT_FINISHED';
    if (!leg.boarded) return 'NOT_BOARDED';
    if (Date.now() - leg.trip.departureTime.getTime() > RATING_WINDOW_MS) return 'TOO_LATE';
    return null;
  }

  private legView(booking: RatableBooking, leg: RatingLegOf) {
    const given = booking.ratings.find((row) => row.tripId === leg.trip.id);
    const reason = this.whyNot(booking.status, leg, !!given);
    let rating: RatingRow | null = null;
    if (given) {
      const { tripId: _tripId, ...row } = given;
      rating = row;
    }
    return {
      leg: leg.leg,
      tripId: leg.trip.id,
      canRate: reason === null,
      isFinished: this.isFinished(leg.trip),
      reason,
      rating,
      trip: { origin: leg.trip.origin, destination: leg.trip.destination, departureTime: leg.trip.departureTime },
      hasSupervisor: leg.trip._count.supervisors > 0,
      hasDriver: leg.trip._count.drivers > 0,
    };
  }

  /**
   * The booking's legs and where each stands. The fields outside `legs` describe the leg to show first (the one waiting
   * for a rating, else the outbound): the shape older apps read.
   */
  async ratingOf(userId: string, bookingId: string) {
    const { booking, legs } = await this.ratableBooking(userId, bookingId);
    const views = legs.map((leg) => this.legView(booking, leg));
    const first = views.find((view) => view.canRate) ?? views[0];
    return {
      ...first,
      // Sharing the live position follows the outbound, as before.
      isFinished: views[0].isFinished,
      bookingReference: booking.bookingReference,
      legs: views,
      canRateAny: views.some((view) => view.canRate),
    };
  }

  async rate(userId: string, bookingId: string, dto: RateTripDto) {
    const { booking, legs } = await this.ratableBooking(userId, bookingId);
    const leg = legs.find((row) => row.leg === (dto.leg ?? 'OUTBOUND'));
    if (!leg) throw new ConflictException('لا توجد رحلة عودة لهذا الحجز');
    const reason = this.whyNot(booking.status, leg, booking.ratings.some((row) => row.tripId === leg.trip.id));
    if (reason === 'ALREADY_RATED') throw new ConflictException('قيّمت هذه الرحلة من قبل، شكرًا لك');
    if (reason === 'NOT_FINISHED') throw new ConflictException('يمكن تقييم الرحلة بعد انتهائها');
    if (reason === 'NOT_BOARDED') throw new ConflictException('التقييم متاح لمن سافر في الرحلة فقط');
    if (reason === 'TOO_LATE') throw new ConflictException('انتهت مدة تقييم هذه الرحلة');
    if (reason) throw new ConflictException('لا يمكن تقييم هذا الحجز');
    try {
      const rating = await this.prisma.tripRating.create({
        data: {
          bookingId,
          tripId: leg.trip.id,
          rating: dto.rating,
          busRating: dto.busRating ?? null,
          supervisorRating: dto.supervisorRating ?? null,
          driverRating: dto.driverRating ?? null,
          comment: dto.comment?.trim() || null,
        },
        select: RATING_SELECT,
      });
      return { success: true, leg: leg.leg, rating };
    } catch (err) {
      // A double tap: the unique booking and trip keep the first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('قيّمت هذه الرحلة من قبل، شكرًا لك');
      throw err;
    }
  }

  /**
   * The customer's trips waiting for a rating, latest first: what the app asks about when it opens and marks in the
   * bookings list. Only trips boarded and left inside the rating window.
   */
  async pendingRatings(userId: string) {
    const since = new Date(Date.now() - RATING_WINDOW_MS);
    const bookings = await this.prisma.booking.findMany({
      where: {
        userId,
        status: { in: RATABLE_STATUSES as ('CONFIRMED' | 'BOARDED')[] },
        OR: [
          { trip: { departureTime: { gte: since } }, tickets: { some: { isBoarded: true } } },
          { trip: { direction: 'ROUND_TRIP', reverseTrip: { departureTime: { gte: since } } }, tickets: { some: { returnBoardedAt: { not: null } } } },
        ],
      },
      orderBy: { trip: { departureTime: 'desc' } },
      take: 30,
      select: { id: true },
    });
    const items: { bookingId: string; bookingReference: string; leg: RatingLeg; tripId: string; trip: { origin: string; destination: string; departureTime: Date }; endedAt: Date }[] = [];
    for (const { id } of bookings) {
      const { booking, legs } = await this.ratableBooking(userId, id);
      for (const leg of legs) {
        if (!this.legView(booking, leg).canRate) continue;
        items.push({
          bookingId: booking.id,
          bookingReference: booking.bookingReference,
          leg: leg.leg,
          tripId: leg.trip.id,
          trip: { origin: leg.trip.origin, destination: leg.trip.destination, departureTime: leg.trip.departureTime },
          endedAt: leg.trip.estimatedArrivalAt ?? leg.trip.arrivalTime,
        });
      }
    }
    items.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
    return { items };
  }

  /** The trip's ratings for the panel: the averages and each customer's words. */
  async tripRatings(tripId: string) {
    const found = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, executedAt: true, reverseOfTripId: true },
    });
    if (!found) throw new NotFoundException('Trip not found');
    const { reverseOfTripId, ...trip } = found;
    // A reverse's riders are mostly round-trip passengers coming back under their outbound booking.
    const returningIds = reverseOfTripId ? await returningBookingIds(this.prisma, reverseOfTripId) : [];
    const [rows, ownRiders, returningRiders] = await Promise.all([
      this.prisma.tripRating.findMany({
        where: { tripId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          rating: true,
          busRating: true,
          supervisorRating: true,
          driverRating: true,
          comment: true,
          createdAt: true,
          booking: { select: { id: true, bookingReference: true, user: { select: { name: true } } } },
        },
      }),
      this.prisma.booking.count({ where: { tripId, status: { in: RATABLE_STATUSES as ('CONFIRMED' | 'BOARDED')[] }, tickets: { some: { isBoarded: true } } } }),
      returningIds.length
        ? this.prisma.booking.count({ where: { id: { in: returningIds }, status: { in: RATABLE_STATUSES as ('CONFIRMED' | 'BOARDED')[] }, tickets: { some: { returnBoardedAt: { not: null } } } } })
        : Promise.resolve(0),
    ]);
    const riders = ownRiders + returningRiders;
    const average = (values: (number | null)[]) => {
      const given = values.filter((value): value is number => value !== null);
      return given.length ? Math.round((given.reduce((sum, value) => sum + value, 0) / given.length) * 10) / 10 : null;
    };
    return {
      trip,
      summary: {
        count: rows.length,
        riders,
        average: average(rows.map((row) => row.rating)),
        bus: average(rows.map((row) => row.busRating)),
        supervisor: average(rows.map((row) => row.supervisorRating)),
        driver: average(rows.map((row) => row.driverRating)),
        distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: rows.filter((row) => row.rating === stars).length })),
      },
      items: rows.map(({ booking, ...row }) => ({ ...row, bookingId: booking.id, bookingReference: booking.bookingReference, customerName: booking.user.name })),
    };
  }
}

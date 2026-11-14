import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { IntegrationsService } from '../../common/services/integrations.service';
import { PrismaService } from '../../common/services/prisma.service';
import { returningBookingIds } from '../../common/utils/linked-seats.util';
import { ensureTrackingToken, publicWebUrl, trackingUrl } from './followup.util';
import { RateTripDto } from './trip-followup.dto';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A position older than this no longer describes where the bus is now. */
const LIVE_FOR_MS = 2 * MINUTE_MS;
/** A trip can be rated for this long after it left. */
const RATING_WINDOW_MS = 60 * DAY_MS;
const SHAREABLE_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];
const RATABLE_STATUSES = ['CONFIRMED', 'BOARDED'];

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
    const stage = hasArrived ? 'ARRIVED' : trip.liveStatus === 'ON_ROAD' || trip.liveStatus === 'AT_POINT' ? 'IN_PROGRESS' : now < trip.departureTime.getTime() ? 'NOT_STARTED' : 'IN_PROGRESS';
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

  private async ratableBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        tripId: true,
        status: true,
        bookingReference: true,
        tickets: { select: { isBoarded: true } },
        rating: { select: { rating: true, busRating: true, supervisorRating: true, driverRating: true, comment: true, createdAt: true } },
        trip: {
          select: {
            origin: true,
            destination: true,
            departureTime: true,
            arrivalTime: true,
            estimatedArrivalAt: true,
            executedAt: true,
            liveStatus: true,
            tripStatus: true,
            _count: { select: { supervisors: true, drivers: true } },
          },
        },
      },
    });
    if (!booking || booking.userId !== userId) throw new NotFoundException('Booking not found');
    return booking;
  }

  /** Over for the customer: the crew said it arrived, or it was executed and its arrival time has passed. */
  private isFinished(trip: { executedAt: Date | null; liveStatus: string; tripStatus: string; arrivalTime: Date; estimatedArrivalAt: Date | null }) {
    if (trip.liveStatus === 'ARRIVED' || trip.tripStatus === 'COMPLETED') return true;
    return !!trip.executedAt && Date.now() >= (trip.estimatedArrivalAt ?? trip.arrivalTime).getTime();
  }

  private whyNot(booking: Awaited<ReturnType<TripFollowupService['ratableBooking']>>) {
    if (booking.rating) return 'ALREADY_RATED';
    if (!RATABLE_STATUSES.includes(booking.status)) return 'NOT_CONFIRMED';
    const { trip } = booking;
    const isFinished = this.isFinished(trip);
    if (!isFinished) return 'NOT_FINISHED';
    if (!booking.tickets.some((ticket) => ticket.isBoarded)) return 'NOT_BOARDED';
    if (Date.now() - trip.departureTime.getTime() > RATING_WINDOW_MS) return 'TOO_LATE';
    return null;
  }

  async ratingOf(userId: string, bookingId: string) {
    const booking = await this.ratableBooking(userId, bookingId);
    const reason = this.whyNot(booking);
    return {
      canRate: reason === null,
      isFinished: this.isFinished(booking.trip),
      reason,
      rating: booking.rating,
      bookingReference: booking.bookingReference,
      trip: { origin: booking.trip.origin, destination: booking.trip.destination, departureTime: booking.trip.departureTime },
      hasSupervisor: booking.trip._count.supervisors > 0,
      hasDriver: booking.trip._count.drivers > 0,
    };
  }

  async rate(userId: string, bookingId: string, dto: RateTripDto) {
    const booking = await this.ratableBooking(userId, bookingId);
    const reason = this.whyNot(booking);
    if (reason === 'ALREADY_RATED') throw new ConflictException('قيّمت هذه الرحلة من قبل، شكرًا لك');
    if (reason === 'NOT_FINISHED') throw new ConflictException('يمكن تقييم الرحلة بعد انتهائها');
    if (reason === 'NOT_BOARDED') throw new ConflictException('التقييم متاح لمن سافر في الرحلة فقط');
    if (reason === 'TOO_LATE') throw new ConflictException('انتهت مدة تقييم هذه الرحلة');
    if (reason) throw new ConflictException('لا يمكن تقييم هذا الحجز');
    try {
      const rating = await this.prisma.tripRating.create({
        data: {
          bookingId,
          tripId: booking.tripId,
          rating: dto.rating,
          busRating: dto.busRating ?? null,
          supervisorRating: dto.supervisorRating ?? null,
          driverRating: dto.driverRating ?? null,
          comment: dto.comment?.trim() || null,
        },
        select: { rating: true, busRating: true, supervisorRating: true, driverRating: true, comment: true, createdAt: true },
      });
      return { success: true, rating };
    } catch (err) {
      // A double tap: the unique booking id keeps the first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('قيّمت هذه الرحلة من قبل، شكرًا لك');
      throw err;
    }
  }

  /** The trip's ratings for the panel: the averages and each customer's words. */
  async tripRatings(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, executedAt: true } });
    if (!trip) throw new NotFoundException('Trip not found');
    const [rows, riders] = await Promise.all([
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
    ]);
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

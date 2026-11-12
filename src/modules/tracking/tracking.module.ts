import { Body, Controller, ForbiddenException, ConflictException, Get, Injectable, Module, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { AppSettingsService, withinHours } from '../../common/services/app-settings.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { RoutingService } from '../../common/services/routing.service';
import { CREW_WINDOW_SELECT, crewWindow } from '../../common/utils/crew-window.util';
import { distanceInMeters } from '../../common/utils/geo.util';
import { formatRiyadhTime } from '../../common/utils/time.util';
import { boardingOfBookings } from '../../common/utils/ticket-boarding.util';
import { tripDayWindow } from '../../common/utils/trip-day.util';
import { clockMinutes, markPassedLegs, orderRouteLegs } from '../../common/utils/trip-route.util';

const HOUR_MS = 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * HOUR_MS;
/** A position older than this no longer describes where the bus is now. */
const LIVE_FOR_MS = 2 * 60 * 1000;
const MAX_NOTICES = 10;
/** Far more buses than the company runs at once; only a guard against an unbounded answer. */
const MAX_LIVE_TRIPS = 300;

class ReportLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  speed?: number;
}

@Injectable()
class TrackingService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private routing: RoutingService,
    private realtime: RealtimeService,
  ) {}

  private async assertAssigned(actor: { userId: string; role: string }, tripId: string) {
    if (actor.role === 'ADMIN') return;
    const assigned = await this.prisma.trip.count({
      where: {
        id: tripId,
        OR: [{ drivers: { some: { userId: actor.userId } } }, { supervisors: { some: { userId: actor.userId } } }],
      },
    });
    if (assigned === 0) throw new ForbiddenException('هذه الرحلة غير مسندة إليك');
  }

  async report(actor: { userId: string; role: string }, tripId: string, dto: ReportLocationDto) {
    await this.assertAssigned(actor, tripId);
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        tripStatus: true,
        arrivalTime: true,
        liveStatus: true,
        currentBoardingPointId: true,
        boardingPoints: { select: { id: true, name: true, lat: true, lng: true } },
        ...CREW_WINDOW_SELECT,
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (actor.role !== 'ADMIN' && !crewWindow(trip).isTripOpen) throw new ConflictException('لم تُفتح هذه الرحلة لك بعد');
    const now = Date.now();
    const limits = await this.appSettings.numbers('trackingOpensBeforeHours', 'trackingClosesAfterHours', 'arrivalRadiusMeters');
    // The crew said the trip is over (arrival also completes it), so a phone left broadcasting is told to stop tracking its owner.
    if (trip.liveStatus === 'ARRIVED' || trip.tripStatus === 'COMPLETED') throw new ConflictException('انتهت الرحلة وتوقف بث الموقع');
    // Keeps a crew member's phone from being tracked outside the trip they are working.
    if (
      trip.tripStatus !== 'PUBLISHED' ||
      now < trip.departureTime.getTime() - limits.trackingOpensBeforeHours * HOUR_MS ||
      now > trip.arrivalTime.getTime() + limits.trackingClosesAfterHours * HOUR_MS
    ) {
      throw new ConflictException(`بث الموقع متاح قبل الانطلاق ${withinHours(limits.trackingOpensBeforeHours)} وحتى بعد الوصول ${withinHours(limits.trackingClosesAfterHours)} فقط`);
    }
    // The server clock stamps the position, so a device cannot make an old one look fresh.
    const data = { lat: dto.lat, lng: dto.lng, speed: dto.speed ?? null, reportedById: actor.userId, recordedAt: new Date() };
    await this.prisma.tripLocation.upsert({ where: { tripId }, create: { tripId, ...data }, update: data });
    this.realtime.tripLocation(tripId, { lat: data.lat, lng: data.lng, speed: data.speed, recordedAt: data.recordedAt, isLive: true });
    // Only a suggestion: the crew confirms, because passing near a point is not the same as stopping there.
    const nearPoint = trip.boardingPoints
      .flatMap((point) => (point.lat !== null && point.lng !== null && point.id !== trip.currentBoardingPointId ? [{ id: point.id, name: point.name, meters: distanceInMeters(dto, { lat: point.lat, lng: point.lng }) }] : []))
      // Close enough to a boarding point to ask the crew whether the bus has arrived.
      .filter((point) => point.meters <= limits.arrivalRadiusMeters)
      .sort((a, b) => a.meters - b.meters)[0];
    return { success: true, recordedAt: data.recordedAt, nearPoint: nearPoint ? { id: nearPoint.id, name: nearPoint.name, meters: Math.round(nearPoint.meters) } : null };
  }

  async stop(actor: { userId: string; role: string }, tripId: string) {
    await this.assertAssigned(actor, tripId);
    await this.prisma.tripLocation.deleteMany({ where: { tripId } });
    this.realtime.tripLocation(tripId, null);
    return { success: true };
  }

  /**
   * Every trip that is out now, for the operations map: the crew said it is on the road or at a point, or it is
   * sending its position. Bounded by the same window the crew may broadcast in, so a trip nobody closed does not
   * stay on the map for days. The map follows later positions over the staff tracking room.
   */
  async live() {
    const now = Date.now();
    const limits = await this.appSettings.numbers('trackingOpensBeforeHours', 'trackingClosesAfterHours');
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: 'PUBLISHED',
        liveStatus: { not: 'ARRIVED' },
        departureTime: { lte: new Date(now + limits.trackingOpensBeforeHours * HOUR_MS) },
        arrivalTime: { gte: new Date(now - limits.trackingClosesAfterHours * HOUR_MS) },
        OR: [{ liveStatus: { in: ['AT_POINT', 'ON_ROAD'] } }, { location: { isNot: null } }],
      },
      orderBy: { departureTime: 'asc' },
      take: MAX_LIVE_TRIPS,
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        departureTime: true,
        arrivalTime: true,
        liveStatus: true,
        liveStatusAt: true,
        currentBoardingPointId: true,
        boardingPoints: { select: { id: true, name: true, time: true, lat: true, lng: true } },
        statusUpdates: { where: { status: 'AT_POINT' }, select: { boardingPointId: true, pointName: true } },
        bus: { select: { plateNumber: true } },
        location: { select: { lat: true, lng: true, speed: true, recordedAt: true } },
        drivers: { select: { user: { select: { name: true, phone: true } } } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true } } } },
      },
    });
    return {
      serverTime: new Date(now),
      liveForMs: LIVE_FOR_MS,
      trips: trips.map(({ boardingPoints, statusUpdates, location, drivers, supervisors, bus, currentBoardingPointId, ...trip }) => {
        const reached = new Set(statusUpdates.flatMap((row) => [row.boardingPointId, row.pointName]));
        return {
          ...trip,
          busPlate: bus?.plateNumber ?? null,
          drivers: drivers.map((row) => row.user),
          supervisors: supervisors.map((row) => row.user),
          points: [...boardingPoints]
            .sort((a, b) => a.time.localeCompare(b.time))
            .map((point) => ({ ...point, isCurrent: point.id === currentBoardingPointId, reached: reached.has(point.id) || reached.has(point.name) })),
          location: location ? { ...location, isLive: now - location.recordedAt.getTime() <= LIVE_FOR_MS } : null,
        };
      }),
    };
  }

  /** The same branch rule as branch bookings: another branch's booking stays hidden unless this employee works the trip. */
  private async staffCanSee(actor: { userId: string; permissions: string[] }, booking: { branchId: string | null; tripId: string }) {
    if (!actor.permissions.includes('bookings.view')) return false;
    if (actor.permissions.includes('bookings.all_branches')) return true;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    if (me?.branchId && booking.branchId === me.branchId) return true;
    const crew = await this.prisma.trip.count({
      where: { id: booking.tripId, OR: [{ drivers: { some: { userId: actor.userId } } }, { supervisors: { some: { userId: actor.userId } } }] },
    });
    return crew > 0;
  }

  async forBooking(actor: { userId: string; permissions: string[] }, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        userId: true,
        tripId: true,
        branchId: true,
        status: true,
        boardingPointId: true,
        boardingPointName: true,
        boardingPointTime: true,
        passengers: { select: { seatNumber: true, ticket: { select: { isBoarded: true } } } },
        // Staff notes in other events are not the customer's concern; this one was written for them.
        events: { where: { action: 'CREW_NOTICE' }, orderBy: { createdAt: 'desc' }, take: MAX_NOTICES, select: { id: true, after: true, createdAt: true } },
        trip: {
          select: {
            tripCode: true,
            origin: true,
            destination: true,
            departureTime: true,
            arrivalTime: true,
            tripStatus: true,
            liveStatus: true,
            liveStatusAt: true,
            currentBoardingPointId: true,
            boardingPoints: { select: { id: true, name: true, time: true, address: true, lat: true, lng: true } },
            statusUpdates: { orderBy: { createdAt: 'desc' }, select: { id: true, status: true, boardingPointId: true, pointName: true, createdAt: true } },
            bus: { select: { plateNumber: true } },
            location: { select: { lat: true, lng: true, speed: true, recordedAt: true } },
            itineraryStops: { orderBy: { sortOrder: 'asc' }, select: { id: true, time: true, title: true, desc: true, kind: true } },
            supervisors: { orderBy: { isPrimary: 'desc' }, take: 1, select: { user: { select: { name: true, phone: true } } } },
          },
        },
      },
    });
    if (!booking || (booking.userId !== actor.userId && !(await this.staffCanSee(actor, booking)))) throw new NotFoundException('Booking not found');
    if (booking.status === 'CANCELLED') throw new ConflictException('هذا الحجز ملغى');

    const { trip } = booking;
    const now = Date.now();
    const start = trip.departureTime.getTime();
    const end = trip.arrivalTime.getTime();
    // The crew's word beats the timetable, which cannot know about a delay.
    const stage =
      trip.tripStatus === 'CANCELLED' ? 'CANCELLED'
        : trip.liveStatus === 'ARRIVED' ? 'ARRIVED'
        : trip.liveStatus === 'ON_ROAD' ? 'IN_PROGRESS'
        : now < start ? 'NOT_STARTED'
          : now < end ? 'IN_PROGRESS'
            : 'ARRIVED';

    // Stop times carry no date, so each is read as the first time that clock comes round after departure; a night trip passes midnight.
    const departureClock = clockMinutes(new Date(start + RIYADH_OFFSET_MS).toISOString().slice(11, 16));
    const minutesIntoTrip = (now - start) / 60_000;
    const stops = trip.itineraryStops;
    const nextStop = stage === 'IN_PROGRESS' ? stops.find((s) => (clockMinutes(s.time) - departureClock + 1440) % 1440 > minutesIntoTrip) ?? null : null;

    const { supervisorContactOpensBeforeHours: contactOpensBeforeHours, trackingClosesAfterHours } = await this.appSettings.numbers('supervisorContactOpensBeforeHours', 'trackingClosesAfterHours');
    const showContact = stage !== 'ARRIVED' && stage !== 'CANCELLED' && now >= start - contactOpensBeforeHours * HOUR_MS;
    const supervisor = trip.supervisors[0]?.user;
    // Once the crew says the bus has arrived, its position is nobody's business any more.
    const position = trip.liveStatus === 'ARRIVED' ? null : trip.location;
    const isMine = (point: { id: string; name: string }) => booking.boardingPointId === point.id || booking.boardingPointName === point.name;
    const reached = new Set(trip.statusUpdates.filter((row) => row.status === 'AT_POINT').flatMap((row) => [row.boardingPointId, row.pointName]));
    const points = [...trip.boardingPoints]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((point) => ({ ...point, isMine: isMine(point), isCurrent: point.id === trip.currentBoardingPointId, reached: reached.has(point.id) || reached.has(point.name) }));

    const hasArrived = trip.liveStatus === 'ARRIVED';
    const route = [
      ...markPassedLegs(orderRouteLegs(points, stops, trip.destination, trip.departureTime), hasArrived),
      { id: 'destination', kind: 'DESTINATION', name: trip.destination, time: formatRiyadhTime(trip.arrivalTime), isMine: false, isCurrent: hasArrived, isPassed: false },
    ];

    const statusNotice = (row: (typeof trip.statusUpdates)[number]) =>
      row.status === 'AT_POINT' ? `وصلت الحافلة إلى ${row.pointName}` : row.status === 'ON_ROAD' ? 'الحافلة في الطريق' : `وصلت الحافلة إلى ${trip.destination}`;
    const notices = [
      ...trip.statusUpdates.map((row) => ({ id: row.id, message: statusNotice(row), at: row.createdAt })),
      ...booking.events.map((event) => ({ id: event.id, message: (event.after as { message?: string } | null)?.message ?? '', at: event.createdAt })),
    ]
      .filter((notice) => notice.message)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, MAX_NOTICES);

    const tripDay = tripDayWindow({ ...trip, bookingStatus: booking.status }, trackingClosesAfterHours);
    // Anyone still waiting in the booking needs to know where the bus is.
    const isAllBoarded = booking.passengers.length > 0 && booking.passengers.every((passenger) => passenger.ticket?.isBoarded);
    const myPoint = points.find((point) => point.isMine && !point.reached && !point.isCurrent && point.lat !== null && point.lng !== null);
    // Each answer costs money, so only someone still waiting for a bus that is really moving gets one.
    const isBusLive = !!position && now - position.recordedAt.getTime() <= LIVE_FOR_MS;
    const etaToMyPoint =
      myPoint && isBusLive && tripDay.isOpen && !isAllBoarded && stage !== 'CANCELLED' && stage !== 'ARRIVED'
        ? await this.routing.etaToPoint(booking.tripId, myPoint.id, { lat: position.lat, lng: position.lng }, { lat: myPoint.lat!, lng: myPoint.lng! })
        : null;

    const boarding = (await boardingOfBookings(this.prisma, [{ ...booking, id: bookingId }])).get(bookingId) ?? null;

    return {
      tripDay,
      seats: booking.passengers.map((passenger) => passenger.seatNumber).sort((a, b) => Number(a) - Number(b)),
      isAllBoarded,
      boarding,
      etaToMyPoint,
      route,
      notices,
      trip: {
        tripCode: trip.tripCode,
        origin: trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        arrivalTime: trip.arrivalTime,
        busPlate: trip.bus?.plateNumber ?? null,
      },
      boardingPoint: booking.boardingPointName ? { name: booking.boardingPointName, time: booking.boardingPointTime } : null,
      stage,
      liveStatus: trip.liveStatus,
      liveStatusAt: trip.liveStatusAt,
      points,
      // A straight line, so the app words it as approximate. Pointless once the bus has been there.
      distanceToMyPointKm: (() => {
        const mine = points.find((point) => point.isMine && !point.reached && point.lat !== null && point.lng !== null);
        return mine && position ? Math.round(distanceInMeters(position, { lat: mine.lat!, lng: mine.lng! }) / 100) / 10 : null;
      })(),
      // Share of the scheduled time elapsed, not of the road; distance needs a mapped route.
      scheduleProgress: stage === 'ARRIVED' ? 100 : stage === 'IN_PROGRESS' ? Math.round(((now - start) / (end - start)) * 100) : 0,
      stops,
      nextStop,
      supervisor: supervisor ? { name: supervisor.name, phone: showContact ? supervisor.phone : null } : null,
      location:
        position && stage !== 'CANCELLED'
          ? {
              lat: position.lat,
              lng: position.lng,
              speed: position.speed,
              recordedAt: position.recordedAt,
              isLive: now - position.recordedAt.getTime() <= LIVE_FOR_MS,
            }
          : null,
    };
  }
}

@ApiTags('Tracking')
@Controller('tracking')
@ApiBearerAuth()
class TrackingController {
  constructor(private tracking: TrackingService) {}

  @Post('trips/:tripId/location')
  @SkipAudit()
  @RequirePermission('crew.track')
  @ApiOperation({ summary: 'Crew reports the current bus position' })
  report(@Req() req, @Param('tripId') tripId: string, @Body() dto: ReportLocationDto) {
    return this.tracking.report(req.user, tripId, dto);
  }

  @Post('trips/:tripId/stop')
  @RequirePermission('crew.track')
  @ApiOperation({ summary: 'Crew stops sharing and clears the last position' })
  stop(@Req() req, @Param('tripId') tripId: string) {
    return this.tracking.stop(req.user, tripId);
  }

  @Get('live')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiOperation({ summary: 'Trips out now with their last bus position, for the operations map' })
  live() {
    return this.tracking.live();
  }

  @Get('bookings/:bookingId')
  @ApiOperation({ summary: 'Live status of the trip behind a booking (owner or staff)' })
  forBooking(@Req() req, @Param('bookingId') bookingId: string) {
    return this.tracking.forBooking(req.user, bookingId);
  }
}

@Module({
  controllers: [TrackingController],
  providers: [TrackingService],
})
export class TrackingModule {}

import { Body, Controller, ForbiddenException, ConflictException, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Public, RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { AppSettingsService, withinHours } from '../../common/services/app-settings.service';
import { PrismaService } from '../../common/services/prisma.service';
import { MAX_ROAD_POINTS, RoutingService } from '../../common/services/routing.service';
import { CREW_ALERT, CrewWatchdogService, supervisorCheckStarted, supervisorWasActive } from './crew-watchdog.service';
import { GpsDeviceService, parseFix } from './gps-device.service';
import { nearestBoardingPoint, TripLocationService } from './trip-location.service';
import { CREW_WINDOW_SELECT, crewWindow } from '../../common/utils/crew-window.util';
import { distanceInMeters } from '../../common/utils/geo.util';
import { bookedOnTrips } from '../../common/utils/linked-seats.util';
import { formatRiyadhTime } from '../../common/utils/time.util';
import { boardingOfBookings } from '../../common/utils/ticket-boarding.util';
import { tripDayWindow } from '../../common/utils/trip-day.util';
import { clockMinutes, markPassedLegs, minutesAfterDeparture, orderRouteLegs } from '../../common/utils/trip-route.util';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
const RIYADH_OFFSET_MS = 3 * HOUR_MS;
/** A position older than this no longer describes where the bus is now. */
const LIVE_FOR_MS = 2 * 60 * 1000;
/** Behind the timetable by this much or more and the operations map marks the trip late. */
const LATE_AFTER_MINUTES = 5;
/** A trip leaving within this many hours with no supervisor is raised on the map, so there is time to assign one. */
const SUPERVISOR_ALERT_HOURS = 12;
const MAX_NOTICES = 10;
/** Far more buses than the company runs at once; only a guard against an unbounded answer. */
const MAX_LIVE_TRIPS = 300;
const MAX_ALERTS = 20;
const REPORT_LABELS: Record<string, string> = { DELAY: 'تأخير', BREAKDOWN: 'عطل', ACCIDENT: 'حادث', PASSENGER: 'راكب', OTHER: 'بلاغ' };

/** Midnight to midnight in Riyadh, the day the office means by "today". */
function riyadhDay(now: number) {
  const start = Math.floor((now + RIYADH_OFFSET_MS) / DAY_MS) * DAY_MS - RIYADH_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

type Checkpoint = { scheduledAt: number; reachedAt: number | null };

/**
 * How far behind the timetable the trip is now, in minutes: how late it reached the last place the crew reported,
 * or, once the next place's time has passed without it, how long it has been due there. Departure and the arrival
 * at the destination count as places, so a bus that has not left, or is still out past its arrival, is late too.
 */
function delayMinutes(checkpoints: Checkpoint[], now: number) {
  const ordered = [...checkpoints].sort((a, b) => a.scheduledAt - b.scheduledAt);
  const lastReached = ordered.reduce((last, point, index) => (point.reachedAt !== null ? index : last), -1);
  const behindAtLast = lastReached >= 0 ? ordered[lastReached].reachedAt! - ordered[lastReached].scheduledAt : 0;
  const next = ordered.slice(lastReached + 1).find((point) => point.reachedAt === null);
  const overdue = next ? now - next.scheduledAt : 0;
  return Math.max(0, Math.floor(Math.max(behindAtLast, overdue) / MINUTE_MS));
}

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

class RoadPointDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;
}

class RoadDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ROAD_POINTS)
  @ValidateNested({ each: true })
  @Type(() => RoadPointDto)
  points: RoadPointDto[];
}

class HeartbeatDto {
  /** The trip whose screen is open, when one is. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tripId?: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: string;
}

class GpsDeviceDto {
  /** The tracker's IMEI or the id set in its tracking app. */
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: 'رقم الجهاز يقبل الحروف الإنجليزية والأرقام و . _ : - فقط' })
  deviceId: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

@Injectable()
class TrackingService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private routing: RoutingService,
    private locations: TripLocationService,
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
    // Sending a position means the app is open: the crew watchdog counts it like a heartbeat.
    await this.locations.crewSeen(actor.userId);
    // The server clock stamps the position, so a device cannot make an old one look fresh. While the bus's GPS device
    // is reporting, the phone's fix is not used, but the crew is still asked about a point it is near.
    const result = await this.locations.record(tripId, { lat: dto.lat, lng: dto.lng, speed: dto.speed ?? null, source: 'PHONE', reportedById: actor.userId, recordedAt: new Date() });
    // Only a suggestion: the crew confirms, because passing near a point is not the same as stopping there.
    const nearPoint = nearestBoardingPoint(trip.boardingPoints, dto, trip.currentBoardingPointId, limits.arrivalRadiusMeters);
    return { success: true, recordedAt: result.recordedAt, source: result.source, nearPoint };
  }

  /** For the trip's page in the panel: whether the supervisors opened the app, where the position comes from, and the watchdog's open alerts. */
  async crewStatus(tripId: string) {
    const now = Date.now();
    const limits = await this.appSettings.numbers('supervisorAppCheckBeforeMinutes', 'gpsDeviceStaleMinutes');
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        tripStatus: true,
        liveStatus: true,
        departureTime: true,
        location: { select: { source: true, recordedAt: true } },
        bus: { select: { gpsDevice: { select: { deviceId: true, isEnabled: true, lastSeenAt: true } } } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { id: true, name: true, crewAppSeenAt: true } } } },
        crewAlerts: { orderBy: { createdAt: 'desc' }, select: { kind: true, createdAt: true, resolvedAt: true } },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    const supervisors = trip.supervisors.map((row) => row.user);
    // Only while the trip is still to run or on the road; afterwards the supervisors' app activity is no longer news.
    const checkStarted = trip.tripStatus === 'PUBLISHED' && trip.liveStatus !== 'ARRIVED' && supervisorCheckStarted(trip.departureTime, limits.supervisorAppCheckBeforeMinutes, now);
    const device = trip.bus?.gpsDevice ?? null;
    return {
      checkStarted,
      supervisorAppNotOpened:
        trip.tripStatus === 'PUBLISHED' &&
        trip.liveStatus === 'NOT_STARTED' &&
        supervisors.length > 0 &&
        checkStarted &&
        !supervisors.some((user) => supervisorWasActive(user, trip.departureTime, limits.supervisorAppCheckBeforeMinutes)),
      supervisors: supervisors.map((user) => ({ id: user.id, name: user.name, appSeenAt: user.crewAppSeenAt })),
      location: trip.location ? { source: trip.location.source, recordedAt: trip.location.recordedAt, isLive: now - trip.location.recordedAt.getTime() <= LIVE_FOR_MS } : null,
      gpsDevice: device ? { ...device, isOnline: device.isEnabled && !!device.lastSeenAt && now - device.lastSeenAt.getTime() <= limits.gpsDeviceStaleMinutes * MINUTE_MS } : null,
      alerts: trip.crewAlerts,
    };
  }

  /** The crew app is open (sent on foreground and while a trip screen is open), for the "did not open the app" alert. */
  async heartbeat(actor: { userId: string; role: string }, dto: HeartbeatDto) {
    if (actor.role === 'PASSENGER') return { ok: true };
    if (dto.tripId) await this.assertAssigned(actor, dto.tripId);
    const now = new Date();
    await this.locations.crewSeen(actor.userId, now);
    return { ok: true, seenAt: now };
  }

  /** The road the bus should take through the crew's places, drawn on their map. Null means straight lines. */
  async road(actor: { userId: string; role: string }, tripId: string, dto: RoadDto) {
    await this.assertAssigned(actor, tripId);
    return { road: await this.routing.roadThrough(dto.points.map(({ lat, lng }) => ({ lat, lng }))) };
  }

  async stop(actor: { userId: string; role: string }, tripId: string) {
    await this.assertAssigned(actor, tripId);
    // Only the phone's position leaves the map; one from the bus's GPS device is not the crew's to clear.
    await this.locations.clearPhone(tripId);
    return { success: true };
  }

  /**
   * Every trip that is out now, for the operations map: the crew said it is on the road or at a point, or it is
   * sending its position. Bounded by the same window the crew may broadcast in, so a trip nobody closed does not
   * stay on the map for days. The map follows later positions over the staff tracking room.
   */
  async live() {
    const now = Date.now();
    const limits = await this.appSettings.numbers('trackingOpensBeforeHours', 'trackingClosesAfterHours', 'supervisorAppCheckBeforeMinutes', 'gpsDeviceStaleMinutes');
    const today = riyadhDay(now);
    const [trips, waiting, arrived, unsupervised, crewAlerts] = await Promise.all([
      this.liveTrips(now, limits),
      // Published for today and not yet moving, the earliest first: the next ones the office has to watch go out.
      this.prisma.trip.findMany({
        where: { tripStatus: 'PUBLISHED', liveStatus: 'NOT_STARTED', location: { is: null }, departureTime: { gte: today.start, lt: today.end } },
        orderBy: { departureTime: 'asc' },
        select: { id: true, tripCode: true, departureTime: true },
      }),
      this.prisma.trip.findMany({
        where: { liveStatus: 'ARRIVED', liveStatusAt: { gte: today.start, lt: today.end } },
        orderBy: { liveStatusAt: 'desc' },
        select: { id: true, tripCode: true, liveStatusAt: true },
      }),
      this.prisma.trip.findMany({
        where: {
          tripStatus: 'PUBLISHED',
          liveStatus: { not: 'ARRIVED' },
          departureTime: { gte: new Date(now - limits.trackingClosesAfterHours * HOUR_MS), lte: new Date(now + SUPERVISOR_ALERT_HOURS * HOUR_MS) },
          supervisors: { none: {} },
        },
        orderBy: { departureTime: 'asc' },
        take: MAX_ALERTS,
        select: { id: true, tripCode: true, departureTime: true },
      }),
      // Raised by the crew watchdog and still standing: a supervisor who has not opened the app, a bus gone silent.
      this.prisma.tripCrewAlert.findMany({
        where: { resolvedAt: null, createdAt: { gte: new Date(now - DAY_MS) } },
        orderBy: { createdAt: 'desc' },
        take: MAX_ALERTS,
        select: {
          id: true,
          kind: true,
          tripId: true,
          createdAt: true,
          trip: { select: { tripCode: true, departureTime: true, supervisors: { orderBy: { isPrimary: 'desc' }, take: 1, select: { user: { select: { name: true } } } } } },
        },
      }),
    ]);
    const liveIds = trips.trips.map((trip) => trip.id);
    const reports = liveIds.length
      ? await this.prisma.tripReport.findMany({
          where: { tripId: { in: liveIds }, status: { not: 'RESOLVED' } },
          orderBy: { createdAt: 'desc' },
          take: MAX_ALERTS,
          select: { id: true, tripId: true, category: true, type: true, details: true, createdAt: true, trip: { select: { tripCode: true } } },
        })
      : [];
    const upcoming = waiting.find((trip) => trip.departureTime.getTime() >= now) ?? null;
    const notLeft = waiting.filter((trip) => now - trip.departureTime.getTime() >= LATE_AFTER_MINUTES * MINUTE_MS);

    const alerts = [
      ...reports.map((report) => ({
        id: `report:${report.id}`,
        tone: report.category === 'SOS' ? ('danger' as const) : ('warning' as const),
        tripId: report.tripId,
        message: `${report.trip.tripCode}: ${report.category === 'SOS' ? 'استغاثة' : REPORT_LABELS[report.type] ?? 'بلاغ'} من الطاقم — ${report.details.slice(0, 80)}`,
        at: report.createdAt,
        href: '/trip-reports',
      })),
      ...crewAlerts.map((alert) => ({
        id: `crew:${alert.id}`,
        tone: alert.kind === CREW_ALERT.TRACKING_SILENT ? ('danger' as const) : ('warning' as const),
        tripId: alert.tripId,
        message:
          alert.kind === CREW_ALERT.TRACKING_SILENT
            ? `${alert.trip.tripCode}: انقطع موقع الحافلة (لا جوال المشرف ولا جهاز GPS) — تواصل مع الطاقم`
            : `${alert.trip.tripCode}: المشرف ${alert.trip.supervisors[0]?.user.name ?? ''} لم يفتح التطبيق، والانطلاق ${formatRiyadhTime(alert.trip.departureTime)}`,
        at: alert.createdAt,
        href: `/trips/${alert.tripId}`,
      })),
      ...notLeft.map((trip) => ({
        id: `not-left:${trip.id}`,
        tone: 'warning' as const,
        tripId: trip.id,
        message: `${trip.tripCode} لم تنطلق بعد، وموعدها ${formatRiyadhTime(trip.departureTime)}`,
        at: trip.departureTime,
        href: `/trips/${trip.id}`,
      })),
      ...unsupervised.map((trip) => ({
        id: `no-supervisor:${trip.id}`,
        tone: 'warning' as const,
        tripId: trip.id,
        message: `${trip.tripCode} ${trip.departureTime < today.end ? 'اليوم' : 'غدًا'} ${formatRiyadhTime(trip.departureTime)} بلا مشرف — أسند مشرفًا قبل الانطلاق`,
        at: trip.departureTime,
        href: `/trips/${trip.id}`,
      })),
    ].slice(0, MAX_ALERTS);

    return {
      ...trips,
      lateAfterMinutes: LATE_AFTER_MINUTES,
      today: {
        waiting: { count: waiting.length, next: upcoming && { id: upcoming.id, tripCode: upcoming.tripCode, departureTime: upcoming.departureTime } },
        arrived: { count: arrived.length, last: arrived[0] ? { id: arrived[0].id, tripCode: arrived[0].tripCode, at: arrived[0].liveStatusAt } : null },
      },
      alerts,
    };
  }

  private async liveTrips(now: number, limits: { trackingOpensBeforeHours: number; trackingClosesAfterHours: number; supervisorAppCheckBeforeMinutes: number; gpsDeviceStaleMinutes: number }) {
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
        estimatedArrivalAt: true,
        liveStatus: true,
        liveStatusAt: true,
        currentBoardingPointId: true,
        boardingPoints: { select: { id: true, name: true, time: true, lat: true, lng: true } },
        statusUpdates: { orderBy: { createdAt: 'asc' }, select: { status: true, boardingPointId: true, pointName: true, createdAt: true } },
        bus: { select: { plateNumber: true, gpsDevice: { select: { deviceId: true, isEnabled: true, lastSeenAt: true } } } },
        location: { select: { lat: true, lng: true, speed: true, recordedAt: true, source: true, accuracy: true, heading: true } },
        drivers: { select: { user: { select: { name: true, phone: true } } } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true, crewAppSeenAt: true } } } },
        crewAlerts: { where: { resolvedAt: null }, select: { kind: true, createdAt: true } },
      },
    });
    const deviceStaleMs = limits.gpsDeviceStaleMinutes * MINUTE_MS;
    const booked = await bookedOnTrips(this.prisma, trips.map((trip) => trip.id));
    return {
      serverTime: new Date(now),
      liveForMs: LIVE_FOR_MS,
      trips: trips.map(({ boardingPoints, statusUpdates, location, drivers, supervisors, bus, currentBoardingPointId, estimatedArrivalAt, crewAlerts, ...trip }) => {
        const device = bus?.gpsDevice ?? null;
        const supervisorUsers = supervisors.map((row) => row.user);
        // Shown on the map as «لم يفتح التطبيق» from the check's start until a supervisor opens it.
        const supervisorAppNotOpened =
          trip.liveStatus === 'NOT_STARTED' &&
          supervisorUsers.length > 0 &&
          supervisorCheckStarted(trip.departureTime, limits.supervisorAppCheckBeforeMinutes, now) &&
          !supervisorUsers.some((user) => supervisorWasActive(user, trip.departureTime, limits.supervisorAppCheckBeforeMinutes));
        // The first time the crew said so: a point visited twice was still reached when it was first reported.
        const reachedAt = new Map<string, Date>();
        for (const row of statusUpdates.filter((update) => update.status === 'AT_POINT')) {
          for (const key of [row.boardingPointId, row.pointName]) if (key && !reachedAt.has(key)) reachedAt.set(key, row.createdAt);
        }
        const departedAt = statusUpdates.find((row) => row.status === 'ON_ROAD')?.createdAt ?? null;
        const departure = trip.departureTime.getTime();
        // The customers' arrival time, not the end of a round trip.
        const scheduledArrival = estimatedArrivalAt ?? trip.arrivalTime;
        const points = [...boardingPoints]
          .sort((a, b) => minutesAfterDeparture(a.time, trip.departureTime) - minutesAfterDeparture(b.time, trip.departureTime))
          .map((point) => {
            const at = reachedAt.get(point.id) ?? reachedAt.get(point.name) ?? null;
            return { ...point, isCurrent: point.id === currentBoardingPointId, reached: at !== null, reachedAt: at };
          });
        const delay = delayMinutes(
          [
            ...points.map((point) => ({ scheduledAt: departure + minutesAfterDeparture(point.time, trip.departureTime) * MINUTE_MS, reachedAt: point.reachedAt?.getTime() ?? null })),
            { scheduledAt: departure, reachedAt: departedAt?.getTime() ?? null },
            { scheduledAt: scheduledArrival.getTime(), reachedAt: null },
          ],
          now,
        );
        return {
          ...trip,
          scheduledArrivalAt: scheduledArrival,
          departedAt,
          delayMinutes: delay,
          expectedArrivalAt: new Date(Math.max(scheduledArrival.getTime() + delay * MINUTE_MS, now)),
          bookedSeats: booked.get(trip.id)?.seats ?? 0,
          busPlate: bus?.plateNumber ?? null,
          drivers: drivers.map((row) => row.user),
          supervisors: supervisorUsers.map(({ crewAppSeenAt, ...user }) => ({ ...user, appSeenAt: crewAppSeenAt })),
          supervisorAppNotOpened: supervisorAppNotOpened || crewAlerts.some((alert) => alert.kind === CREW_ALERT.SUPERVISOR_APP_NOT_OPENED),
          trackingSilent: crewAlerts.some((alert) => alert.kind === CREW_ALERT.TRACKING_SILENT),
          points,
          location: location ? { ...location, isLive: now - location.recordedAt.getTime() <= LIVE_FOR_MS } : null,
          gpsDevice: device
            ? { deviceId: device.deviceId, isEnabled: device.isEnabled, lastSeenAt: device.lastSeenAt, isOnline: device.isEnabled && !!device.lastSeenAt && now - device.lastSeenAt.getTime() <= deviceStaleMs }
            : null,
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

  @Post('trips/:tripId/road')
  @SkipAudit()
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'The road through the trip places, for the crew map' })
  road(@Req() req, @Param('tripId') tripId: string, @Body() dto: RoadDto) {
    return this.tracking.road(req.user, tripId, dto);
  }

  @Post('trips/:tripId/stop')
  @RequirePermission('crew.track')
  @ApiOperation({ summary: 'Crew stops sharing and clears the last position' })
  stop(@Req() req, @Param('tripId') tripId: string) {
    return this.tracking.stop(req.user, tripId);
  }

  @Post('heartbeat')
  @SkipAudit()
  @HttpCode(200)
  @RequirePermission('crew.trips', 'crew.track')
  @ApiOperation({ summary: 'The crew app is open (foreground or a trip screen); feeds the supervisor-inactivity alert' })
  heartbeat(@Req() req, @Body() dto: HeartbeatDto) {
    return this.tracking.heartbeat(req.user, dto);
  }

  @Get('trips/:tripId/crew-status')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiOperation({ summary: "Supervisors' app activity, position source, GPS device and watchdog alerts for one trip" })
  crewStatus(@Param('tripId') tripId: string) {
    return this.tracking.crewStatus(tripId);
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

/** A bus's fixed GPS tracker: registered by its id, and given a token it sends with each fix. */
@ApiTags('GPS devices')
@Controller('gps-devices')
@ApiBearerAuth()
class GpsDevicesController {
  constructor(private devices: GpsDeviceService) {}

  @Get()
  @RequirePermission('buses.view', 'trips.view')
  @ApiOperation({ summary: 'Every bus GPS device with its last report' })
  list() {
    return this.devices.list();
  }

  @Get('buses/:busId')
  @RequirePermission('buses.view')
  @ApiOperation({ summary: "A bus's GPS device, or null" })
  get(@Param('busId') busId: string) {
    return this.devices.get(busId);
  }

  @Put('buses/:busId')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: "Register or edit a bus's GPS device" })
  save(@Param('busId') busId: string, @Body() dto: GpsDeviceDto) {
    return this.devices.save(busId, dto);
  }

  @Post('buses/:busId/token')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: 'Generate or rotate the device token; shown only in this answer' })
  rotateToken(@Param('busId') busId: string) {
    return this.devices.rotateToken(busId);
  }

  @Delete('buses/:busId')
  @RequirePermission('buses.manage')
  @ApiOperation({ summary: "Remove a bus's GPS device; the phone tracks the bus again" })
  remove(@Param('busId') busId: string) {
    return this.devices.remove(busId);
  }
}

/**
 * Where trackers send their fixes, with no sign-in: the device token is the credential. Speaks the OsmAnd/Traccar
 * HTTP protocol (GET or POST with query parameters, or a form body) and JSON.
 */
@ApiTags('GPS devices')
@Controller('gps')
class GpsIngestController {
  constructor(private devices: GpsDeviceService) {}

  @Post('ingest')
  @Public()
  @SkipAudit()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'A fix from a bus GPS device (OsmAnd/Traccar protocol or JSON), authenticated by its token' })
  ingest(@Req() req) {
    return this.devices.ingest(parseFix(req.query ?? {}, req.body, req.headers ?? {}));
  }

  /** OsmAnd and some trackers send each fix as a GET with query parameters. */
  @Get('ingest')
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The same, as a GET with OsmAnd query parameters' })
  ingestByGet(@Req() req) {
    return this.devices.ingest(parseFix(req.query ?? {}, undefined, req.headers ?? {}));
  }
}

@Module({
  controllers: [TrackingController, GpsDevicesController, GpsIngestController],
  providers: [TrackingService, TripLocationService, GpsDeviceService, CrewWatchdogService],
  exports: [TripLocationService, CrewWatchdogService, GpsDeviceService],
})
export class TrackingModule {}

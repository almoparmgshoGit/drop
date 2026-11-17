import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TripStopReason } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { cityTripWhere, servedCity } from '../../common/utils/branch-city.util';
import { inTravelOrder } from '../../common/utils/trip-route.util';
import { ACTION_PERMISSION, TRIP_STATUS_SELECT, TripStatusAction, TripStatusTrip, tripStatusActions, tripStatusView } from '../../common/utils/trip-status.util';
import { TripsService } from '../trips/trips.service';
import { UpdateTripDto } from '../trips/trips.dto';
import { TicketsService } from '../tickets/tickets.service';

interface Actor {
  userId: string;
  role: string;
  permissions: string[];
}

export interface ApplyTripStatusInput {
  action: TripStatusAction;
  boardingPointId?: string;
  /** DELAY: minutes to add, or a new departure. A negative number brings the trip back toward its first time. */
  minutes?: number;
  departureTime?: string;
  stopReason?: TripStopReason;
  note?: string;
  acknowledgeReturning?: boolean;
}

const HISTORY_LIMIT = 30;
const DAY_MS = 24 * 3_600_000;
const TRAVELLING = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;

/**
 * One place that changes a trip's status, for the dashboard and the staff app alike. Each action goes through the code that
 * already owns it (publishing and delays through the trip edit, the bus's position through the crew's status, cancelling
 * through the trip's cancellation), so what the system does with a status is the same whoever sets it and from where.
 */
@Injectable()
export class TripStatusService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private trips: TripsService,
    private tickets: TicketsService,
  ) {}

  private async read(id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id }, select: TRIP_STATUS_SELECT });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private describe(trip: TripStatusTrip, actor: Actor, trackingGraceHours: number) {
    return {
      id: trip.id,
      tripCode: trip.tripCode,
      tripStatus: trip.tripStatus,
      liveStatus: trip.liveStatus,
      departureTime: trip.departureTime,
      arrivalTime: trip.arrivalTime,
      status: tripStatusView(trip),
      actions: tripStatusActions(trip, actor.permissions, { trackingGraceHours }),
    };
  }

  /** The trip's status, what can be done next, its gathering points (for "the bus is at") and what was done before. */
  async get(actor: Actor, id: string) {
    const trip = await this.read(id);
    const [details, points, history, trackingGraceHours] = await Promise.all([
      this.prisma.trip.findUniqueOrThrow({
        where: { id },
        select: {
          origin: true,
          destination: true,
          currentBoardingPointId: true,
          bus: { select: { plateNumber: true } },
          _count: { select: { bookings: { where: { status: { in: [...TRAVELLING] } } } } },
        },
      }),
      this.prisma.boardingPoint.findMany({ where: { tripId: id }, select: { id: true, name: true, time: true } }),
      this.prisma.tripStatusUpdate.findMany({
        where: { tripId: id },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { id: true, status: true, pointName: true, actorName: true, createdAt: true },
      }),
      this.appSettings.number('trackingClosesAfterHours'),
    ]);
    return {
      ...this.describe(trip, actor, trackingGraceHours),
      origin: details.origin,
      destination: details.destination,
      busPlate: details.bus?.plateNumber ?? null,
      activeBookings: details._count.bookings,
      currentBoardingPointId: details.currentBoardingPointId,
      boardingPoints: inTravelOrder(points),
      history,
    };
  }

  /** The trips staff follow from the app: those under way or leaving within the day, the coming week, or the past week. */
  async list(actor: Actor, scope: 'live' | 'upcoming' | 'recent' = 'live') {
    const now = new Date();
    const city = await servedCity(this.prisma, { userId: actor.userId, permissions: actor.permissions });
    const window: Prisma.TripWhereInput =
      scope === 'upcoming'
        ? { departureTime: { gt: new Date(now.getTime() + DAY_MS), lt: new Date(now.getTime() + 7 * DAY_MS) }, tripStatus: { in: ['DRAFT', 'PUBLISHED'] } }
        : scope === 'recent'
          ? { departureTime: { gt: new Date(now.getTime() - 7 * DAY_MS), lt: now }, tripStatus: { in: ['COMPLETED', 'CANCELLED'] } }
          : {
              tripStatus: 'PUBLISHED',
              OR: [
                { liveStatus: { in: ['AT_POINT', 'ON_ROAD', 'STOPPED'] } },
                // Leaving within the day, or late to leave.
                { liveStatus: 'NOT_STARTED', departureTime: { gt: new Date(now.getTime() - DAY_MS), lt: new Date(now.getTime() + DAY_MS) } },
              ],
            };
    const [trips, trackingGraceHours] = await Promise.all([
      this.prisma.trip.findMany({
        where: { AND: [window, city ? cityTripWhere(city) : {}] },
        orderBy: { departureTime: scope === 'recent' ? 'desc' : 'asc' },
        take: 100,
        select: { ...TRIP_STATUS_SELECT, origin: true, destination: true, bus: { select: { plateNumber: true } } },
      }),
      this.appSettings.number('trackingClosesAfterHours'),
    ]);
    return trips.map((trip) => ({
      ...this.describe(trip, actor, trackingGraceHours),
      origin: trip.origin,
      destination: trip.destination,
      busPlate: trip.bus?.plateNumber ?? null,
    }));
  }

  async apply(actor: Actor, id: string, input: ApplyTripStatusInput) {
    const permission = ACTION_PERMISSION[input.action];
    if (!permission) throw new BadRequestException('إجراء غير معروف');
    if (!actor.permissions.includes(permission)) throw new ForbiddenException('لا تملك صلاحية هذا الإجراء');
    const trip = await this.read(id);
    const trackingGraceHours = await this.appSettings.number('trackingClosesAfterHours');
    // Refused here with a clear reason, rather than deep in the code that owns the action.
    const allowed = tripStatusActions(trip, actor.permissions, { trackingGraceHours }).some((item) => item.action === input.action);
    if (!allowed) throw new ConflictException(`لا يمكن هذا الإجراء والرحلة ${tripStatusView(trip).label}`);
    const name = (await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } }))?.name ?? null;
    const crewActor = { userId: actor.userId, name };

    switch (input.action) {
      case 'PUBLISH':
        await this.trips.updateTrip(id, { tripStatus: 'PUBLISHED' } as UpdateTripDto, crewActor);
        break;
      case 'UNPUBLISH':
        await this.trips.updateTrip(id, { tripStatus: 'DRAFT' } as UpdateTripDto, crewActor);
        break;
      case 'CLOSE_SALES':
      case 'OPEN_SALES':
        await this.setSales(id, input.action === 'CLOSE_SALES', name);
        break;
      case 'DELAY': {
        const target = input.departureTime
          ? new Date(input.departureTime)
          : input.minutes
            ? new Date(trip.departureTime.getTime() + Math.round(input.minutes) * 60_000)
            : null;
        if (!target) throw new BadRequestException('حدد مدة التأخير أو الموعد الجديد');
        await this.trips.delayTrip(id, target, crewActor, input.note);
        break;
      }
      case 'START':
        await this.tickets.startTrip(actor, id, { fromOffice: true });
        break;
      case 'AT_POINT':
        if (!input.boardingPointId) throw new BadRequestException('اختر النقطة التي وصلت إليها الحافلة');
        await this.tickets.updateLiveStatus(actor, id, 'AT_POINT', input.boardingPointId, { fromOffice: true });
        break;
      case 'ON_ROAD':
      case 'ARRIVED':
        await this.tickets.updateLiveStatus(actor, id, input.action, undefined, { fromOffice: true });
        break;
      case 'STOP':
        await this.tickets.stopTrip(actor, id, { reason: input.stopReason ?? 'OFFICE', note: input.note });
        break;
      case 'RESUME':
        await this.tickets.resumeTrip(actor, id);
        break;
      case 'UNDO_ARRIVAL':
        await this.undoArrival(actor, id, name);
        break;
      case 'CANCEL':
        await this.trips.cancelTrip(id, actor.userId, input.note, input.acknowledgeReturning);
        break;
      case 'RESTORE':
        await this.trips.restoreCancelledTrip(id);
        break;
    }
    return this.describe(await this.read(id), actor, trackingGraceHours);
  }

  /** Closing stops new bookings from every channel; the trip runs for those who booked, and its channels stay as they were. */
  private async setSales(id: string, close: boolean, byName: string | null) {
    // The buses of one trip are sold as one, so they close and open together.
    await this.prisma.trip.updateMany({
      where: { OR: [{ id }, { convoyLeadId: id }], tripStatus: 'PUBLISHED' },
      data: close ? { salesClosedAt: new Date(), salesClosedByName: byName } : { salesClosedAt: null, salesClosedByName: null },
    });
  }

  /** Puts a trip marked arrived by mistake back on the road, so the crew can finish it properly. */
  private async undoArrival(actor: Actor, id: string, name: string | null) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${id} FOR UPDATE`;
      const trip = await tx.trip.findUniqueOrThrow({ where: { id }, select: { tripStatus: true, liveStatus: true, financeClosedAt: true } });
      if (trip.tripStatus !== 'COMPLETED' || trip.liveStatus !== 'ARRIVED') throw new ConflictException('هذه الرحلة لم تُسجَّل واصلة');
      if (trip.financeClosedAt) throw new ConflictException('أُقفل حساب هذه الرحلة، فلا يمكن إعادتها جارية');
      await tx.trip.update({ where: { id }, data: { tripStatus: 'PUBLISHED', liveStatus: 'ON_ROAD', liveStatusAt: new Date(), currentBoardingPointId: null } });
      await tx.tripStatusUpdate.create({ data: { tripId: id, status: 'ON_ROAD', actorId: actor.userId, actorName: name } });
      this.realtime.tripChanged(id);
      await this.notifications.toTripCrew(tx, 'CREW_TRIP_STATUS_CHANGED', id, {
        exceptUserId: actor.userId,
        extra: { senderName: name, currentPoint: 'أُلغي تسجيل الوصول، الرحلة في الطريق' },
      });
    });
  }
}

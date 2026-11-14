import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { Prisma, TripLiveStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { NotificationsService, tripValues } from '../../common/services/notifications.service';
import { StationAlertsService } from '../../common/services/station-alerts.service';
import { TicketAlertsService } from '../../common/services/ticket-alerts.service';
import { crewManualEvents, describeEntry, isNotificationEvent, NOTIFICATION_CATALOG, renderNotification } from '../../common/notification-catalog';
import { bookingHasStay } from '../../common/utils/booking-types.util';
import { CREW_WINDOW_SELECT, CrewWindowSettings, crewWindow } from '../../common/utils/crew-window.util';
import { formatRiyadhDate, formatRiyadhTime } from '../../common/utils/time.util';
import { returningBookingIds } from '../../common/utils/linked-seats.util';
import { paymentFigures } from '../../common/utils/payment.util';
import { TICKET_BOARDING_TRIP_SELECT, ticketBoarding } from '../../common/utils/ticket-boarding.util';
import { signPaperCode, verifyPaperCode, verifyTicketToken } from '../../common/utils/ticket-token.util';
import { PROFILE_ACCOUNT_SELECT, PROFILE_PASSENGER_SELECT, passengerProfiles } from '../../common/utils/passenger-profile.util';

interface Actor {
  userId: string;
  role: string;
  permissions: string[];
}

type ScanResult = 'BOARDED' | 'ALREADY_USED' | 'WRONG_TRIP' | 'INVALID' | 'CANCELLED' | 'NOT_PAID' | 'UNPAID_WARNING' | 'CANCELLATION_PENDING' | 'OUTSIDE_WINDOW' | 'WRONG_POINT' | 'TICKET_STOPPED';

/** A boarding the crew's app recorded on the road without internet and sent later: it counts from the moment it was scanned. */
interface OfflineScan {
  scannedAt: Date;
}

/** One boarding queued on the crew's phone without internet: the scanned code (or the ticket picked from the saved list) and when. */
export interface OfflineBoardingItem {
  clientId: string;
  signedToken?: string;
  code?: string;
  ticketNumber?: string;
  scannedAt: string;
  allowUnpaid?: boolean;
}

// The pack carries hashes of the codes, never the codes or the signing secret: 128 bits cannot be guessed or turned back into a ticket.
const OFFLINE_HASH_LENGTH = 32;
const offlineHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, OFFLINE_HASH_LENGTH);
// A queue left on a phone for days is better resolved by the office than boarded from an old scan.
const MAX_OFFLINE_AGE_MS = 72 * 60 * 60 * 1000;

/** Why the server did not take a boarding sent from the road, in the words the crew reads on the trip screen. */
const OFFLINE_REJECT_REASONS: Record<string, string> = {
  WRONG_TRIP: 'التذكرة لرحلة أخرى',
  INVALID: 'التذكرة غير صالحة',
  CANCELLED: 'الحجز ملغى',
  NOT_PAID: 'الحجز غير مدفوع بالكامل',
  UNPAID_WARNING: 'على الراكب مبلغ متبقٍ ولم يُؤكَّد صعوده رغم ذلك',
  CANCELLATION_PENDING: 'طلب إلغاء الحجز قيد المراجعة',
  OUTSIDE_WINDOW: 'وقت المسح خارج وقت الصعود لهذه الرحلة',
  WRONG_POINT: 'نقطة صعود مختلفة',
  TICKET_STOPPED: 'التذكرة موقوفة',
};

/** What the crew chose after a warning: board at another point, or board one who still owes money on a trip that allows it. */
export interface BoardOverrides {
  allowOtherPoint?: boolean;
  allowUnpaid?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
// Passenger names and phones are only the crew's business while they work the trip.
const MANIFEST_CLOSES_AFTER_MS = 24 * HOUR_MS;
const MAX_NOTICES_PER_HOUR = 5;
const NEW_VALUE_TOKEN = '{{newValue}}';

// The bookings that actually travel: unpaid and cancelled ones have no seat on the bus.
const TRAVELING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;

const TICKET_INCLUDE = {
  passenger: true,
  booking: {
    include: {
      compensation: { select: { id: true } },
      payment: { select: { amount: true, walletAmount: true, status: true } },
      collections: { select: { amount: true } },
      trip: {
        include: {
          currentBoardingPoint: { select: { id: true, name: true, time: true } },
          boardingPoints: TICKET_BOARDING_TRIP_SELECT.boardingPoints,
          statusUpdates: TICKET_BOARDING_TRIP_SELECT.statusUpdates,
        },
      },
    },
  },
} satisfies Prisma.TicketInclude;

type TicketWithBooking = Prisma.TicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

const describeTicket = (ticket: TicketWithBooking) => ({
  ticketNumber: ticket.ticketNumber,
  bookingReference: ticket.booking.bookingReference,
  passengerName: ticket.passenger.fullName,
  seatNumber: ticket.passenger.seatNumber,
  boardedAt: ticket.boardedAt,
  boardingPointName: ticket.booking.boardingPointName,
  boardingPointTime: ticket.booking.boardingPointTime,
  bus: { liveStatus: ticket.booking.trip.liveStatus, pointName: ticket.booking.trip.currentBoardingPoint?.name ?? null },
  bookingType: ticket.booking.trip.bookingType,
  trip: {
    id: ticket.booking.trip.id,
    tripCode: ticket.booking.trip.tripCode,
    origin: ticket.booking.trip.origin,
    destination: ticket.booking.trip.destination,
    departureTime: ticket.booking.trip.departureTime,
  },
});

/**
 * Whether the bus stands where this ticket boards. Editing a trip recreates its points with new ids,
 * and the booking keeps a copy of the name, so either one matching counts as the same place.
 */
const isAtTicketPoint = (booking: { boardingPointId: string | null; boardingPointName: string | null }, current: { id: string; name: string } | null) => {
  if (!booking.boardingPointId && !booking.boardingPointName) return true;
  return !!current && (booking.boardingPointId === current.id || booking.boardingPointName === current.name);
};

/** What decides whether a passenger on the list can actually ride: the booking's state, a compensation, and money still owed. */
const RIDE_STATE_SELECT = {
  status: true,
  compensation: { select: { id: true } },
  payment: { select: { amount: true, walletAmount: true, status: true } },
  collections: { select: { amount: true } },
} satisfies Prisma.BookingSelect;

/**
 * Why a listed passenger will be refused at the door, the same order the scanner checks in, so the crew knows before scanning.
 * A compensated ticket is settled and paid out: that passenger is not expected on the bus at all.
 */
function rideHold(booking: Prisma.BookingGetPayload<{ select: typeof RIDE_STATE_SELECT }>) {
  if (booking.compensation) return { hold: 'COMPENSATED' as const, remaining: 0 };
  if (booking.status === 'PENDING_CANCELLATION_REVIEW') return { hold: 'CANCELLATION_PENDING' as const, remaining: 0 };
  const remaining = paymentFigures(booking.payment, booking.collections).remaining;
  if (booking.status === 'PENDING' || remaining > 0) return { hold: 'NOT_PAID' as const, remaining: remaining / 100 };
  return { hold: null, remaining: 0 };
}

/** A compensated passenger who has not boarded is not one the bus waits for; one already aboard still counts. */
const STILL_EXPECTED = { OR: [{ isBoarded: true }, { booking: { compensation: { is: null } } }] } satisfies Prisma.TicketWhereInput;
const isExpectedBack = (ticket: { returnBoardedAt: Date | null; booking: { compensation: { id: string } | null } }) => !!ticket.returnBoardedAt || !ticket.booking.compensation;

const RETURN_TICKET_INCLUDE = {
  passenger: true,
  booking: { select: { bookingReference: true, ...RIDE_STATE_SELECT } },
} satisfies Prisma.TicketInclude;

/** What the crew's phone keeps of each ticket for boarding without internet. */
const OFFLINE_TICKET_SELECT = {
  ticketNumber: true,
  signedToken: true,
  isBoarded: true,
  boardedAt: true,
  boardedOffline: true,
  returnBoardedAt: true,
  returnBoardedOffline: true,
  passenger: { select: { fullName: true, seatNumber: true } },
  booking: { select: { bookingReference: true, source: true, boardingPointName: true, boardingPointTime: true, ...RIDE_STATE_SELECT } },
} satisfies Prisma.TicketSelect;

@Injectable()
export class TicketsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private events: BookingEventsService,
    private notifications: NotificationsService,
    private stationAlerts: StationAlertsService,
    private realtime: RealtimeService,
    private ticketAlerts: TicketAlertsService,
  ) {}

  private async assertAssigned(actor: Actor, tripId: string) {
    if (actor.role === 'ADMIN') return;
    const assigned = await this.prisma.trip.count({
      where: {
        id: tripId,
        OR: [{ drivers: { some: { userId: actor.userId } } }, { supervisors: { some: { userId: actor.userId } } }],
      },
    });
    if (assigned === 0) throw new ForbiddenException('هذه الرحلة غير مسندة إليك');
  }

  /** Until its opening time the crew can read about the trip but not act on it. The office is not held to the crew's schedule. */
  private assertTripOpen(actor: Actor, trip: CrewWindowSettings) {
    if (actor.role === 'ADMIN') return;
    const { isTripOpen, tripOpensAt } = crewWindow(trip);
    if (!isTripOpen) {
      throw new ConflictException(`تفتح هذه الرحلة لك يوم ${formatRiyadhDate(tripOpensAt)} الساعة ${formatRiyadhTime(tripOpensAt)}`);
    }
  }

  /** Speaking to passengers is the supervisor's job, whatever else the rank allows; a driver on the trip does not qualify. */
  private async assertSupervises(actor: Actor, tripId: string) {
    if (actor.role === 'ADMIN') return;
    const assigned = await this.prisma.tripSupervisor.count({ where: { tripId, userId: actor.userId } });
    if (assigned === 0) throw new ForbiddenException('إشعار المسافرين متاح لمشرف الرحلة فقط');
  }

  /** The cap is per trip, so passengers are protected however many supervisors the trip has. */
  private async assertNoticeAllowance(bookingIds: string[]) {
    const recent = await this.prisma.bookingEvent.groupBy({
      by: ['bookingId'],
      where: { action: 'CREW_NOTICE', createdAt: { gte: new Date(Date.now() - HOUR_MS) }, bookingId: { in: bookingIds } },
      _count: { _all: true },
    });
    if (recent.some((row) => row._count._all >= MAX_NOTICES_PER_HOUR)) {
      throw new HttpException(`الحد الأقصى ${MAX_NOTICES_PER_HOUR} إشعارات في الساعة لكل رحلة، حاول لاحقًا`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** The round trip's bookings riding back on this reverse. A trip that is not a reverse has none. */
  private async returningOn(db: Pick<Prisma.TransactionClient, 'trip' | 'booking'>, tripId: string) {
    const trip = await db.trip.findUnique({ where: { id: tripId }, select: { reverseOfTripId: true, tripStatus: true } });
    if (!trip?.reverseOfTripId || !['PUBLISHED', 'COMPLETED'].includes(trip.tripStatus)) return [];
    return returningBookingIds(db, trip.reverseOfTripId);
  }

  private async returningTickets(tripId: string) {
    const bookingIds = await this.returningOn(this.prisma, tripId);
    if (bookingIds.length === 0) return [];
    return this.prisma.ticket.findMany({ where: { bookingId: { in: bookingIds } }, include: RETURN_TICKET_INCLUDE });
  }

  async getTicketsForBooking(actor: Actor, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { userId: true, branchId: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.userId !== actor.userId) {
      if (!actor.permissions.includes('bookings.view')) throw new ForbiddenException('Access denied to this booking');
      // The same branch rule as the panel's booking routes: staff see only their own branch unless allowed all of them.
      if (!actor.permissions.includes('bookings.all_branches')) {
        const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
        if (!me?.branchId || booking.branchId !== me.branchId) throw new ForbiddenException('هذا الحجز خارج نطاق فرعك');
      }
    }
    const tickets = await this.prisma.ticket.findMany({
      where: { bookingId },
      include: { passenger: { select: { id: true, fullName: true, seatNumber: true } } },
    });
    // Only the booking's owner gets the token that opens the bus door.
    return booking.userId === actor.userId ? tickets : tickets.map((t) => ({ ...t, signedToken: undefined }));
  }

  async getMyAssignedTrips(actor: Actor) {
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: { in: ['PUBLISHED', 'COMPLETED'] },
        OR: [{ drivers: { some: { userId: actor.userId } } }, { supervisors: { some: { userId: actor.userId } } }],
      },
      orderBy: { departureTime: 'desc' },
      take: 50,
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        departureTime: true,
        arrivalTime: true,
        busType: true,
        tripStatus: true,
        executedAt: true,
        liveStatus: true,
        totalSeats: true,
        availableSeats: true,
        reverseOfTripId: true,
        ...CREW_WINDOW_SELECT,
      },
    });

    const tickets = await this.prisma.ticket.findMany({
      where: { booking: { tripId: { in: trips.map((trip) => trip.id) }, status: { in: [...TRAVELING_STATUSES] } }, ...STILL_EXPECTED },
      select: { isBoarded: true, noShowAt: true, booking: { select: { tripId: true } } },
    });
    return Promise.all(trips.map(async (trip) => {
      const ofTrip = tickets.filter((ticket) => ticket.booking.tripId === trip.id);
      const returning = trip.reverseOfTripId ? await this.returningTickets(trip.id) : [];
      return {
        ...trip,
        access: crewWindow(trip),
        passengerCount: ofTrip.length + returning.filter(isExpectedBack).length,
        boardedCount: ofTrip.filter((ticket) => ticket.isBoarded).length + returning.filter((ticket) => ticket.returnBoardedAt).length,
        noShowCount: ofTrip.filter((ticket) => ticket.noShowAt && !ticket.isBoarded).length + returning.filter((ticket) => ticket.returnNoShowAt && !ticket.returnBoardedAt).length,
      };
    }));
  }

  /** What the crew may read at any time, even before the trip opens: no passenger names or phones here. */
  async getTripDetails(actor: Actor, tripId: string) {
    await this.assertAssigned(actor, tripId);
    const crewMember = { orderBy: { isPrimary: 'desc' }, select: { isPrimary: true, user: { select: { id: true, name: true } } } } as const;
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
      select: {
        id: true,
        tripCode: true,
        title: true,
        origin: true,
        destination: true,
        arrivalTime: true,
        hijriDate: true,
        busType: true,
        miqat: true,
        tripStatus: true,
        executedAt: true,
        ...CREW_WINDOW_SELECT,
        bus: { select: { plateNumber: true, model: true, color: true } },
        boardingPoints: { select: { id: true, name: true, time: true, address: true, lat: true, lng: true } },
        liveStatus: true,
        liveStatusAt: true,
        currentBoardingPointId: true,
        // The crew's map shows the last position any of them sent, even from another member's phone.
        location: { select: { lat: true, lng: true, recordedAt: true } },
        drivers: crewMember,
        supervisors: crewMember,
        manifestSentAt: true,
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const tickets = await this.prisma.ticket.findMany({
      where: { booking: { tripId, status: { in: [...TRAVELING_STATUSES] } }, ...STILL_EXPECTED },
      select: { isBoarded: true, noShowAt: true },
    });
    const returning = await this.returningTickets(tripId);
    const toMember = ({ isPrimary, user }: { isPrimary: boolean; user: { id: string; name: string | null } }) => ({ id: user.id, name: user.name, isPrimary });
    return {
      ...trip,
      boardingPoints: [...trip.boardingPoints].sort((a, b) => a.time.localeCompare(b.time)),
      location: trip.location && trip.liveStatus !== 'ARRIVED' ? { ...trip.location, isLive: Date.now() - trip.location.recordedAt.getTime() <= 2 * 60 * 1000 } : null,
      drivers: trip.drivers.map(toMember),
      supervisors: trip.supervisors.map(toMember),
      access: crewWindow(trip),
      passengerCount: tickets.length + returning.filter(isExpectedBack).length,
      boardedCount: tickets.filter((ticket) => ticket.isBoarded).length + returning.filter((ticket) => ticket.returnBoardedAt).length,
      noShowCount: tickets.filter((ticket) => ticket.noShowAt && !ticket.isBoarded).length + returning.filter((ticket) => ticket.returnNoShowAt && !ticket.returnBoardedAt).length,
    };
  }

  async sendNotice(actor: Actor, tripId: string, message: string) {
    await this.assertSupervises(actor, tripId);
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { tripStatus: true, ...CREW_WINDOW_SELECT } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('لا يمكن إرسال إشعار إلا لرحلة قائمة');
    this.assertTripOpen(actor, trip);
    const own = await this.prisma.booking.findMany({
      where: { tripId, status: { in: [...TRAVELING_STATUSES] } },
      select: { id: true },
    });
    const bookings = [...own, ...(await this.returningOn(this.prisma, tripId)).map((id) => ({ id }))];
    await this.assertNoticeAllowance(bookings.map((booking) => booking.id));
    const sender = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });

    await this.prisma.$transaction(async (tx) => {
      for (const booking of bookings) {
        await this.events.record(tx, { bookingId: booking.id, action: 'CREW_NOTICE', actorId: actor.userId, after: { message } });
      }
      await this.notifications.toBookingOwners(tx, 'CREW_NOTICE', bookings.map((booking) => booking.id), { message });
      // The rest of the crew will be asked about it by the passengers.
      await this.notifications.toTripCrew(tx, 'CREW_PASSENGERS_NOTIFIED', tripId, { exceptUserId: actor.userId, extra: { senderName: sender?.name, message } });
    }, { timeout: 30_000 });
    return { bookings: bookings.length };
  }

  async getNoticeTemplates(actor: Actor, tripId: string) {
    await this.assertSupervises(actor, tripId);
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { tripCode: true, origin: true, destination: true, departureTime: true, hijriDate: true } });
    if (!trip) throw new NotFoundException('Trip not found');
    const events = crewManualEvents();
    const customs = new Map((await this.prisma.notificationTemplate.findMany({ where: { event: { in: events } } })).map((row) => [row.event, row]));
    return events.flatMap((event) => {
      const entry = NOTIFICATION_CATALOG[event];
      const custom = customs.get(event);
      if (custom && (!custom.crewCanSend || (!custom.isActive && !custom.whatsappEnabled))) return [];
      // The typed value stays a placeholder, so the app can show it as the supervisor types.
      const body = renderNotification(event, custom?.body ?? entry.body, { ...tripValues(trip), newValue: NEW_VALUE_TOKEN });
      return [{ event, label: entry.label, trigger: entry.trigger, body, needsValue: describeEntry(event).requires.includes('newValue'), hasWhatsapp: !!custom?.whatsappEnabled }];
    });
  }

  async sendTemplateNotice(actor: Actor, tripId: string, event: string, value?: string) {
    await this.assertSupervises(actor, tripId);
    if (!isNotificationEvent(event) || !crewManualEvents().includes(event)) throw new BadRequestException('هذا القالب غير متاح للمشرف');
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    if (custom && !custom.crewCanSend) throw new ForbiddenException('أوقفت الإدارة إرسال هذا القالب من المشرف');
    if (custom && !custom.isActive && !custom.whatsappEnabled) throw new ConflictException('هذا القالب متوقف');
    if (describeEntry(event).requires.includes('newValue') && !value) throw new BadRequestException('اكتب القيمة الجديدة أولًا');

    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { tripStatus: true, tripCode: true, origin: true, destination: true, hijriDate: true, ...CREW_WINDOW_SELECT } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('لا يمكن إرسال إشعار إلا لرحلة قائمة');
    this.assertTripOpen(actor, trip);
    const own = await this.prisma.booking.findMany({ where: { tripId, status: { in: [...TRAVELING_STATUSES] } }, select: { id: true } });
    const bookingIds = [...own.map((booking) => booking.id), ...(await this.returningOn(this.prisma, tripId))];
    await this.assertNoticeAllowance(bookingIds);
    const sender = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const entry = NOTIFICATION_CATALOG[event];
    const message = renderNotification(event, custom?.body ?? entry.body, { ...tripValues(trip), newValue: value });

    await this.prisma.$transaction(async (tx) => {
      for (const bookingId of bookingIds) {
        await this.events.record(tx, { bookingId, action: 'CREW_NOTICE', actorId: actor.userId, after: { message } });
      }
      await this.notifications.toBookingOwners(tx, event, bookingIds, { newValue: value });
      await this.notifications.toTripCrew(tx, 'CREW_PASSENGERS_NOTIFIED', tripId, { exceptUserId: actor.userId, extra: { senderName: sender?.name, message } });
    }, { timeout: 30_000 });
    return { bookings: bookingIds.length };
  }

  /** The crew's word on where the bus is: passengers follow it, and the scanner checks tickets against it. */
  async updateLiveStatus(actor: Actor, tripId: string, status: TripLiveStatus, boardingPointId?: string) {
    await this.assertAssigned(actor, tripId);
    if (status === 'NOT_STARTED') throw new BadRequestException('لا يمكن إعادة الرحلة إلى ما قبل الانطلاق');
    if (status === 'AT_POINT' && !boardingPointId) throw new BadRequestException('اختر النقطة التي وصلت إليها الحافلة');

    return this.prisma.$transaction(async (tx) => {
      // Two crew members on one bus must not interleave, or passengers would be told about a stale position.
      await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
      const trip = await tx.trip.findUnique({
        where: { id: tripId },
        select: { tripStatus: true, liveStatus: true, tripCode: true, hijriDate: true, destination: true, currentBoardingPointId: true, currentBoardingPoint: { select: { name: true } }, origin: true, ...CREW_WINDOW_SELECT },
      });
      if (!trip) throw new NotFoundException('Trip not found');
      if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('لا يمكن تحديث حالة رحلة غير قائمة');
      this.assertTripOpen(actor, trip);

      const point = status === 'AT_POINT' ? await tx.boardingPoint.findFirst({ where: { id: boardingPointId, tripId } }) : null;
      if (status === 'AT_POINT' && !point) throw new BadRequestException('هذه النقطة لا تخص هذه الرحلة');

      const pointId = point?.id ?? null;
      // A repeated tap changes nothing, so it must not notify every passenger again.
      if (trip.liveStatus === status && trip.currentBoardingPointId === pointId) {
        return { liveStatus: status, currentBoardingPointId: pointId, changed: false };
      }

      const now = new Date();
      const actorUser = await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
      // Arriving at the destination ends the trip: it leaves the crew's open trips at once and frees the bus and crew for their next one.
      await tx.trip.update({
        where: { id: tripId },
        data: { liveStatus: status, liveStatusAt: now, currentBoardingPointId: pointId, ...(status === 'ARRIVED' && { tripStatus: 'COMPLETED' }) },
      });
      await tx.tripStatusUpdate.create({ data: { tripId, status, boardingPointId: pointId, pointName: point?.name, actorId: actor.userId, actorName: actorUser?.name } });
      this.realtime.tripChanged(tripId);

      const bookings = await tx.booking.findMany({
        where: { tripId, status: { in: [...TRAVELING_STATUSES] } },
        select: { id: true, status: true, boardingPointId: true, boardingPointName: true, tickets: { select: { isBoarded: true } } },
      });
      // Whoever this move just left behind hears that instead of the general alert, which would only confuse it.
      const justToldTicket = await this.ticketAlerts.announce(tx, tripId);
      // Someone already on the bus knows where it is; only arrival is news to everyone.
      const waiting = bookings.filter((booking) => booking.tickets.some((ticket) => !ticket.isBoarded) && !justToldTicket.has(booking.id));
      if (status === 'AT_POINT') {
        // Arrival at a point is news only to those who board there; the rest of the bus is not told about every stop.
        const here = waiting.filter((booking) => isAtTicketPoint(booking, point) && (booking.boardingPointId || booking.boardingPointName));
        // The company can turn this alert off for all trips or one, from the station alerts page.
        if (await this.stationAlerts.isEnabled(tx, tripId, 'AT_STOP')) {
          await this.notifications.toBookingOwners(tx, 'BUS_AT_YOUR_POINT', here.map((booking) => booking.id), { currentPoint: point!.name });
          if (here.length > 0) await this.stationAlerts.recordMoment(tx, tripId, 'AT_STOP', point!, here.length);
        }
      } else if (status === 'ON_ROAD') {
        await this.notifications.toBookingOwners(tx, 'BUS_ON_ROAD', waiting.map((booking) => booking.id), { currentPoint: trip.currentBoardingPoint?.name ?? trip.origin });
      } else if (status === 'ARRIVED') {
        // "Thank God for your safe arrival" is wrong for someone who never got on.
        await this.notifications.toBookingOwners(tx, 'BUS_ARRIVED', bookings.filter((booking) => booking.tickets.some((ticket) => ticket.isBoarded)).map((booking) => booking.id));
      }
      await this.tellReturning(tx, tripId, trip, status, point?.name);

      const statusText = status === 'AT_POINT' ? `الحافلة في ${point!.name}` : status === 'ON_ROAD' ? 'الحافلة في الطريق' : `الحافلة وصلت إلى ${trip.destination}`;
      await this.notifications.toTripCrew(tx, 'CREW_TRIP_STATUS_CHANGED', tripId, { exceptUserId: actor.userId, extra: { senderName: actorUser?.name, currentPoint: statusText } });
      return { liveStatus: status, currentBoardingPointId: pointId, changed: true };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  /** Passengers riding back have no point of their own on the reverse: wherever it boards is their point, and the route they read is this one. */
  private async tellReturning(
    tx: Prisma.TransactionClient,
    tripId: string,
    trip: Parameters<typeof tripValues>[0] & { currentBoardingPoint: { name: string } | null },
    status: TripLiveStatus,
    pointName?: string,
  ) {
    const bookingIds = await this.returningOn(tx, tripId);
    if (bookingIds.length === 0) return;
    const waiting = await tx.ticket.findMany({ where: { bookingId: { in: bookingIds }, returnBoardedAt: null }, select: { bookingId: true }, distinct: ['bookingId'] });
    const route = tripValues(trip);
    const here = { ...route, boardingPoint: pointName ?? trip.currentBoardingPoint?.name ?? trip.origin, boardingTime: formatRiyadhTime(trip.departureTime) };
    const waitingIds = waiting.map((ticket) => ticket.bookingId);
    if (status === 'AT_POINT') await this.notifications.toBookingOwners(tx, 'BUS_AT_YOUR_POINT', waitingIds, { ...here, currentPoint: pointName });
    else if (status === 'ON_ROAD') await this.notifications.toBookingOwners(tx, 'BUS_ON_ROAD', waitingIds, { ...here, currentPoint: trip.currentBoardingPoint?.name ?? trip.origin });
    else if (status === 'ARRIVED') await this.notifications.toBookingOwners(tx, 'BUS_ARRIVED', bookingIds, route);
  }

  getReports() {
    return this.prisma.tripReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { trip: { select: { tripCode: true, origin: true, destination: true, departureTime: true } } },
    });
  }

  async getManifest(actor: Actor, tripId: string) {
    await this.assertAssigned(actor, tripId);
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, tripCode: true, origin: true, destination: true, arrivalTime: true, busType: true, tripStatus: true, bookingType: true, manifestSentAt: true, ...CREW_WINDOW_SELECT },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    // Once the office has sent the list, the crew may read it before the trip opens for them.
    if (!trip.manifestSentAt) this.assertTripOpen(actor, trip);

    // The crew's copy leaves phone numbers out: the office reaches the passengers, the crew works from names and seats.
    const tickets = await this.prisma.ticket.findMany({
      where: { booking: { tripId, status: { in: [...TRAVELING_STATUSES] } } },
      include: {
        passenger: { include: { hotelRoom: { select: { number: true, type: true } } } },
        booking: {
          select: {
            bookingReference: true,
            boardingPointName: true,
            boardingPointTime: true,
            kind: true,
            roomChoice: true,
            stayHotelId: true,
            user: { select: PROFILE_ACCOUNT_SELECT },
            passengers: { select: PROFILE_PASSENGER_SELECT },
            _count: { select: { passengers: true } },
            ...RIDE_STATE_SELECT,
          },
        },
      },
    });
    const returning = await this.returningTickets(tripId);
    const profileOf = (ticket: (typeof tickets)[number]) =>
      passengerProfiles(ticket.booking.passengers, ticket.booking.user).get(ticket.passengerId ?? '') ?? { gender: null, nationality: null };
    const passengers = tickets
      .map((ticket) => ({
        gender: profileOf(ticket).gender as string | null,
        nationality: profileOf(ticket).nationality,
        ticketNumber: ticket.ticketNumber,
        bookingReference: ticket.booking.bookingReference,
        fullName: ticket.passenger.fullName,
        seatNumber: ticket.passenger.seatNumber,
        boardingPointName: ticket.booking.boardingPointName,
        boardingPointTime: ticket.booking.boardingPointTime,
        isBoarded: ticket.isBoarded,
        boardedAt: ticket.boardedAt,
        /** Recorded on the road without internet and sent later (سُجل بدون إنترنت). */
        boardedOffline: ticket.boardedOffline,
        /** The trip was executed without this passenger aboard (لم يحضر). */
        isNoShow: !!ticket.noShowAt && !ticket.isBoarded,
        isReturning: false,
        passengerId: ticket.passengerId as string | null,
        needsRoom: bookingHasStay(trip.bookingType, ticket.booking),
        roomChoice: ticket.booking.roomChoice as string | null,
        roomNumber: ticket.passenger.hotelRoom?.number ?? null,
        roomType: (ticket.passenger.hotelRoom?.type ?? null) as string | null,
        bookingPassengers: ticket.booking._count.passengers,
        ...rideHold(ticket.booking),
      }))
      .concat(
        returning.map((ticket) => ({
          gender: (ticket.passenger.gender ?? null) as string | null,
          nationality: ticket.passenger.nationality ?? null,
          ticketNumber: ticket.ticketNumber,
          bookingReference: ticket.booking.bookingReference,
          fullName: ticket.passenger.fullName,
          seatNumber: ticket.passenger.seatNumber,
          boardingPointName: null,
          boardingPointTime: null,
          isBoarded: !!ticket.returnBoardedAt,
          boardedAt: ticket.returnBoardedAt,
          boardedOffline: ticket.returnBoardedOffline,
          isNoShow: !!ticket.returnNoShowAt && !ticket.returnBoardedAt,
          isReturning: true,
          // Their stay belongs to the outbound trip, so this sheet does not place them.
          passengerId: null,
          needsRoom: false,
          roomChoice: null,
          roomNumber: null,
          roomType: null,
          bookingPassengers: 1,
          ...rideHold(ticket.booking),
        })),
      )
      .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));

    // The office keeps its own manifests; for the crew only the totals outlive the trip.
    const passengersHidden = actor.role !== 'ADMIN' && Date.now() > trip.arrivalTime.getTime() + MANIFEST_CLOSES_AFTER_MS;

    // A compensated passenger stays on the list, marked, but is not one the bus is waiting for.
    const riding = passengers.filter((p) => p.hold !== 'COMPENSATED' || p.isBoarded);
    return {
      trip,
      total: riding.length,
      boarded: riding.filter((p) => p.isBoarded).length,
      noShow: riding.filter((p) => p.isNoShow).length,
      passengersHidden,
      passengers: passengersHidden ? [] : passengers,
    };
  }

  async verifyAndBoard(actor: Actor, signedToken: string, tripId: string, overrides: BoardOverrides = {}): Promise<{ result: ScanResult; ticket?: any }> {
    await this.assertAssigned(actor, tripId);
    const payload = verifyTicketToken(signedToken, this.config.getOrThrow('TICKET_SIGNING_SECRET'));
    if (!payload) return { result: 'INVALID' };
    return this.boardByNumber(actor, payload.ticketNumber, tripId, overrides);
  }

  /**
   * The barcode printed on a branch ticket, for customers without the app. It works only for an assigned crew member during
   * boarding, and each passenger still boards once. One ticket can carry several travellers, so one scan boards all of them.
   */
  async boardFromPaper(actor: Actor, code: string, tripId: string, overrides: BoardOverrides = {}, offline: OfflineScan | null = null): Promise<{ result: ScanResult; ticket?: any; boardedCount?: number }> {
    await this.assertAssigned(actor, tripId);
    const reference = verifyPaperCode(code, this.config.getOrThrow('TICKET_SIGNING_SECRET'));
    if (!reference) return { result: 'INVALID' };
    // Tickets from the app board with their own signed code only.
    const booking = await this.prisma.booking.findFirst({
      where: { bookingReference: reference, source: 'BRANCH' },
      select: { tickets: { select: { ticketNumber: true }, orderBy: { ticketNumber: 'asc' } } },
    });
    if (!booking?.tickets.length) return { result: 'INVALID' };

    let boarded: { result: ScanResult; ticket?: any } | null = null;
    let last: { result: ScanResult; ticket?: any } | null = null;
    let boardedCount = 0;
    for (const { ticketNumber } of booking.tickets) {
      last = await this.boardByNumber(actor, ticketNumber, tripId, overrides, offline);
      if (last.result === 'BOARDED') {
        boardedCount += 1;
        boarded ??= last;
      } else if (last.result !== 'ALREADY_USED') {
        // Everyone on a ticket shares its trip, window and point, so this answer holds for the others too.
        if (!boarded) return last;
      }
    }
    return boarded ? { ...boarded, boardedCount } : last!;
  }

  async boardManually(actor: Actor, ticketNumber: string, tripId: string, overrides: BoardOverrides = {}) {
    await this.assertAssigned(actor, tripId);
    return this.boardByNumber(actor, ticketNumber, tripId, overrides);
  }

  /**
   * What the crew's phone keeps to board passengers on the road without internet. The signing secret never leaves the server:
   * each ticket comes with a hash of its QR code (and of the printed barcode for a branch ticket), which the app compares with
   * what it scans. A hash cannot be turned back into a code, so the pack cannot be used to make a ticket.
   */
  async getOfflinePack(actor: Actor, tripId: string) {
    await this.assertAssigned(actor, tripId);
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        arrivalTime: true,
        busType: true,
        bookingType: true,
        tripStatus: true,
        unpaidBoarding: true,
        liveStatus: true,
        manifestSentAt: true,
        currentBoardingPoint: { select: { id: true, name: true } },
        ...CREW_WINDOW_SELECT,
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    // The same rule as the passenger list: once the office has sent it, the crew may keep it before the trip opens.
    if (!trip.manifestSentAt) this.assertTripOpen(actor, trip);

    const secret = this.config.getOrThrow<string>('TICKET_SIGNING_SECRET');
    const own = await this.prisma.ticket.findMany({ where: { booking: { tripId, status: { in: [...TRAVELING_STATUSES] } } }, select: OFFLINE_TICKET_SELECT });
    const returningIds = await this.returningOn(this.prisma, tripId);
    const returning = returningIds.length ? await this.prisma.ticket.findMany({ where: { bookingId: { in: returningIds } }, select: OFFLINE_TICKET_SELECT }) : [];

    const toEntry = (ticket: (typeof own)[number], isReturning: boolean) => {
      const { hold } = rideHold(ticket.booking);
      return {
        ticketNumber: ticket.ticketNumber,
        bookingReference: ticket.booking.bookingReference,
        fullName: ticket.passenger.fullName,
        seatNumber: ticket.passenger.seatNumber,
        boardingPointName: isReturning ? null : ticket.booking.boardingPointName,
        boardingPointTime: isReturning ? null : ticket.booking.boardingPointTime,
        isReturning,
        isBoarded: isReturning ? !!ticket.returnBoardedAt : ticket.isBoarded,
        boardedAt: isReturning ? ticket.returnBoardedAt : ticket.boardedAt,
        boardedOffline: isReturning ? ticket.returnBoardedOffline : ticket.boardedOffline,
        bookingStatus: ticket.booking.status,
        hold,
        // Riyals, as on the manifest.
        remaining: paymentFigures(ticket.booking.payment, ticket.booking.collections).remaining / 100,
        tokenHash: offlineHash(ticket.signedToken),
        // One printed barcode boards everyone on a branch ticket.
        paperHash: ticket.booking.source === 'BRANCH' ? offlineHash(signPaperCode(ticket.booking.bookingReference, secret)) : null,
      };
    };

    const passengersHidden = actor.role !== 'ADMIN' && Date.now() > trip.arrivalTime.getTime() + MANIFEST_CLOSES_AFTER_MS;
    const passengers = [...own.map((ticket) => toEntry(ticket, false)), ...returning.map((ticket) => toEntry(ticket, true))].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));
    const { manifestSentAt: _sent, ...tripFacts } = trip;
    return {
      version: 1,
      generatedAt: new Date(),
      hash: { algorithm: 'SHA-256', length: OFFLINE_HASH_LENGTH },
      trip: { ...tripFacts, access: crewWindow(trip) },
      passengersHidden,
      passengers: passengersHidden ? [] : passengers,
    };
  }

  /**
   * Boardings the crew recorded on the road without internet, sent once the phone is back online. Each one goes through the same
   * checks as a scan at the door, read at the moment it was scanned. Sending the same scan again (a lost reply, a retry) answers
   * the same way and never boards twice.
   */
  async syncOfflineBoardings(actor: Actor, tripId: string, items: OfflineBoardingItem[]) {
    await this.assertAssigned(actor, tripId);
    const results: Awaited<ReturnType<TicketsService['syncOfflineItem']>>[] = [];
    // One at a time: two scans of one booking's tickets share its lock.
    for (const item of items) results.push(await this.syncOfflineItem(actor, tripId, item));
    return {
      results,
      accepted: results.filter((row) => row.status === 'ACCEPTED').length,
      alreadyBoarded: results.filter((row) => row.status === 'ALREADY_BOARDED').length,
      rejected: results.filter((row) => row.status === 'REJECTED').length,
      failed: results.filter((row) => row.status === 'ERROR').length,
    };
  }

  private async syncOfflineItem(actor: Actor, tripId: string, item: OfflineBoardingItem) {
    const key = { actorId_clientId: { actorId: actor.userId, clientId: item.clientId } };
    const stored = await this.prisma.offlineBoardingSync.findUnique({ where: key });
    if (stored) return { ...(stored.response as Record<string, any>), clientId: item.clientId, status: stored.status, repeated: true };

    const now = Date.now();
    // A phone clock running ahead of the server must not board anyone in the future.
    const scannedAt = new Date(Math.min(new Date(item.scannedAt).getTime() || now, now));
    let outcome: { result: ScanResult; ticket?: any; boardedCount?: number };
    let reason: string | undefined;
    if (now - scannedAt.getTime() > MAX_OFFLINE_AGE_MS) {
      outcome = { result: 'OUTSIDE_WINDOW' };
      reason = 'مضى وقت طويل على هذا المسح، راجع الإدارة لتسجيل الصعود';
    } else {
      try {
        const offline = { scannedAt };
        const overrides = { allowUnpaid: !!item.allowUnpaid };
        if (item.signedToken) {
          const payload = verifyTicketToken(item.signedToken, this.config.getOrThrow('TICKET_SIGNING_SECRET'));
          outcome = payload ? await this.boardByNumber(actor, payload.ticketNumber, tripId, overrides, offline) : { result: 'INVALID' };
        } else if (item.code) {
          outcome = await this.boardFromPaper(actor, item.code, tripId, overrides, offline);
        } else if (item.ticketNumber) {
          outcome = await this.boardByNumber(actor, item.ticketNumber, tripId, overrides, offline);
        } else {
          outcome = { result: 'INVALID' };
        }
      } catch {
        // Not kept: the app sends it again with the next sync.
        return { clientId: item.clientId, status: 'ERROR' as const, result: null, reason: 'تعذر حفظ هذا الصعود الآن، سيُعاد إرساله تلقائيًا', ticket: null, repeated: false };
      }
    }

    const status = outcome.result === 'BOARDED' ? 'ACCEPTED' : outcome.result === 'ALREADY_USED' ? 'ALREADY_BOARDED' : 'REJECTED';
    const ticket = outcome.ticket
      ? {
          ticketNumber: outcome.ticket.ticketNumber as string,
          bookingReference: outcome.ticket.bookingReference as string,
          passengerName: outcome.ticket.passengerName as string,
          seatNumber: outcome.ticket.seatNumber as string,
          boardedAt: outcome.ticket.boardedAt ?? null,
          boardedBy: outcome.ticket.boardedBy ?? null,
          remaining: outcome.ticket.remaining ?? null,
        }
      : null;
    if (status === 'ALREADY_BOARDED') reason = ticket?.boardedBy ? `سبق تسجيل صعوده بواسطة ${ticket.boardedBy}` : 'سبق تسجيل صعوده';
    if (status === 'REJECTED') reason ??= OFFLINE_REJECT_REASONS[outcome.result] ?? OFFLINE_REJECT_REASONS.INVALID;
    const response = { clientId: item.clientId, status, result: outcome.result, reason: reason ?? null, ticket, boardedCount: outcome.boardedCount ?? (status === 'ACCEPTED' ? 1 : 0) };

    try {
      await this.prisma.offlineBoardingSync.create({
        data: { actorId: actor.userId, clientId: item.clientId, tripId, ticketNumber: ticket?.ticketNumber ?? item.ticketNumber ?? null, scannedAt, status, response: response as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      // The same scan sent twice at once: the first one's answer is the one the app keeps.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const first = await this.prisma.offlineBoardingSync.findUnique({ where: key });
      if (first) return { ...(first.response as Record<string, any>), clientId: item.clientId, status: first.status, repeated: true };
    }
    return { ...response, repeated: false };
  }

  private async boardByNumber(
    actor: Actor,
    ticketNumber: string,
    tripId: string,
    { allowOtherPoint = false, allowUnpaid = false }: BoardOverrides,
    offline: OfflineScan | null = null,
  ): Promise<{ result: ScanResult; ticket?: any }> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.ticket.findUnique({ where: { ticketNumber }, select: { bookingId: true } });
      if (!found) return { result: 'INVALID' as const };

      // Re-read under the lock: a seat change replaces the ticket number and a cancellation changes the status.
      await this.events.lock(tx, found.bookingId);
      const ticket = await tx.ticket.findUnique({ where: { ticketNumber }, include: TICKET_INCLUDE });
      if (!ticket) return { result: 'INVALID' as const };

      const details = describeTicket(ticket);
      const isReturning = ticket.booking.tripId !== tripId && (await this.returningOn(tx, tripId)).includes(ticket.bookingId);
      if (ticket.booking.tripId !== tripId && !isReturning) return { result: 'WRONG_TRIP' as const, ticket: details };
      if (ticket.booking.status === 'CANCELLED') return { result: 'CANCELLED' as const, ticket: details };
      // An unpaid booking (PENDING) has no seat at all. Branch bookings are CONFIRMED with the payment still open,
      // so for those the money decides, and the trip's creator chose whether owing it keeps the passenger off.
      if (ticket.booking.status === 'PENDING') return { result: 'NOT_PAID' as const, ticket: details };
      const alreadyAboard = isReturning ? !!ticket.returnBoardedAt : ticket.isBoarded;
      const owed = paymentFigures(ticket.booking.payment, ticket.booking.collections).remaining;
      if (owed > 0 && !alreadyAboard) {
        const owing = { ...details, remaining: owed / 100 };
        const scanned = await tx.trip.findUnique({ where: { id: tripId }, select: { unpaidBoarding: true } });
        if (scanned?.unpaidBoarding !== 'WARN') return { result: 'NOT_PAID' as const, ticket: owing };
        if (!allowUnpaid) return { result: 'UNPAID_WARNING' as const, ticket: owing };
      }
      // A pending cancellation could still refund the seat, so it is settled before anyone boards on it.
      if (ticket.booking.status !== 'CONFIRMED' && ticket.booking.status !== 'BOARDED') return { result: 'CANCELLATION_PENDING' as const, ticket: details };
      if (isReturning) return this.boardReturn(tx, actor, ticket, tripId, offline);

      // A boarding sent later from the road keeps the moment it was scanned, so the window is read at that moment.
      const boardedAt = offline?.scannedAt ?? new Date();
      const window = crewWindow(ticket.booking.trip, boardedAt.getTime());
      // A used ticket still reports who boarded it, so only a fresh boarding is refused here.
      if (!ticket.isBoarded && !window.isBoardingOpen) {
        return { result: 'OUTSIDE_WINDOW' as const, ticket: { ...details, boardingOpensAt: window.boardingOpensAt, boardingClosesAt: window.boardingClosesAt } };
      }

      // The bus has left every point, so this is support's to resolve. If it is still taking passengers, the crew setting its point again lifts this.
      // A compensated ticket stays stopped whatever the bus does: it has been settled and paid for.
      // Sent later, the bus has moved on since the scan, so only a compensation stops it (the time was checked above at the scan's moment).
      if (!ticket.isBoarded && (ticket.booking.compensation || (!offline && ticketBoarding(ticket.booking, ticket.booking.trip, boardedAt.getTime()).state === 'STOPPED'))) {
        return { result: 'TICKET_STOPPED' as const, ticket: details };
      }

      // A warning rather than a refusal: the crew can see the passenger standing there and decides.
      // Without internet the crew saw the passenger at the door and let them on; where the bus stands now says nothing about then.
      const atPoint = !!offline || isAtTicketPoint(ticket.booking, ticket.booking.trip.currentBoardingPoint);
      if (!ticket.isBoarded && !atPoint && !allowOtherPoint) return { result: 'WRONG_POINT' as const, ticket: details };

      const claimed = await tx.ticket.updateMany({
        where: { id: ticket.id, isBoarded: false },
        data: { isBoarded: true, boardedAt, noShowAt: null, boardedOffline: !!offline },
      });
      if (claimed.count === 0) {
        const boardings = await tx.bookingEvent.findMany({
          where: { bookingId: ticket.bookingId, action: 'BOARDED' },
          orderBy: { createdAt: 'desc' },
          select: { actorName: true, after: true },
        });
        const boarding = boardings.find((event) => (event.after as { ticketNumber?: string } | null)?.ticketNumber === ticketNumber);
        return { result: 'ALREADY_USED' as const, ticket: { ...details, boardedBy: boarding?.actorName ?? null } };
      }

      await this.events.record(tx, {
        bookingId: ticket.bookingId,
        action: 'BOARDED',
        actorId: actor.userId,
        after: {
          passenger: ticket.passenger.fullName,
          seat: ticket.passenger.seatNumber,
          ticketNumber,
          ...(!atPoint && { otherPoint: { ticket: ticket.booking.boardingPointName, bus: ticket.booking.trip.currentBoardingPoint?.name ?? null } }),
          ...(offline && { offline: true, scannedAt: boardedAt.toISOString() }),
        },
      });
      const remaining = await tx.ticket.count({ where: { bookingId: ticket.bookingId, isBoarded: false } });
      await tx.booking.update({
        where: { id: ticket.bookingId },
        data: remaining === 0 ? { status: 'BOARDED' } : { updatedAt: boardedAt },
      });
      await this.notifications.toBookingOwners(tx, 'PASSENGER_BOARDED', [ticket.bookingId], { passengerName: ticket.passenger.fullName, seatNumber: ticket.passenger.seatNumber });
      return { result: 'BOARDED' as const, ticket: { ...details, boardedAt } };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  /** The same ticket a second time, for the way back: the window and route are the reverse's, and the bus's position is not checked because the reverse has no other point to send them to. */
  private async boardReturn(tx: Prisma.TransactionClient, actor: Actor, ticket: TicketWithBooking, tripId: string, offline: OfflineScan | null = null): Promise<{ result: ScanResult; ticket?: any }> {
    const reverse = await tx.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        departureTime: true,
        hijriDate: true,
        liveStatus: true,
        ...CREW_WINDOW_SELECT,
        currentBoardingPoint: { select: { name: true } },
        boardingPoints: { select: { name: true, time: true }, take: 1 },
      },
    });
    const details = {
      ...describeTicket(ticket),
      isReturning: true,
      boardedAt: ticket.returnBoardedAt,
      boardingPointName: reverse.boardingPoints[0]?.name ?? null,
      boardingPointTime: reverse.boardingPoints[0]?.time ?? null,
      bus: { liveStatus: reverse.liveStatus, pointName: reverse.currentBoardingPoint?.name ?? null },
      trip: { id: reverse.id, tripCode: reverse.tripCode, origin: reverse.origin, destination: reverse.destination, departureTime: reverse.departureTime },
    };

    const boardedAt = offline?.scannedAt ?? new Date();
    const window = crewWindow(reverse, boardedAt.getTime());
    if (!ticket.returnBoardedAt && !window.isBoardingOpen) {
      return { result: 'OUTSIDE_WINDOW', ticket: { ...details, boardingOpensAt: window.boardingOpensAt, boardingClosesAt: window.boardingClosesAt } };
    }
    // Compensation paid for the journey not taken, so the way back is not owed on top of it.
    if (!ticket.returnBoardedAt && ticket.booking.compensation) return { result: 'TICKET_STOPPED', ticket: details };

    const claimed = await tx.ticket.updateMany({ where: { id: ticket.id, returnBoardedAt: null }, data: { returnBoardedAt: boardedAt, returnNoShowAt: null, returnBoardedOffline: !!offline } });
    if (claimed.count === 0) {
      const boardings = await tx.bookingEvent.findMany({
        where: { bookingId: ticket.bookingId, action: 'RETURN_BOARDED' },
        orderBy: { createdAt: 'desc' },
        select: { actorName: true, after: true },
      });
      const boarding = boardings.find((event) => (event.after as { ticketNumber?: string } | null)?.ticketNumber === ticket.ticketNumber);
      return { result: 'ALREADY_USED', ticket: { ...details, boardedBy: boarding?.actorName ?? null } };
    }

    await this.events.record(tx, {
      bookingId: ticket.bookingId,
      action: 'RETURN_BOARDED',
      actorId: actor.userId,
      after: {
        passenger: ticket.passenger.fullName,
        seat: ticket.passenger.seatNumber,
        ticketNumber: ticket.ticketNumber,
        tripCode: reverse.tripCode,
        ...(offline && { offline: true, scannedAt: boardedAt.toISOString() }),
      },
    });
    await tx.booking.update({ where: { id: ticket.bookingId }, data: { updatedAt: boardedAt } });
    await this.notifications.toBookingOwners(tx, 'PASSENGER_BOARDED', [ticket.bookingId], {
      ...tripValues(reverse),
      passengerName: ticket.passenger.fullName,
      seatNumber: ticket.passenger.seatNumber,
    });
    return { result: 'BOARDED', ticket: { ...details, boardedAt } };
  }
}

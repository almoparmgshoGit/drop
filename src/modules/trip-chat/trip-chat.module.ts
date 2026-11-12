import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, TripChatSender } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { AppSettingsService, withinHours } from '../../common/services/app-settings.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { returningBookingIds } from '../../common/utils/linked-seats.util';

const PAGE_SIZE = 50;
const PREVIEW_LENGTH = 120;
const NOTIFY_LENGTH = 200;
const HOUR_MS = 60 * 60 * 1000;
/** Long enough for a late bus or a bag left on board to be sorted out, short enough that the supervisor is not on call for days after. */
const CLOSES_AFTER_ARRIVAL_HOURS = 12;
/** The app reports every 45 seconds, so one missed report does not make someone look gone. */
const ONLINE_WINDOW_MS = 2 * 60_000;
const CHAT_ROUTE = 'TripChat';
const TRAVELING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;
const LIVE_TRIP_STATUSES = ['PUBLISHED', 'COMPLETED'];

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

class TripChatMessageDto {
  @trimmed() @IsString() @Length(1, 2000, { message: 'اكتب رسالة لا تتجاوز 2000 حرف' }) body: string;
  /** Chosen by the device and kept across retries, so a bad signal cannot post one message twice. */
  @IsOptional() @IsString() @MaxLength(64) clientId?: string;
}

class MessagesQuery {
  /** Only what arrived at or after this moment; clients merge by id. */
  @IsOptional() @IsDateString() after?: string;
  /** Older messages, for scrolling back. */
  @IsOptional() @IsDateString() before?: string;
}

interface Actor {
  userId: string;
  role: string;
  name?: string | null;
}

/** The crew's copy keeps who wrote it, so two supervisors on one trip can tell their replies apart. */
const CREW_MESSAGE_SELECT = { id: true, sender: true, senderId: true, senderName: true, body: true, createdAt: true } as const;
const CUSTOMER_MESSAGE_SELECT = { id: true, sender: true, senderName: true, body: true, createdAt: true } as const;
type CrewMessage = Prisma.TripChatMessageGetPayload<{ select: typeof CREW_MESSAGE_SELECT }>;
const COUNTS_SELECT ={ id: true, tripId: true, customerId: true, crewUnread: true, customerUnread: true } as const;

const TRIP_WINDOW_SELECT = {
  id: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  tripStatus: true,
  liveStatus: true,
  liveStatusAt: true,
  reverseOfTripId: true,
  supervisors: { orderBy: { isPrimary: 'desc' }, select: { userId: true, user: { select: { name: true } } } },
} satisfies Prisma.TripSelect;

type ChatTrip = Prisma.TripGetPayload<{ select: typeof TRIP_WINDOW_SELECT }>;

const preview = (text: string, length = PREVIEW_LENGTH) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/**
 * The thread opens for writing when the passenger first sees the supervisor's phone (the same setting as the tracking
 * screen) and closes some hours after the bus arrives. The crew's word that it arrived beats the timetable, which a late
 * bus overruns. Outside it the thread stays readable by both sides.
 */
function chatWindow(trip: ChatTrip, opensBeforeHours: number, now = Date.now()) {
  const opensAt = new Date(trip.departureTime.getTime() - opensBeforeHours * HOUR_MS);
  const endedAt = trip.liveStatus === 'ARRIVED' && trip.liveStatusAt ? trip.liveStatusAt : trip.arrivalTime;
  const closesAt = new Date(endedAt.getTime() + CLOSES_AFTER_ARRIVAL_HOURS * HOUR_MS);
  const isLive = LIVE_TRIP_STATUSES.includes(trip.tripStatus);
  return {
    opensAt,
    closesAt,
    hasOpened: isLive && now >= opensAt.getTime(),
    isOpen: isLive && now >= opensAt.getTime() && now <= closesAt.getTime(),
    hasEnded: trip.liveStatus === 'ARRIVED' || now >= trip.arrivalTime.getTime(),
  };
}

@Injectable()
export class TripChatService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  private assertCustomer(actor: Actor) {
    if (actor.role !== 'PASSENGER') throw new ForbiddenException('مراسلة مشرف الرحلة لحسابات العملاء فقط');
  }

  private opensBeforeHours() {
    return this.appSettings.number('supervisorContactOpensBeforeHours');
  }

  /**
   * The booking this customer rides the trip on: their own booking on it, or, on a reverse, a round trip's booking on
   * its outbound, which carries them home with no booking of its own. Null when they do not ride it (any more).
   */
  private async rideOf(customerId: string, trip: { id: string; reverseOfTripId: string | null }) {
    const own = await this.prisma.booking.findFirst({
      where: { userId: customerId, tripId: trip.id, status: { in: [...TRAVELING_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (own) return own.id;
    if (!trip.reverseOfTripId) return null;
    const outbound = await this.prisma.booking.findMany({
      where: { userId: customerId, tripId: trip.reverseOfTripId, status: { in: [...TRAVELING_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (outbound.length === 0) return null;
    const returning = new Set(await returningBookingIds(this.prisma, trip.reverseOfTripId));
    return outbound.find((booking) => returning.has(booking.id))?.id ?? null;
  }

  /**
   * The trip a booking's chat is about right now. A round trip's booking lives on the outbound, but once the outbound is
   * over and its reverse has opened, the passenger is on the reverse's bus with the reverse's supervisor.
   */
  private async chatTripOf(customerId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId: customerId },
      select: { id: true, status: true, trip: { select: { ...TRIP_WINDOW_SELECT, reverseTrip: { select: TRIP_WINDOW_SELECT } } } },
    });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    if (!(TRAVELING_STATUSES as readonly string[]).includes(booking.status)) throw new ConflictException('مراسلة المشرف متاحة للحجوزات المؤكدة فقط');

    const opensBefore = await this.opensBeforeHours();
    const { reverseTrip, ...outbound } = booking.trip;
    if (reverseTrip && chatWindow(outbound, opensBefore).hasEnded && chatWindow(reverseTrip, opensBefore).hasOpened) {
      const returning = await returningBookingIds(this.prisma, outbound.id);
      if (returning.includes(booking.id)) return { trip: reverseTrip, window: chatWindow(reverseTrip, opensBefore) };
    }
    return { trip: outbound, window: chatWindow(outbound, opensBefore) };
  }

  // ---- The customer's side ----

  /** What the call card needs to offer the chat: whether it is open yet, and how much of it is unread. */
  async forBooking(actor: Actor, bookingId: string) {
    this.assertCustomer(actor);
    const { trip, window } = await this.chatTripOf(actor.userId, bookingId);
    const thread = await this.prisma.tripChatThread.findUnique({
      where: { tripId_customerId: { tripId: trip.id, customerId: actor.userId } },
      select: { id: true, crewUnread: true, customerUnread: true },
    });
    const supervisor = trip.supervisors[0];
    return {
      threadId: thread?.id ?? null,
      customerUnread: thread?.customerUnread ?? 0,
      crewUnread: thread?.crewUnread ?? 0,
      trip: { id: trip.id, origin: trip.origin, destination: trip.destination, departureTime: trip.departureTime },
      supervisor: supervisor ? { name: supervisor.user.name } : null,
      // A thread already written in stays readable after the trip; a new one is only offered once contact opens.
      canOpen: window.hasOpened || !!thread,
      canWrite: window.isOpen && !!supervisor,
      opensAt: window.opensAt,
      closesAt: window.closesAt,
    };
  }

  /** The customer's threads, newest first, for a badge anywhere in the app. */
  async mine(actor: Actor) {
    if (actor.role !== 'PASSENGER') return { unread: 0, threads: [] };
    const threads = await this.prisma.tripChatThread.findMany({
      where: { customerId: actor.userId },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
      select: {
        id: true,
        tripId: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        lastSender: true,
        customerUnread: true,
        crewUnread: true,
        trip: { select: { origin: true, destination: true, departureTime: true } },
      },
    });
    return { unread: threads.reduce((sum, thread) => sum + thread.customerUnread, 0), threads };
  }

  async customerMessages(actor: Actor, threadId: string, query: MessagesQuery) {
    this.assertCustomer(actor);
    const thread = await this.prisma.tripChatThread.findFirst({ where: { id: threadId, customerId: actor.userId }, select: { crewUnread: true, customerUnread: true } });
    if (!thread) throw new NotFoundException('المحادثة غير موجودة');
    return { ...thread, ...(await this.messagesOf(threadId, query, CUSTOMER_MESSAGE_SELECT)) };
  }

  async sendAsCustomer(actor: Actor, bookingId: string, dto: TripChatMessageDto) {
    this.assertCustomer(actor);
    const { trip, window } = await this.chatTripOf(actor.userId, bookingId);
    const existingThread = await this.prisma.tripChatThread.findUnique({ where: { tripId_customerId: { tripId: trip.id, customerId: actor.userId } }, select: { id: true } });
    // A retry of a message that did get through is answered with it, even if the window closed in between.
    if (existingThread && dto.clientId) {
      const sent = await this.findByClientId(existingThread.id, dto.clientId, CUSTOMER_MESSAGE_SELECT);
      if (sent) return { threadId: existingThread.id, message: sent, ...(await this.countsOf(existingThread.id)) };
    }
    if (!window.isOpen) {
      throw new ConflictException(
        Date.now() < window.opensAt.getTime()
          ? `مراسلة المشرف تُفتح قبل الانطلاق ${withinHours(await this.opensBeforeHours())}`
          : 'انتهت الرحلة وأُغلقت المراسلة مع المشرف',
      );
    }
    if (trip.supervisors.length === 0) throw new ConflictException('لم يُسند مشرف لهذه الرحلة بعد');

    const threadId = existingThread?.id ?? (await this.openThread(trip.id, actor.userId));
    const crewIds = trip.supervisors.map((member) => member.userId);
    const customer = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });

    const result = await this.post(threadId, 'CUSTOMER', dto.body, dto.clientId, {}, async (tx, message) => {
      const counts = await tx.tripChatThread.update({
        where: { id: threadId },
        data: { lastMessageAt: message.createdAt, lastMessagePreview: preview(message.body), lastSender: 'CUSTOMER', crewUnread: { increment: 1 } },
        select: COUNTS_SELECT,
      });
      // One push per unread stretch: a passenger sending five lines in a row rings the supervisor's phone once.
      if (counts.crewUnread === 1) {
        await this.notifications.toTripCrew(tx, 'TRIP_CHAT_PASSENGER_MESSAGE', trip.id, {
          userIds: crewIds,
          extra: { customerName: customer?.name || 'راكب', message: preview(message.body, NOTIFY_LENGTH) },
        });
      }
      return counts;
    });
    if (result.counts) this.emitMessage(result.counts, crewIds, result.message, dto.clientId);
    const { senderId: _senderId, ...forCustomer } = result.message;
    return { threadId, message: forCustomer, ...(await this.countsOf(threadId, result.counts)) };
  }

  async markMineRead(actor: Actor, threadId: string) {
    this.assertCustomer(actor);
    const thread = await this.prisma.tripChatThread.findFirst({ where: { id: threadId, customerId: actor.userId }, select: { id: true, tripId: true } });
    if (!thread) throw new NotFoundException('المحادثة غير موجودة');
    return this.markRead(thread, { customerUnread: 0 });
  }

  // ---- The crew's side ----

  /** Answering passengers is the supervisor's job; a driver on the trip is busy with the road. */
  private async assertSupervises(actor: Actor, tripId: string) {
    const assigned = await this.prisma.tripSupervisor.count({ where: { tripId, userId: actor.userId } });
    if (assigned === 0) throw new ForbiddenException('محادثات الركاب متاحة لمشرف الرحلة فقط');
  }

  private async crewThread(actor: Actor, threadId: string) {
    const thread = await this.prisma.tripChatThread.findUnique({ where: { id: threadId }, select: { id: true, tripId: true, customerId: true } });
    if (!thread) throw new NotFoundException('المحادثة غير موجودة');
    await this.assertSupervises(actor, thread.tripId);
    return thread;
  }

  /** Unread passenger threads on the trips this supervisor works, for the badges on their home and trip screens. */
  async crewUnread(actor: Actor) {
    const threads = await this.prisma.tripChatThread.findMany({
      where: { crewUnread: { gt: 0 }, trip: { supervisors: { some: { userId: actor.userId } } } },
      select: { tripId: true },
    });
    const trips: Record<string, number> = {};
    for (const thread of threads) trips[thread.tripId] = (trips[thread.tripId] ?? 0) + 1;
    return { total: threads.length, trips };
  }

  async tripThreads(actor: Actor, tripId: string) {
    await this.assertSupervises(actor, tripId);
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { ...TRIP_WINDOW_SELECT, tripCode: true } });
    if (!trip) throw new NotFoundException('Trip not found');
    const window = chatWindow(trip, await this.opensBeforeHours());
    const threads = await this.prisma.tripChatThread.findMany({
      where: { tripId },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      select: {
        id: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        lastSender: true,
        crewUnread: true,
        customerUnread: true,
        customer: { select: { id: true, name: true } },
      },
    });

    // Seat numbers tell the supervisor who is writing; returning passengers keep the seats of their outbound booking.
    const customerIds = threads.map((thread) => thread.customer.id);
    const returning = trip.reverseOfTripId && customerIds.length > 0 ? await returningBookingIds(this.prisma, trip.reverseOfTripId) : [];
    const bookings = customerIds.length
      ? await this.prisma.booking.findMany({
          where: { userId: { in: customerIds }, OR: [{ tripId, status: { in: [...TRAVELING_STATUSES] } }, { id: { in: returning } }] },
          select: { userId: true, passengers: { select: { seatNumber: true } } },
        })
      : [];
    const seatsOf = (customerId: string) =>
      bookings
        .filter((booking) => booking.userId === customerId)
        .flatMap((booking) => booking.passengers.map((passenger) => passenger.seatNumber))
        .sort((a, b) => Number(a) - Number(b));

    return {
      trip: { id: trip.id, tripCode: trip.tripCode, origin: trip.origin, destination: trip.destination, departureTime: trip.departureTime },
      canWrite: window.isOpen,
      closesAt: window.closesAt,
      threads: threads.map((thread) => ({ ...thread, seats: seatsOf(thread.customer.id), isRiding: bookings.some((booking) => booking.userId === thread.customer.id) })),
    };
  }

  async crewMessages(actor: Actor, threadId: string, query: MessagesQuery) {
    const thread = await this.crewThread(actor, threadId);
    const [counts, page, header] = await Promise.all([
      this.prisma.tripChatThread.findUniqueOrThrow({ where: { id: threadId }, select: { crewUnread: true, customerUnread: true } }),
      this.messagesOf(threadId, query, CREW_MESSAGE_SELECT),
      // Polls only want new messages, so who the thread is with is read once when it opens.
      query.after ? null : this.crewHeader(thread),
    ]);
    return { ...counts, ...page, ...(header && { thread: header }) };
  }

  private async crewHeader(thread: { id: string; tripId: string; customerId: string }) {
    const [trip, customer] = await Promise.all([
      this.prisma.trip.findUniqueOrThrow({ where: { id: thread.tripId }, select: TRIP_WINDOW_SELECT }),
      this.prisma.user.findUnique({ where: { id: thread.customerId }, select: { name: true, phone: true } }),
    ]);
    const window = chatWindow(trip, await this.opensBeforeHours());
    const isRiding = !!(await this.rideOf(thread.customerId, trip));
    return { id: thread.id, tripId: thread.tripId, customer, canWrite: window.isOpen && isRiding, closesAt: window.closesAt };
  }

  async sendAsCrew(actor: Actor, threadId: string, dto: TripChatMessageDto) {
    const thread = await this.crewThread(actor, threadId);
    if (dto.clientId) {
      const sent = await this.findByClientId(threadId, dto.clientId, CREW_MESSAGE_SELECT);
      if (sent) return { threadId, message: sent, ...(await this.countsOf(threadId)) };
    }
    const trip = await this.prisma.trip.findUniqueOrThrow({ where: { id: thread.tripId }, select: TRIP_WINDOW_SELECT });
    if (!chatWindow(trip, await this.opensBeforeHours()).isOpen) throw new ConflictException('أُغلقت المراسلة لهذه الرحلة');
    // Someone who cancelled is no longer this trip's passenger, and their old thread is not a way to keep reaching them.
    const bookingId = await this.rideOf(thread.customerId, trip);
    if (!bookingId) throw new ConflictException('لم يعد هذا العميل من ركاب الرحلة');

    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const senderName = me?.name ?? null;
    const presence = await this.prisma.appPresence.findUnique({ where: { userId: thread.customerId }, select: { screen: true, lastSeenAt: true } });
    const isReading = !!presence && presence.screen === CHAT_ROUTE && presence.lastSeenAt.getTime() >= Date.now() - ONLINE_WINDOW_MS;

    const result = await this.post(threadId, 'CREW', dto.body, dto.clientId, { senderId: actor.userId, senderName }, async (tx, message) => {
      const counts = await tx.tripChatThread.update({
        where: { id: threadId },
        // Answering is reading: the supervisor should not have to open the thread twice.
        data: { lastMessageAt: message.createdAt, lastMessagePreview: preview(message.body), lastSender: 'CREW', customerUnread: { increment: 1 }, crewUnread: 0 },
        select: COUNTS_SELECT,
      });
      // Someone looking at the thread already sees the reply; a sheet on top of it would only get in the way.
      if (!isReading) {
        await this.notifications.toBookingOwners(tx, 'TRIP_CHAT_CREW_MESSAGE', [bookingId], { senderName: senderName || 'مشرف الرحلة', message: preview(message.body, NOTIFY_LENGTH) });
      }
      return counts;
    });
    if (result.counts) this.emitMessage(result.counts, trip.supervisors.map((member) => member.userId), result.message, dto.clientId);
    return { threadId, message: result.message, ...(await this.countsOf(threadId, result.counts)) };
  }

  async markCrewRead(actor: Actor, threadId: string) {
    const thread = await this.crewThread(actor, threadId);
    return this.markRead(thread, { crewUnread: 0 });
  }

  // ---- Shared ----

  /** Sent back with every message, so the sender's read ticks are right even when the live connection is down. */
  private async countsOf(threadId: string, known?: { crewUnread: number; customerUnread: number } | null) {
    const counts = known ?? (await this.prisma.tripChatThread.findUniqueOrThrow({ where: { id: threadId }, select: { crewUnread: true, customerUnread: true } }));
    return { crewUnread: counts.crewUnread, customerUnread: counts.customerUnread };
  }

  private async openThread(tripId: string, customerId: string) {
    const where = { tripId_customerId: { tripId, customerId } };
    try {
      return (await this.prisma.tripChatThread.upsert({ where, create: { tripId, customerId }, update: {}, select: { id: true } })).id;
    } catch (err) {
      // Two first messages sent together can both try to create the thread; the second reads the one that won.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return (await this.prisma.tripChatThread.findUniqueOrThrow({ where, select: { id: true } })).id;
      throw err;
    }
  }

  private async markRead(thread: { id: string; tripId: string }, data: { crewUnread: 0 } | { customerUnread: 0 }) {
    const key = 'crewUnread' in data ? 'crewUnread' : 'customerUnread';
    const updated = await this.prisma.tripChatThread.updateMany({ where: { id: thread.id, [key]: { gt: 0 } }, data });
    const counts = await this.prisma.tripChatThread.findUniqueOrThrow({ where: { id: thread.id }, select: COUNTS_SELECT });
    // Nothing changed means nobody needs telling, which keeps an open thread's repeated reads quiet.
    if (updated.count > 0) {
      const crew = await this.prisma.tripSupervisor.findMany({ where: { tripId: thread.tripId }, select: { userId: true } });
      this.realtime.tripChatUpdated(counts.customerId, crew.map((member) => member.userId), {
        threadId: counts.id,
        tripId: counts.tripId,
        crewUnread: counts.crewUnread,
        customerUnread: counts.customerUnread,
      });
    }
    return { crewUnread: counts.crewUnread, customerUnread: counts.customerUnread };
  }

  private emitMessage(counts: { id: string; tripId: string; customerId: string; crewUnread: number; customerUnread: number }, crewIds: string[], message: Record<string, unknown>, clientId?: string) {
    this.realtime.tripChatMessage(counts.customerId, crewIds, { threadId: counts.id, tripId: counts.tripId, crewUnread: counts.crewUnread, customerUnread: counts.customerUnread, clientId: clientId ?? null }, message);
  }

  private findByClientId<S extends Prisma.TripChatMessageSelect>(threadId: string, clientId: string, select: S) {
    return this.prisma.tripChatMessage.findUnique({ where: { threadId_clientId: { threadId, clientId } }, select });
  }

  private async messagesOf<S extends Prisma.TripChatMessageSelect>(threadId: string, query: MessagesQuery, select: S) {
    if (query.after) {
      // Oldest first, so a client that missed more than a page reads on from the last one it got instead of skipping the rest.
      const rows = await this.prisma.tripChatMessage.findMany({
        where: { threadId, createdAt: { gte: new Date(query.after) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE + 1,
        select,
      });
      return { messages: rows.slice(0, PAGE_SIZE), hasMore: false, hasNewer: rows.length > PAGE_SIZE };
    }
    const rows = await this.prisma.tripChatMessage.findMany({
      where: { threadId, ...(query.before && { createdAt: { lt: new Date(query.before) } }) },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      select,
    });
    return { messages: rows.slice(0, PAGE_SIZE).reverse(), hasMore: rows.length > PAGE_SIZE };
  }

  /**
   * Writes the message and the thread's summary together. A retry with the same clientId returns the message already
   * posted instead of posting it again, and then counts is null: the first copy already told everyone.
   */
  private async post<C>(
    threadId: string,
    sender: TripChatSender,
    body: string,
    clientId: string | undefined,
    author: { senderId?: string; senderName?: string | null },
    after: (tx: Prisma.TransactionClient, message: CrewMessage) => Promise<C>,
  ): Promise<{ message: CrewMessage; counts: C | null }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const message = await tx.tripChatMessage.create({ data: { threadId, sender, body, clientId, ...author }, select: CREW_MESSAGE_SELECT });
        return { message, counts: await after(tx, message) };
      });
    } catch (err) {
      // Two copies of the same retry can pass the check before together; the unique index stops the second.
      if (clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const found = await this.findByClientId(threadId, clientId, CREW_MESSAGE_SELECT);
        if (found) return { message: found, counts: null };
      }
      throw err;
    }
  }
}

@ApiTags('Trip chat')
@Controller('trip-chat')
@ApiBearerAuth()
class TripChatController {
  constructor(private chat: TripChatService) {}

  @Get('mine')
  @ApiOperation({ summary: "The customer's threads with their trips' crews" })
  mine(@Req() req) {
    return this.chat.mine(req.user);
  }

  @Get('bookings/:bookingId')
  @ApiOperation({ summary: "Whether the customer can write to the supervisor of a booking's trip now, and the thread if there is one" })
  forBooking(@Req() req, @Param('bookingId') bookingId: string) {
    return this.chat.forBooking(req.user, bookingId);
  }

  @Post('bookings/:bookingId/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "The customer writes to their trip's supervisor, opening the thread on the first message" })
  sendAsCustomer(@Req() req, @Param('bookingId') bookingId: string, @Body() dto: TripChatMessageDto) {
    return this.chat.sendAsCustomer(req.user, bookingId, dto);
  }

  @Get('mine/threads/:id/messages')
  @ApiOperation({ summary: "A page of one of the customer's threads" })
  customerMessages(@Req() req, @Param('id') id: string, @Query() query: MessagesQuery) {
    return this.chat.customerMessages(req.user, id, query);
  }

  @Post('mine/threads/:id/read')
  @SkipAudit()
  @ApiOperation({ summary: 'The customer opened the thread' })
  markMineRead(@Req() req, @Param('id') id: string) {
    return this.chat.markMineRead(req.user, id);
  }

  @Get('crew/unread')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Passenger threads waiting for this supervisor, per trip' })
  crewUnread(@Req() req) {
    return this.chat.crewUnread(req.user);
  }

  @Get('crew/trips/:tripId/threads')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: "The passengers' threads on a trip this employee supervises" })
  tripThreads(@Req() req, @Param('tripId') tripId: string) {
    return this.chat.tripThreads(req.user, tripId);
  }

  @Get('crew/threads/:id/messages')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: "A page of a passenger's thread, for the trip's supervisor" })
  crewMessages(@Req() req, @Param('id') id: string, @Query() query: MessagesQuery) {
    return this.chat.crewMessages(req.user, id, query);
  }

  @Post('crew/threads/:id/messages')
  @RequirePermission('crew.trips')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The supervisor answers a passenger' })
  sendAsCrew(@Req() req, @Param('id') id: string, @Body() dto: TripChatMessageDto) {
    return this.chat.sendAsCrew(req.user, id, dto);
  }

  @Post('crew/threads/:id/read')
  @SkipAudit()
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'The supervisor opened the thread' })
  markCrewRead(@Req() req, @Param('id') id: string) {
    return this.chat.markCrewRead(req.user, id);
  }
}

@Module({
  controllers: [TripChatController],
  providers: [TripChatService],
})
export class TripChatModule {}

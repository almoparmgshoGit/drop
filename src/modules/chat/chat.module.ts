import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { paymentFigures } from '../../common/utils/payment.util';
import { boardingOfBookings } from '../../common/utils/ticket-boarding.util';

const PAGE_SIZE = 50;
const PREVIEW_LENGTH = 120;
const NOTIFY_LENGTH = 200;
/** The app reports every 45 seconds, so one missed report does not make someone look gone. */
const ONLINE_WINDOW_MS = 2 * 60_000;
const ABANDON_WINDOW_MS = 60 * 60_000;
const PAYMENT_ROUTE = 'Payment';
const CHAT_ROUTE = 'Chat';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** What the panel shows for each app screen. A screen left out reads as browsing the app. */
const SCREEN_LABELS: Record<string, string> = {
  Home: 'الرئيسية',
  Search: 'البحث عن رحلة',
  SearchResults: 'نتائج البحث',
  ReturnSearchResults: 'نتائج رحلة العودة',
  TripDetails: 'تفاصيل رحلة',
  SelectPackage: 'اختيار باقة',
  SeatSelection: 'اختيار المقعد',
  PassengerDetails: 'بيانات المسافرين',
  MapBoardingPoint: 'نقطة الصعود',
  BookingReview: 'مراجعة الحجز',
  Payment: 'صفحة الدفع',
  BookingConfirmed: 'تأكيد الحجز',
  Bookings: 'حجوزاتي',
  BookingDetails: 'تفاصيل حجز',
  TicketStatus: 'التذكرة',
  CancellationStatus: 'طلب إلغاء',
  LiveTracking: 'تتبع الحافلة',
  MyTripNow: 'رحلتي الآن',
  Wallet: 'المحفظة',
  WalletTransactionDetails: 'المحفظة',
  LoyaltyPoints: 'نقاط الولاء',
  Notifications: 'الإشعارات',
  Profile: 'حسابي',
  Policy: 'السياسات',
  Chat: 'المحادثة مع الدعم',
  TripChat: 'المحادثة مع مشرف الرحلة',
};
const BROWSING_SCREENS = ['Search', 'SearchResults', 'ReturnSearchResults', 'TripDetails', 'SelectPackage', 'SeatSelection', 'PassengerDetails', 'MapBoardingPoint', 'BookingReview'];

class CustomerMessageDto {
  @trimmed() @IsString() @Length(1, 2000, { message: 'اكتب رسالة لا تتجاوز 2000 حرف' }) body: string;
  @IsOptional() @IsString() @MaxLength(64) clientId?: string;
}

class BookingCardDto {
  @IsString() @MaxLength(64) bookingId: string;
}

class StaffMessageDto {
  @IsOptional() @trimmed() @IsString() @MaxLength(2000, { message: 'الرسالة لا تتجاوز 2000 حرف' }) body?: string;
  /** Sends this coupon to the customer; the text may be left empty. */
  @IsOptional() @IsString() @MaxLength(30) couponCode?: string;
  @IsOptional() @IsString() @MaxLength(64) clientId?: string;
}

class MineQuery {
  /** Only what arrived at or after this moment; clients merge by id. */
  @IsOptional() @IsDateString() after?: string;
  /** Older messages, for scrolling back. */
  @IsOptional() @IsDateString() before?: string;
}

class ConversationsQuery {
  @IsOptional() @IsIn(['all', 'unread', 'mine', 'closed']) filter?: 'all' | 'unread' | 'mine' | 'closed';
  @IsOptional() @trimmed() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class UpdateConversationDto {
  @IsOptional() @IsIn(['OPEN', 'CLOSED']) status?: 'OPEN' | 'CLOSED';
  @IsOptional() @IsBoolean() assignToMe?: boolean;
}

class StartConversationDto {
  @IsString() @MaxLength(64) customerId: string;
}

class PresenceDto {
  @IsString() @Matches(/^[A-Za-z]{1,40}$/) screen: string;
  @IsOptional() @IsString() @MaxLength(64) tripId?: string;
  @IsOptional() @IsString() @MaxLength(64) bookingId?: string;
  @IsIn(['ios', 'android']) platform: string;
}

interface Staff {
  userId: string;
  name?: string | null;
}

const CUSTOMER_MESSAGE_SELECT = { id: true, sender: true, body: true, couponCode: true, bookingCard: true, createdAt: true } as const;
const STAFF_MESSAGE_SELECT = { ...CUSTOMER_MESSAGE_SELECT, staffId: true, staffName: true } as const;

const preview = (text: string, length = PREVIEW_LENGTH) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const BOOKING_STATUS_TEXT: Record<string, string> = {
  PENDING: 'قيد الدفع',
  CONFIRMED: 'مؤكد',
  BOARDED: 'تم الصعود',
  PENDING_CANCELLATION_REVIEW: 'طلب الإلغاء قيد المراجعة',
  CANCELLED: 'ملغى',
};
const BOARDING_STATE_TEXT: Record<string, string> = {
  WAITING: 'بانتظار الصعود',
  LATE: 'متأخر عن نقطة الصعود',
  STOPPED: 'التذكرة موقوفة',
};

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  private assertCustomer(role: string) {
    if (role !== 'PASSENGER') throw new ForbiddenException('المحادثة مع الدعم لحسابات العملاء فقط');
  }

  // ---- The customer's side ----

  async mine(user: { userId: string; role: string }, query: MineQuery) {
    this.assertCustomer(user.role);
    const conversation = await this.prisma.conversation.findUnique({
      where: { customerId: user.userId },
      select: { id: true, status: true, customerUnread: true },
    });
    if (!conversation) return { conversation: null, messages: [], hasMore: false };
    const page = await this.messagesOf(conversation.id, query, CUSTOMER_MESSAGE_SELECT);
    return { conversation, ...page };
  }

  async mineSummary(user: { userId: string; role: string }) {
    if (user.role !== 'PASSENGER') return { unread: 0 };
    const conversation = await this.prisma.conversation.findUnique({ where: { customerId: user.userId }, select: { customerUnread: true } });
    return { unread: conversation?.customerUnread ?? 0 };
  }

  private customerConversation(customerId: string) {
    return this.prisma.conversation.upsert({
      where: { customerId },
      create: { customerId },
      update: {},
      select: { id: true, status: true },
    });
  }

  async sendAsCustomer(user: { userId: string; role: string }, dto: CustomerMessageDto) {
    this.assertCustomer(user.role);
    const conversation = await this.customerConversation(user.userId);
    return this.postFromCustomer(user.userId, conversation.id, dto.body, dto.clientId);
  }

  /** The server fills the card from the booking itself, so a customer can only ever describe their own, and only truthfully. */
  async sendBookingCard(user: { userId: string; role: string }, bookingId: string) {
    this.assertCustomer(user.role);
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId: user.userId },
      select: {
        id: true,
        tripId: true,
        bookingReference: true,
        status: true,
        totalPrice: true,
        boardingPointId: true,
        boardingPointName: true,
        boardingPointTime: true,
        payment: { select: { amount: true, walletAmount: true, status: true, method: true } },
        collections: { select: { amount: true } },
        passengers: { orderBy: { seatNumber: 'asc' }, select: { fullName: true, seatNumber: true, ticket: { select: { ticketNumber: true, isBoarded: true, boardedAt: true } } } },
        trip: {
          select: {
            tripCode: true,
            origin: true,
            destination: true,
            departureTime: true,
            arrivalTime: true,
            liveStatus: true,
            bus: { select: { plateNumber: true } },
            currentBoardingPoint: { select: { name: true } },
          },
        },
      },
    });
    if (!booking) throw new NotFoundException('الحجز غير موجود');

    const conversation = await this.customerConversation(user.userId);
    const boarding = (await boardingOfBookings(this.prisma, [booking])).get(booking.id) ?? null;

    // Opening the chat from the ticket again says nothing new to whoever is reading the thread.
    const last = await this.prisma.chatMessage.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' }, select: CUSTOMER_MESSAGE_SELECT });
    const lastCard = last?.bookingCard as { bookingId?: string; status?: string; boardingState?: string | null } | null | undefined;
    if (last && conversation.status === 'OPEN' && lastCard?.bookingId === booking.id && lastCard.status === booking.status && lastCard.boardingState === (boarding?.state ?? null)) return last;

    const { received, wallet, isPaid } = paymentFigures(booking.payment, booking.collections);
    const { trip } = booking;
    const card = {
      bookingId: booking.id,
      reference: booking.bookingReference,
      status: booking.status,
      statusText: BOOKING_STATUS_TEXT[booking.status] ?? booking.status,
      boardingState: boarding?.state ?? null,
      boardingText: boarding ? BOARDING_STATE_TEXT[boarding.state] : null,
      boardingReason: boarding?.reason ?? null,
      otherPoints: boarding?.otherPoints ?? [],
      tripCode: trip.tripCode,
      origin: trip.origin,
      destination: trip.destination,
      departureTime: trip.departureTime.toISOString(),
      arrivalTime: trip.arrivalTime.toISOString(),
      busPlate: trip.bus?.plateNumber ?? null,
      liveStatus: trip.liveStatus,
      busPointName: trip.currentBoardingPoint?.name ?? null,
      boardingPointName: booking.boardingPointName,
      boardingPointTime: booking.boardingPointTime,
      passengers: booking.passengers.map((passenger) => ({
        name: passenger.fullName,
        seat: passenger.seatNumber,
        ticketNumber: passenger.ticket?.ticketNumber ?? null,
        isBoarded: !!passenger.ticket?.isBoarded,
        boardedAt: passenger.ticket?.boardedAt?.toISOString() ?? null,
      })),
      total: Number(booking.totalPrice),
      paid: (received + wallet) / 100,
      isPaid,
      paymentMethod: booking.payment?.method ?? null,
    };
    const body = `بخصوص الحجز ${booking.bookingReference}: ${trip.origin} ← ${trip.destination}، ${card.boardingText ?? card.statusText}.`;
    return this.postFromCustomer(user.userId, conversation.id, body, undefined, card);
  }

  private async postFromCustomer(customerId: string, conversationId: string, body: string, clientId?: string, bookingCard?: Prisma.InputJsonValue) {
    const sent = await this.post(conversationId, clientId, CUSTOMER_MESSAGE_SELECT, async (tx) => {
      const message = await tx.chatMessage.create({
        data: { conversationId, sender: 'CUSTOMER', body, bookingCard, clientId },
        select: CUSTOMER_MESSAGE_SELECT,
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: 'OPEN',
          closedAt: null,
          lastMessageAt: message.createdAt,
          lastMessagePreview: preview(body),
          lastSender: 'CUSTOMER',
          staffUnread: { increment: 1 },
        },
      });
      return message;
    });
    this.realtime.chatMessage(customerId, conversationId, sent, clientId);
    return sent;
  }

  async markMineRead(user: { userId: string; role: string }) {
    this.assertCustomer(user.role);
    await this.prisma.conversation.updateMany({ where: { customerId: user.userId, customerUnread: { gt: 0 } }, data: { customerUnread: 0 } });
    return { unread: 0 };
  }

  // ---- The staff's side ----

  async conversations(staff: Staff, query: ConversationsQuery) {
    const search = query.search?.trim();
    // Phones are stored as +966 5..., so a local 05... has to lose its leading zero to match.
    const phone = search && /^0\d+$/.test(search) ? search.slice(1) : search;
    const matching: Prisma.ConversationWhereInput = search
      ? {
          OR: [
            { customer: { name: { contains: search, mode: 'insensitive' } } },
            { customer: { phone: { contains: phone } } },
            { customer: { bookings: { some: { bookingReference: { contains: search, mode: 'insensitive' } } } } },
          ],
        }
      : {};
    const FILTERS: Record<string, Prisma.ConversationWhereInput> = {
      all: { status: 'OPEN' },
      unread: { status: 'OPEN', staffUnread: { gt: 0 } },
      mine: { status: 'OPEN', assignedToId: staff.userId },
      closed: { status: 'CLOSED' },
    };
    const [items, all, unread, mine, closed, online] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { ...FILTERS[query.filter ?? 'all'], ...matching },
        orderBy: { lastMessageAt: 'desc' },
        take: query.limit ?? 50,
        select: {
          id: true,
          status: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          lastSender: true,
          staffUnread: true,
          assignedToId: true,
          assignedToName: true,
          customer: { select: { id: true, name: true, phone: true, messageLanguage: true, nationality: true, blockedAt: true, appPresence: { select: { lastSeenAt: true } } } },
        },
      }),
      this.prisma.conversation.count({ where: FILTERS.all }),
      this.prisma.conversation.count({ where: FILTERS.unread }),
      this.prisma.conversation.count({ where: FILTERS.mine }),
      this.prisma.conversation.count({ where: FILTERS.closed }),
      this.prisma.appPresence.count({ where: { lastSeenAt: { gte: this.onlineSince() } } }),
    ]);
    const since = this.onlineSince();
    return {
      counts: { all, unread, mine, closed, online },
      items: items.map(({ customer: { appPresence, ...customer }, ...conversation }) => ({
        ...conversation,
        customer: { ...customer, isOnline: !!appPresence && appPresence.lastSeenAt >= since },
      })),
    };
  }

  /** Small enough for the sidebar to ask for often. */
  async unreadCount() {
    return { unread: await this.prisma.conversation.count({ where: { status: 'OPEN', staffUnread: { gt: 0 } } }) };
  }

  async conversation(id: string, query: MineQuery) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        staffUnread: true,
        assignedToId: true,
        assignedToName: true,
        customerId: true,
      },
    });
    if (!conversation) throw new NotFoundException('المحادثة غير موجودة');
    const [page, customer] = await Promise.all([
      this.messagesOf(id, query, STAFF_MESSAGE_SELECT),
      // Polls only want new messages, so the customer's card is read once when the thread opens.
      query.after ? null : this.customerCard(conversation.customerId),
    ]);
    return { ...conversation, ...page, customer };
  }

  async customerCard(customerId: string) {
    const customer = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        name: true,
        phone: true,
        walletBalance: true,
        loyaltyPoints: true,
        nationality: true,
        messageLanguage: true,
        blockedAt: true,
        createdAt: true,
        appPresence: { select: { screen: true, tripId: true, bookingId: true, lastSeenAt: true, sessionStartedAt: true } },
        _count: { select: { bookings: true } },
      },
    });
    if (!customer) throw new NotFoundException('العميل غير موجود');
    const bookings = await this.prisma.booking.findMany({
      where: { userId: customerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        bookingReference: true,
        status: true,
        totalPrice: true,
        boardingPointName: true,
        boardingPointTime: true,
        trip: { select: { tripCode: true, origin: true, destination: true, departureTime: true } },
        passengers: { select: { seatNumber: true } },
      },
    });
    const { appPresence, _count, ...details } = customer;
    return {
      ...details,
      bookingCount: _count.bookings,
      bookings,
      activity: appPresence ? await this.describePresence(appPresence) : null,
    };
  }

  async sendAsStaff(staff: Staff, id: string, dto: StaffMessageDto) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true, assignedToId: true, customerId: true, customer: { select: { blockedAt: true, appPresence: { select: { screen: true, lastSeenAt: true } } } } },
    });
    if (!conversation) throw new NotFoundException('المحادثة غير موجودة');
    if (conversation.customer.blockedAt) throw new ConflictException('هذا العميل محظور، فلا تصله الرسائل');

    let couponCode: string | undefined;
    let body = dto.body?.trim() ?? '';
    if (dto.couponCode) {
      const coupon = await this.sendableCoupon(dto.couponCode);
      couponCode = coupon.code;
      body ||= `أرسلنا لك كوبون خصم ${coupon.code}. استخدمه عند إتمام حجزك.`;
    }
    if (!body) throw new BadRequestException('اكتب رسالة أو اختر كوبونًا');

    const presence = conversation.customer.appPresence;
    const isReading = !!presence && presence.screen === CHAT_ROUTE && presence.lastSeenAt >= this.onlineSince();

    const sent = await this.post(id, dto.clientId, STAFF_MESSAGE_SELECT, async (tx) => {
      const message = await tx.chatMessage.create({
        data: { conversationId: id, sender: 'STAFF', staffId: staff.userId, staffName: staff.name ?? null, body, couponCode, clientId: dto.clientId },
        select: STAFF_MESSAGE_SELECT,
      });
      await tx.conversation.update({
        where: { id },
        data: {
          status: 'OPEN',
          closedAt: null,
          lastMessageAt: message.createdAt,
          lastMessagePreview: preview(body),
          lastSender: 'STAFF',
          customerUnread: { increment: 1 },
          // Answering is reading: nobody should have to open the thread twice.
          staffUnread: 0,
          // The first to answer takes the conversation, so two employees do not both pick it up.
          ...(conversation.assignedToId ? {} : { assignedToId: staff.userId, assignedToName: staff.name ?? null }),
        },
      });
      // Someone looking at the thread already sees the reply; a sheet on top of it would only get in the way.
      if (!isReading) await this.notifications.toUser(tx, 'CHAT_STAFF_REPLY', conversation.customerId, { message: preview(body, NOTIFY_LENGTH) });
      return message;
    });
    this.realtime.chatMessage(conversation.customerId, id, sent, dto.clientId);
    return sent;
  }

  private async sendableCoupon(code: string) {
    const now = new Date();
    const coupon = await this.prisma.coupon.findFirst({
      where: { code: { equals: code, mode: 'insensitive' }, isActive: true, ownerUserId: null },
      select: { code: true, validFrom: true, validUntil: true, maxUses: true, usedCount: true },
    });
    const isUsable = !!coupon && (!coupon.validFrom || coupon.validFrom <= now) && (!coupon.validUntil || coupon.validUntil >= now) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses);
    if (!isUsable) throw new BadRequestException('هذا الكوبون غير متاح للإرسال');
    return coupon;
  }

  async sendableCoupons() {
    const now = new Date();
    const coupons = await this.prisma.coupon.findMany({
      where: {
        isActive: true,
        ownerUserId: null,
        AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { code: true, type: true, value: true, maxUses: true, usedCount: true, validUntil: true },
    });
    return coupons.filter((coupon) => coupon.maxUses === null || coupon.usedCount < coupon.maxUses);
  }

  async markRead(id: string) {
    const updated = await this.prisma.conversation.updateMany({ where: { id }, data: { staffUnread: 0 } });
    if (updated.count === 0) throw new NotFoundException('المحادثة غير موجودة');
    this.realtime.chatUpdated(id);
    return { staffUnread: 0 };
  }

  async update(staff: Staff, id: string, dto: UpdateConversationDto) {
    const exists = await this.prisma.conversation.count({ where: { id } });
    if (exists === 0) throw new NotFoundException('المحادثة غير موجودة');
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        ...(dto.status === 'CLOSED' && { status: 'CLOSED', closedAt: new Date(), staffUnread: 0 }),
        ...(dto.status === 'OPEN' && { status: 'OPEN', closedAt: null }),
        ...(dto.assignToMe && { assignedToId: staff.userId, assignedToName: staff.name ?? null }),
      },
      select: { id: true, status: true, assignedToId: true, assignedToName: true },
    });
    this.realtime.chatUpdated(id);
    return updated;
  }

  async start(dto: StartConversationDto) {
    const customer = await this.prisma.user.findUnique({ where: { id: dto.customerId }, select: { role: true } });
    if (!customer || customer.role !== 'PASSENGER') throw new NotFoundException('العميل غير موجود');
    return this.prisma.conversation.upsert({
      where: { customerId: dto.customerId },
      create: { customerId: dto.customerId },
      update: {},
      select: { id: true },
    });
  }

  private async messagesOf<S extends Prisma.ChatMessageSelect>(conversationId: string, query: MineQuery, select: S) {
    if (query.after) {
      // Oldest first, so a client that missed more than a page reads on from the last one it got instead of skipping the rest.
      const rows = await this.prisma.chatMessage.findMany({
        where: { conversationId, createdAt: { gte: new Date(query.after) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE + 1,
        select,
      });
      return { messages: rows.slice(0, PAGE_SIZE), hasMore: false, hasNewer: rows.length > PAGE_SIZE };
    }
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId, ...(query.before && { createdAt: { lt: new Date(query.before) } }) },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      select,
    });
    return { messages: rows.slice(0, PAGE_SIZE).reverse(), hasMore: rows.length > PAGE_SIZE };
  }

  /** A retry with the same clientId returns the message already posted instead of posting it again. */
  private async post<S extends Prisma.ChatMessageSelect, R>(
    conversationId: string,
    clientId: string | undefined,
    select: S,
    write: (tx: Prisma.TransactionClient) => Promise<R>,
  ) {
    const existing = () => this.prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId, clientId: clientId! } }, select });
    if (clientId) {
      const found = await existing();
      if (found) return found;
    }
    try {
      return await this.prisma.$transaction((tx) => write(tx));
    } catch (err) {
      // Two copies of the same retry can pass the check above together; the unique index stops the second.
      if (clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const found = await existing();
        if (found) return found;
      }
      throw err;
    }
  }

  // ---- Who is in the app ----

  private onlineSince() {
    return new Date(Date.now() - ONLINE_WINDOW_MS);
  }

  async recordPresence(user: { userId: string; role: string }, dto: PresenceDto) {
    // Crew and office accounts use the same app, and are not customers to reach out to.
    if (user.role !== 'PASSENGER') return { ok: true };
    const now = new Date();
    const previous = await this.prisma.appPresence.findUnique({ where: { userId: user.userId }, select: { lastSeenAt: true, sessionStartedAt: true } });
    const continuing = !!previous && previous.lastSeenAt >= this.onlineSince();
    const data = {
      screen: dto.screen,
      tripId: dto.tripId ?? null,
      bookingId: dto.bookingId ?? null,
      platform: dto.platform,
      lastSeenAt: now,
      sessionStartedAt: continuing ? previous.sessionStartedAt : now,
      ...(dto.screen === PAYMENT_ROUTE && { paymentSeenAt: now }),
    };
    // Upsert on purpose: the id middleware adds an id to every plain create, and this table has none.
    await this.prisma.appPresence.upsert({ where: { userId: user.userId }, create: { userId: user.userId, ...data }, update: data });
    return { ok: true };
  }

  async clearPresence(user: { userId: string }) {
    // The row stays: it remembers that this customer reached the payment screen.
    await this.prisma.appPresence.updateMany({ where: { userId: user.userId }, data: { lastSeenAt: new Date(Date.now() - ONLINE_WINDOW_MS - 1000) } });
    return { ok: true };
  }

  private async describePresence(presence: { screen: string; tripId: string | null; bookingId: string | null; lastSeenAt: Date; sessionStartedAt: Date }) {
    const trip = presence.tripId ? await this.prisma.trip.findUnique({ where: { id: presence.tripId }, select: { tripCode: true, origin: true, destination: true } }) : null;
    return {
      screen: presence.screen,
      label: this.screenLabel(presence.screen, trip),
      isOnline: presence.lastSeenAt >= this.onlineSince(),
      lastSeenAt: presence.lastSeenAt,
      sessionStartedAt: presence.sessionStartedAt,
    };
  }

  private screenLabel(screen: string, trip?: { tripCode: string; origin: string; destination: string } | null) {
    const label = SCREEN_LABELS[screen] ?? 'يتصفح التطبيق';
    return trip ? `${label} — ${trip.tripCode}: ${trip.origin} ← ${trip.destination}` : label;
  }

  async live() {
    const since = this.onlineSince();
    const abandonSince = new Date(Date.now() - ABANDON_WINDOW_MS);
    const [rows, online, browsing, inPayment, leftPayment] = await Promise.all([
      this.prisma.appPresence.findMany({
        where: { lastSeenAt: { gte: since } },
        orderBy: [{ sessionStartedAt: 'asc' }],
        take: 200,
        select: {
          screen: true,
          tripId: true,
          platform: true,
          sessionStartedAt: true,
          lastSeenAt: true,
          user: { select: { id: true, name: true, phone: true, nationality: true, messageLanguage: true, conversation: { select: { id: true, staffUnread: true } } } },
        },
      }),
      this.prisma.appPresence.count({ where: { lastSeenAt: { gte: since } } }),
      this.prisma.appPresence.count({ where: { lastSeenAt: { gte: since }, screen: { in: BROWSING_SCREENS } } }),
      this.prisma.appPresence.count({ where: { lastSeenAt: { gte: since }, screen: PAYMENT_ROUTE } }),
      this.prisma.appPresence.findMany({
        where: { paymentSeenAt: { gte: abandonSince }, NOT: { screen: PAYMENT_ROUTE, lastSeenAt: { gte: since } } },
        select: { userId: true, paymentSeenAt: true },
      }),
    ]);

    // Someone who booked after reaching the payment screen paid; they did not leave it.
    const paid = leftPayment.length
      ? await this.prisma.booking.findMany({
          where: { userId: { in: leftPayment.map((row) => row.userId) }, createdAt: { gte: new Date(abandonSince.getTime() - ABANDON_WINDOW_MS) }, status: { in: ['CONFIRMED', 'BOARDED'] } },
          select: { userId: true, createdAt: true },
        })
      : [];
    const abandoned = leftPayment.filter((row) => !paid.some((booking) => booking.userId === row.userId && booking.createdAt >= new Date(row.paymentSeenAt!.getTime() - ABANDON_WINDOW_MS))).length;

    const tripIds = [...new Set(rows.map((row) => row.tripId).filter((id): id is string => !!id))];
    const trips = tripIds.length ? await this.prisma.trip.findMany({ where: { id: { in: tripIds } }, select: { id: true, tripCode: true, origin: true, destination: true } }) : [];
    const tripById = new Map(trips.map((trip) => [trip.id, trip]));

    return {
      counts: { online, browsing, inPayment, abandoned },
      // Those at the payment screen come first: they are the ones a message can still help.
      items: rows
        .map((row) => ({
          customer: row.user,
          screen: row.screen,
          label: this.screenLabel(row.screen, row.tripId ? tripById.get(row.tripId) : null),
          platform: row.platform,
          sessionStartedAt: row.sessionStartedAt,
          isPaying: row.screen === PAYMENT_ROUTE,
        }))
        .sort((a, b) => Number(b.isPaying) - Number(a.isPaying)),
    };
  }
}

@ApiTags('Chat')
@Controller('chat')
@ApiBearerAuth()
class ChatController {
  constructor(private chat: ChatService) {}

  @Get('mine')
  @ApiOperation({ summary: "The customer's support thread" })
  mine(@Req() req, @Query() query: MineQuery) {
    return this.chat.mine(req.user, query);
  }

  @Get('mine/summary')
  @ApiOperation({ summary: 'How many support replies the customer has not opened' })
  mineSummary(@Req() req) {
    return this.chat.mineSummary(req.user);
  }

  @Post('mine/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'The customer writes to support' })
  sendAsCustomer(@Req() req, @Body() dto: CustomerMessageDto) {
    return this.chat.sendAsCustomer(req.user, dto);
  }

  @Post('mine/booking-card')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "The customer sends support a booking's details from its ticket" })
  sendBookingCard(@Req() req, @Body() dto: BookingCardDto) {
    return this.chat.sendBookingCard(req.user, dto.bookingId);
  }

  @Post('mine/read')
  @SkipAudit()
  @ApiOperation({ summary: 'The customer opened the thread' })
  markMineRead(@Req() req) {
    return this.chat.markMineRead(req.user);
  }

  @Get('conversations')
  @RequirePermission('chat.view')
  @ApiOperation({ summary: 'Support threads, newest message first' })
  conversations(@Req() req, @Query() query: ConversationsQuery) {
    return this.chat.conversations(req.user, query);
  }

  @Get('unread')
  @RequirePermission('chat.view')
  @ApiOperation({ summary: 'How many open threads wait for an answer' })
  unread() {
    return this.chat.unreadCount();
  }

  @Get('coupons')
  @RequirePermission('chat.reply')
  @ApiOperation({ summary: 'Coupons an employee can hand out in a conversation' })
  coupons() {
    return this.chat.sendableCoupons();
  }

  @Get('live')
  @RequirePermission('chat.view')
  @ApiOperation({ summary: 'Signed-in customers with the app open right now' })
  live() {
    return this.chat.live();
  }

  @Post('conversations/start')
  @RequirePermission('chat.reply')
  @ApiOperation({ summary: "Open a customer's thread, creating it when they have none" })
  start(@Body() dto: StartConversationDto) {
    return this.chat.start(dto);
  }

  @Get('conversations/:id')
  @RequirePermission('chat.view')
  @ApiOperation({ summary: "One thread's messages and the customer's details" })
  conversation(@Param('id') id: string, @Query() query: MineQuery) {
    return this.chat.conversation(id, query);
  }

  @Post('conversations/:id/messages')
  @RequirePermission('chat.reply')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'An employee answers, optionally with a coupon' })
  sendAsStaff(@Req() req, @Param('id') id: string, @Body() dto: StaffMessageDto) {
    return this.chat.sendAsStaff(req.user, id, dto);
  }

  @Post('conversations/:id/read')
  @SkipAudit()
  @RequirePermission('chat.view')
  @ApiOperation({ summary: 'An employee opened the thread' })
  markRead(@Param('id') id: string) {
    return this.chat.markRead(id);
  }

  @Put('conversations/:id')
  @RequirePermission('chat.reply')
  @ApiOperation({ summary: 'Close, reopen or take a thread' })
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateConversationDto) {
    return this.chat.update(req.user, id, dto);
  }
}

@ApiTags('Chat')
@Controller('presence')
@ApiBearerAuth()
class PresenceController {
  constructor(private chat: ChatService) {}

  @Post()
  @SkipAudit()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The app reports the screen a signed-in customer is on' })
  record(@Req() req, @Body() dto: PresenceDto) {
    return this.chat.recordPresence(req.user, dto);
  }

  @Post('leave')
  @SkipAudit()
  @ApiOperation({ summary: 'The customer signed out or closed the app' })
  leave(@Req() req) {
    return this.chat.clearPresence(req.user);
  }
}

@Module({
  controllers: [ChatController, PresenceController],
  providers: [ChatService],
})
export class ChatModule {}

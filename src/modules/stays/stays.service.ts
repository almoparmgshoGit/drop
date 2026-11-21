import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RoomType, StayBookingStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { WalletService } from '../../common/services/wallet.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { hotelHousingTerms, housingCharge, isRoomSellable, privateRoomsNeeded } from '../../common/utils/housing-price.util';
import { applicableRule, CancellationRule, daysUntil, parseCancellationRules } from '../../common/utils/cancellation-policy.util';
import { hotelRatingSummaries, NO_RATINGS } from '../../common/utils/hotel-ratings.util';
import { GALLERY_SELECT } from '../../common/utils/gallery.util';
import { SERVICE_SELECT } from '../../common/utils/services.util';
import { RIYADH_OFFSET_MS, riyadhDate } from '../../common/utils/time.util';
import { randomCode, toHalalas, toSar } from '../bookings/bookings.service';
import { AdminCancelStayDto, AdminStaysQuery, CreateStayDto, RateStayDto, StayHotelsQuery, StayQuoteDto } from './stays.dto';

const DEFAULT_VAT_RATE = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const REVIEWS_SHOWN = 20;
const DEFAULT_PAGE_SIZE = 25;

/** What prices a hotel for a stay of its own, the same fields a transport booking's chosen hotel is priced from. */
const HOTEL_PRICE_SELECT = {
  id: true,
  name: true,
  city: true,
  address: true,
  stars: true,
  isActive: true,
  offersSharedRoom: true,
  offersPrivateRoom: true,
  bedPrice: true,
  privateRoomPrice: true,
  privateRoomCapacity: true,
  privateRoomPriceBasis: true,
  housingPricePeriod: true,
} satisfies Prisma.HotelSelect;

type PricedHotel = Prisma.HotelGetPayload<{ select: typeof HOTEL_PRICE_SELECT }>;

const STAY_INCLUDE = {
  hotel: { select: { id: true, name: true, city: true, address: true, stars: true, images: { ...GALLERY_SELECT, take: 1 } } },
  rating: { select: { rating: true, comment: true } },
} satisfies Prisma.StayBookingInclude;

const ADMIN_STAY_INCLUDE = {
  ...STAY_INCLUDE,
  user: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.StayBookingInclude;

type StayRow = Prisma.StayBookingGetPayload<{ include: typeof STAY_INCLUDE }>;

type CancellationTerms = { mode: 'TRIP' | 'CUSTOM'; text: string; rules: CancellationRule[] };

const roomOptionsOf = (hotel: { offersSharedRoom: boolean; offersPrivateRoom: boolean }): RoomType[] => [
  ...(hotel.offersSharedRoom ? (['SHARED'] as const) : []),
  ...(hotel.offersPrivateRoom ? (['PRIVATE'] as const) : []),
];

const money = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
/** A calendar day as stored in a DATE column: midnight UTC of that day. */
const dateOnly = (day: string) => new Date(`${day}T00:00:00Z`);
const todayDate = () => dateOnly(riyadhDate(new Date()));
/** The moment a check-in day starts in Riyadh, which notice for a cancellation is counted to. */
const checkInStarts = (checkIn: Date) => new Date(checkIn.getTime() - RIYADH_OFFSET_MS);
const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || 'عميل';

@Injectable()
export class StaysService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private wallet: WalletService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
  ) {}

  // ---------------------------------------------------------------- pricing

  /** The room types this hotel can sell on its own prices: offered, and with a customer price set. */
  private sellableRooms(hotel: PricedHotel) {
    const terms = hotelHousingTerms(hotel);
    return roomOptionsOf(hotel).filter((room) => isRoomSellable(terms, room));
  }

  /** Halalas for the whole stay, VAT included as on trip bookings; null when this room type cannot be sold here. */
  private priceStay(hotel: PricedHotel, roomChoice: RoomType, guests: number, nights: number) {
    if (!this.sellableRooms(hotel).includes(roomChoice)) return null;
    const terms = hotelHousingTerms(hotel);
    const rooms = roomChoice === 'PRIVATE' ? privateRoomsNeeded(terms.privateRoomCapacity, guests) : 1;
    return { rooms, amount: housingCharge(terms, roomChoice, guests, nights, rooms) };
  }

  /** The lowest price the hotel lists: one bed, or one private room, for one night or the stay as the hotel prices it. */
  private startingPrice(hotel: PricedHotel) {
    const prices = this.sellableRooms(hotel).map((room) => Number(room === 'SHARED' ? hotel.bedPrice : hotel.privateRoomPrice));
    return prices.length ? Math.min(...prices) : null;
  }

  private async vatRate(db: Prisma.TransactionClient) {
    const setting = await db.setting.findUnique({ where: { key: 'vatRate' } });
    return setting ? Number(setting.value) : DEFAULT_VAT_RATE;
  }

  /** The stay's own policy, or the trips' one when the settings say to follow it. */
  private async cancellationTerms(db: Prisma.TransactionClient = this.prisma): Promise<CancellationTerms> {
    const keys = ['stayCancellationMode', 'stayCancellationPolicy', 'stayCancellationRules', 'cancellationPolicy', 'cancellationRules'];
    const rows = await db.setting.findMany({ where: { key: { in: keys } } });
    const value = (key: string) => rows.find((row) => row.key === key)?.value ?? '';
    const custom = value('stayCancellationMode') === 'CUSTOM';
    return {
      mode: custom ? 'CUSTOM' : 'TRIP',
      text: custom ? value('stayCancellationPolicy') : value('cancellationPolicy'),
      rules: parseCancellationRules(custom ? value('stayCancellationRules') : value('cancellationRules')),
    };
  }

  private parseCheckIn(day: string) {
    const checkIn = dateOnly(day);
    if (Number.isNaN(checkIn.getTime()) || dayOf(checkIn) !== day) throw new BadRequestException('تاريخ الدخول غير صحيح');
    if (day < riyadhDate(new Date())) throw new BadRequestException('تاريخ الدخول مضى، اختر تاريخًا من اليوم فصاعدًا');
    return checkIn;
  }

  // ---------------------------------------------------------------- public catalogue

  private activeHotels(where: Prisma.HotelWhereInput = {}) {
    return this.prisma.hotel.findMany({
      where: { isActive: true, ...where },
      orderBy: { name: 'asc' },
      select: { ...HOTEL_PRICE_SELECT, images: { ...GALLERY_SELECT, take: 1 } },
    });
  }

  async cities() {
    const hotels = (await this.activeHotels()).filter((hotel) => this.sellableRooms(hotel).length > 0);
    const byCity = new Map<string, { city: string; hotelsCount: number; minPrice: number | null }>();
    for (const hotel of hotels) {
      const city = hotel.city.trim();
      const entry = byCity.get(city) ?? { city, hotelsCount: 0, minPrice: null };
      const price = this.startingPrice(hotel);
      entry.hotelsCount += 1;
      if (price !== null) entry.minPrice = entry.minPrice === null ? price : Math.min(entry.minPrice, price);
      byCity.set(city, entry);
    }
    return [...byCity.values()].sort((a, b) => b.hotelsCount - a.hotelsCount || a.city.localeCompare(b.city, 'ar'));
  }

  async hotels(query: StayHotelsQuery) {
    const city = query.city?.trim();
    const hotels = (await this.activeHotels()).filter((hotel) => (!city || hotel.city.trim() === city) && this.sellableRooms(hotel).length > 0);
    const ratings = await hotelRatingSummaries(this.prisma, hotels.map((hotel) => hotel.id));
    const nights = query.nights ?? 1;
    const guests = query.guests ?? 1;
    const totalOf = (hotel: PricedHotel) => {
      const rooms = query.roomChoice ? [query.roomChoice] : this.sellableRooms(hotel);
      const totals = rooms.map((room) => this.priceStay(hotel, room, guests, nights)?.amount).filter((amount): amount is number => amount !== undefined);
      return totals.length ? toSar(Math.min(...totals)) : null;
    };
    return hotels
      .map((hotel) => ({
        id: hotel.id,
        name: hotel.name,
        city: hotel.city,
        address: hotel.address,
        stars: hotel.stars,
        coverImage: hotel.images[0]?.url ?? null,
        rating: ratings.get(hotel.id) ?? NO_RATINGS,
        offersSharedRoom: hotel.offersSharedRoom,
        offersPrivateRoom: hotel.offersPrivateRoom,
        bedPrice: money(hotel.bedPrice),
        privateRoomPrice: money(hotel.privateRoomPrice),
        privateRoomCapacity: hotel.privateRoomCapacity,
        housingPricePeriod: hotel.housingPricePeriod,
        total: totalOf(hotel),
      }))
      .sort((a, b) => (a.total === null ? 1 : 0) - (b.total === null ? 1 : 0) || (a.total ?? 0) - (b.total ?? 0));
  }

  async hotelDetail(id: string) {
    const hotel = await this.prisma.hotel.findFirst({
      where: { id, isActive: true },
      select: { ...HOTEL_PRICE_SELECT, description: true, images: GALLERY_SELECT, services: SERVICE_SELECT },
    });
    if (!hotel) throw new NotFoundException('الفندق غير موجود');
    const [groups, reviews] = await Promise.all([
      this.prisma.hotelRating.groupBy({ by: ['rating'], where: { hotelId: id }, _count: { _all: true } }),
      this.prisma.hotelRating.findMany({
        where: { hotelId: id, isHidden: false, comment: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: REVIEWS_SHOWN,
        select: { id: true, rating: true, comment: true, createdAt: true, user: { select: { name: true } } },
      }),
    ]);
    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;
    for (const group of groups) {
      breakdown[group.rating] = group._count._all;
      count += group._count._all;
      sum += group.rating * group._count._all;
    }
    return {
      id: hotel.id,
      name: hotel.name,
      city: hotel.city,
      address: hotel.address,
      description: hotel.description,
      stars: hotel.stars,
      images: hotel.images.map((image) => image.url),
      services: hotel.services.map((row) => row.service),
      rating: { average: count ? Math.round((sum / count) * 10) / 10 : null, count, breakdown },
      reviews: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        customerName: firstName(review.user.name),
        createdAt: review.createdAt,
      })),
      offersSharedRoom: hotel.offersSharedRoom,
      offersPrivateRoom: hotel.offersPrivateRoom,
      bedPrice: money(hotel.bedPrice),
      privateRoomPrice: money(hotel.privateRoomPrice),
      privateRoomCapacity: hotel.privateRoomCapacity,
      housingPricePeriod: hotel.housingPricePeriod,
      privateRoomPriceBasis: hotel.privateRoomPriceBasis,
    };
  }

  // ---------------------------------------------------------------- quote and booking

  /** The only place a stay is priced: the app shows this and never sends amounts. */
  private async computeQuote(db: Prisma.TransactionClient, userId: string, dto: StayQuoteDto, useWallet = !!dto.useWallet) {
    const checkIn = this.parseCheckIn(dto.checkIn);
    const checkOut = new Date(checkIn.getTime() + dto.nights * DAY_MS);
    const hotel = await db.hotel.findUnique({ where: { id: dto.hotelId }, select: HOTEL_PRICE_SELECT });
    if (!hotel?.isActive) throw new BadRequestException('الفندق غير موجود أو موقوف');
    const priced = this.priceStay(hotel, dto.roomChoice, dto.guests, dto.nights);
    if (!priced) throw new BadRequestException(`نوع السكن المختار غير متاح في ${hotel.name}`);

    const user = await db.user.findUnique({ where: { id: userId }, select: { walletBalance: true, walletTransportBalance: true } });
    if (!user) throw new NotFoundException('الحساب غير موجود');
    // Compensations, promotional credit and points pay for transport only; a stay is paid from the ordinary balance.
    const balance = toHalalas(user.walletBalance);
    const ordinary = Math.max(0, balance - Math.min(balance, toHalalas(user.walletTransportBalance)));

    const total = priced.amount;
    const vatRate = await this.vatRate(db);
    // Prices include VAT, as on trip bookings: this is the part of the total that is tax.
    const vat = Math.round((total * vatRate) / (100 + vatRate));
    const walletAmount = useWallet ? Math.min(ordinary, total) : 0;
    const cancellation = await this.cancellationTerms(db);

    return {
      hotel,
      checkIn,
      checkOut,
      rooms: priced.rooms,
      total,
      vat,
      walletAmount,
      amountDue: total - walletAmount,
      publicQuote: {
        hotelId: hotel.id,
        checkIn: dayOf(checkIn),
        checkOut: dayOf(checkOut),
        nights: dto.nights,
        roomChoice: dto.roomChoice,
        guests: dto.guests,
        rooms: priced.rooms,
        subtotal: toSar(total),
        vatRate,
        vatAmount: toSar(vat),
        total: toSar(total),
        walletAvailable: toSar(ordinary),
        walletAmount: toSar(walletAmount),
        amountDue: toSar(total - walletAmount),
        cancellation: { text: cancellation.text, rules: cancellation.rules },
      },
    };
  }

  async quote(userId: string, dto: StayQuoteDto) {
    return (await this.computeQuote(this.prisma, userId, dto)).publicQuote;
  }

  private async findByKey(userId: string, idempotencyKey: string) {
    const existing = await this.prisma.stayBooking.findUnique({ where: { idempotencyKey: `${userId}:${idempotencyKey}` }, include: STAY_INCLUDE });
    return existing ? this.toItem(existing) : null;
  }

  async create(userId: string, dto: CreateStayDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.findByKey(userId, idempotencyKey);
      if (existing) return existing;
    }
    await this.appSettings.assertBookingsOpen();
    const guestNames = dto.guestNames?.map((name) => name.trim()).filter(Boolean);
    if (guestNames && guestNames.length > dto.guests) throw new BadRequestException('أسماء النزلاء أكثر من عددهم');

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        // One stay per customer at a time, so two taps cannot both spend the same wallet balance.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stay:${userId}`}))`;
        const quote = await this.computeQuote(tx, userId, dto, !!dto.useWallet || dto.paymentMethod === 'wallet');
        if (dto.paymentMethod === 'wallet' && quote.amountDue > 0) throw new BadRequestException('الرصيد الأساسي في المحفظة لا يكفي لهذا الحجز');
        // Until the gateway ships, anything left to pay can only go through in explicit simulated mode.
        const simulated = this.config.get('PAYMENT_MODE') === 'simulated';
        if (quote.amountDue > 0 && !simulated) throw new ServiceUnavailableException('الدفع الإلكتروني غير متاح حاليًا');

        const reference = `ST-${randomCode(8)}`;
        const paidOnline = quote.amountDue > 0;
        const stay = await tx.stayBooking.create({
          data: {
            reference,
            userId,
            hotelId: quote.hotel.id,
            city: quote.hotel.city.trim(),
            checkIn: quote.checkIn,
            checkOut: quote.checkOut,
            nights: dto.nights,
            roomChoice: dto.roomChoice,
            guests: dto.guests,
            rooms: quote.rooms,
            ...(guestNames?.length && { guestNames }),
            notes: dto.notes || null,
            subtotal: toSar(quote.total),
            vatAmount: toSar(quote.vat),
            walletAmount: toSar(quote.walletAmount),
            totalPrice: toSar(quote.total),
            paidOnline: toSar(quote.amountDue),
            paymentMethod: paidOnline ? dto.paymentMethod : 'wallet',
            paymentStatus: paidOnline ? 'SIMULATED' : 'COMPLETED',
            idempotencyKey: idempotencyKey ? `${userId}:${idempotencyKey}` : undefined,
          },
        });
        if (quote.walletAmount > 0) {
          await this.wallet.apply(tx, {
            userId,
            amount: -toSar(quote.walletAmount),
            // Housing is never paid from transport-only credit.
            transportAmount: 0,
            type: 'DEBIT_SPENT',
            description: `حجز سكن ${quote.hotel.name} رقم ${reference}`,
          });
        }
        await this.notifications.toUser(tx, 'STAY_CONFIRMED', userId, {
          bookingReference: reference,
          hotelName: quote.hotel.name,
          checkInDate: dayOf(quote.checkIn),
          nights: dto.nights,
          totalPrice: formatSar(toSar(quote.total)),
        });
        return stay.id;
      }, TX_OPTIONS);
      return this.toItem(await this.prisma.stayBooking.findUniqueOrThrow({ where: { id }, include: STAY_INCLUDE }));
    } catch (err) {
      // A concurrent retry with the same key won the race; hand back its result instead of an error.
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.findByKey(userId, idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- reading a stay

  /** CONFIRMED is shown as COMPLETED once check-out day has come; the row keeps CONFIRMED. */
  private effectiveStatus(stay: { status: StayBookingStatus; checkOut: Date }): StayBookingStatus {
    return stay.status === 'CONFIRMED' && stay.checkOut <= todayDate() ? 'COMPLETED' : stay.status;
  }

  private toItem(stay: StayRow) {
    const today = todayDate();
    return {
      id: stay.id,
      reference: stay.reference,
      status: this.effectiveStatus(stay),
      hotel: {
        id: stay.hotel.id,
        name: stay.hotel.name,
        city: stay.hotel.city,
        address: stay.hotel.address,
        coverImage: stay.hotel.images[0]?.url ?? null,
        stars: stay.hotel.stars,
      },
      checkIn: dayOf(stay.checkIn),
      checkOut: dayOf(stay.checkOut),
      nights: stay.nights,
      roomChoice: stay.roomChoice,
      guests: stay.guests,
      rooms: stay.rooms,
      guestNames: (stay.guestNames as string[] | null) ?? [],
      notes: stay.notes,
      subtotal: Number(stay.subtotal),
      vatAmount: Number(stay.vatAmount),
      walletAmount: Number(stay.walletAmount),
      totalPrice: Number(stay.totalPrice),
      paidOnline: Number(stay.paidOnline),
      paymentMethod: stay.paymentMethod,
      paymentStatus: stay.paymentStatus,
      cancelReason: stay.cancelReason,
      cancelRequestedAt: stay.cancelRequestedAt,
      cancelReviewedAt: stay.cancelReviewedAt,
      cancelReviewNote: stay.cancelReviewNote,
      refundAmount: money(stay.refundAmount),
      createdAt: stay.createdAt,
      canCancel: stay.status === 'CONFIRMED' && checkInStarts(stay.checkIn) > new Date(),
      canRate: !stay.rating && stay.status !== 'CANCELLED' && stay.checkOut <= today,
      rating: stay.rating ? { rating: stay.rating.rating, comment: stay.rating.comment } : null,
    };
  }

  /** What the policy would give back now (or at the customer's request, so a slow review never costs them); staff still decide. */
  private async cancellationInfo(stay: StayRow) {
    const terms = await this.cancellationTerms();
    const at = stay.status === 'CANCEL_REQUESTED' && stay.cancelRequestedAt ? stay.cancelRequestedAt : new Date();
    const starts = checkInStarts(stay.checkIn);
    const daysLeft = daysUntil(starts, at);
    const rule = applicableRule(terms.rules, daysLeft);
    const paid = toHalalas(stay.totalPrice);
    let suggested: number;
    if (starts <= at) suggested = 0;
    else if (terms.rules.length === 0) suggested = paid;
    else suggested = Math.round((paid * (rule?.percent ?? 0)) / 100);
    return { mode: terms.mode, text: terms.text, rules: terms.rules, daysLeft, rule, suggestedRefund: toSar(suggested) };
  }

  private async ownStay(userId: string, id: string) {
    const stay = await this.prisma.stayBooking.findUnique({ where: { id }, include: STAY_INCLUDE });
    if (!stay || stay.userId !== userId) throw new NotFoundException('حجز السكن غير موجود');
    return stay;
  }

  async mine(userId: string) {
    const stays = await this.prisma.stayBooking.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, include: STAY_INCLUDE });
    return stays.map((stay) => this.toItem(stay));
  }

  async mineDetail(userId: string, id: string) {
    const stay = await this.ownStay(userId, id);
    return { ...this.toItem(stay), cancellation: await this.cancellationInfo(stay) };
  }

  /** Locks the stay's row so two decisions on it cannot both go through. */
  private async lockStay(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT 1 FROM "StayBooking" WHERE "id" = ${id} FOR UPDATE`;
    const stay = await tx.stayBooking.findUnique({ where: { id }, include: { ...STAY_INCLUDE, user: { select: { name: true, phone: true } } } });
    if (!stay) throw new NotFoundException('حجز السكن غير موجود');
    return stay;
  }

  async requestCancel(userId: string, id: string, reason?: string) {
    await this.prisma.$transaction(async (tx) => {
      const stay = await this.lockStay(tx, id);
      if (stay.userId !== userId) throw new NotFoundException('حجز السكن غير موجود');
      if (stay.status !== 'CONFIRMED') throw new BadRequestException('لا يمكن طلب إلغاء هذا الحجز في حالته الحالية');
      if (checkInStarts(stay.checkIn) <= new Date()) throw new BadRequestException('بدأ موعد الدخول ولا يمكن طلب الإلغاء');
      await tx.stayBooking.update({ where: { id }, data: { status: 'CANCEL_REQUESTED', cancelReason: reason || null, cancelRequestedAt: new Date() } });
      await this.notifications.toStaff(tx, 'STAFF_STAY_CANCEL_REQUEST', ['hotels.book'], {
        bookingReference: stay.reference,
        hotelName: stay.hotel.name,
        checkInDate: dayOf(stay.checkIn),
        customerName: stay.user.name,
        customerPhone: stay.user.phone,
        cancelReason: reason,
      }, { exceptUserId: userId });
    }, TX_OPTIONS);
    return this.toItem(await this.ownStay(userId, id));
  }

  async rate(userId: string, id: string, dto: RateStayDto) {
    const stay = await this.ownStay(userId, id);
    if (stay.rating) throw new ConflictException('قيّمت هذه الإقامة من قبل');
    if (stay.status === 'CANCELLED') throw new BadRequestException('لا يمكن تقييم حجز ملغى');
    if (stay.checkOut > todayDate()) throw new BadRequestException('يمكنك التقييم بعد موعد الخروج من الفندق');
    try {
      await this.prisma.hotelRating.create({
        data: { stayBookingId: id, hotelId: stay.hotelId, userId, rating: dto.rating, comment: dto.comment || null },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('قيّمت هذه الإقامة من قبل');
      throw err;
    }
    return this.toItem(await this.ownStay(userId, id));
  }

  // ---------------------------------------------------------------- staff

  async adminList(query: AdminStaysQuery) {
    const today = todayDate();
    const where: Prisma.StayBookingWhereInput[] = [];
    if (query.status === 'COMPLETED') where.push({ status: 'CONFIRMED', checkOut: { lte: today } });
    else if (query.status === 'CONFIRMED') where.push({ status: 'CONFIRMED', checkOut: { gt: today } });
    else if (query.status) where.push({ status: query.status });
    if (query.hotelId) where.push({ hotelId: query.hotelId });
    if (query.city) where.push({ city: query.city });
    if (query.from) where.push({ checkIn: { gte: dateOnly(query.from) } });
    if (query.to) where.push({ checkIn: { lte: dateOnly(query.to) } });
    if (query.search) {
      const q = query.search;
      where.push({
        OR: [
          { reference: { contains: q, mode: 'insensitive' } },
          { user: { name: { contains: q, mode: 'insensitive' } } },
          { user: { phone: { contains: q } } },
          { hotel: { name: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const page = query.page ?? 1;
    const [rows, total] = await Promise.all([
      this.prisma.stayBooking.findMany({
        where: { AND: where },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: ADMIN_STAY_INCLUDE,
      }),
      this.prisma.stayBooking.count({ where: { AND: where } }),
    ]);
    return { items: rows.map((row) => ({ ...this.toItem(row), customer: row.user })), total };
  }

  async adminDetail(id: string) {
    const stay = await this.prisma.stayBooking.findUnique({ where: { id }, include: ADMIN_STAY_INCLUDE });
    if (!stay) throw new NotFoundException('حجز السكن غير موجود');
    return { ...this.toItem(stay), customer: stay.user, cancellation: await this.cancellationInfo(stay) };
  }

  /** Approves the customer's request, or cancels on staff's own decision; the refund goes to the wallet as ordinary money. */
  async adminCancel(actor: { userId: string }, id: string, dto: AdminCancelStayDto) {
    await this.prisma.$transaction(async (tx) => {
      const stay = await this.lockStay(tx, id);
      if (stay.status === 'CANCELLED') throw new ConflictException('الحجز ملغى من قبل');
      const total = toHalalas(stay.totalPrice);
      const refund = toHalalas(dto.refundAmount);
      if (refund > total) throw new BadRequestException(`المبلغ المسترد أكبر من إجمالي الحجز ${toSar(total).toFixed(2)} ر.س`);
      await tx.stayBooking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          refundAmount: toSar(refund),
          ...(refund > 0 && { paymentStatus: refund >= total ? 'REFUNDED' : 'PARTIALLY_REFUNDED' }),
          cancelReviewedAt: new Date(),
          cancelReviewedById: actor.userId,
          cancelReviewNote: dto.note || null,
        },
      });
      if (refund > 0) {
        await this.wallet.apply(tx, {
          userId: stay.userId,
          amount: toSar(refund),
          // Ordinary money: the stay was paid from the ordinary balance or online, never from transport-only credit.
          transportAmount: 0,
          type: 'REFUND',
          description: `استرداد حجز سكن ${stay.hotel.name} رقم ${stay.reference}`,
          createdById: actor.userId,
        });
      }
      await this.notifications.toUser(tx, 'STAY_CANCELLED', stay.userId, {
        bookingReference: stay.reference,
        hotelName: stay.hotel.name,
        checkInDate: dayOf(stay.checkIn),
        refundAmount: formatSar(toSar(refund)),
        reviewNote: dto.note,
      });
    }, TX_OPTIONS);
    return this.adminDetail(id);
  }

  async rejectCancel(actor: { userId: string }, id: string, note?: string) {
    await this.prisma.$transaction(async (tx) => {
      const stay = await this.lockStay(tx, id);
      if (stay.status !== 'CANCEL_REQUESTED') throw new ConflictException('لا يوجد طلب إلغاء قيد المراجعة لهذا الحجز');
      await tx.stayBooking.update({
        where: { id },
        data: { status: 'CONFIRMED', cancelReviewedAt: new Date(), cancelReviewedById: actor.userId, cancelReviewNote: note || null },
      });
      await this.notifications.toUser(tx, 'STAY_CANCEL_REJECTED', stay.userId, {
        bookingReference: stay.reference,
        hotelName: stay.hotel.name,
        checkInDate: dayOf(stay.checkIn),
        reviewNote: note,
      });
    }, TX_OPTIONS);
    return this.adminDetail(id);
  }

  async hotelRatings(hotelId: string) {
    const hotel = await this.prisma.hotel.findUnique({ where: { id: hotelId }, select: { id: true } });
    if (!hotel) throw new NotFoundException('الفندق غير موجود');
    const ratings = await this.prisma.hotelRating.findMany({
      where: { hotelId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        stayBooking: { select: { id: true, reference: true, checkIn: true, checkOut: true } },
      },
    });
    return ratings.map(({ user, stayBooking, ...rating }) => ({
      id: rating.id,
      rating: rating.rating,
      comment: rating.comment,
      isHidden: rating.isHidden,
      createdAt: rating.createdAt,
      customer: user,
      stay: { id: stayBooking.id, reference: stayBooking.reference, checkIn: dayOf(stayBooking.checkIn), checkOut: dayOf(stayBooking.checkOut) },
    }));
  }

  async setRatingHidden(id: string, isHidden: boolean) {
    const rating = await this.prisma.hotelRating.findUnique({ where: { id }, select: { id: true } });
    if (!rating) throw new NotFoundException('التقييم غير موجود');
    return this.prisma.hotelRating.update({ where: { id }, data: { isHidden } });
  }
}

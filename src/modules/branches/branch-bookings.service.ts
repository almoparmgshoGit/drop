import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RoomType } from '@prisma/client';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { BOOKING_KIND_LABELS, BOOKING_KIND_PARTS } from '../../common/utils/booking-kinds.util';
import { housingCharge, HousingTerms, isRoomSellable } from '../../common/utils/housing-price.util';
import { vatInside } from '../../common/utils/invoice.util';
import { tripSeatLayout } from '../../common/utils/bus-layout.util';
import { lockTripsWithLinked, takeLinkedSeats } from '../../common/utils/linked-seats.util';
import { halalas, netBookingFigures, paymentFigures } from '../../common/utils/payment.util';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { signTicketToken } from '../../common/utils/ticket-token.util';
import { allocate, BookingsService, holdAvailableTo, randomCode, toSar } from '../bookings/bookings.service';
import { CashActor, CashService } from '../cash/cash.service';
import { CollectionsService } from '../cash/collections.service';
import { CreateJourneyDto, JourneyQuoteDto, TripSearchQuery } from './branches.dto';
import { PACKAGE_PRICE_SELECT, packageGroupTotal, packagePriceTiers } from '../../common/utils/package-price.util';

type Db = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const MAX_NIGHTS = 60;
const RECENT_LIMIT = 10;
const CUSTOMER_HISTORY_LIMIT = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

const riyadhDate = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
const dateOnly = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
const normalizeSeats = (seats: string[]) => seats.map((seat) => String(parseInt(seat, 10)));

const JOURNEY_TRIP = {
  id: true,
  tripCode: true,
  title: true,
  origin: true,
  destination: true,
  departureTime: true,
  tripStatus: true,
  channelBranch: true,
  price: true,
  totalSeats: true,
  availableSeats: true,
  maxSeatsPerBooking: true,
  busId: true,
  bookingType: true,
  housingPrice: true,
  privateRoomPrice: true,
  privateRoomCapacity: true,
  housingPriceMode: true,
  privateRoomPriceBasis: true,
  housingPricePeriod: true,
  package: { select: { ...PACKAGE_PRICE_SELECT, status: true } },
  hotelBookings: { where: { status: 'CONFIRMED' as const }, select: { hotelId: true } },
} satisfies Prisma.TripSelect;

type JourneyTrip = Prisma.TripGetPayload<{ select: typeof JOURNEY_TRIP }>;

/** Staff-facing words for the last thing that happened to a booking. */
function describeLastChange(action: string, before: any, after: any): string {
  switch (action) {
    case 'BRANCH_BOOKING_CREATED':
      return 'جديد';
    case 'SEAT_CHANGED':
      return `تعديل الكرسي ${before?.seat} ← ${after?.seat}`;
    case 'PASSENGER_UPDATED':
      return before?.fullName !== after?.fullName ? 'تعديل الاسم' : before?.phone !== after?.phone ? 'تعديل الجوال' : 'تعديل البيانات';
    case 'PAYMENT_COLLECTED':
      return `دفعة ${after?.amount} ر.س`;
    case 'PRICE_OVERRIDDEN':
      return 'تعديل السعر';
    case 'BOARDING_POINT_CHANGED':
      return 'تغيير نقطة التجمع';
    case 'ROOM_ASSIGNED':
      return 'تسكين';
    case 'BOARDED':
      return 'صعود';
    case 'CANCELLATION_REQUESTED':
      return 'طلب إلغاء';
    case 'CANCELLED':
      return 'إلغاء';
    default:
      return 'تحديث';
  }
}

@Injectable()
export class BranchBookingsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private cash: CashService,
    private collections: CollectionsService,
    private events: BookingEventsService,
    private invoices: InvoiceLedgerService,
    private notifications: NotificationsService,
    private bookings: BookingsService,
  ) {}

  // ---------------------------------------------------------------- what the screen needs

  async context(actor: CashActor) {
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true, branchId: true } });
    const anyBranch = actor.permissions.includes('bookings.all_branches');
    const branches = await this.prisma.branch.findMany({
      where: { isActive: true, ...(!anyBranch && { id: me?.branchId ?? '' }) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
    const drawers = await this.prisma.cashSession.findMany({
      where: { branchId: { in: branches.map((branch) => branch.id) }, status: 'OPEN' },
      select: { branchId: true, businessDate: true },
    });
    const today = riyadhDate(new Date());
    return {
      employeeName: me?.name ?? null,
      ownBranchId: me?.branchId ?? null,
      canChooseBranch: anyBranch,
      canOverridePrice: actor.permissions.includes('bookings.price_override'),
      canTakePayment: actor.permissions.includes('collections.collect'),
      vatRate: await this.invoices.vatRate(this.prisma),
      branches: branches.map((branch) => ({
        ...branch,
        // A drawer left open from an earlier day cannot take cash until it is closed.
        drawerOpen: drawers.some((drawer) => drawer.branchId === branch.id && drawer.businessDate.toISOString().slice(0, 10) === today),
      })),
    };
  }

  async searchTrips(query: TripSearchQuery) {
    const now = new Date();
    const open = { tripStatus: 'PUBLISHED' as const, channelBranch: true, departureTime: { gt: now }, OR: [{ packageId: null }, { package: { status: 'PUBLISHED' as const } }] };
    const day = query.date ? new Date(`${query.date}T00:00:00+03:00`) : null;
    const [items, places] = await Promise.all([
      this.prisma.trip.findMany({
        where: {
          ...open,
          ...(query.origin && { origin: query.origin }),
          ...(query.destination && { destination: query.destination }),
          ...(day && { departureTime: { gte: day > now ? day : now, lt: new Date(day.getTime() + DAY_MS) } }),
        },
        orderBy: { departureTime: 'asc' },
        take: 100,
        select: {
          id: true,
          tripCode: true,
          title: true,
          origin: true,
          destination: true,
          departureTime: true,
          availableSeats: true,
          totalSeats: true,
          price: true,
          bookingType: true,
          package: { select: PACKAGE_PRICE_SELECT },
          boardingPoints: { select: { id: true, name: true, time: true } },
        },
      }),
      this.prisma.trip.findMany({ where: open, distinct: ['origin', 'destination'], select: { origin: true, destination: true } }),
    ]);
    return {
      items: items.map(({ package: pack, price, ...trip }) => ({
        ...trip,
        price: Number(pack?.price ?? price),
        packagePriceTiers: pack ? packagePriceTiers(pack) : null,
      })),
      origins: [...new Set(places.map((place) => place.origin))].sort(),
      destinations: [...new Set(places.map((place) => place.destination))].sort(),
    };
  }

  async seatMap(tripId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tripStatus: 'PUBLISHED', channelBranch: true, OR: [{ packageId: null }, { package: { status: 'PUBLISHED' } }] },
      select: { totalSeats: true, availableSeats: true, seatLayout: true, seats: { select: { seatNumber: true, isBooked: true, heldUntil: true } } },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const now = new Date();
    return {
      totalSeats: trip.totalSeats,
      layout: tripSeatLayout(trip),
      availableSeats: trip.availableSeats,
      seats: trip.seats
        .map((seat) => ({ seatNumber: seat.seatNumber, status: seat.isBooked ? 'booked' : seat.heldUntil && seat.heldUntil > now ? 'held' : 'available' }))
        .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber)),
    };
  }

  /** Customer prices only: what the company pays a hotel is not a counter employee's concern. */
  async hotels() {
    const hotels = await this.prisma.hotel.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        city: true,
        offersSharedRoom: true,
        offersPrivateRoom: true,
        bedPrice: true,
        privateRoomPrice: true,
      },
    });
    return hotels.map((hotel) => ({ ...hotel, bedPrice: hotel.bedPrice === null ? null : Number(hotel.bedPrice), privateRoomPrice: hotel.privateRoomPrice === null ? null : Number(hotel.privateRoomPrice) }));
  }

  /** Everything the counter needs about a returning customer: their details to fill the form, and their bookings so far. */
  async findCustomer(phoneText: string) {
    const phone = normalizeSaudiPhone(phoneText);
    const local = phone.slice(4);
    // A companion booked under someone else's account can still be found by the phone typed for them.
    const where: Prisma.BookingWhereInput = { OR: [{ user: { phone } }, { passengers: { some: { phone: { in: [phone, `0${local}`, local, `966${local}`] } } } }] };
    const [user, bookings, total, cancelled, boarded] = await Promise.all([
      this.prisma.user.findUnique({ where: { phone }, select: { name: true, idType: true, idNumber: true, createdAt: true } }),
      this.prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: CUSTOMER_HISTORY_LIMIT,
        select: {
          id: true,
          bookingReference: true,
          status: true,
          kind: true,
          source: true,
          createdAt: true,
          totalPrice: true,
          refundAmount: true,
          externalRefunded: true,
          boardingPointName: true,
          stayNights: true,
          stayHotel: { select: { name: true } },
          branch: { select: { name: true } },
          trip: { select: { tripCode: true, origin: true, destination: true, departureTime: true } },
          passengers: { select: { fullName: true, nationalId: true, phone: true, seatNumber: true, ticket: { select: { boardedAt: true, isBoarded: true } } } },
          user: { select: { phone: true } },
          payment: { select: { amount: true, walletAmount: true, status: true } },
          collections: { select: { amount: true } },
          cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
        },
      }),
      this.prisma.booking.count({ where }),
      this.prisma.booking.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
      // A trip counts as ridden once anyone on the booking was scanned onto the bus.
      this.prisma.booking.count({ where: { AND: [where, { OR: [{ status: 'BOARDED' }, { tickets: { some: { isBoarded: true } } }] }] } }),
    ]);
    if (!user && bookings.length === 0) return { found: false, name: null, nationalId: null, idType: null, lastBoardingPoint: null, stats: null, history: [] };

    // This phone's own passenger row comes first; the account holder is the fallback.
    const own = (booking: (typeof bookings)[number]) =>
      booking.passengers.find((p) => p.phone && p.phone.replace(/\D/g, '').endsWith(local)) ??
      (booking.user.phone === phone ? [...booking.passengers].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber))[0] : undefined);
    const lastNamed = bookings.map(own).find((p) => p?.fullName);
    // The document the customer registered with comes first; a number typed on an earlier booking only fills in for it.
    const nationalId = user?.idNumber ?? bookings.map(own).find((p) => p?.nationalId)?.nationalId ?? null;
    const lastBoardingPoint = bookings.find((b) => b.status !== 'CANCELLED' && b.boardingPointName)?.boardingPointName ?? null;
    const now = Date.now();

    return {
      found: true,
      name: user?.name || lastNamed?.fullName || null,
      nationalId,
      idType: user?.idNumber ? user.idType : null,
      lastBoardingPoint,
      stats: {
        total,
        boarded,
        cancelled,
        upcoming: bookings.filter((b) => b.status !== 'CANCELLED' && b.trip.departureTime.getTime() > now).length,
        customerSince: user?.createdAt ?? bookings[bookings.length - 1]?.createdAt ?? null,
      },
      history: bookings.map((booking) => {
        const { remaining } = netBookingFigures(booking);
        const boardedAt = booking.passengers.map((p) => p.ticket?.boardedAt).find(Boolean) ?? null;
        return {
          id: booking.id,
          reference: booking.bookingReference,
          status: booking.status,
          kindLabel: booking.kind ? BOOKING_KIND_LABELS[booking.kind] : null,
          source: booking.source,
          branchName: booking.branch?.name ?? null,
          createdAt: booking.createdAt,
          tripCode: booking.trip.tripCode,
          route: `${booking.trip.origin} ← ${booking.trip.destination}`,
          departureTime: booking.trip.departureTime,
          seats: booking.passengers.map((p) => p.seatNumber).sort((a, b) => Number(a) - Number(b)),
          passengers: booking.passengers.map((p) => p.fullName),
          boardingPoint: booking.boardingPointName,
          stay: booking.stayHotel ? `${booking.stayHotel.name}${booking.stayNights ? ` · ${booking.stayNights} ليالٍ` : ''}` : null,
          total: Number(booking.totalPrice),
          remaining: toSar(remaining),
          boarded: booking.status === 'BOARDED' || booking.passengers.some((p) => p.ticket?.isBoarded),
          boardedAt,
          upcoming: booking.status !== 'CANCELLED' && booking.trip.departureTime.getTime() > now,
        };
      }),
    };
  }

  async recent(actor: CashActor, branchId?: string) {
    const scope = await this.scope(actor, branchId);
    // By the last thing that happened, so a booking someone just changed comes back to the top.
    const latest = await this.prisma.$queryRaw<{ bookingId: string }[]>`
      SELECT e."bookingId", MAX(e."createdAt") AS "at"
      FROM "BookingEvent" e
      JOIN "Booking" b ON b."id" = e."bookingId"
      WHERE b."source" = 'BRANCH' AND (${scope ?? null}::text IS NULL OR b."branchId" = ${scope ?? null})
      GROUP BY e."bookingId"
      ORDER BY "at" DESC
      LIMIT ${RECENT_LIMIT}`;
    const ids = latest.map((row) => row.bookingId);
    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        bookingReference: true,
        status: true,
        kind: true,
        totalPrice: true,
        refundAmount: true,
        externalRefunded: true,
        trip: { select: { tripCode: true } },
        branch: { select: { name: true } },
        passengers: { select: { fullName: true, nationalId: true, phone: true, seatNumber: true } },
        user: { select: { phone: true } },
        payment: { select: { amount: true, walletAmount: true, status: true } },
        collections: { select: { amount: true } },
        cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 1, select: { action: true, before: true, after: true, createdAt: true, actorName: true } },
      },
    });
    const byId = new Map(bookings.map((booking) => [booking.id, booking]));
    return ids.flatMap((id) => {
      const booking = byId.get(id);
      if (!booking) return [];
      const passengers = [...booking.passengers].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));
      const { held, remaining } = netBookingFigures(booking);
      const event = booking.events[0];
      const isCancelled = booking.status === 'CANCELLED';
      return [{
        id: booking.id,
        reference: booking.bookingReference,
        passengerName: passengers[0]?.fullName ?? null,
        passengerCount: passengers.length,
        nationalId: passengers[0]?.nationalId ?? null,
        phone: passengers[0]?.phone ?? booking.user.phone,
        tripCode: booking.trip.tripCode,
        seats: passengers.map((passenger) => passenger.seatNumber),
        branchName: booking.branch?.name ?? null,
        kindLabel: booking.kind ? BOOKING_KIND_LABELS[booking.kind] : null,
        price: Number(booking.totalPrice),
        paid: toSar(held),
        remaining: toSar(remaining),
        paymentState: isCancelled ? 'CANCELLED' : remaining === 0 ? 'PAID' : held > 0 ? 'PARTIAL' : 'UNPAID',
        lastChange: event ? { label: describeLastChange(event.action, event.before, event.after), at: event.createdAt, by: event.actorName } : null,
      }];
    });
  }

  // ---------------------------------------------------------------- price

  quote(dto: JourneyQuoteDto) {
    return this.computeQuote(this.prisma, dto).then((quote) => quote.publicQuote);
  }

  private assertSellable(trip: JourneyTrip | undefined): asserts trip is JourneyTrip {
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    if (trip.tripStatus !== 'PUBLISHED' || !trip.channelBranch) throw new BadRequestException(`الرحلة ${trip.tripCode} غير متاحة للحجز من الفروع`);
    // A package's trips go on sale with it, the same rule as the app.
    if (trip.package && trip.package.status !== 'PUBLISHED') throw new BadRequestException(`باقة الرحلة ${trip.tripCode} غير منشورة`);
    if (trip.departureTime <= new Date()) throw new BadRequestException(`انتهى موعد الحجز للرحلة ${trip.tripCode}`);
  }

  /** The only place a branch price is calculated: the screen shows the result and never supplies a listed amount. */
  private async computeQuote(db: Db, dto: JourneyQuoteDto) {
    const parts = BOOKING_KIND_PARTS[dto.kind];
    const outbound = dto.legs.find((leg) => leg.leg === 'OUTBOUND');
    const inbound = dto.legs.find((leg) => leg.leg === 'RETURN');
    if (!!outbound !== parts.outbound || !!inbound !== parts.return || dto.legs.length !== Number(parts.outbound) + Number(parts.return)) {
      throw new BadRequestException('رحلات الحجز لا تطابق نوع الحجز');
    }
    if (parts.stay && !dto.stay) throw new BadRequestException('اختر الفندق وتواريخ السكن');
    if (!parts.stay && dto.stay) throw new BadRequestException('هذا النوع من الحجز لا يشمل سكنًا');
    if (outbound && inbound && outbound.tripId === inbound.tripId) throw new BadRequestException('اختر رحلة عودة مختلفة عن رحلة الذهاب');

    const seatCounts = new Set(dto.legs.map((leg) => leg.seats.length));
    if (seatCounts.size !== 1) throw new BadRequestException('عدد المقاعد يجب أن يتساوى في الذهاب والعودة');
    const persons = dto.legs[0].seats.length;

    const trips = await db.trip.findMany({ where: { id: { in: dto.legs.map((leg) => leg.tripId) } }, select: JOURNEY_TRIP });
    const priced = dto.legs.map((leg) => {
      const trip = trips.find((row) => row.id === leg.tripId);
      this.assertSellable(trip);
      const seats = normalizeSeats(leg.seats);
      // A package charges its total for the group's size, the same rule as the app.
      const transport = trip.package ? packageGroupTotal(trip.package, seats.length) : halalas(trip.price) * seats.length;
      const unitPrice = seats.length ? Math.round(transport / seats.length) : halalas(trip.price);
      return { leg, trip, seats, unitPrice, transport };
    });
    const outboundTrip = priced.find((row) => row.leg.leg === 'OUTBOUND')?.trip;
    const returnTrip = priced.find((row) => row.leg.leg === 'RETURN')?.trip;
    if (outboundTrip && returnTrip && returnTrip.departureTime <= outboundTrip.departureTime) {
      throw new BadRequestException('رحلة العودة يجب أن تكون بعد رحلة الذهاب');
    }

    const stay = dto.stay ? await this.priceStay(db, dto, persons, priced.map((row) => row.trip), outboundTrip, returnTrip) : null;

    const transport = priced.reduce((sum, row) => sum + row.transport, 0);
    const listTotal = transport + (stay?.amount ?? 0);
    const total = dto.finalTotal === undefined ? listTotal : halalas(dto.finalTotal);
    // Housing is carried on the first trip of the journey, so each invoice still adds up to its own trip.
    const listByLeg = priced.map((row, index) => row.transport + (index === 0 ? stay?.amount ?? 0 : 0));
    const totals = allocate(total, listTotal > 0 ? listByLeg : priced.map(() => 1));
    const vatRate = await this.invoices.vatRate(db);
    const legs = priced.map((row, index) => ({ ...row, listTotal: listByLeg[index], total: totals[index], vat: vatInside(totals[index], vatRate), housing: index === 0 ? stay?.amount ?? 0 : 0 }));
    const vat = legs.reduce((sum, leg) => sum + leg.vat, 0);

    return {
      legs,
      stay,
      listTotal,
      total,
      persons,
      publicQuote: {
        kind: dto.kind,
        kindLabel: BOOKING_KIND_LABELS[dto.kind],
        persons,
        tickets: priced.reduce((sum, row) => sum + row.seats.length, 0),
        legs: priced.map((row) => ({ leg: row.leg.leg, tripId: row.trip.id, tripCode: row.trip.tripCode, seats: row.seats, pricePerSeat: toSar(row.unitPrice), amount: toSar(row.transport) })),
        transport: toSar(transport),
        stay: stay && { hotelName: stay.hotelName, roomType: stay.roomType, nights: stay.nights, amount: toSar(stay.amount), perPerson: toSar(stay.amount / persons) },
        listTotal: toSar(listTotal),
        total: toSar(total),
        discount: toSar(Math.max(0, listTotal - total)),
        surcharge: toSar(Math.max(0, total - listTotal)),
        vatRate,
        vat: toSar(vat),
        taxable: toSar(total - vat),
      },
    };
  }

  private async priceStay(db: Db, dto: JourneyQuoteDto, persons: number, trips: JourneyTrip[], outbound?: JourneyTrip, inbound?: JourneyTrip) {
    const stay = dto.stay!;
    const checkIn = dateOnly(stay.checkIn);
    const checkOut = dateOnly(stay.checkOut);
    const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
    if (nights < 1) throw new BadRequestException('تاريخ الخروج يجب أن يكون بعد تاريخ الدخول');
    if (nights > MAX_NIGHTS) throw new BadRequestException(`الحد الأقصى للسكن ${MAX_NIGHTS} ليلة`);
    if (outbound && stay.checkIn.slice(0, 10) < riyadhDate(outbound.departureTime)) throw new BadRequestException('تاريخ الدخول قبل موعد رحلة الذهاب');
    if (inbound && stay.checkOut.slice(0, 10) > riyadhDate(inbound.departureTime)) throw new BadRequestException('تاريخ الخروج بعد موعد رحلة العودة');

    const hotel = await db.hotel.findUnique({ where: { id: stay.hotelId } });
    if (!hotel?.isActive) throw new BadRequestException('الفندق غير موجود أو موقوف');
    const offers: RoomType[] = [...(hotel.offersSharedRoom ? (['SHARED'] as const) : []), ...(hotel.offersPrivateRoom ? (['PRIVATE'] as const) : [])];
    if (!offers.includes(stay.roomType)) throw new BadRequestException('نوع السكن المختار غير متاح في هذا الفندق');

    // A trip already sold with this hotel keeps its own terms. A hotel the counter adds to a plain trip is not part of its base price, so it is always charged on top.
    const tripWithHotel = trips.find((trip) => trip.hotelBookings.some((booking) => booking.hotelId === hotel.id));
    const terms: HousingTerms = tripWithHotel ?? {
      housingPrice: hotel.bedPrice,
      privateRoomPrice: hotel.privateRoomPrice,
      privateRoomCapacity: hotel.privateRoomCapacity,
      housingPriceMode: 'ADDED_TO_BASE',
      privateRoomPriceBasis: hotel.privateRoomPriceBasis,
      housingPricePeriod: hotel.housingPricePeriod,
    };
    // A package's price is all-inclusive, the same rule as the app.
    const charges = !trips.some((trip) => trip.package);
    if (charges && !isRoomSellable(terms, stay.roomType)) throw new BadRequestException(`لا يوجد سعر لهذا النوع من السكن في ${hotel.name}، أضفه من صفحة الفنادق`);
    return {
      hotelId: hotel.id,
      hotelName: hotel.name,
      roomType: stay.roomType,
      checkIn,
      checkOut,
      nights,
      amount: charges ? housingCharge(terms, stay.roomType, persons, nights) : 0,
    };
  }

  // ---------------------------------------------------------------- saving

  async create(actor: CashActor, dto: CreateJourneyDto) {
    const payments = dto.payments ?? [];
    if (payments.length > 0 && !actor.permissions.includes('collections.collect')) {
      throw new ForbiddenException('ليست لديك صلاحية تحصيل الدفعات، سجّل الحجز دون دفع');
    }
    if (new Set(payments.map((payment) => payment.method)).size !== payments.length) throw new BadRequestException('طريقة الدفع مكررة');
    if (dto.passengers.length !== dto.legs[0]?.seats.length) throw new BadRequestException('عدد الركاب يجب أن يساوي عدد المقاعد');

    const branchId = await this.sellingBranch(actor, dto.branchId);
    const takesCash = payments.some((payment) => payment.method === 'CASH');
    if (takesCash) await this.cash.assertBranchAccess(actor, branchId);

    const keyOf = (index: number) => (dto.idempotencyKey ? `${actor.userId}:${dto.idempotencyKey}:${index}` : undefined);
    if (dto.idempotencyKey) {
      const repeated = await this.prisma.booking.findUnique({ where: { idempotencyKey: keyOf(0) }, select: { groupReference: true } });
      if (repeated?.groupReference) return this.summary(repeated.groupReference);
    }

    const phone = normalizeSaudiPhone(dto.customer.phone);
    const passengers = dto.passengers.map((passenger, index) => ({
      fullName: passenger.fullName,
      nationalId: passenger.nationalId || null,
      // Reaching the first passenger is what the customer's phone is for.
      phone: passenger.phone?.trim() ? normalizeSaudiPhone(passenger.phone) : index === 0 ? phone : null,
    }));
    const ticketSecret = this.config.getOrThrow<string>('TICKET_SIGNING_SECRET');

    try {
      const group = await this.prisma.$transaction(async (tx) => {
        // Branch first, the same order as every other drawer write, so these cannot deadlock.
        if (takesCash) await this.cash.openDrawer(tx, branchId);
        await lockTripsWithLinked(tx, dto.legs.map((leg) => leg.tripId));

        const quote = await this.computeQuote(tx, dto);
        const changed = quote.total !== quote.listTotal;
        if (changed && !actor.permissions.includes('bookings.price_override')) throw new ForbiddenException('ليست لديك صلاحية تعديل سعر الحجز');
        const paying = payments.reduce((sum, payment) => sum + halalas(payment.amount), 0);
        if (paying > quote.total) throw new BadRequestException(`مجموع الدفعات أكبر من قيمة الحجز (${toSar(quote.total)} ر.س)`);

        const customer = await this.customerFor(tx, phone, dto.customer.name);
        const groupReference = `GRP-${randomCode(10)}`;
        const now = new Date();
        const created: { id: string; total: number }[] = [];

        for (const [index, leg] of quote.legs.entries()) {
          await this.bookings.assertSeatRules(leg.trip, leg.seats);
          const available = holdAvailableTo(actor.userId, now);
          const claimed = await tx.seat.updateMany({
            where: { tripId: leg.trip.id, seatNumber: { in: leg.seats }, ...available },
            data: { isBooked: true, heldByUserId: null, heldUntil: null },
          });
          if (claimed.count !== leg.seats.length) throw new ConflictException(`بعض مقاعد الرحلة ${leg.trip.tripCode} لم تعد متاحة، اختر غيرها`);
          await tx.trip.update({ where: { id: leg.trip.id }, data: { availableSeats: { decrement: leg.seats.length } } });
          await takeLinkedSeats(tx, leg.trip.id, leg.seats, available);

          const point = leg.leg.boardingPointId ? await tx.boardingPoint.findFirst({ where: { id: leg.leg.boardingPointId, tripId: leg.trip.id } }) : null;
          if (leg.leg.boardingPointId && !point) throw new BadRequestException('نقطة التجمع لا تخص هذه الرحلة');

          const [{ next }] = await tx.$queryRaw<{ next: bigint }[]>`SELECT nextval('"BranchReceiptNumber"') AS "next"`;
          const hasStay = index === 0 ? quote.stay : null;
          const booking = await tx.booking.create({
            data: {
              bookingReference: `DR-${next}`,
              groupReference,
              userId: customer.id,
              tripId: leg.trip.id,
              status: 'CONFIRMED',
              source: 'BRANCH',
              branchId,
              kind: dto.kind,
              leg: leg.leg.leg,
              createdById: actor.userId,
              createdByName: actor.name ?? null,
              ...(hasStay && {
                stayHotelId: hasStay.hotelId,
                stayCheckIn: hasStay.checkIn,
                stayCheckOut: hasStay.checkOut,
                stayNights: hasStay.nights,
                roomChoice: hasStay.roomType,
              }),
              housingAmount: toSar(leg.housing),
              subtotal: toSar(leg.listTotal),
              discountAmount: toSar(Math.max(0, leg.listTotal - leg.total)),
              vatAmount: toSar(leg.vat),
              totalPrice: toSar(leg.total),
              boardingPointId: point?.id,
              boardingPointName: point?.name,
              boardingPointTime: point?.time,
              idempotencyKey: keyOf(index),
              passengers: { create: passengers.map((passenger, position) => ({ ...passenger, seatNumber: leg.seats[position] })) },
              // What is owed until the collections below settle it, the same as any booking paid at a counter.
              payment: { create: { amount: toSar(leg.total), currency: 'SAR', status: leg.total === 0 ? 'COMPLETED' : 'PENDING', method: null } },
            },
            include: { passengers: true },
          });
          for (const passenger of booking.passengers) {
            const ticketNumber = `TKT-${randomCode(10)}`;
            await tx.ticket.create({
              data: {
                bookingId: booking.id,
                passengerId: passenger.id,
                ticketNumber,
                signedToken: signTicketToken({ ticketNumber, tripId: leg.trip.id, seat: passenger.seatNumber }, ticketSecret),
              },
            });
          }
          await this.events.record(tx, {
            bookingId: booking.id,
            action: 'BRANCH_BOOKING_CREATED',
            actorId: actor.userId,
            after: { kind: dto.kind, branchId, total: toSar(leg.total), seats: leg.seats },
          });
          if (leg.total !== leg.listTotal) {
            // The history keeps both figures, so a changed price can always be reviewed later.
            await this.events.record(tx, {
              bookingId: booking.id,
              action: 'PRICE_OVERRIDDEN',
              actorId: actor.userId,
              before: { total: toSar(leg.listTotal) },
              after: { total: toSar(leg.total) },
            });
          }
          created.push({ id: booking.id, total: leg.total });
        }

        await this.takePayments(tx, actor, branchId, created, payments);
        await this.notifications.toBookingOwners(tx, 'BOOKING_CONFIRMED', created.map((booking) => booking.id));
        for (const booking of created) await this.notifications.toBranchStaffAboutBooking(tx, 'STAFF_NEW_BOOKING', branchId, booking.id, { exceptUserId: actor.userId });
        // Last, so a failure earlier in the booking does not burn an invoice number.
        for (const booking of created) await this.invoices.ensure(tx, booking.id);
        return groupReference;
      }, TX_OPTIONS);
      return await this.summary(group);
    } catch (err) {
      // A retry that lost the race with itself gets the booking its twin already saved.
      if (dto.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const repeated = await this.prisma.booking.findUnique({ where: { idempotencyKey: keyOf(0) }, select: { groupReference: true } });
        if (repeated?.groupReference) return this.summary(repeated.groupReference);
      }
      throw err;
    }
  }

  /** Fills each trip's booking in turn from the payments, so a split payment still adds up on every invoice. */
  private async takePayments(tx: Db, actor: CashActor, branchId: string, bookings: { id: string; total: number }[], payments: { method: 'CASH' | 'NETWORK' | 'TRANSFER'; amount: number; reference?: string }[]) {
    const left = bookings.map((booking) => booking.total);
    for (const payment of payments) {
      let amount = halalas(payment.amount);
      for (const [index, booking] of bookings.entries()) {
        const share = Math.min(amount, left[index]);
        if (share === 0) continue;
        await this.collections.collectInTx(tx, actor, { bookingId: booking.id, method: payment.method, amount: toSar(share), branchId, reference: payment.reference, quiet: true });
        left[index] -= share;
        amount -= share;
      }
    }
  }

  private async customerFor(tx: Db, phone: string, name: string) {
    // The customer can later sign in with this phone and find the booking in the app.
    const customer = await tx.user.upsert({ where: { phone }, create: { phone, name, role: 'PASSENGER' }, update: {} });
    if (!customer.name) await tx.user.update({ where: { id: customer.id }, data: { name } });
    return customer;
  }

  private async summary(groupReference: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { groupReference },
      orderBy: { leg: 'asc' },
      select: {
        id: true,
        bookingReference: true,
        leg: true,
        kind: true,
        totalPrice: true,
        boardingPointName: true,
        boardingPointTime: true,
        trip: { select: { tripCode: true, origin: true, destination: true, departureTime: true } },
        passengers: { select: { fullName: true, phone: true, seatNumber: true } },
        payment: { select: { amount: true, walletAmount: true, status: true } },
        collections: { select: { amount: true } },
      },
    });
    let total = 0;
    let remaining = 0;
    const legs = bookings.map((booking) => {
      const figures = paymentFigures(booking.payment, booking.collections);
      total += halalas(booking.totalPrice);
      remaining += figures.remaining;
      return {
        id: booking.id,
        reference: booking.bookingReference,
        leg: booking.leg,
        tripCode: booking.trip.tripCode,
        origin: booking.trip.origin,
        destination: booking.trip.destination,
        departureTime: booking.trip.departureTime,
        boardingPointName: booking.boardingPointName,
        boardingPointTime: booking.boardingPointTime,
        seats: booking.passengers.map((passenger) => passenger.seatNumber).sort((a, b) => Number(a) - Number(b)),
        total: Number(booking.totalPrice),
      };
    });
    const first = bookings[0]?.passengers[0];
    return {
      groupReference,
      kindLabel: bookings[0]?.kind ? BOOKING_KIND_LABELS[bookings[0].kind] : null,
      passengerName: first?.fullName ?? null,
      phone: first?.phone ?? null,
      legs,
      total: toSar(total),
      paid: toSar(total - remaining),
      remaining: toSar(remaining),
    };
  }

  // ---------------------------------------------------------------- whose branch

  /** The branch a booking is sold from. Only someone working across branches may choose it. */
  private async sellingBranch(actor: CashActor, requested?: string) {
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    const anyBranch = actor.permissions.includes('bookings.all_branches');
    if (requested && requested !== me?.branchId && !anyBranch) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    const branchId = requested ?? me?.branchId;
    if (!branchId) throw new BadRequestException(anyBranch ? 'اختر الفرع الذي يُسجل منه الحجز' : 'حسابك غير مرتبط بفرع، اطلب من مديرك إضافتك إلى فرع');
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { isActive: true } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    if (!branch.isActive) throw new ConflictException('هذا الفرع موقوف');
    return branchId;
  }

  /** Returns the branch to limit to, or null for every branch. */
  private async scope(actor: CashActor, requested?: string): Promise<string | null> {
    if (actor.permissions.includes('bookings.all_branches')) return requested || null;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    if (!me?.branchId || (requested && requested !== me.branchId)) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    return me.branchId;
  }
}

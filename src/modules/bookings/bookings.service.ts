import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingCategory, Gender, Prisma, RefundDestination, RoomType } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/services/prisma.service';
import { WalletService } from '../../common/services/wallet.service';
import { BookingCancellationService, lockBookingWithTrip } from '../../common/services/booking-cancellation.service';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { earnedPoints, LoyaltyService, transportShare } from '../../common/services/loyalty.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PaymentLedgerService } from '../../common/services/payment-ledger.service';
import { includesHousing, includesVisits } from '../../common/utils/booking-types.util';
import { serviceTypeOf } from '../../common/utils/booking-kinds.util';
import { nextBookingNumber } from '../../common/utils/booking-number.util';
import { GALLERY_SELECT } from '../../common/utils/gallery.util';
import { housingCharge, HousingTerms, isRoomSellable } from '../../common/utils/housing-price.util';
import { applicableRule, daysUntil, parseCancellationRules } from '../../common/utils/cancellation-policy.util';
import { paymentFigures } from '../../common/utils/payment.util';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { signTicketToken } from '../../common/utils/ticket-token.util';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { tripSeatLayout } from '../../common/utils/bus-layout.util';
import { assertSoloTravelerAllowed, describeSinglesRange, isSinglesSeat } from '../../common/utils/singles-seats.util';
import { holdLinkedSeats, lockTripsWithLinked, releaseLinkedHolds, returnRideOf, takeLinkedSeats } from '../../common/utils/linked-seats.util';
import { boardingOfBookings } from '../../common/utils/ticket-boarding.util';
import { tripDayWindow } from '../../common/utils/trip-day.util';
import { PACKAGE_MAX_PERSONS, PACKAGE_PRICE_SELECT, packageGroupTotal, packagePriceTiers } from '../../common/utils/package-price.util';
import { BookingLegDto, CreateBookingDto, HoldSeatsDto, QuoteDto, ReviewCancellationDto } from './bookings.dto';
import { PublicService, SERVICE_SELECT, withHotelServices } from '../../common/utils/services.util';
import { customPackageStay, loadCustomPackage } from '../../common/utils/custom-package.util';
import { assertBookingOpened } from '../../common/utils/booking-opens.util';
import { seatPricing } from '../../common/utils/dynamic-pricing.util';
import { WaitlistService } from '../../common/services/waitlist.service';

const DEFAULT_VAT_RATE = 15;
const CANCELLATION_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const BOOKING_INCLUDE = {
  trip: {
    select: {
      id: true,
      tripCode: true,
      title: true,
      origin: true,
      destination: true,
      departureTime: true,
      arrivalTime: true,
      // When the bus reaches the destination; arrivalTime is the end of the whole trip, the return on a round trip.
      estimatedArrivalAt: true,
      hijriDate: true,
      busType: true,
      miqat: true,
      direction: true,
      bookingType: true,
      tripStatus: true,
      liveStatus: true,
      visits: { orderBy: { sortOrder: 'asc' }, select: { id: true, title: true, desc: true, expectedTime: true } },
      // A fixed package's name, nights and hotel, so the confirmation shows the whole package as one ticket.
      package: { select: { id: true, name: true, nights: true, hotel: { select: { name: true, city: true } } } },
    },
  },
  // Selected field by field: national id and staff notes must never reach the customer.
  passengers: {
    select: {
      id: true,
      bookingId: true,
      fullName: true,
      phone: true,
      seatNumber: true,
      gender: true,
      roomNote: true,
      ticket: true,
      hotelRoom: {
        select: {
          number: true,
          type: true,
          hotelBooking: {
            select: {
              checkIn: true,
              checkOut: true,
              mealPlan: true,
              hotel: { select: { name: true, city: true, address: true, phone: true, description: true, images: GALLERY_SELECT } },
            },
          },
        },
      },
    },
  },
  // The package the customer built and the hotel chosen for its stay.
  customPackage: { select: { id: true, name: true } },
  stayHotel: { select: { name: true, city: true, address: true, images: GALLERY_SELECT } },
  // Field by field: the collector's follow-up note and the gateway reference stay with staff.
  payment: { select: { id: true, bookingId: true, amount: true, currency: true, status: true, method: true, walletAmount: true, createdAt: true } },
  // Enough for the customer to follow a refund; references and failure reasons stay with staff.
  paymentTransactions: {
    where: { type: 'REFUND' },
    orderBy: { number: 'asc' },
    select: { id: true, status: true, amount: true, method: true, destination: true, processedAt: true },
  },
} satisfies Prisma.BookingInclude;

const CUSTOMER_UPDATE_ACTIONS = ['SEAT_CHANGED', 'BOARDING_POINT_CHANGED', 'ROOM_ASSIGNED', 'ROOM_UNASSIGNED', 'BOARDED', 'RETURN_BOARDED', 'PASSENGER_UPDATED', 'CANCELLATION_REJECTED', 'CANCELLED', 'CREW_NOTICE', 'COMPENSATED'];

/** Wording the customer sees; reasons, staff names and addresses in the event are deliberately left out. */
function describeForCustomer(action: string, before: any, after: any): string | null {
  switch (action) {
    case 'COMPENSATED':
      return `أضفنا ${Number(after.amount).toFixed(2)} ر.س إلى محفظتك تعويضًا عن هذا الحجز`;
    case 'SEAT_CHANGED':
      return `تم تغيير مقعد ${after.passenger} إلى ${after.seat}. افتح تذكرتك الجديدة`;
    case 'BOARDING_POINT_CHANGED':
      return `تم تغيير نقطة التجمع إلى ${after.name} (${after.time})`;
    case 'ROOM_ASSIGNED':
      return `تم تسكين ${after.passenger} في الغرفة ${after.room ?? after.roomLabel}${after.hotel ? ` بفندق ${after.hotel}` : ''}`;
    case 'ROOM_UNASSIGNED':
      return `أُلغي تسكين ${before.passenger} في الغرفة ${before.room}، وستُحدد غرفة جديدة`;
    case 'BOARDED':
      return `تم تسجيل صعود ${after.passenger}`;
    case 'RETURN_BOARDED':
      return `تم تسجيل صعود ${after.passenger} في طريق العودة`;
    case 'PASSENGER_UPDATED':
      return before.fullName !== after.fullName || before.phone !== after.phone ? `تم تحديث بيانات المسافر ${after.fullName}` : null;
    case 'CANCELLATION_REJECTED':
      return 'تعذر قبول طلب الإلغاء، وحجزك ما زال مؤكدًا';
    case 'CANCELLED':
      return 'تم إلغاء الحجز';
    case 'CREW_NOTICE':
      return after.message;
    default:
      return null;
  }
}

const SAFE_USER_SELECT = { select: { id: true, name: true, phone: true } };

/** The internal reason, the reviewer's id and the retry key stay with staff; the app reads the customer's note as the review note. */
function toCustomerBooking<T extends { cancelReviewNote: string | null; cancelCustomerNote: string | null }>(booking: T) {
  // A manual price shows to the customer as its amount; why and by whom stays with staff.
  const { cancelCustomerNote, cancelReviewedById: _reviewer, idempotencyKey: _key, loyaltyPlan: _plan, createdById: _creator, createdByName: _creatorName, priceAdjustmentReason: _why, priceAdjustedById: _adjuster, priceAdjustedByName: _adjusterName, ...rest } = booking as T & { cancelReviewedById?: unknown; idempotencyKey?: unknown; loyaltyPlan?: unknown; createdById?: unknown; createdByName?: unknown; priceAdjustmentReason?: unknown; priceAdjustedById?: unknown; priceAdjustedByName?: unknown };
  return { ...rest, cancelReviewNote: cancelCustomerNote };
}

export const toHalalas = (sar: number | Prisma.Decimal) => Math.round(Number(sar) * 100);
export const toSar = (halalas: number) => Math.round(halalas) / 100;
const normalizeSeats = (seats: string[]) => seats.map((seat) => String(parseInt(seat, 10)));
export const randomCode = (length: number) =>
  crypto.randomBytes(length).toString('base64url').replace(/[-_]/g, 'X').slice(0, length).toUpperCase();

/** Splits an amount across legs in proportion to their weight so the parts always sum to the whole. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  let remaining = total;
  return weights.map((weight, idx) => {
    if (idx === weights.length - 1) return remaining;
    const share = Math.floor((total * weight) / sum);
    remaining -= share;
    return share;
  });
}

const roomOptionsOf = (hotel: { offersSharedRoom: boolean; offersPrivateRoom: boolean }): RoomType[] => [
  ...(hotel.offersSharedRoom ? (['SHARED'] as const) : []),
  ...(hotel.offersPrivateRoom ? (['PRIVATE'] as const) : []),
];

export const holdAvailableTo = (userId: string, now: Date): Prisma.SeatWhereInput => ({
  isBooked: false,
  OR: [{ heldUntil: null }, { heldUntil: { lt: now } }, { heldByUserId: userId }],
});

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private wallet: WalletService,
    private cancellation: BookingCancellationService,
    private events: BookingEventsService,
    private loyalty: LoyaltyService,
    private notifications: NotificationsService,
    private invoices: InvoiceLedgerService,
    private ledger: PaymentLedgerService,
    private appSettings: AppSettingsService,
    private waitlist: WaitlistService,
  ) {}

  private assertBookable(
    trip: { tripStatus: string; departureTime: Date; channelApp: boolean; bookingOpensAt: Date | null; packageId: string | null; package?: { status: string } | null } | null,
  ) {
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    if (trip.tripStatus !== 'PUBLISHED' || !trip.channelApp) throw new BadRequestException('هذه الرحلة غير متاحة للحجز');
    // A package's trips go on sale with it: a draft or archived package keeps them off the app.
    if (trip.packageId && trip.package?.status !== 'PUBLISHED') throw new BadRequestException('هذه الرحلة غير متاحة للحجز');
    if (trip.departureTime <= new Date()) throw new BadRequestException('انتهى موعد الحجز لهذه الرحلة');
    assertBookingOpened(trip);
  }

  /**
   * The same seat rules everywhere; the branch screen and the customer's app differ only in who may buy. Singles sit in the
   * singles range and families everywhere else. With `solo`, the whole booking is being checked, so a booking of one traveller
   * is kept out of the family section as the bus says; leaving it out checks the seats alone, as when one seat is changed.
   */
  async assertSeatRules(
    trip: { maxSeatsPerBooking: number; busId: string | null; packageId?: string | null; package?: unknown },
    seats: string[],
    category: BookingCategory = 'FAMILY',
    solo?: { travellers: number; gender?: Gender | null },
  ) {
    if (new Set(seats).size !== seats.length) throw new BadRequestException('يوجد مقعد مكرر في الطلب');
    if ((trip.packageId || trip.package) && seats.length > PACKAGE_MAX_PERSONS) {
      throw new BadRequestException(`الباقة تُحجز من شخص واحد إلى ${PACKAGE_MAX_PERSONS} أشخاص`);
    }
    if (seats.length > trip.maxSeatsPerBooking) {
      throw new BadRequestException(`الحد الأقصى ${trip.maxSeatsPerBooking} مقاعد في الحجز الواحد`);
    }
    const { range, soloPolicy } = await this.appSettings.seatRules(trip.busId);
    if (category === 'SINGLES') {
      if (seats.some((seat) => !isSinglesSeat(seat, range))) {
        throw new BadRequestException(`مقاعد العزّاب ${describeSinglesRange(range)}`);
      }
      return;
    }
    const inSingles = seats.filter((seat) => isSinglesSeat(seat, range));
    if (inSingles.length > 0) {
      throw new BadRequestException(`المقعد ${inSingles.join('، ')} من مقاعد العزّاب (${describeSinglesRange(range)}) ولا يُحجز لعائلة`);
    }
    if (solo) assertSoloTravelerAllowed(soloPolicy, solo.travellers, solo.gender);
  }

  async getSeatMap(userId: string, tripId: string) {
    const now = new Date();
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tripStatus: 'PUBLISHED', channelApp: true, OR: [{ packageId: null }, { package: { status: 'PUBLISHED' } }] },
      include: { seats: true, package: { select: PACKAGE_PRICE_SELECT } },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const { range: singles, soloPolicy } = await this.appSettings.seatRules(trip.busId);

    const seats = trip.seats
      .map((seat) => {
        const heldActive = seat.heldUntil && seat.heldUntil > now;
        let status = 'available';
        if (seat.isBooked) status = 'booked';
        else if (heldActive) status = seat.heldByUserId === userId ? 'mine' : 'held';
        return { seatNumber: seat.seatNumber, status };
      })
      .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));

    return {
      tripId: trip.id,
      busType: trip.busType,
      totalSeats: trip.totalSeats,
      layout: tripSeatLayout(trip),
      availableSeats: trip.availableSeats,
      maxSeatsPerBooking: trip.package ? Math.min(trip.maxSeatsPerBooking, PACKAGE_MAX_PERSONS) : trip.maxSeatsPerBooking,
      // A package is priced per group size, so the app shows the total for the seats picked rather than seat price × seats.
      packagePriceTiers: trip.package ? packagePriceTiers(trip.package) : null,
      singlesFromSeat: singles.from,
      singlesToSeat: singles.to,
      /** Where a booking of one traveller may sit: SINGLES_ONLY, or WOMEN_ALLOWED in the family section too. */
      soloTravelerPolicy: soloPolicy,
      // The same seat price the quote charges: flexible pricing when the trip has it on, the listed price otherwise.
      pricePerSeat: trip.package ? Number(trip.package.price) : seatPricing(trip).price / 100,
      basePricePerSeat: Number(trip.package?.price ?? trip.price),
      seats,
    };
  }

  async holdSeats(userId: string, dto: HoldSeatsDto) {
    const seats = normalizeSeats(dto.seats);
    await this.appSettings.assertBookingsOpen();
    const holdMinutes = await this.appSettings.number('holdMinutes');
    return this.prisma.$transaction(async (tx) => {
      // Holds touch both directions, so opposite requests would otherwise deadlock on each other's seats.
      await lockTripsWithLinked(tx, [dto.tripId]);
      const trip = await tx.trip.findUnique({ where: { id: dto.tripId }, include: { package: { select: { status: true } } } });
      this.assertBookable(trip);
      await this.assertSeatRules(trip, seats, dto.category, { travellers: seats.length });

      const now = new Date();
      const usualHold = new Date(now.getTime() + holdMinutes * 60 * 1000);
      // Seats offered from the waiting list stay the customer's until the offer ends, even while they pick them again at checkout.
      const offerEnds = await this.waitlist.offerHoldUntil(tx, userId, dto.tripId, now);
      const heldUntil = offerEnds && offerEnds > usualHold ? offerEnds : usualHold;
      await this.dropHolds(tx, userId, dto.tripId);
      const held = await tx.seat.updateMany({
        where: { tripId: dto.tripId, seatNumber: { in: seats }, ...holdAvailableTo(userId, now) },
        data: { heldByUserId: userId, heldUntil },
      });
      if (held.count !== seats.length) {
        throw new ConflictException('بعض المقاعد المختارة لم تعد متاحة، يرجى اختيار مقاعد أخرى');
      }
      await holdLinkedSeats(tx, dto.tripId, seats, { userId, heldUntil }, holdAvailableTo(userId, now));
      return { seats, heldUntil };
    });
  }

  private async dropHolds(tx: Prisma.TransactionClient, userId: string, tripId: string) {
    const mine = await tx.seat.findMany({ where: { tripId, heldByUserId: userId, isBooked: false }, select: { seatNumber: true } });
    await tx.seat.updateMany({
      where: { tripId, heldByUserId: userId, isBooked: false },
      data: { heldByUserId: null, heldUntil: null },
    });
    await releaseLinkedHolds(tx, tripId, mine.map((seat) => seat.seatNumber), userId);
  }

  async releaseHolds(userId: string, tripId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockTripsWithLinked(tx, [tripId]);
      await this.dropHolds(tx, userId, tripId);
    });
    return { success: true };
  }

  async quote(userId: string, dto: QuoteDto) {
    const { publicQuote } = await this.computeQuote(this.prisma, userId, dto);
    return publicQuote;
  }

  /** The only place prices are calculated: clients display this result and never supply amounts. */
  private async computeQuote(db: Prisma.TransactionClient, userId: string, dto: QuoteDto) {
    const tripIds = dto.legs.map((leg) => leg.tripId);
    if (new Set(tripIds).size !== tripIds.length) {
      throw new BadRequestException('لا يمكن تكرار نفس الرحلة في الحجز');
    }

    const trips = await db.trip.findMany({
      where: { id: { in: tripIds } },
      include: {
        package: { select: { ...PACKAGE_PRICE_SELECT, status: true } },
        accommodations: { select: { nights: true } },
        // The customer reads about the place and picks a room type; room counts and numbers stay with staff.
        hotelBookings: {
          where: { status: 'CONFIRMED' },
          orderBy: { number: 'asc' },
          take: 1,
          select: { hotel: { select: { name: true, city: true, address: true, description: true, services: SERVICE_SELECT, offersSharedRoom: true, offersPrivateRoom: true } } },
        },
      },
    });
    // A package the customer builds: its two trips are sold as transport, and its stay is priced by the night on the outbound.
    const customPackage = dto.customPackageId ? await loadCustomPackage(db, dto.customPackageId) : null;
    if (customPackage && dto.legs.length !== 2) throw new BadRequestException('اختر رحلة الذهاب ورحلة العودة للباقة');
    const seated = dto.legs.map((leg) => {
      const trip = trips.find((t) => t.id === leg.tripId);
      this.assertBookable(trip);
      return { leg, trip, seats: normalizeSeats(leg.seats) };
    });
    // Leaving out the stay of a package the customer builds leaves its two trips, priced as plain transport like any other.
    const skipsCustomStay = !!customPackage && !!dto.legs[0].withoutHousing;
    if (skipsCustomStay && dto.legs[0].roomChoice) throw new BadRequestException('اختر نوع الغرفة أو بدون سكن، لا الاثنين');
    const builtStay = customPackage
      ? customPackageStay(customPackage, { trip: seated[0].trip, seats: seated[0].seats.length }, { trip: seated[1].trip, seats: seated[1].seats.length }, skipsCustomStay ? undefined : dto.legs[0].roomChoice)
      : null;
    // What the customer can still pick from is shown either way; only a stay they keep is charged and saved.
    const customStayLeg = builtStay && {
      amount: skipsCustomStay ? 0 : builtStay.amount,
      details: { ...builtStay.details, ...(skipsCustomStay && { choice: null }), canSkip: true, withoutHousing: skipsCustomStay },
    };
    const customStay = skipsCustomStay ? null : builtStay;

    const legs = seated.map(({ leg, trip, seats }, index) => {
      // A package charges its total for the group's size; an ordinary trip charges each seat.
      // One seat price for the quote and the booking alike; without flexible pricing it is the listed price.
      const pricing = seatPricing(trip);
      const seatsSubtotal = trip.package ? packageGroupTotal(trip.package, seats.length) : pricing.price * seats.length;
      const unitPrice = seats.length ? Math.round(seatsSubtotal / seats.length) : pricing.price;
      // A package's price takes its stay with it, so only an ordinary trip can be booked as transport alone.
      if ((dto.transportOnly || leg.withoutHousing) && trip.package) throw new BadRequestException('الباقة تُحجز كاملة، ولا يمكن حجز النقل منها وحده');
      // Its seat price already pays for the stay, so selling it as transport would charge for a room the customer never gets.
      if (dto.transportOnly && includesHousing(trip.bookingType) && trip.housingPriceMode === 'INCLUDED_IN_BASE') {
        throw new BadRequestException('السكن مشمول في سعر هذه الرحلة، ولا يمكن حجزها بدون سكن');
      }
      const stay = customStayLeg ? (index === 0 ? customStayLeg : null) : dto.transportOnly ? null : this.priceStay(trip, leg, seats.length);
      const housingAmount = stay?.amount ?? 0;
      return { leg, trip, seats, unitPrice, pricing, stay, seatsSubtotal, housingAmount, subtotal: seatsSubtotal + housingAmount };
    });

    const subtotal = legs.reduce((sum, leg) => sum + leg.subtotal, 0);
    const seatCount = legs.reduce((sum, leg) => sum + leg.seats.length, 0);
    // Points, the wallet and vouchers bought with points pay for transport only, never the stay: this is each leg's ticket part.
    const legShares = legs.map((leg) =>
      transportShare({ subtotal: leg.subtotal / 100, housingAmount: leg.housingAmount / 100, seats: leg.seats.length, trip: { price: leg.trip.price, packageId: leg.trip.packageId } }),
    );
    const legTransport = legs.map((leg, idx) => Math.round(leg.subtotal * legShares[idx]));
    const transportSubtotal = legTransport.reduce((sum, amount) => sum + amount, 0);

    const coupon = dto.couponCode ? await this.resolveCoupon(db, userId, dto.couponCode) : null;
    // A voucher bought with points is points spent, so like them it only comes off the tickets.
    const transportOnlyCoupon = !!coupon?.ownerUserId;
    let discount = 0;
    if (coupon) {
      const base = transportOnlyCoupon ? transportSubtotal : subtotal;
      discount =
        coupon.type === 'PERCENT'
          ? Math.round((base * Number(coupon.value)) / 100)
          : coupon.type === 'FIXED_TOTAL'
            ? toHalalas(coupon.value)
            : toHalalas(coupon.value) * seatCount;
      discount = Math.min(discount, base);
    }
    const afterCoupon = subtotal - discount;

    const weights = legs.map((leg) => leg.subtotal);
    const legDiscounts = transportOnlyCoupon ? allocate(discount, legTransport) : allocate(discount, weights);
    // The ticket part each leg still owes once the coupon is off; an ordinary coupon comes off tickets and stay in proportion.
    const transportAfterCoupon = legTransport.map((amount, idx) =>
      Math.max(0, amount - (transportOnlyCoupon ? legDiscounts[idx] : Math.round(legDiscounts[idx] * legShares[idx]))),
    );

    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { walletBalance: true, walletTransportBalance: true, loyaltyPoints: true } });
    const program = await this.loyalty.getProgram(db);
    const redeemable = Math.min(afterCoupon, transportAfterCoupon.reduce((sum, amount) => sum + amount, 0));
    const redemption = this.loyalty.priceRedemption(program, user.loyaltyPoints, dto.pointsToRedeem ?? 0, redeemable);
    const total = afterCoupon - redemption.discount;

    const legPointDiscounts = allocate(redemption.discount, transportAfterCoupon);
    const legPoints = allocate(redemption.points, transportAfterCoupon);
    // What each leg still owes, split into its tickets (after the coupon and points) and the rest, which is its stay.
    const legOwed = legs.map((leg, idx) => Math.max(0, leg.subtotal - legDiscounts[idx] - legPointDiscounts[idx]));
    const ticketRoom = legs.map((_, idx) => Math.max(0, Math.min(transportAfterCoupon[idx] - legPointDiscounts[idx], legOwed[idx])));
    const stayRoom = legs.map((_, idx) => legOwed[idx] - ticketRoom[idx]);
    const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);

    // Compensations and promotional credit pay for tickets only; ordinary money (refunds) pays for anything.
    // Tickets take transport-only credit first, so ordinary money is left for the stay.
    const walletBalance = toHalalas(user.walletBalance);
    const walletTransportBalance = Math.min(walletBalance, toHalalas(user.walletTransportBalance));
    const walletOrdinary = walletBalance - walletTransportBalance;
    const walletOnTickets = dto.useWallet ? Math.min(walletBalance, sum(ticketRoom)) : 0;
    const walletFromTransport = Math.min(walletTransportBalance, walletOnTickets);
    const walletOnStay = dto.useWallet ? Math.min(walletOrdinary - (walletOnTickets - walletFromTransport), sum(stayRoom)) : 0;
    const walletUsed = walletOnTickets + walletOnStay;
    const payable = total - walletUsed;

    const vatSetting = await db.setting.findUnique({ where: { key: 'vatRate' } });
    const vatRate = vatSetting ? Number(vatSetting.value) : DEFAULT_VAT_RATE;
    const vat = Math.round((total * vatRate) / (100 + vatRate));

    const ticketWallets = allocate(walletOnTickets, ticketRoom);
    const stayWallets = allocate(walletOnStay, stayRoom);
    const legWallets = legs.map((_, idx) => ticketWallets[idx] + stayWallets[idx]);
    const legWalletTransport = allocate(walletFromTransport, ticketWallets);
    const legVats = allocate(vat, weights);

    const pricedLegs = legs.map((leg, idx) => ({
      ...leg,
      discount: legDiscounts[idx],
      pointsDiscount: legPointDiscounts[idx],
      points: legPoints[idx],
      wallet: legWallets[idx],
      walletTransport: legWalletTransport[idx],
      vat: legVats[idx],
      total: leg.subtotal - legDiscounts[idx] - legPointDiscounts[idx],
      payable: leg.subtotal - legDiscounts[idx] - legPointDiscounts[idx] - legWallets[idx],
    }));

    // Worked out once here, so the preview and the saved booking can never disagree.
    const plans = await Promise.all(pricedLegs.map((leg) => this.loyalty.earnPlan(db, userId, program, leg.trip, leg.seats.length)));
    // Points are earned on the tickets alone, so the hotel's part of each leg is left out, the same rule as crediting at payment.
    const willEarn = pricedLegs.reduce((sum, leg, idx) => {
      const share = transportShare({ subtotal: leg.subtotal / 100, housingAmount: leg.housingAmount / 100, seats: leg.seats.length, trip: { price: leg.trip.price, packageId: leg.trip.packageId } });
      // A leg's total is exactly what it brings in, online and from the wallet, so this is what payment will credit.
      return sum + earnedPoints(leg.total, share, plans[idx]);
    }, 0);

    const housing = pricedLegs.map((leg) => leg.stay?.details ?? null);

    return {
      coupon,
      housing,
      customStay,
      skipsCustomStay,
      walletUsed,
      walletOnTickets,
      payable,
      pricedLegs,
      plans,
      pointsUsed: redemption.points,
      publicQuote: {
        legs: pricedLegs.map((leg, idx) => ({
          housing: housing[idx],
          tripId: leg.trip.id,
          tripCode: leg.trip.tripCode,
          origin: leg.trip.origin,
          destination: leg.trip.destination,
          seats: leg.seats,
          pricePerSeat: toSar(leg.unitPrice),
          // The listed seat price before flexible pricing, so the app can show what moved it; equal to pricePerSeat when it is off.
          basePricePerSeat: leg.trip.package ? toSar(leg.unitPrice) : toSar(leg.pricing.base),
          // A package's seatsSubtotal is its total for the group's size, so the app shows it as such, not seats × price.
          isPackage: !!leg.trip.package,
          seatsSubtotal: toSar(leg.seatsSubtotal),
          housingAmount: toSar(leg.housingAmount),
          subtotal: toSar(leg.subtotal),
        })),
        seatCount,
        subtotal: toSar(subtotal),
        couponCode: coupon?.code ?? null,
        couponDiscount: toSar(discount),
        loyalty: {
          enabled: program.enabled,
          balance: user.loyaltyPoints,
          step: program.redeemPoints,
          stepValue: program.redeemValue,
          min: program.minRedeemPoints,
          maxPoints: redemption.maxPoints,
          pointsUsed: redemption.points,
          discount: toSar(redemption.discount),
          willEarn,
        },
        total: toSar(total),
        walletBalance: toSar(walletBalance),
        // Of the balance, what pays for transport only (compensations and promotional credit).
        walletTransportBalance: toSar(walletTransportBalance),
        walletUsed: toSar(walletUsed),
        payable: toSar(payable),
        vatRate,
        vatIncluded: toSar(vat),
        currency: 'SAR',
      },
    };
  }

  /** The hotel the customer reads about, the room types they can pick, and what each costs on this booking. */
  private priceStay(
    trip: HousingTerms & {
      bookingType: string;
      package: unknown;
      accommodations: { nights: number | null }[];
      hotelBookings: { hotel: { name: string; city: string; address: string | null; description: string | null; services: { service: PublicService }[]; offersSharedRoom: boolean; offersPrivateRoom: boolean } }[];
    },
    leg: { roomChoice?: RoomType; withoutHousing?: boolean },
    seats: number,
  ) {
    if (!includesHousing(trip.bookingType)) return null;
    const hotel = trip.hotelBookings[0]?.hotel;
    // A package's price is all-inclusive, so its trips charge nothing more for housing.
    const charges = !trip.package;
    // The seat alone has a price only when housing is charged on top of it; a price that includes the stay has no part to take off.
    const canSkip = charges && trip.housingPriceMode === 'ADDED_TO_BASE';
    const skips = !!leg.withoutHousing;
    if (skips && !canSkip) throw new BadRequestException('السكن مشمول في سعر هذه الرحلة، ولا يمكن حجزها بدون سكن');
    if (skips && leg.roomChoice) throw new BadRequestException('اختر نوع الغرفة أو بدون سكن، لا الاثنين');
    if (!hotel) {
      // Transport alone owes nothing for a hotel, so it needs none.
      if (skips) return null;
      // Selling without a hotel here would leave out a price the customer owes.
      if (canSkip) throw new BadRequestException('لم يُحدد فندق هذه الرحلة بعد');
      return null;
    }
    const nights = trip.accommodations[0]?.nights ?? 1;
    const options = roomOptionsOf(hotel).filter((room) => !charges || isRoomSellable(trip, room));
    if (leg.roomChoice && !options.includes(leg.roomChoice)) throw new BadRequestException('نوع الغرفة المختار غير متاح في هذا الفندق');
    // With no housing left out, a hotel with one room type picks it; leaving the stay out picks none.
    const choice = skips ? null : leg.roomChoice ?? (options.length === 1 ? options[0] : null);
    const chargeFor = (room: RoomType) => (charges ? housingCharge(trip, room, seats, nights) : 0);
    const { offersSharedRoom, offersPrivateRoom, ...place } = withHotelServices(hotel);
    return {
      amount: choice ? chargeFor(choice) : 0,
      details: {
        ...place,
        options,
        choice,
        optionAmounts: Object.fromEntries(options.map((room) => [room, toSar(chargeFor(room))])),
        // Whether the app may offer the stay as optional, and whether the customer left it out.
        canSkip,
        withoutHousing: skips,
      },
    };
  }

  private async resolveCoupon(db: Prisma.TransactionClient, userId: string, code: string) {
    const coupon = await db.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    const now = new Date();
    const invalid = new BadRequestException('كوبون غير صالح');
    if (!coupon || !coupon.isActive) throw invalid;
    // A voucher bought with points belongs to one customer; to anyone else the code does not exist.
    if (coupon.ownerUserId && coupon.ownerUserId !== userId) throw invalid;
    if (coupon.validFrom && coupon.validFrom > now) throw invalid;
    if (coupon.validUntil && coupon.validUntil < now) throw new BadRequestException('انتهت صلاحية الكوبون');
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException('تم استنفاد هذا الكوبون');
    }
    if (coupon.perUserLimit !== null) {
      const used = await db.booking.findMany({
        where: { userId, couponId: coupon.id, status: { not: 'CANCELLED' } },
        distinct: ['groupReference'],
        select: { id: true },
      });
      if (used.length >= coupon.perUserLimit) {
        throw new BadRequestException('لقد استخدمت هذا الكوبون من قبل');
      }
    }
    return coupon;
  }

  private async findGroupByKey(userId: string, idempotencyKey: string) {
    const first = await this.prisma.booking.findUnique({ where: { idempotencyKey: `${userId}:${idempotencyKey}:0` } });
    return first ? this.getGroup(first.groupReference) : null;
  }

  private async getGroup(groupReference: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { groupReference },
      include: BOOKING_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    // A round trip's return rides on the same booking, so the confirmation can list it beside the outbound.
    const withReturn = await Promise.all(bookings.map(async (booking) => ({ ...toCustomerBooking(booking), returnRide: await returnRideOf(this.prisma, booking) })));
    return { groupReference, bookings: withReturn };
  }

  private normalizePassengerPhone(phone?: string) {
    return phone?.trim() ? normalizeSaudiPhone(phone) : null;
  }

  async createBooking(userId: string, dto: CreateBookingDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.findGroupByKey(userId, idempotencyKey);
      if (existing) return existing;
    }
    await this.appSettings.assertBookingsOpen();

    for (const leg of dto.legs) {
      if (leg.seats.length !== dto.passengers.length) {
        throw new BadRequestException('عدد المسافرين يجب أن يساوي عدد المقاعد');
      }
    }
    const passengers = dto.passengers.map((p) => ({
      fullName: p.fullName.trim(),
      phone: this.normalizePassengerPhone(p.phone),
      gender: p.gender ?? null,
    }));
    const category = dto.category ?? 'FAMILY';
    // A traveller booking alone with no gender entered is taken to be the account holder.
    const soloGender =
      passengers.length === 1 ? passengers[0].gender ?? (await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } }))?.gender ?? null : undefined;
    const ticketSecret = this.config.getOrThrow<string>('TICKET_SIGNING_SECRET');

    try {
      const groupReference = await this.prisma.$transaction(
        async (tx) => {
          // One booking per customer at a time, or simultaneous requests would each count no earlier use of a coupon limited per customer.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${userId}`}))`;
          // Taken before the quote checks the trip, so a booking waiting on a trip being cancelled sees the cancellation instead of confirming onto it.
          await lockTripsWithLinked(tx, dto.legs.map((leg) => leg.tripId));
          const quote = await this.computeQuote(tx, userId, dto);
          if (quote.housing.some((stay) => stay && !stay.choice && !stay.withoutHousing)) throw new BadRequestException('اختر نوع الغرفة أو بدون سكن');
          // Which rows are sold as transport alone: all of them when the customer asked for transport or left a built package's stay
          // out, otherwise each trip whose hotel they left out. The kind tells the rooming sheet and the crew there is no stay.
          const asTransport = quote.pricedLegs.map(
            (leg) => quote.skipsCustomStay || (!quote.customStay && (!!dto.transportOnly || !!leg.leg.withoutHousing)),
          );
          const allTransport = asTransport.every(Boolean);
          const transportKind = (legIndex: number) =>
            allTransport
              ? quote.pricedLegs.length > 1
                ? ('TRANSPORT_ROUND' as const)
                : ('TRANSPORT_OUTBOUND' as const)
              : legIndex === 0
                ? ('TRANSPORT_OUTBOUND' as const)
                : ('TRANSPORT_RETURN' as const);

          // Until the gateway ships, anything left to pay can only go through in explicit simulated mode.
          const simulated = this.config.get('PAYMENT_MODE') === 'simulated';
          if (quote.payable > 0 && !simulated) {
            throw new ServiceUnavailableException('الدفع الإلكتروني غير متاح حاليًا');
          }

          const group = `GRP-${randomCode(10)}`;
          const now = new Date();
          const created: { id: string; reference: string }[] = [];

          for (const [legIndex, leg] of quote.pricedLegs.entries()) {
            await this.assertSeatRules(leg.trip, leg.seats, category, { travellers: passengers.length, gender: soloGender });

            const claimed = await tx.seat.updateMany({
              where: { tripId: leg.trip.id, seatNumber: { in: leg.seats }, ...holdAvailableTo(userId, now) },
              data: { isBooked: true, heldByUserId: null, heldUntil: null },
            });
            if (claimed.count !== leg.seats.length) {
              throw new ConflictException('بعض المقاعد المختارة لم تعد متاحة، يرجى اختيار مقاعد أخرى');
            }
            await tx.trip.update({
              where: { id: leg.trip.id },
              data: { availableSeats: { decrement: leg.seats.length } },
            });
            await takeLinkedSeats(tx, leg.trip.id, leg.seats, holdAvailableTo(userId, now), { returnsOnOtherLeg: quote.pricedLegs.length > 1 });

            const boardingPoint = await this.resolveBoardingPoint(tx, leg.leg, leg.trip.id);
            // The same numbering as a branch's bookings; the plain client, so the counter is not held while this one saves.
            const bookingReference = await nextBookingNumber(this.prisma);
            // Stored on the booking, so every screen reads what was bought here rather than what the trip offers.
            const hasStay = !asTransport[legIndex] && (!!quote.customStay || !!quote.housing[legIndex]?.choice);
            const paidOnline = leg.payable > 0;

            const booking = await tx.booking.create({
              data: {
                bookingReference,
                groupReference: group,
                userId,
                tripId: leg.trip.id,
                status: 'CONFIRMED',
                category,
                roomChoice: quote.housing[legIndex]?.choice ?? null,
                serviceType: serviceTypeOf(hasStay, includesVisits(leg.trip.bookingType)),
                // The customer's own package: both legs carry it, and the stay sits on the outbound like a branch's journey.
                ...(quote.customStay && {
                  kind: 'PACKAGE_ROUND_STAY' as const,
                  leg: legIndex === 0 ? ('OUTBOUND' as const) : ('RETURN' as const),
                  customPackageId: dto.customPackageId,
                  ...(legIndex === 0 && {
                    stayHotelId: quote.customStay.hotelId,
                    stayCheckIn: quote.customStay.checkIn,
                    stayCheckOut: quote.customStay.checkOut,
                    stayNights: quote.customStay.nights,
                  }),
                }),
                // Named as transport, so the rooming sheet and the crew know this booking has no stay even on a trip with a hotel.
                ...(asTransport[legIndex] && {
                  kind: transportKind(legIndex),
                  leg: legIndex === 0 ? ('OUTBOUND' as const) : ('RETURN' as const),
                }),
                housingAmount: toSar(leg.housingAmount),
                subtotal: toSar(leg.subtotal),
                discountAmount: toSar(leg.discount),
                pointsRedeemed: leg.points,
                pointsDiscount: toSar(leg.pointsDiscount),
                loyaltyPlan: quote.plans[legIndex] as unknown as Prisma.InputJsonValue,
                walletAmount: toSar(leg.wallet),
                vatAmount: toSar(leg.vat),
                totalPrice: toSar(leg.total),
                // The seat price as charged now, so a later change of rules or occupancy never rewrites what was sold.
                ...(!leg.trip.package && { seatPrice: toSar(leg.pricing.price), seatBasePrice: toSar(leg.pricing.base) }),
                couponId: quote.coupon?.id,
                boardingPointId: boardingPoint?.id,
                boardingPointName: boardingPoint?.name,
                boardingPointTime: boardingPoint?.time,
                idempotencyKey: idempotencyKey ? `${userId}:${idempotencyKey}:${legIndex}` : undefined,
                passengers: {
                  create: passengers.map((p, idx) => ({ ...p, position: idx, seatNumber: leg.seats[idx] })),
                },
                payment: {
                  create: {
                    amount: toSar(leg.payable),
                    walletAmount: toSar(leg.wallet),
                    walletTransportAmount: toSar(leg.walletTransport),
                    currency: 'SAR',
                    method: paidOnline ? dto.paymentMethod ?? 'mada' : 'wallet_balance',
                    status: paidOnline ? 'SIMULATED' : 'COMPLETED',
                  },
                },
              },
              include: { passengers: true },
            });
            if (paidOnline) await this.ledger.charge(tx, { bookingId: booking.id, amount: toSar(leg.payable), method: dto.paymentMethod ?? 'mada', simulated });

            for (const passenger of booking.passengers) {
              const ticketNumber = `TKT-${randomCode(10)}`;
              await tx.ticket.create({
                data: {
                  bookingId: booking.id,
                  passengerId: passenger.id,
                  ticketNumber,
                  signedToken: signTicketToken(
                    { ticketNumber, tripId: leg.trip.id, seat: passenger.seatNumber },
                    ticketSecret,
                  ),
                },
              });
            }
            created.push({ id: booking.id, reference: bookingReference });
          }

          if (quote.coupon) {
            const redeemed = await tx.coupon.updateMany({
              where: {
                id: quote.coupon.id,
                ...(quote.coupon.maxUses !== null && { usedCount: { lt: quote.coupon.maxUses } }),
              },
              data: { usedCount: { increment: 1 } },
            });
            if (redeemed.count === 0) throw new BadRequestException('تم استنفاد هذا الكوبون');
          }
          if (quote.pointsUsed > 0) {
            await this.loyalty.spend(tx, {
              userId,
              points: quote.pointsUsed,
              type: 'REDEEMED',
              description: `استبدال بخصم • ${created.map((b) => b.reference).join(' و ')}`,
              bookingId: created[0].id,
              uniqueKey: `redeem:${group}`,
            });
          }
          if (quote.walletUsed > 0) {
            await this.wallet.apply(tx, {
              userId,
              amount: -toSar(quote.walletUsed),
              // Only the tickets' part may come from transport-only credit; the stay is paid from ordinary money.
              transportAmount: toSar(quote.walletOnTickets),
              type: 'DEBIT_SPENT',
              description: `خصم حجز ${created.map((b) => b.reference).join(' و ')}`,
              bookingId: created[0].id,
            });
          }
          // A customer who was waiting for these trips has their place in the queue closed: the seats are theirs now.
          await this.waitlist.markBooked(tx, userId, quote.pricedLegs.map((leg) => leg.trip.id));
          await this.notifications.toBookingOwners(tx, 'BOOKING_CONFIRMED', created.map((booking) => booking.id));
          for (const booking of created) {
            await this.notifications.toStaffAboutBooking(tx, 'STAFF_NEW_BOOKING', ['bookings.view'], booking.id, { exceptUserId: userId });
          }
          // Paid in full at checkout, online or from the wallet, so the points are credited now rather than after the trip.
          for (const booking of created) await this.loyalty.creditPaidBooking(tx, booking.id);
          // Last, so a failure earlier in the booking does not burn an invoice number.
          for (const booking of created) await this.invoices.ensure(tx, booking.id);
          return group;
        },
        { timeout: 30_000 },
      );
      return this.getGroup(groupReference);
    } catch (err) {
      // A concurrent retry with the same key won the race; hand back its result instead of an error.
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.findGroupByKey(userId, idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async resolveBoardingPoint(tx: Prisma.TransactionClient, leg: BookingLegDto, tripId: string) {
    if (!leg.boardingPointId) return null;
    const point = await tx.boardingPoint.findFirst({ where: { id: leg.boardingPointId, tripId } });
    if (!point) throw new BadRequestException('نقطة الصعود لا تخص هذه الرحلة');
    return point;
  }

  async getMyBookings(userId: string) {
    const [bookings, closesAfterHours] = await Promise.all([
      this.prisma.booking.findMany({
        where: { userId },
        include: BOOKING_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.appSettings.number('trackingClosesAfterHours'),
    ]);
    const boarding = await boardingOfBookings(this.prisma, bookings);
    return bookings.map((booking) => ({ ...toCustomerBooking(booking), tripDayOpen: this.isTripDayOpen(booking, closesAfterHours), boarding: boarding.get(booking.id) ?? null }));
  }

  /** The server decides, so a phone with the wrong date cannot hide or open the trip page. */
  private isTripDayOpen(booking: { status: string; trip: { departureTime: Date; arrivalTime: Date; tripStatus: string; liveStatus: string } }, closesAfterHours: number) {
    return tripDayWindow({ ...booking.trip, bookingStatus: booking.status }, closesAfterHours).isOpen;
  }

  /**
   * The names of whoever shares each passenger's hotel room, from this booking or another. Names only: another
   * booking's ids, phones and details never reach this customer.
   */
  private async roommatesOf(bookingId: string) {
    const housed = await this.prisma.bookingPassenger.findMany({
      where: { bookingId, hotelRoomId: { not: null } },
      select: {
        id: true,
        hotelRoom: {
          select: {
            occupants: {
              where: { booking: { status: { in: ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] } } },
              orderBy: { fullName: 'asc' },
              select: { id: true, fullName: true },
            },
          },
        },
      },
    });
    return new Map(housed.map((p) => [p.id, (p.hotelRoom?.occupants ?? []).filter((o) => o.id !== p.id).map((o) => o.fullName)]));
  }

  async getBookingById(userId: string, bookingId: string, canViewAll: boolean, canViewBranch = false) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { ...BOOKING_INCLUDE, user: SAFE_USER_SELECT },
    });

    if (!booking) throw new NotFoundException('Booking not found');

    if (!canViewAll && booking.userId !== userId) {
      const me = canViewBranch ? await this.prisma.user.findUnique({ where: { id: userId }, select: { branchId: true } }) : null;
      if (!me?.branchId || me.branchId !== booking.branchId) throw new ForbiddenException('Access denied to this booking');
    }

    const events = await this.prisma.bookingEvent.findMany({
      where: { bookingId, action: { in: CUSTOMER_UPDATE_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, action: true, before: true, after: true, createdAt: true, actorName: true },
    });
    // The crew member who checked a ticket is shown on the customer's used-ticket screen.
    const boardedBy = new Map(
      events
        .filter((e) => e.action === 'BOARDED')
        .map((e) => [(e.after as { ticketNumber?: string } | null)?.ticketNumber, e.actorName] as const),
    );
    const updates = events.flatMap((event) => {
      const message = describeForCustomer(event.action, event.before ?? {}, event.after ?? {});
      return message ? [{ id: event.id, type: event.action, message, at: event.createdAt }] : [];
    });

    const cancellationEstimate = booking.userId === userId ? await this.cancellationEstimate(booking) : null;
    const roommates = await this.roommatesOf(booking.id);
    const withBoarding = booking.passengers.map((p) => ({
      ...p,
      boardedByName: p.ticket?.isBoarded ? boardedBy.get(p.ticket.ticketNumber) ?? null : null,
      roommates: roommates.get(p.id) ?? [],
    }));
    const tripDayOpen = this.isTripDayOpen(booking, await this.appSettings.number('trackingClosesAfterHours'));
    const returnRide = await returnRideOf(this.prisma, booking);
    const boarding = (await boardingOfBookings(this.prisma, [booking])).get(booking.id) ?? null;
    // Where the boarding point is, so the ticket can open directions to it. The point may have been removed since.
    const boardingPlace = booking.boardingPointId
      ? await this.prisma.boardingPoint.findUnique({ where: { id: booking.boardingPointId }, select: { address: true, lat: true, lng: true } })
      : null;
    if (booking.userId === userId) return { ...toCustomerBooking(booking), passengers: withBoarding, updates, cancellationEstimate, tripDayOpen, returnRide, boarding, boardingPlace };
    // Staff read bookings but do not need the token a passenger scans to board.
    return {
      ...booking,
      updates,
      tripDayOpen,
      returnRide,
      boarding,
      passengers: withBoarding.map((p) => ({ ...p, ticket: p.ticket && { ...p.ticket, signedToken: undefined } })),
    };
  }

  /** What the current policy would give back if the customer asked today; the reviewer still decides. */
  private async cancellationEstimate(booking: { id: string; status: string; payment: { amount: Prisma.Decimal; walletAmount: Prisma.Decimal; status: string } | null; trip: { departureTime: Date } }) {
    if (booking.status !== 'CONFIRMED') return null;
    const setting = await this.prisma.setting.findUnique({ where: { key: 'cancellationRules' } });
    const rule = applicableRule(parseCancellationRules(setting?.value), daysUntil(booking.trip.departureTime, new Date()));
    if (!rule) return null;
    const collections = await this.prisma.bookingCollection.findMany({ where: { bookingId: booking.id }, select: { amount: true } });
    const { received, wallet } = paymentFigures(booking.payment, collections);
    return { percent: rule.percent, amount: toSar(((received + wallet) * rule.percent) / 100) };
  }

  async requestCancellation(userId: string, bookingId: string, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.events.lock(tx, bookingId);
      const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { trip: true } });
      if (!booking || booking.userId !== userId) throw new NotFoundException('Booking not found');
      if (booking.status !== 'CONFIRMED') throw new BadRequestException('لا يمكن طلب إلغاء هذا الحجز في حالته الحالية');
      if (booking.trip.departureTime <= new Date()) throw new BadRequestException('انطلقت الرحلة ولا يمكن طلب الإلغاء');

      await this.events.record(tx, { bookingId, action: 'CANCELLATION_REQUESTED', actorId: userId, reason });
      await this.notifications.toBookingOwners(tx, 'CANCELLATION_REQUESTED', [bookingId]);
      await this.notifications.toStaffAboutBooking(tx, 'STAFF_CANCELLATION_REQUEST', ['cancellations.review', 'cancellations.approve'], bookingId, {
        exceptUserId: userId,
        extra: { cancelReason: reason },
      });
      return toCustomerBooking(await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'PENDING_CANCELLATION_REVIEW', cancelReason: reason, cancelRequestedAt: new Date() },
        include: BOOKING_INCLUDE,
      }));
    }, CANCELLATION_TX_OPTIONS);
  }

  async reviewCancellation(actor: { userId: string; role: string; permissions: string[] }, bookingId: string, dto: ReviewCancellationDto, ip?: string) {
    // A refund is a financial decision, so reviewers without this permission may only send the booking back to confirmed.
    if (dto.approve && !actor.permissions.includes('cancellations.approve')) {
      throw new ForbiddenException('ليست لديك صلاحية قبول الإلغاء والاسترداد');
    }
    return this.prisma.$transaction(async (tx) => {
      // Trip first, then booking: the order trip-wide actions use, so the two cannot deadlock.
      await lockBookingWithTrip(tx, bookingId);
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException('Booking not found');
      if (booking.status !== 'PENDING_CANCELLATION_REVIEW') {
        throw new ConflictException('لا يوجد طلب إلغاء قيد المراجعة لهذا الحجز');
      }

      if (dto.approve) {
        return this.cancellation.cancel(tx, bookingId, {
          refundAmount: await this.decideRefund(tx, actor, bookingId, dto.refundAmount),
          refundDestination: dto.refundDestination,
          customerNote: dto.note,
          reviewedById: actor.userId,
          note: dto.note,
          ip,
        });
      }
      await this.events.record(tx, {
        bookingId,
        action: 'CANCELLATION_REJECTED',
        actorId: actor.userId,
        reason: dto.note,
        before: { status: booking.status },
        after: { status: 'CONFIRMED' },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'CANCELLATION_REJECTED', [bookingId], { reviewNote: dto.note });
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CONFIRMED', cancelReviewedById: actor.userId, cancelReviewedAt: new Date(), cancelReviewNote: dto.note, cancelCustomerNote: dto.note },
      });
    }, CANCELLATION_TX_OPTIONS);
  }

  async adminCancel(actor: { userId: string; permissions: string[] }, bookingId: string, dto: { refundAmount?: number; refundMethod?: RefundDestination; note: string }, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      // Trip first, then booking: the order trip-wide actions use, so the two cannot deadlock.
      await lockBookingWithTrip(tx, bookingId);
      const refundAmount = await this.decideRefund(tx, actor, bookingId, dto.refundAmount);
      // ORIGINAL takes the path of an approved cancellation request: what came from the wallet goes back to it now,
      // and the card and branch-cash parts wait as pending refunds for staff with refunds.execute to carry out.
      return this.cancellation.cancel(tx, bookingId, { refundAmount, refundDestination: dto.refundMethod ?? 'WALLET', reviewedById: actor.userId, note: dto.note, ip });
    }, CANCELLATION_TX_OPTIONS);
  }

  /**
   * How much a cancellation may give back, by who is asking. The policy sets the amount and going above it takes its own permission.
   * A trip that has left has no notice to reward, so a no-show gets nothing unless someone with that permission decides otherwise.
   * With no policy saved there is nothing to cap against, so the decision takes the permission to approve refunds.
   */
  private async decideRefund(tx: Prisma.TransactionClient, actor: { permissions: string[] }, bookingId: string, requested?: number) {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        status: true,
        cancelRequestedAt: true,
        payment: { select: { amount: true, walletAmount: true, status: true } },
        collections: { select: { amount: true } },
        trip: { select: { departureTime: true } },
        compensation: { select: { amount: true } },
      },
    });
    const { received, wallet } = paymentFigures(booking.payment, booking.collections);
    // What was already paid out as compensation is not paid out a second time as a refund.
    const paid = Math.max(0, received + wallet - toHalalas(booking.compensation?.amount ?? 0));
    // Notice is counted from the customer's request, so a slow review never costs them a better percentage.
    const now = booking.status === 'PENDING_CANCELLATION_REVIEW' && booking.cancelRequestedAt ? booking.cancelRequestedAt : new Date();
    const setting = await tx.setting.findUnique({ where: { key: 'cancellationRules' } });
    const rules = parseCancellationRules(setting?.value);

    let policy: number | null;
    if (booking.trip.departureTime <= now) policy = 0;
    else if (rules.length === 0) policy = null;
    else policy = Math.round((paid * (applicableRule(rules, daysUntil(booking.trip.departureTime, now))?.percent ?? 0)) / 100);

    const refund = requested ?? (policy === null ? paid : policy) / 100;
    if (policy === null) {
      if (refund > 0 && !actor.permissions.includes('cancellations.approve')) {
        throw new ForbiddenException('لا توجد سياسة استرداد محددة، والاسترداد يحتاج صلاحية قبول الاسترداد');
      }
    } else if (toHalalas(refund) > policy && !actor.permissions.includes('refunds.override_policy')) {
      throw new ForbiddenException(`الحد المسموح لك وفق سياسة الإلغاء هو ${toSar(policy).toFixed(2)} ر.س`);
    }
    return refund;
  }
}

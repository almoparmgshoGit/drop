import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RefundDestination } from '@prisma/client';
import { BookingEventsService } from './booking-events.service';
import { LoyaltyService } from './loyalty.service';
import { formatSar, NotificationsService } from './notifications.service';
import { RoomAllocationService } from './room-allocation.service';
import { WalletService } from './wallet.service';
import { InvoiceLedgerService } from './invoice-ledger.service';
import { PaymentLedgerService, refundMethodLabel } from './payment-ledger.service';
import { WaitlistService } from './waitlist.service';
import { hasOtherLeg, lockTripsWithLinked, releaseLinkedPlaces, releaseLinkedSeats, retakeReturnSeats, ridesBack, takeLinkedPlaces } from '../utils/linked-seats.util';
import { halalas, netBookingFigures, paymentFigures, splitOriginalRefund } from '../utils/payment.util';
import { cancelledTicketsTake, ticketCancelFigures } from '../utils/ticket-cancel.util';

/**
 * Locks the booking's trip (and its linked trip) before the booking itself. Trip-wide actions such as cancelling a trip
 * lock the trips first and then each booking, so taking them the other way round here could deadlock against them.
 * The trip is read without a lock first, then checked again once the booking is locked.
 */
export async function lockBookingWithTrip(tx: Prisma.TransactionClient, bookingId: string) {
  const found = await tx.booking.findUnique({ where: { id: bookingId }, select: { tripId: true } });
  if (!found) throw new NotFoundException('Booking not found');
  await lockTripsWithLinked(tx, [found.tripId]);
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
  const locked = await tx.booking.findUnique({ where: { id: bookingId }, select: { tripId: true } });
  if (!locked) throw new NotFoundException('Booking not found');
  if (locked.tripId !== found.tripId) throw new ConflictException('تغيّرت رحلة هذا الحجز للتو، حاول مرة أخرى');
  return locked.tripId;
}

interface CancelOptions {
  /** SAR given back; defaults to everything the customer paid. */
  refundAmount?: number;
  /** ORIGINAL leaves a refund for staff to execute instead of crediting the wallet. */
  refundDestination?: RefundDestination;
  /** Written by the reviewer for the customer to read in the notification. */
  customerNote?: string;
  reviewedById?: string;
  note?: string;
  ip?: string;
  /** A whole trip being cancelled reads differently to the customer than one booking being cancelled. */
  notifyAs?: 'BOOKING_CANCELLED' | 'TRIP_CANCELLED';
}

@Injectable()
export class BookingCancellationService {
  constructor(
    private wallet: WalletService,
    private events: BookingEventsService,
    private loyalty: LoyaltyService,
    private rooms: RoomAllocationService,
    private notifications: NotificationsService,
    private invoices: InvoiceLedgerService,
    private ledger: PaymentLedgerService,
    private waitlist: WaitlistService,
  ) {}

  /** Frees the seats, refunds to the wallet and marks the booking cancelled. Run inside a transaction. */
  async cancel(tx: Prisma.TransactionClient, bookingId: string, options: CancelOptions = {}) {
    // Without the lock, two simultaneous cancellations would both pass the checks and refund twice.
    await lockBookingWithTrip(tx, bookingId);
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { passengers: true, payment: true, compensation: { select: { amount: true } }, collections: { select: { amount: true, method: true, branchId: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('هذا الحجز ملغى مسبقًا');
    }
    if (booking.status === 'BOARDED') {
      throw new BadRequestException('لا يمكن إلغاء حجز تم صعود ركابه');
    }
    const boarded = await tx.ticket.count({ where: { bookingId, isBoarded: true } });
    if (boarded > 0) {
      throw new BadRequestException('لا يمكن إلغاء حجز صعد بعض ركابه');
    }

    // Only money actually received can go back, or cancelling an unpaid booking would credit a wallet for free.
    const { received, wallet } = paymentFigures(booking.payment, booking.collections);
    // What was already paid out as compensation is not paid out a second time as a refund, and what tickets cancelled
    // on their own already gave back or kept as a fee is not this booking's to give back again.
    const taken = await cancelledTicketsTake(tx, bookingId);
    const paid = Math.max(0, received + wallet - halalas(booking.compensation?.amount ?? 0) - taken) / 100;
    const refund = options.refundAmount ?? paid;
    if (refund < 0 || refund > paid) {
      throw new BadRequestException(`مبلغ الاسترداد يجب أن يكون بين 0 و ${paid.toFixed(2)} ر.س`);
    }

    const toOriginal = options.refundDestination === 'ORIGINAL';
    if (toOriginal && refund > 0 && received === 0) {
      throw new BadRequestException('دُفع هذا الحجز من المحفظة، فلا يعود مبلغه إلا إليها');
    }
    const split = toOriginal ? splitOriginalRefund(halalas(refund), Math.max(0, received - taken), booking.collections) : { wallet: halalas(refund), cash: 0, external: 0 };
    const walletRefund = split.wallet / 100;

    // A passenger whose ticket was cancelled on its own already gave back its seat and place.
    const live = booking.passengers.filter((p) => !p.cancelled);
    // A passenger saved without a seat holds a place on the trip but no seat on the plan.
    const seatNumbers = live.map((p) => p.seatNumber).filter((seat): seat is string => !!seat);
    await lockTripsWithLinked(tx, [booking.tripId]);
    await tx.seat.updateMany({
      where: { tripId: booking.tripId, seatNumber: { in: seatNumbers } },
      data: { isBooked: false, heldByUserId: null, heldUntil: null },
    });
    await tx.trip.update({
      where: { id: booking.tripId },
      data: { availableSeats: { increment: live.length } },
    });
    await releaseLinkedSeats(tx, booking.tripId, seatNumbers);
    // The places its seatless passengers held on the linked trip, unless it rode another leg and so held none there.
    // A ذهاب فقط held none there either.
    if (ridesBack(booking.kind) && !(await hasOtherLeg(tx, booking))) await releaseLinkedPlaces(tx, booking.tripId, live.length - seatNumbers.length);
    await this.returnHomeOnOwnTrip(tx, booking);
    // The freed seats go first to whoever is waiting for this trip; a whole trip being cancelled has nothing to offer.
    if (options.notifyAs !== 'TRIP_CANCELLED') await this.waitlist.offerFreedSeats(tx, booking.tripId);

    if (walletRefund > 0) {
      // What the booking spent of transport-only credit goes back as transport-only, so a cancellation never turns
      // a compensation or promotional credit into money that can pay for a stay.
      const transportBack = Math.min(walletRefund, Number(booking.payment?.walletTransportAmount ?? 0));
      if (transportBack > 0 && booking.payment) {
        await tx.payment.update({ where: { id: booking.payment.id }, data: { walletTransportAmount: { decrement: transportBack } } });
      }
      await this.wallet.apply(tx, {
        userId: booking.userId,
        amount: walletRefund,
        transportAmount: transportBack,
        type: 'REFUND',
        description: `استرداد إلغاء الحجز ${booking.bookingReference}`,
        bookingId: booking.id,
        createdById: options.reviewedById,
      });
      await this.ledger.walletRefund(tx, { bookingId: booking.id, amount: walletRefund, actorId: options.reviewedById });
    }
    const pendingRefunds = [];
    if (split.external > 0) {
      const nonCash = [...new Set(booking.collections.filter((row) => row.method !== 'CASH').map((row) => row.method.toLowerCase()))];
      const method = nonCash.length > 1 ? 'mixed' : nonCash[0] ?? booking.payment?.method ?? null;
      pendingRefunds.push(await this.ledger.pendingRefund(tx, { bookingId: booking.id, amount: split.external / 100, method }));
    }
    if (split.cash > 0) {
      const branchId = [...booking.collections].reverse().find((row) => row.method === 'CASH')?.branchId ?? booking.branchId;
      pendingRefunds.push(await this.ledger.pendingRefund(tx, { bookingId: booking.id, amount: split.cash / 100, method: 'cash', branchId }));
    }

    // A cancelled traveller's bed goes back on sale.
    await tx.bookingPassenger.updateMany({ where: { bookingId }, data: { hotelRoomId: null, roomNote: null } });
    await this.rooms.tidyEmptyRooms(tx, booking.passengers.map((p) => p.hotelRoomId).filter((id): id is string => !!id));

    await this.loyalty.restoreForCancelledBooking(tx, booking);
    // Points were credited when it was paid; a cancelled booking keeps none, whatever share of the money it keeps.
    await this.loyalty.withdrawEarned(tx, booking.id, { cancelled: true });
    await this.releaseVoucher(tx, booking);

    await this.events.record(tx, {
      bookingId: booking.id,
      action: 'CANCELLED',
      actorId: options.reviewedById,
      reason: options.note,
      before: { status: booking.status },
      after: { status: 'CANCELLED', refundAmount: walletRefund, originalRefund: (split.external + split.cash) / 100, seats: seatNumbers },
      ip: options.ip,
    });
    if (pendingRefunds.length > 0) {
      const amount = formatSar((split.external + split.cash) / 100);
      await this.notifications.toBookingOwners(tx, 'BOOKING_CANCELLED_REFUND_PENDING', [booking.id], { amount, refundAmount: formatSar(walletRefund), reviewNote: options.customerNote });
      await this.notifications.toStaffAboutBooking(tx, 'STAFF_REFUND_PENDING', ['refunds.execute'], booking.id, {
        exceptUserId: options.reviewedById,
        extra: { amount, refundMethod: pendingRefunds.map((row) => refundMethodLabel(row.method)).join(' و') },
      });
    } else {
      await this.notifications.toBookingOwners(tx, options.notifyAs ?? 'BOOKING_CANCELLED', [booking.id], { refundAmount: formatSar(walletRefund), reviewNote: options.customerNote });
    }

    // Only what the company keeps stays a sale; the unpaid part and the refund both come off the invoice.
    // Money still on its way back stays here until a refund is executed, which issues its own credit note.
    // Counted over the booking's whole life, so what cancelled tickets and compensations already credited is not credited twice.
    // Cancelled before its invoice was issued: none is issued now, and so there is no credit note either.
    const invoice = await tx.invoice.findUnique({ where: { bookingId: booking.id }, select: { id: true, total: true } });
    if (invoice) {
      const notes = await tx.creditNote.aggregate({ where: { invoiceId: invoice.id }, _sum: { total: true } });
      const cashRefunded = await tx.cashMovement.aggregate({ where: { bookingId: booking.id, type: 'BOOKING_REFUND' }, _sum: { amount: true } });
      const { held } = netBookingFigures({
        status: 'CANCELLED',
        refundAmount: halalas(booking.refundAmount ?? 0) / 100 + walletRefund,
        externalRefunded: booking.externalRefunded,
        payment: booking.payment,
        collections: booking.collections,
        cashMovements: [{ amount: cashRefunded._sum.amount ?? 0 }],
      });
      const kept = held - halalas(booking.compensation?.amount ?? 0);
      await this.invoices.credit(tx, {
        bookingId: booking.id,
        amount: halalas(invoice.total) - kept - halalas(notes._sum.total ?? 0),
        reason: options.note ?? 'إلغاء الحجز',
        actorId: options.reviewedById,
      });
    }

    // Its tickets read ملغية, with this cancellation as their record; one cancelled on its own keeps its own.
    const reviewer = options.reviewedById ? await tx.user.findUnique({ where: { id: options.reviewedById }, select: { name: true } }) : null;
    await tx.ticket.updateMany({
      where: { bookingId: booking.id, status: 'CONFIRMED' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: options.reviewedById ?? null, cancelledByName: reviewer?.name ?? null, cancelReason: options.note ?? booking.cancelReason ?? null },
    });

    return tx.booking.update({
      where: { id: booking.id },
      data: {
        status: 'CANCELLED',
        // Added to what cancelled tickets already credited to the wallet, as a refund moved to the wallet later adds to it.
        refundAmount: { increment: walletRefund },
        cancelReviewedById: options.reviewedById,
        cancelReviewedAt: new Date(),
        cancelReviewNote: options.note,
        cancelCustomerNote: options.customerNote ?? null,
      },
    });
  }

  /**
   * Cancels one passenger's ticket and leaves the rest of the booking travelling. The seat (and its place on a linked return)
   * goes back on sale, the bed is freed, and the ticket's share of what was paid is refunded as staff decide; the unpaid rest
   * of its price is no longer owed. The last active ticket is the booking itself, so that one cancels the whole booking.
   * Run inside a transaction. Final: a cancelled ticket never comes back.
   */
  async cancelTicket(tx: Prisma.TransactionClient, bookingId: string, passengerId: string, options: Omit<CancelOptions, 'notifyAs' | 'customerNote'> & { note: string }) {
    await lockBookingWithTrip(tx, bookingId);
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { passengers: { include: { ticket: true } }, payment: true, collections: { select: { amount: true, method: true, branchId: true }, orderBy: { createdAt: 'asc' } } },
    });
    const passenger = booking.passengers.find((p) => p.id === passengerId);
    if (!passenger || !passenger.ticket) throw new NotFoundException('التذكرة غير موجودة في هذا الحجز');
    if (passenger.cancelled || passenger.ticket.status === 'CANCELLED') throw new BadRequestException('هذه التذكرة ملغاة مسبقًا');
    if (booking.status !== 'CONFIRMED') throw new BadRequestException('لا تُلغى تذكرة إلا من حجز مؤكد');
    if (passenger.ticket.isBoarded || passenger.ticket.returnBoardedAt) throw new BadRequestException('لا يمكن إلغاء تذكرة راكب صعد الحافلة');
    const ticket = passenger.ticket;

    const live = booking.passengers.filter((p) => !p.cancelled);
    if (live.length <= 1) {
      await this.cancel(tx, bookingId, { refundAmount: options.refundAmount, refundDestination: options.refundDestination, reviewedById: options.reviewedById, note: options.note, ip: options.ip });
      return tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    }

    // The invoice holds the price the booking was sold at, which a ticket's share is worked out from.
    await this.invoices.ensure(tx, bookingId);
    const figures = await ticketCancelFigures(tx, bookingId);
    const refund = halalas(options.refundAmount ?? figures.paidShare / 100);
    if (refund < 0 || refund > figures.paidShare) {
      throw new BadRequestException(`مبلغ الاسترداد يجب أن يكون بين 0 و ${(figures.paidShare / 100).toFixed(2)} ر.س`);
    }
    const { wallet: paidFromWallet } = paymentFigures(booking.payment, booking.collections);
    const toOriginal = options.refundDestination === 'ORIGINAL';
    const receivedLeft = Math.max(0, figures.received - figures.taken);
    if (toOriginal && refund > 0 && receivedLeft === 0 && paidFromWallet > 0) {
      throw new BadRequestException('دُفع هذا الحجز من المحفظة، فلا يعود مبلغه إلا إليها');
    }
    const split = toOriginal ? splitOriginalRefund(refund, receivedLeft, booking.collections) : { wallet: refund, cash: 0, external: 0 };
    const walletRefund = split.wallet / 100;

    // The seat goes back on sale here and, on a round trip, on its reverse; a seatless passenger gives back their place.
    const seat = passenger.seatNumber;
    await lockTripsWithLinked(tx, [booking.tripId]);
    if (seat) {
      await tx.seat.updateMany({ where: { tripId: booking.tripId, seatNumber: seat }, data: { isBooked: false, heldByUserId: null, heldUntil: null } });
      await releaseLinkedSeats(tx, booking.tripId, [seat]);
    } else if (ridesBack(booking.kind) && !(await hasOtherLeg(tx, booking))) {
      await releaseLinkedPlaces(tx, booking.tripId, 1);
    }
    await tx.trip.update({ where: { id: booking.tripId }, data: { availableSeats: { increment: 1 } } });
    await this.waitlist.offerFreedSeats(tx, booking.tripId);

    if (walletRefund > 0) {
      const transportBack = Math.min(walletRefund, Number(booking.payment?.walletTransportAmount ?? 0));
      if (transportBack > 0 && booking.payment) {
        await tx.payment.update({ where: { id: booking.payment.id }, data: { walletTransportAmount: { decrement: transportBack } } });
      }
      await this.wallet.apply(tx, {
        userId: booking.userId,
        amount: walletRefund,
        transportAmount: transportBack,
        type: 'REFUND',
        description: `استرداد إلغاء تذكرة ${passenger.fullName} من الحجز ${booking.bookingReference}`,
        bookingId: booking.id,
        createdById: options.reviewedById,
      });
      await this.ledger.walletRefund(tx, { bookingId: booking.id, amount: walletRefund, actorId: options.reviewedById });
    }
    const pendingRefunds = [];
    if (split.external > 0) {
      const nonCash = [...new Set(booking.collections.filter((row) => row.method !== 'CASH').map((row) => row.method.toLowerCase()))];
      const method = nonCash.length > 1 ? 'mixed' : nonCash[0] ?? booking.payment?.method ?? null;
      pendingRefunds.push(await this.ledger.pendingRefund(tx, { bookingId: booking.id, amount: split.external / 100, method }));
    }
    if (split.cash > 0) {
      const branchId = [...booking.collections].reverse().find((row) => row.method === 'CASH')?.branchId ?? booking.branchId;
      pendingRefunds.push(await this.ledger.pendingRefund(tx, { bookingId: booking.id, amount: split.cash / 100, method: 'cash', branchId }));
    }

    // The booking now sells one ticket fewer: what was given back and what was never paid leave its price, and the unpaid
    // part leaves what is owed. What the company kept of the ticket's paid share stays a sale.
    await tx.booking.update({
      where: { id: booking.id },
      data: {
        totalPrice: { decrement: (refund + figures.debtCut) / 100 },
        refundAmount: { increment: walletRefund },
      },
    });
    if (figures.debtCut > 0 && booking.payment) {
      await tx.payment.update({ where: { id: booking.payment.id }, data: { amount: { decrement: figures.debtCut / 100 } } });
    }
    // Money still on its way back stays on the invoice until that refund is executed, which issues its own credit note.
    await this.invoices.credit(tx, { bookingId: booking.id, amount: split.wallet + figures.debtCut, reason: `إلغاء تذكرة ${passenger.fullName}: ${options.note}`, actorId: options.reviewedById });

    await tx.bookingPassenger.update({ where: { id: passenger.id }, data: { cancelled: true, seatNumber: null, hotelRoomId: null, roomNote: null } });
    if (passenger.hotelRoomId) await this.rooms.tidyEmptyRooms(tx, [passenger.hotelRoomId]);

    const reviewer = options.reviewedById ? await tx.user.findUnique({ where: { id: options.reviewedById }, select: { name: true } }) : null;
    const updated = await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: options.reviewedById ?? null,
        cancelledByName: reviewer?.name ?? null,
        cancelReason: options.note,
        cancelledSeatNumber: seat,
        refundAmount: refund / 100,
        keptAmount: (figures.paidShare - refund) / 100,
      },
    });

    await this.events.record(tx, {
      bookingId: booking.id,
      action: 'TICKET_CANCELLED',
      actorId: options.reviewedById,
      reason: options.note,
      before: { passenger: passenger.fullName, ticket: ticket.ticketNumber, seat, status: 'CONFIRMED' },
      after: { status: 'CANCELLED', refundAmount: walletRefund, originalRefund: (split.external + split.cash) / 100, kept: (figures.paidShare - refund) / 100, unpaidRemoved: figures.debtCut / 100 },
      ip: options.ip,
    });
    await this.notifications.toBookingOwners(tx, 'TICKET_CANCELLED', [booking.id], {
      passengerName: passenger.fullName,
      refundAmount: formatSar(walletRefund),
      amount: formatSar((split.external + split.cash) / 100),
      reviewNote: options.note,
    });
    if (pendingRefunds.length > 0) {
      await this.notifications.toStaffAboutBooking(tx, 'STAFF_REFUND_PENDING', ['refunds.execute'], booking.id, {
        exceptUserId: options.reviewedById,
        extra: { amount: formatSar((split.external + split.cash) / 100), refundMethod: pendingRefunds.map((row) => refundMethodLabel(row.method)).join(' و') },
      });
    }
    return updated;
  }

  /** Cancelling gives back the use the booking took, for a points voucher and a marketing coupon alike. */
  /**
   * Cancelling the return leg of a journey sends its round-trip outbound home on that trip's own reverse again, so the
   * outbound's seats there are taken back. Seats a return-only passenger bought meanwhile stay theirs.
   */
  private async returnHomeOnOwnTrip(tx: Prisma.TransactionClient, booking: { id: string; groupReference: string | null }) {
    if (!booking.groupReference) return;
    const legs = await tx.booking.findMany({
      where: { groupReference: booking.groupReference, id: { not: booking.id }, status: { in: ['CONFIRMED', 'PENDING_CANCELLATION_REVIEW'] } },
      select: { id: true, tripId: true, kind: true, passengers: { select: { seatNumber: true } }, trip: { select: { direction: true, reverseOfTripId: true } } },
    });
    // Only a lone remaining leg rides back on its own trip; with two legs left, the journey still returns elsewhere.
    if (legs.length !== 1) return;
    const [outbound] = legs;
    if (outbound.trip.direction !== 'ROUND_TRIP' || outbound.trip.reverseOfTripId || !ridesBack(outbound.kind)) return;
    await lockTripsWithLinked(tx, [outbound.tripId]);
    await retakeReturnSeats(tx, outbound.tripId, outbound.passengers.map((passenger) => passenger.seatNumber).filter((seat): seat is string => !!seat));
    // Its passengers without a seat number come back too, on whatever places are left there.
    await takeLinkedPlaces(tx, outbound.tripId, outbound.passengers.filter((passenger) => !passenger.seatNumber).length, { soft: true });
  }

  private async releaseVoucher(tx: Prisma.TransactionClient, booking: { id: string; couponId: string | null; groupReference: string | null }) {
    if (!booking.couponId) return;
    // A round trip is one use across two bookings, so it comes back only with the last of them.
    // Without a group the booking stands alone; counting by a null group would match other customers' bookings.
    const stillActive = booking.groupReference
      ? await tx.booking.count({
          where: { couponId: booking.couponId, groupReference: booking.groupReference, id: { not: booking.id }, status: { not: 'CANCELLED' } },
        })
      : 0;
    if (stillActive === 0) await tx.coupon.updateMany({ where: { id: booking.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }
}

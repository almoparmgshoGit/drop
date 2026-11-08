import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RefundDestination } from '@prisma/client';
import { BookingEventsService } from './booking-events.service';
import { LoyaltyService } from './loyalty.service';
import { formatSar, NotificationsService } from './notifications.service';
import { RoomAllocationService } from './room-allocation.service';
import { WalletService } from './wallet.service';
import { InvoiceLedgerService } from './invoice-ledger.service';
import { PaymentLedgerService, refundMethodLabel } from './payment-ledger.service';
import { lockTripsWithLinked, releaseLinkedSeats } from '../utils/linked-seats.util';
import { halalas, paymentFigures, splitOriginalRefund } from '../utils/payment.util';

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
    // What was already paid out as compensation is not paid out a second time as a refund.
    const paid = Math.max(0, received + wallet - halalas(booking.compensation?.amount ?? 0)) / 100;
    const refund = options.refundAmount ?? paid;
    if (refund < 0 || refund > paid) {
      throw new BadRequestException(`مبلغ الاسترداد يجب أن يكون بين 0 و ${paid.toFixed(2)} ر.س`);
    }

    const toOriginal = options.refundDestination === 'ORIGINAL';
    if (toOriginal && refund > 0 && received === 0) {
      throw new BadRequestException('دُفع هذا الحجز من المحفظة، فلا يعود مبلغه إلا إليها');
    }
    const split = toOriginal ? splitOriginalRefund(halalas(refund), received, booking.collections) : { wallet: halalas(refund), cash: 0, external: 0 };
    const walletRefund = split.wallet / 100;

    const seatNumbers = booking.passengers.map((p) => p.seatNumber);
    await lockTripsWithLinked(tx, [booking.tripId]);
    await tx.seat.updateMany({
      where: { tripId: booking.tripId, seatNumber: { in: seatNumbers } },
      data: { isBooked: false, heldByUserId: null, heldUntil: null },
    });
    await tx.trip.update({
      where: { id: booking.tripId },
      data: { availableSeats: { increment: seatNumbers.length } },
    });
    await releaseLinkedSeats(tx, booking.tripId, seatNumbers);

    if (walletRefund > 0) {
      await this.wallet.apply(tx, {
        userId: booking.userId,
        amount: walletRefund,
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
    const kept = received + wallet - split.wallet;
    await this.invoices.credit(tx, { bookingId: booking.id, amount: halalas(booking.totalPrice) - kept, reason: options.note ?? 'إلغاء الحجز', actorId: options.reviewedById });

    return tx.booking.update({
      where: { id: booking.id },
      data: {
        status: 'CANCELLED',
        refundAmount: walletRefund,
        cancelReviewedById: options.reviewedById,
        cancelReviewedAt: new Date(),
        cancelReviewNote: options.note,
        cancelCustomerNote: options.customerNote ?? null,
      },
    });
  }

  /** Cancelling gives back the use the booking took, for a points voucher and a marketing coupon alike. */
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

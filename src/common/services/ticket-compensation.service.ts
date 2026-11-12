import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { returnRideOf } from '../utils/linked-seats.util';
import { halalas, PAID_PAYMENT_STATUSES, paymentFigures } from '../utils/payment.util';
import { boardingOfBookings } from '../utils/ticket-boarding.util';
import { AppSettingsService } from './app-settings.service';
import { BookingEventsService } from './booking-events.service';
import { InvoiceLedgerService } from './invoice-ledger.service';
import { formatSar, NotificationsService } from './notifications.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PrismaService } from './prisma.service';
import { LoyaltyService } from './loyalty.service';
import { WalletService } from './wallet.service';

const AUTOMATIC_BATCH = 200;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const BOOKING_SELECT = {
  id: true,
  userId: true,
  tripId: true,
  status: true,
  bookingReference: true,
  boardingPointId: true,
  boardingPointName: true,
  payment: { select: { amount: true, walletAmount: true, status: true } },
  collections: { select: { amount: true } },
  passengers: { select: { ticket: { select: { isBoarded: true } } } },
  compensation: { select: { amount: true, isAutomatic: true, note: true, createdByName: true, createdAt: true } },
} satisfies Prisma.BookingSelect;

type Db = Prisma.TransactionClient;
type Actor = { userId: string; permissions: string[]; name?: string | null };

@Injectable()
export class TicketCompensationService {
  private readonly logger = new Logger(TicketCompensationService.name);

  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private wallet: WalletService,
    private events: BookingEventsService,
    private notifications: NotificationsService,
    private ledger: PaymentLedgerService,
    private invoices: InvoiceLedgerService,
    private loyalty: LoyaltyService,
  ) {}

  /** The most that can be given is what was paid for those who did not travel, so a part-boarded booking gets only their share. */
  private async assess(db: Db, bookingId: string, percent: number) {
    const booking = await db.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    const boarding = (await boardingOfBookings(db, [booking])).get(bookingId) ?? null;
    const { received, wallet } = paymentFigures(booking.payment, booking.collections);
    const total = booking.passengers.length;
    const missed = booking.passengers.filter((passenger) => !passenger.ticket?.isBoarded).length;
    const capHalalas = total > 0 ? Math.round(((received + wallet) * missed) / total) : 0;
    const isRoundTrip = !!(await returnRideOf(db, booking));

    let blockedReason: string | null = null;
    if (booking.compensation) blockedReason = 'تم تعويض هذا الحجز مسبقًا';
    else if (booking.status !== 'CONFIRMED') blockedReason = 'يُعوَّض الحجز المؤكد فقط، وأي طلب إلغاء قائم يُبت فيه أولًا';
    else if (boarding?.state !== 'STOPPED') blockedReason = 'التذكرة ليست موقوفة، فما زال بإمكان العميل الصعود';
    else if (capHalalas <= 0) blockedReason = 'لم يُدفع شيء عن هذا الحجز';

    return { booking, capHalalas, suggestedHalalas: Math.round((capHalalas * percent) / 100), isRoundTrip, blockedReason };
  }

  async quote(bookingId: string) {
    const percent = await this.appSettings.number('ticketCompensationPercent');
    const { booking, capHalalas, suggestedHalalas, isRoundTrip, blockedReason } = await this.assess(this.prisma, bookingId, percent);
    return {
      isEligible: !blockedReason,
      blockedReason,
      percent,
      cap: capHalalas / 100,
      suggested: suggestedHalalas / 100,
      isRoundTrip,
      compensation: booking.compensation,
    };
  }

  private async give(tx: Db, booking: { id: string; userId: string; bookingReference: string }, amount: number, details: { actor?: Actor; note?: string; ip?: string }) {
    // The unique booking id is what finally stops a second compensation, even from two people at once.
    await tx.ticketCompensation.create({
      data: {
        bookingId: booking.id,
        userId: booking.userId,
        amount,
        isAutomatic: !details.actor,
        note: details.note,
        createdById: details.actor?.userId,
        createdByName: details.actor?.name ?? null,
      },
    });
    const walletBalance = await this.wallet.apply(tx, {
      userId: booking.userId,
      amount,
      type: 'COMPENSATION',
      description: `تعويض عن الحجز ${booking.bookingReference}`,
      bookingId: booking.id,
      createdById: details.actor?.userId,
    });
    // Money handed back to the customer, so the books record it like any refund to the wallet.
    await this.ledger.walletRefund(tx, { bookingId: booking.id, amount, actorId: details.actor?.userId });
    await tx.booking.update({ where: { id: booking.id }, data: { refundAmount: { increment: amount } } });
    // Points were credited on the whole payment; the share now handed back takes its points with it.
    await this.loyalty.withdrawEarned(tx, booking.id);
    await this.invoices.credit(tx, { bookingId: booking.id, amount: halalas(amount), reason: 'تعويض تذكرة موقوفة', actorId: details.actor?.userId });
    await this.events.record(tx, {
      bookingId: booking.id,
      action: 'COMPENSATED',
      actorId: details.actor?.userId,
      reason: details.note,
      after: { amount, isAutomatic: !details.actor },
      ip: details.ip,
    });
    await this.notifications.toBookingOwners(tx, 'TICKET_COMPENSATED', [booking.id], { amount: formatSar(amount), walletBalance: formatSar(walletBalance) });
    return walletBalance;
  }

  /** An employee's decision: the policy suggests the amount, and going above it takes the same permission as a refund above policy. */
  async compensate(actor: Actor, bookingId: string, dto: { amount?: number; note: string }, ip?: string) {
    const percent = await this.appSettings.number('ticketCompensationPercent');
    return this.prisma.$transaction(async (tx) => {
      await this.events.lock(tx, bookingId);
      const { booking, capHalalas, suggestedHalalas, blockedReason } = await this.assess(tx, bookingId, percent);
      if (blockedReason) throw new ConflictException(blockedReason);
      if (booking.userId === actor.userId && !actor.permissions.includes('wallet.adjust_self')) {
        throw new ForbiddenException('لا يمكنك تعويض حجزك بنفسك');
      }

      const amountHalalas = dto.amount === undefined ? suggestedHalalas : Math.round(dto.amount * 100);
      if (amountHalalas <= 0) throw new ConflictException('حدد مبلغ التعويض');
      if (amountHalalas > capHalalas) throw new ConflictException(`لا يتجاوز التعويض ما دُفع عن من لم يسافر: ${(capHalalas / 100).toFixed(2)} ر.س`);
      // A policy of 0% suggests nothing, so any amount at all is above it.
      if (amountHalalas > suggestedHalalas && !actor.permissions.includes('refunds.override_policy')) {
        throw new ForbiddenException(`الحد المسموح لك وفق نسبة التعويض هو ${(suggestedHalalas / 100).toFixed(2)} ر.س`);
      }

      const amount = amountHalalas / 100;
      const walletBalance = await this.give(tx, booking, amount, { actor, note: dto.note.trim(), ip });
      return { amount, walletBalance: Number(walletBalance) };
    }, TX_OPTIONS);
  }

  /**
   * Only when the panel's switch is on, and only once a trip has finished, so a crew's mistaken status can never pay anyone.
   * A trip nobody was scanned on is left to staff, because that points at the crew or the scanner rather than at no-shows.
   * Round trips are left too: nothing says how much of what was paid belongs to the way out.
   */
  async compensateFinishedTrips() {
    if (!(await this.appSettings.flag('ticketCompensationAutomatic'))) return 0;
    const percent = await this.appSettings.number('ticketCompensationPercent');
    if (percent <= 0) return 0;
    // Turning the switch on must not pay out for every trip already in the past.
    const switchedOnAt = (await this.prisma.setting.findUnique({ where: { key: 'ticketCompensationAutomatic' } }))?.updatedAt;
    if (!switchedOnAt) return 0;

    // What assess() would skip is left out here, or the same skipped bookings would fill every batch and starve the rest.
    const where: Prisma.BookingWhereInput = {
      status: 'CONFIRMED',
      compensation: { is: null },
      tickets: { some: { isBoarded: false } },
      user: { blockedAt: null },
      trip: { tripStatus: 'COMPLETED', arrivalTime: { gte: switchedOnAt }, bookings: { some: { tickets: { some: { isBoarded: true } } } } },
      // Nothing paid means nothing to give back.
      OR: [
        { payment: { status: { in: PAID_PAYMENT_STATUSES } } },
        { payment: { walletAmount: { gt: 0 } } },
        { collections: { some: { amount: { gt: 0 } } } },
      ],
      // A round trip riding back on a live reverse. One in a group may have its own return leg elsewhere, so assess() decides those.
      NOT: { groupReference: null, trip: { direction: 'ROUND_TRIP', reverseTrip: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } } } },
    };

    let paid = 0;
    let cursor: string | undefined;
    for (;;) {
      // Paging by id moves past whatever assess() still refuses, so nothing is stuck at the head of the queue.
      const due = await this.prisma.booking.findMany({
        where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: AUTOMATIC_BATCH,
      });
      paid += await this.payBatch(due.map((row) => row.id), percent);
      if (due.length < AUTOMATIC_BATCH) break;
      cursor = due[due.length - 1].id;
    }
    return paid;
  }

  private async payBatch(ids: string[], percent: number) {
    let paid = 0;
    for (const id of ids) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          await this.events.lock(tx, id);
          const { booking, suggestedHalalas, isRoundTrip, blockedReason } = await this.assess(tx, id, percent);
          if (blockedReason || isRoundTrip || suggestedHalalas <= 0) return false;
          await this.give(tx, booking, suggestedHalalas / 100, {});
          return true;
        }, TX_OPTIONS);
        if (done) paid += 1;
      } catch (err) {
        // One booking's failure must not stop the others, and the next sweep tries it again.
        this.logger.error(`Automatic compensation failed for booking ${id}: ${(err as Error).message}`);
      }
    }
    return paid;
  }
}

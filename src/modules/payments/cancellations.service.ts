import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PaymentLedgerService, refundMethodLabel, transactionCode } from '../../common/services/payment-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { WalletService } from '../../common/services/wallet.service';
import { applicableRule, daysUntil, parseCancellationRules } from '../../common/utils/cancellation-policy.util';
import { halalas, paymentFigures } from '../../common/utils/payment.util';
import { startOfRiyadhMonth } from '../../common/utils/time.util';
import { bookingTypeLabel } from '../../common/utils/booking-kinds.util';
import { CashActor, CashService } from '../cash/cash.service';
import { CancellationsQuery, CancellationTab, ExecuteRefundDto, MoveRefundToWalletDto, PAGE_SIZE } from './payments.dto';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const sar = (value: number) => Math.round(value) / 100;

const TAB_WHERE: Record<CancellationTab, Prisma.BookingWhereInput> = {
  review: { status: 'PENDING_CANCELLATION_REVIEW' },
  refunding: { paymentTransactions: { some: { type: 'REFUND', status: 'PENDING' } } },
  // Cancelling a booking directly or through its trip was nobody's request, so it is not listed here.
  finished: {
    cancelRequestedAt: { not: null },
    cancelReviewedAt: { not: null },
    status: { not: 'PENDING_CANCELLATION_REVIEW' },
    paymentTransactions: { none: { type: 'REFUND', status: 'PENDING' } },
  },
};

const TAB_ORDER: Record<CancellationTab, Prisma.BookingOrderByWithRelationInput> = {
  // The longest waiting is answered first.
  review: { cancelRequestedAt: 'asc' },
  refunding: { cancelReviewedAt: 'asc' },
  finished: { cancelReviewedAt: 'desc' },
};

type PaymentFields = { payment: { amount: Prisma.Decimal; walletAmount: Prisma.Decimal; status: string } | null; collections: { amount: Prisma.Decimal }[] };

const paidOf = (booking: PaymentFields) => {
  const { received, wallet } = paymentFigures(booking.payment, booking.collections);
  return { received: sar(received), wallet: sar(wallet), paid: sar(received + wallet) };
};

const toRefund = (row: Prisma.PaymentTransactionGetPayload<object>) => ({
  id: row.id,
  code: transactionCode(row),
  status: row.status,
  destination: row.destination,
  method: row.method,
  amount: Number(row.amount),
  gatewayReference: row.gatewayReference,
  failureReason: row.failureReason,
  processedByName: row.processedByName,
  processedAt: row.processedAt,
  createdAt: row.createdAt,
});

@Injectable()
export class CancellationsService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
    private events: BookingEventsService,
    private invoices: InvoiceLedgerService,
    private notifications: NotificationsService,
    private wallet: WalletService,
    private ledger: PaymentLedgerService,
  ) {}

  async counts() {
    const [review, refunding, finished, reviewedThisMonth] = await Promise.all([
      this.prisma.booking.count({ where: TAB_WHERE.review }),
      this.prisma.booking.count({ where: TAB_WHERE.refunding }),
      this.prisma.booking.count({ where: TAB_WHERE.finished }),
      this.prisma.booking.count({ where: { cancelRequestedAt: { not: null }, cancelReviewedAt: { gte: startOfRiyadhMonth() } } }),
    ]);
    return { review, refunding, finished, reviewedThisMonth };
  }

  async list(query: CancellationsQuery) {
    const tab = query.tab ?? 'review';
    const page = query.page ?? 1;
    const where = TAB_WHERE[tab];
    const [rows, total, counts] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: TAB_ORDER[tab],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          bookingReference: true,
          status: true,
          cancelRequestedAt: true,
          cancelReviewedAt: true,
          kind: true,
          serviceType: true,
          user: { select: { name: true } },
          trip: { select: { origin: true, destination: true, departureTime: true, bookingType: true } },
          payment: { select: { amount: true, walletAmount: true, status: true } },
          collections: { select: { amount: true } },
          paymentTransactions: { where: { type: 'REFUND', status: { in: ['PENDING', 'SUCCEEDED'] } }, select: { amount: true } },
        },
      }),
      this.prisma.booking.count({ where }),
      this.counts(),
    ]);
    return {
      counts,
      total,
      page,
      items: rows.map((booking) => ({
        id: booking.id,
        reference: booking.bookingReference,
        status: booking.status,
        customerName: booking.user.name,
        trip: booking.trip,
        typeLabel: bookingTypeLabel(booking),
        requestedAt: booking.cancelRequestedAt,
        reviewedAt: booking.cancelReviewedAt,
        paid: paidOf(booking).paid,
        refunded: sar(booking.paymentTransactions.reduce((sum, row) => sum + halalas(row.amount), 0)),
      })),
    };
  }

  async details(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        trip: { select: { tripCode: true, origin: true, destination: true, departureTime: true, bookingType: true } },
        passengers: { select: { id: true } },
        payment: true,
        collections: { select: { amount: true } },
        paymentTransactions: { where: { type: 'REFUND' }, orderBy: { number: 'asc' } },
      },
    });
    if (!booking) throw new NotFoundException('الحجز غير موجود');

    const [charge, settings, reviewer] = await Promise.all([
      this.prisma.paymentTransaction.findFirst({ where: { bookingId, type: 'CHARGE', status: 'SUCCEEDED' }, orderBy: { number: 'asc' } }),
      this.prisma.setting.findMany({ where: { key: { in: ['cancellationPolicy', 'cancellationRules'] } } }),
      booking.cancelReviewedById ? this.prisma.user.findUnique({ where: { id: booking.cancelReviewedById }, select: { name: true } }) : null,
    ]);
    const setting = (key: string) => settings.find((row) => row.key === key)?.value;

    // Notice is counted from the request, so a slow review never costs the customer a better percentage.
    const rules = parseCancellationRules(setting('cancellationRules'));
    const daysLeft = daysUntil(booking.trip.departureTime, booking.cancelRequestedAt ?? new Date());
    const rule = applicableRule(rules, daysLeft);
    const { received, wallet, paid } = paidOf(booking);

    return {
      id: booking.id,
      reference: booking.bookingReference,
      status: booking.status,
      source: booking.source,
      customer: booking.user,
      trip: booking.trip,
      typeLabel: bookingTypeLabel(booking),
      seats: booking.passengers.length,
      cancelReason: booking.cancelReason,
      cancelReviewNote: booking.cancelReviewNote,
      requestedAt: booking.cancelRequestedAt,
      reviewedAt: booking.cancelReviewedAt,
      reviewerName: reviewer?.name ?? null,
      money: {
        paid,
        // The part that can leave through the method the customer paid with; the wallet part returns to the wallet.
        original: received,
        wallet,
        method: booking.payment?.method ?? null,
        chargeCode: charge ? transactionCode(charge) : null,
      },
      policy: {
        text: setting('cancellationPolicy') ?? '',
        rules,
        daysLeft,
        rule,
        suggested: rule ? sar((halalas(paid) * rule.percent) / 100) : null,
      },
      refunds: booking.paymentTransactions.map(toRefund),
    };
  }

  /** Confirms that staff returned the money outside the system, or hands the cash over from the drawer. */
  async executeRefund(actor: CashActor, transactionId: string, dto: ExecuteRefundDto, ip?: string) {
    const found = await this.findRefund(transactionId);
    // A second click on a cash refund would otherwise be told about the drawer limit instead of what really happened.
    if (found.status !== 'PENDING') throw new ConflictException('تمت معالجة هذا الاسترداد مسبقًا');
    const isCash = found.method === 'cash';
    if (!isCash && !dto.gatewayReference) throw new BadRequestException('اكتب رقم مرجع عملية الرد');
    if (isCash) {
      if (!found.branchId) throw new ConflictException('لا يوجد صندوق مرتبط بهذا الاسترداد');
      await this.cash.assertBranchAccess(actor, found.branchId);
    }

    return this.prisma.$transaction(async (tx) => {
      // The drawer write takes the branch lock before the booking lock, the same order as every other drawer write.
      if (isCash) await this.cash.recordBookingRefund(tx, actor, { branchId: found.branchId!, bookingId: found.bookingId, amount: Number(found.amount) });
      else await this.events.lock(tx, found.bookingId);
      await this.assertStillPending(tx, transactionId);

      const row = await tx.paymentTransaction.update({
        where: { id: transactionId },
        data: { status: 'SUCCEEDED', gatewayReference: dto.gatewayReference || null, processedById: actor.userId, processedByName: actor.name ?? null, processedAt: new Date() },
      });
      if (!isCash) {
        await tx.booking.update({ where: { id: found.bookingId }, data: { externalRefunded: { increment: found.amount } } });
        await this.invoices.credit(tx, { bookingId: found.bookingId, amount: halalas(found.amount), reason: 'استرداد إلى وسيلة الدفع الأصلية', actorId: actor.userId });
      }
      await this.events.record(tx, {
        bookingId: found.bookingId,
        action: 'REFUND_EXECUTED',
        actorId: actor.userId,
        after: { amount: Number(found.amount), method: found.method, reference: dto.gatewayReference ?? null },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'REFUND_COMPLETED', [found.bookingId], { amount: formatSar(found.amount), refundMethod: refundMethodLabel(found.method) });
      return toRefund(row);
    }, TX_OPTIONS);
  }

  /** The way out when a card or account can no longer receive the money, so the customer is not left waiting for it. */
  async moveToWallet(actor: CashActor, transactionId: string, dto: MoveRefundToWalletDto, ip?: string) {
    const found = await this.findRefund(transactionId);
    // Cash waits in one branch's drawer, so another branch's employee may not settle it, by this route or by executing it.
    if (found.method === 'cash' && found.branchId) await this.cash.assertBranchAccess(actor, found.branchId);
    return this.prisma.$transaction(async (tx) => {
      await this.events.lock(tx, found.bookingId);
      await this.assertStillPending(tx, transactionId);

      const booking = await tx.booking.findUniqueOrThrow({ where: { id: found.bookingId }, select: { userId: true, bookingReference: true } });
      const amount = Number(found.amount);
      await tx.paymentTransaction.update({
        where: { id: transactionId },
        data: { status: 'FAILED', failureReason: dto.reason, processedById: actor.userId, processedByName: actor.name ?? null, processedAt: new Date() },
      });
      await this.wallet.apply(tx, {
        userId: booking.userId,
        amount,
        type: 'REFUND',
        description: `استرداد إلغاء الحجز ${booking.bookingReference}`,
        bookingId: found.bookingId,
        createdById: actor.userId,
      });
      await this.ledger.walletRefund(tx, { bookingId: found.bookingId, amount, actorId: actor.userId });
      await tx.booking.update({ where: { id: found.bookingId }, data: { refundAmount: { increment: amount } } });
      await this.invoices.credit(tx, { bookingId: found.bookingId, amount: halalas(amount), reason: 'استرداد إلى المحفظة', actorId: actor.userId });
      await this.events.record(tx, { bookingId: found.bookingId, action: 'REFUND_MOVED_TO_WALLET', actorId: actor.userId, reason: dto.reason, after: { amount, method: found.method }, ip });
      await this.notifications.toBookingOwners(tx, 'REFUND_COMPLETED', [found.bookingId], { amount: formatSar(amount), refundMethod: 'محفظتك' });
      return { success: true };
    }, TX_OPTIONS);
  }

  private async findRefund(transactionId: string) {
    const found = await this.prisma.paymentTransaction.findFirst({ where: { id: transactionId, type: 'REFUND' } });
    if (!found) throw new NotFoundException('عملية الاسترداد غير موجودة');
    return found;
  }

  private async assertStillPending(tx: Prisma.TransactionClient, transactionId: string) {
    const row = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: transactionId }, select: { status: true } });
    if (row.status !== 'PENDING') throw new ConflictException('تمت معالجة هذا الاسترداد مسبقًا');
  }
}

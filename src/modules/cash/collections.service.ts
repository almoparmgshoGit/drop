import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, CollectionMethod, Prisma } from '@prisma/client';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PaymentLedgerService } from '../../common/services/payment-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { PAID_PAYMENT_STATUSES, paymentFigures } from '../../common/utils/payment.util';
import { startOfRiyadhDay } from '../../common/utils/time.util';
import { toHalalas, toSar } from '../bookings/bookings.service';
import { CashActor, CashService } from './cash.service';
import { CollectionPeriod, CollectionsQuery, CollectPaymentDto } from './collections.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
// A booking under cancellation review may be refunded, so it is not chased for more money.
const COLLECTIBLE: BookingStatus[] = ['PENDING', 'CONFIRMED', 'BOARDED'];
const PAYMENT_METHOD: Record<CollectionMethod, string> = { CASH: 'cash', NETWORK: 'network', TRANSFER: 'transfer' };

const periodFilter = (period: CollectionPeriod, now: Date): Prisma.DateTimeFilter | undefined => {
  const today = startOfRiyadhDay(now);
  if (period === 'today') return { gte: today, lt: new Date(today.getTime() + DAY_MS) };
  if (period === 'week') return { gte: today, lt: new Date(today.getTime() + 7 * DAY_MS) };
  if (period === 'overdue') return { lt: today };
  return undefined;
};

@Injectable()
export class CollectionsService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
    private events: BookingEventsService,
    private notifications: NotificationsService,
    private invoices: InvoiceLedgerService,
    private ledger: PaymentLedgerService,
  ) {}

  async list(actor: CashActor, query: CollectionsQuery) {
    const now = new Date();
    const scope = await this.branchScope(actor, query.branchId);
    const departure = periodFilter(query.period ?? 'week', now);
    const where: Prisma.BookingWhereInput = {
      ...scope,
      status: { in: COLLECTIBLE },
      ...(departure && { trip: { departureTime: departure } }),
    };

    const [totals, unpaid, overdue] = await Promise.all([
      this.prisma.booking.aggregate({ where, _sum: { totalPrice: true } }),
      this.prisma.booking.findMany({
        where: { ...where, payment: { status: { notIn: PAID_PAYMENT_STATUSES } } },
        orderBy: [{ trip: { departureTime: 'asc' } }, { createdAt: 'asc' }],
        select: {
          id: true,
          bookingReference: true,
          totalPrice: true,
          branchId: true,
          user: { select: { phone: true, name: true } },
          trip: { select: { id: true, tripCode: true, departureTime: true } },
          passengers: { select: { fullName: true, phone: true }, orderBy: { seatNumber: 'asc' } },
          payment: { select: { amount: true, walletAmount: true, status: true, followUpNote: true } },
          collections: { select: { amount: true } },
        },
      }),
      this.prisma.booking.findMany({
        where: { ...scope, status: { in: COLLECTIBLE }, trip: { departureTime: periodFilter('overdue', now) }, payment: { status: { notIn: PAID_PAYMENT_STATUSES } } },
        select: { payment: { select: { amount: true, walletAmount: true, status: true } }, collections: { select: { amount: true } } },
      }),
    ]);

    const rows = unpaid
      .map((booking) => {
        const figures = paymentFigures(booking.payment, booking.collections);
        const passenger = booking.passengers[0];
        return {
          id: booking.id,
          reference: booking.bookingReference,
          passengerName: passenger?.fullName ?? booking.user.name,
          passengerCount: booking.passengers.length,
          phone: passenger?.phone ?? booking.user.phone,
          branchId: booking.branchId,
          tripCode: booking.trip.tripCode,
          tripId: booking.trip.id,
          departureTime: booking.trip.departureTime,
          price: Number(booking.totalPrice),
          paid: toSar(toHalalas(booking.totalPrice) - figures.remaining),
          remaining: toSar(figures.remaining),
          hasPaidAnything: figures.received + figures.wallet > 0,
          followUpNote: booking.payment?.followUpNote ?? null,
        };
      })
      .filter((row) => row.remaining > 0);

    const remaining = rows.reduce((sum, row) => sum + toHalalas(row.remaining), 0);
    const total = toHalalas(totals._sum.totalPrice ?? 0);
    const collected = total - remaining;

    const nextDeparture = rows.find((row) => row.departureTime > now);
    const nearest = nextDeparture && {
      tripCode: nextDeparture.tripCode,
      departureTime: nextDeparture.departureTime,
      remaining: toSar(rows.filter((row) => row.tripId === nextDeparture.tripId).reduce((sum, row) => sum + toHalalas(row.remaining), 0)),
    };

    const page = query.page ?? 1;
    return {
      summary: {
        remaining: toSar(remaining),
        count: rows.length,
        collected: toSar(collected),
        rate: total > 0 ? Math.round((collected / total) * 1000) / 10 : null,
        nearest: nearest ?? null,
        overdueCount: overdue.filter((row) => paymentFigures(row.payment, row.collections).remaining > 0).length,
      },
      items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: rows.length,
      page,
    };
  }

  async collect(actor: CashActor, bookingId: string, dto: CollectPaymentDto) {
    await this.assertBookingVisible(actor, bookingId);
    if (dto.method === 'CASH') await this.cash.assertBranchAccess(actor, dto.branchId!);
    return this.prisma.$transaction((tx) => this.collectInTx(tx, actor, { ...dto, bookingId }), TX_OPTIONS);
  }

  /** Records money against a booking inside the caller's transaction, for screens that take payment as part of a larger action. */
  async collectInTx(
    tx: Prisma.TransactionClient,
    actor: CashActor,
    input: { bookingId: string; method: CollectionMethod; amount: number; branchId?: string; reference?: string; followUpNote?: string; idempotencyKey?: string; quiet?: boolean },
  ) {
    if (input.method === 'CASH' && !input.branchId) throw new BadRequestException('اختر صندوق الفرع الذي يستلم النقد');
    // Branch before booking, the same order as every other drawer write, so these cannot deadlock.
    const drawer = input.method === 'CASH' ? await this.cash.openDrawer(tx, input.branchId!) : null;
    await this.events.lock(tx, input.bookingId);

    const idempotencyKey = input.idempotencyKey ? `${actor.userId}:${input.idempotencyKey}` : null;
    if (idempotencyKey) {
      const repeated = await tx.bookingCollection.findUnique({ where: { idempotencyKey } });
      if (repeated) return repeated;
    }

    const booking = await tx.booking.findUnique({ where: { id: input.bookingId }, include: { payment: true, collections: { select: { amount: true, method: true } } } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    if (booking.status === 'CANCELLED') throw new ConflictException('هذا الحجز ملغى');
    if (booking.status === 'PENDING_CANCELLATION_REVIEW') throw new ConflictException('هذا الحجز بانتظار مراجعة الإلغاء');

    const { remaining, isPaid } = paymentFigures(booking.payment, booking.collections);
    if (!booking.payment || isPaid || remaining === 0) throw new ConflictException('لا يوجد مبلغ مستحق على هذا الحجز');
    const amount = toHalalas(input.amount);
    if (amount <= 0 || amount > remaining) throw new BadRequestException(`المبلغ المستحق على الحجز ${formatSar(toSar(remaining))}`);

    const collection = await tx.bookingCollection.create({
      data: {
        bookingId: booking.id,
        method: input.method,
        amount: input.amount,
        branchId: input.branchId ?? booking.branchId,
        reference: input.reference || null,
        idempotencyKey,
        createdById: actor.userId,
        createdByName: actor.name ?? null,
      },
    });
    if (drawer) await this.cash.addMovement(tx, actor, drawer.id, 'BOOKING_RECEIPT', input.amount, { bookingId: booking.id });
    // The register lists every payment a booking received, so a refund there always has the charge it reverses.
    await this.ledger.branchCharge(tx, {
      bookingId: booking.id,
      amount: input.amount,
      method: PAYMENT_METHOD[input.method],
      branchId: collection.branchId,
      reference: input.reference,
      actorId: actor.userId,
      actorName: actor.name,
    });
    await this.invoices.ensure(tx, booking.id);

    const left = remaining - amount;
    const methods = new Set([...booking.collections.map((row) => row.method), input.method]);
    await tx.payment.update({
      where: { bookingId: booking.id },
      data: {
        method: methods.size > 1 ? 'mixed' : PAYMENT_METHOD[input.method],
        ...(left === 0 && { status: 'COMPLETED' }),
        ...(input.followUpNote !== undefined && { followUpNote: input.followUpNote || null }),
      },
    });
    await this.events.record(tx, {
      bookingId: booking.id,
      action: 'PAYMENT_COLLECTED',
      actorId: actor.userId,
      after: { amount: input.amount, method: input.method, remaining: toSar(left), reference: input.reference ?? null },
    });
    // A payment taken while booking is already part of the booking's own confirmation.
    if (!input.quiet) {
      await this.notifications.toBookingOwners(tx, 'PAYMENT_COLLECTED', [booking.id], {
        amount: formatSar(input.amount),
        remainingAmount: formatSar(toSar(left)),
      });
    }
    return collection;
  }

  async updateFollowUpNote(actor: CashActor, bookingId: string, note: string) {
    await this.assertBookingVisible(actor, bookingId);
    await this.prisma.payment.update({ where: { bookingId }, data: { followUpNote: note || null } });
    return { followUpNote: note || null };
  }

  /** Staff without all-branch access only ever see bookings of their own branch. */
  async branchScope(actor: CashActor, branchId?: string): Promise<Prisma.BookingWhereInput> {
    if (actor.permissions.includes('cash.all_branches')) return branchId ? { branchId } : {};
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    if (!me?.branchId || (branchId && branchId !== me.branchId)) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    return { branchId: me.branchId };
  }

  async assertBookingVisible(actor: CashActor, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { branchId: true } });
    if (!booking) throw new NotFoundException('الحجز غير موجود');
    if (actor.permissions.includes('cash.all_branches')) return;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    if (!me?.branchId || me.branchId !== booking.branchId) throw new ForbiddenException('هذا الحجز خارج نطاق صلاحيتك');
  }
}

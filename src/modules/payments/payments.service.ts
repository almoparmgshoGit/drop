import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { transactionCode } from '../../common/services/payment-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { csvFile } from '../../common/utils/csv.util';
import { halalas } from '../../common/utils/payment.util';
import { riyadhMonth, riyadhMonthRange } from '../../common/utils/time.util';
import { PAGE_SIZE, PaymentState, PaymentsQuery } from './payments.dto';

const EXPORT_LIMIT = 5000;
const sar = (value: number) => Math.round(value) / 100;

const STATE_FILTER: Record<PaymentState, Prisma.PaymentTransactionWhereInput> = {
  SUCCEEDED: { type: 'CHARGE', status: 'SUCCEEDED' },
  FAILED: { status: 'FAILED' },
  CANCELLED: { status: 'CANCELLED' },
  REFUND_WALLET: { type: 'REFUND', destination: 'WALLET', status: 'SUCCEEDED' },
  REFUND_ORIGINAL: { type: 'REFUND', destination: 'ORIGINAL', status: 'SUCCEEDED' },
  REFUND_PENDING: { type: 'REFUND', status: 'PENDING' },
};

const STATE_LABELS: Record<PaymentState, string> = {
  SUCCEEDED: 'ناجحة',
  FAILED: 'فاشلة',
  CANCELLED: 'ملغاة من العميل',
  REFUND_WALLET: 'استرداد للمحفظة',
  REFUND_ORIGINAL: 'استرداد لوسيلة الدفع',
  REFUND_PENDING: 'استرداد قيد التنفيذ',
};

const stateOf = (row: { type: string; status: string; destination: string | null }): PaymentState => {
  if (row.status === 'FAILED' || row.status === 'CANCELLED') return row.status;
  if (row.type === 'CHARGE') return 'SUCCEEDED';
  if (row.status === 'PENDING') return 'REFUND_PENDING';
  return row.destination === 'WALLET' ? 'REFUND_WALLET' : 'REFUND_ORIGINAL';
};

const ROW_INCLUDE = { booking: { select: { id: true, bookingReference: true, user: { select: { name: true, phone: true } } } } } satisfies Prisma.PaymentTransactionInclude;

@Injectable()
export class PaymentsService {
  constructor(private prisma: PrismaService) {}

  private buildWhere(query: PaymentsQuery, month: string): Prisma.PaymentTransactionWhereInput {
    const where: Prisma.PaymentTransactionWhereInput = { createdAt: riyadhMonthRange(month), ...(query.state && STATE_FILTER[query.state]) };
    if (query.method) where.method = query.method;
    if (query.search) {
      // A code is shown with its date and type around the number, but the number alone identifies it.
      const number = /^(?:(?:TX|RF)-\d{8}-)?0*(\d{1,9})$/i.exec(query.search)?.[1];
      where.OR = [
        { booking: { bookingReference: { contains: query.search, mode: 'insensitive' } } },
        { booking: { user: { name: { contains: query.search, mode: 'insensitive' } } } },
        { booking: { user: { phone: { contains: query.search } } } },
        { gatewayReference: { contains: query.search, mode: 'insensitive' } },
        ...(number ? [{ number: Number(number) }] : []),
      ];
    }
    return where;
  }

  async list(query: PaymentsQuery) {
    const month = query.month ?? riyadhMonth(new Date());
    const page = query.page ?? 1;
    const where = this.buildWhere(query, month);
    const [items, total, groups] = await Promise.all([
      this.prisma.paymentTransaction.findMany({ where, include: ROW_INCLUDE, orderBy: { number: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.prisma.paymentTransaction.count({ where }),
      // The cards describe the month as a whole, so the table's filters do not change them.
      this.prisma.paymentTransaction.groupBy({ by: ['type', 'status', 'destination'], where: { createdAt: riyadhMonthRange(month) }, _count: true, _sum: { amount: true } }),
    ]);

    const figures = (match: (group: (typeof groups)[number]) => boolean) => {
      const rows = groups.filter(match);
      return { count: rows.reduce((sum, row) => sum + row._count, 0), amount: sar(rows.reduce((sum, row) => sum + halalas(row._sum.amount ?? 0), 0)) };
    };
    return {
      month,
      // Until the gateway ships nothing can report a failed attempt, so the page says why those figures are empty.
      gatewayConnected: false,
      summary: {
        succeeded: figures((row) => row.type === 'CHARGE' && row.status === 'SUCCEEDED'),
        failed: figures((row) => row.type === 'CHARGE' && (row.status === 'FAILED' || row.status === 'CANCELLED')),
        walletRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'WALLET' && row.status === 'SUCCEEDED'),
        originalRefunds: figures((row) => row.type === 'REFUND' && row.destination === 'ORIGINAL' && row.status === 'SUCCEEDED'),
        pendingRefunds: figures((row) => row.type === 'REFUND' && row.status === 'PENDING'),
      },
      items: items.map((row) => ({
        id: row.id,
        code: transactionCode(row),
        type: row.type,
        state: stateOf(row),
        bookingId: row.booking.id,
        reference: row.booking.bookingReference,
        customerName: row.booking.user.name,
        amount: Number(row.amount),
        method: row.method,
        simulated: row.simulated,
        gatewayReference: row.gatewayReference,
        failureReason: row.failureReason,
        createdAt: row.createdAt,
      })),
      total,
      page,
    };
  }

  async exportCsv(actorId: string, query: PaymentsQuery, ip?: string) {
    const month = query.month ?? riyadhMonth(new Date());
    const rows = await this.prisma.paymentTransaction.findMany({ where: this.buildWhere(query, month), include: ROW_INCLUDE, orderBy: { number: 'desc' }, take: EXPORT_LIMIT });
    // Exports carry customer data out of the system, and the audit interceptor only covers writes.
    await this.prisma.auditLog.create({
      data: { userId: actorId, action: 'GET /payments/export', entity: 'PaymentTransaction', ip, details: { filters: { ...query }, rows: rows.length } as Prisma.InputJsonValue },
    });
    return csvFile(
      ['رقم العملية', 'رقم الحجز', 'العميل', 'الجوال', 'المبلغ', 'الوسيلة', 'الحالة', 'مرجع البوابة', 'التاريخ'],
      rows.map((row) => [
        transactionCode(row),
        row.booking.bookingReference,
        row.booking.user.name,
        row.booking.user.phone,
        Number(row.amount).toFixed(2),
        row.method,
        STATE_LABELS[stateOf(row)],
        row.gatewayReference,
        row.createdAt.toISOString(),
      ]),
    );
  }
}

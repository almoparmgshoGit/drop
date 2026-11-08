import { Injectable } from '@nestjs/common';
import { PaymentTransactionType, Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

const METHOD_LABELS: Record<string, string> = {
  mada: 'مدى',
  card: 'البطاقة',
  cash: 'النقد',
  network: 'الشبكة',
  transfer: 'التحويل البنكي',
  wallet_balance: 'المحفظة',
  mixed: 'وسائل الدفع الأصلية',
};

export const refundMethodLabel = (method: string | null) => METHOD_LABELS[method ?? ''] ?? 'وسيلة الدفع الأصلية';

/** TX-20260310-4472 for a charge and RF-20260225-0144 for a refund, dated in Riyadh time. */
export const transactionCode = (row: { type: PaymentTransactionType; number: number; createdAt: Date }) => {
  const date = new Date(row.createdAt.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `${row.type === 'REFUND' ? 'RF' : 'TX'}-${date}-${String(row.number).padStart(4, '0')}`;
};

/** Writes the register of money movements inside the caller's transaction, so a row cannot exist without the movement behind it. */
@Injectable()
export class PaymentLedgerService {
  charge(tx: Db, input: { bookingId: string; amount: number; method: string; simulated: boolean }) {
    return tx.paymentTransaction.create({ data: { ...input, type: 'CHARGE', status: 'SUCCEEDED', processedAt: new Date() } });
  }

  /** Money a branch took against a booking: cash into the drawer, a network terminal or a bank transfer. */
  branchCharge(tx: Db, input: { bookingId: string; amount: number; method: string; branchId?: string | null; reference?: string | null; actorId: string; actorName?: string | null }) {
    return tx.paymentTransaction.create({
      data: {
        type: 'CHARGE',
        status: 'SUCCEEDED',
        bookingId: input.bookingId,
        amount: input.amount,
        method: input.method,
        branchId: input.branchId ?? null,
        gatewayReference: input.reference || null,
        processedById: input.actorId,
        processedByName: input.actorName ?? null,
        processedAt: new Date(),
      },
    });
  }

  /** Already credited by the time this is written, so it is born settled. */
  async walletRefund(tx: Db, input: { bookingId: string; amount: number; actorId?: string }) {
    const actor = input.actorId ? await tx.user.findUnique({ where: { id: input.actorId }, select: { name: true } }) : null;
    return tx.paymentTransaction.create({
      data: {
        type: 'REFUND',
        status: 'SUCCEEDED',
        destination: 'WALLET',
        method: 'wallet_balance',
        bookingId: input.bookingId,
        amount: input.amount,
        processedById: input.actorId,
        processedByName: actor?.name,
        processedAt: new Date(),
      },
    });
  }

  pendingRefund(tx: Db, input: { bookingId: string; amount: number; method: string | null; branchId?: string | null }) {
    return tx.paymentTransaction.create({ data: { ...input, type: 'REFUND', status: 'PENDING', destination: 'ORIGINAL' } });
  }
}

import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, WalletTransactionType } from '@prisma/client';

interface WalletEntry {
  userId: string;
  /** Signed amount in SAR: positive credits the wallet, negative debits it. */
  amount: number;
  type: WalletTransactionType;
  description: string;
  bookingId?: string;
  createdById?: string;
  /** Marks the entry as promotional credit that lapses on this date. */
  expiresAt?: Date;
  /**
   * On a credit: how much of it pays for transport only. Compensations and promotional credit are wholly so by default;
   * a refund passes the transport-only part the booking had spent; anything else is ordinary money unless given.
   * On a debit: the most that may come from transport-only credit (it is used first). Defaults to the whole debit;
   * paying for a stay passes only the tickets' part, so the rest must come from ordinary money.
   */
  transportAmount?: number;
}

/** Credit of these kinds is a gift from the company, so it buys tickets only, like loyalty points. */
const TRANSPORT_ONLY_TYPES: WalletTransactionType[] = ['COMPENSATION', 'PROMO_CREDIT'];

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class WalletService {
  /** Must run inside a transaction so the balance change and its ledger entry commit together. */
  async apply(tx: Prisma.TransactionClient, entry: WalletEntry) {
    return (await this.applyDetailed(tx, entry)).walletBalance;
  }

  /** Like apply, and also says how much of the change was transport-only credit. */
  async applyDetailed(tx: Prisma.TransactionClient, entry: WalletEntry) {
    const { userId, amount } = entry;
    let transportAmount = 0;
    if (amount < 0) {
      const debit = -amount;
      // Locked so two payments at once cannot both spend the same transport-only credit.
      const [row] = await tx.$queryRaw<{ walletBalance: Prisma.Decimal; walletTransportBalance: Prisma.Decimal }[]>`
        SELECT "walletBalance", "walletTransportBalance" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const balance = Number(row?.walletBalance ?? 0);
      const transportBalance = Math.min(balance, Number(row?.walletTransportBalance ?? 0));
      if (balance < debit) throw new ConflictException('رصيد المحفظة غير كافٍ');
      transportAmount = round2(Math.max(0, Math.min(transportBalance, entry.transportAmount ?? debit, debit)));
      if (round2(debit - transportAmount) > round2(balance - transportBalance)) {
        throw new ConflictException('رصيد التعويضات والرصيد الترويجي للنقل فقط، ولا يكفي الرصيد الأساسي لباقي المبلغ');
      }
      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: debit }, walletTransportBalance: round2(transportBalance - transportAmount) },
      });
      if (entry.type !== 'PROMO_EXPIRED') await this.consumePromo(tx, userId, debit);
    } else {
      const byDefault = TRANSPORT_ONLY_TYPES.includes(entry.type) ? amount : 0;
      transportAmount = round2(Math.max(0, Math.min(amount, entry.transportAmount ?? byDefault)));
      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: amount }, ...(transportAmount > 0 && { walletTransportBalance: { increment: transportAmount } }) },
      });
    }

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { walletBalance: true } });
    await tx.walletTransaction.create({
      data: {
        userId,
        amount,
        type: entry.type,
        description: entry.description,
        balanceAfter: user.walletBalance,
        bookingId: entry.bookingId,
        createdById: entry.createdById,
        transportAmount,
        ...(entry.expiresAt && { expiresAt: entry.expiresAt, promoRemaining: amount }),
      },
    });
    return { walletBalance: user.walletBalance, transportAmount };
  }

  /** Money leaving the wallet uses promotional credit first, the soonest to expire first, so the customer loses as little as possible. */
  private async consumePromo(tx: Prisma.TransactionClient, userId: string, amount: number) {
    let left = amount;
    const credits = await tx.walletTransaction.findMany({
      where: { userId, type: 'PROMO_CREDIT', promoRemaining: { gt: 0 }, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'asc' },
      select: { id: true, promoRemaining: true },
    });
    for (const credit of credits) {
      if (left <= 0) break;
      const remaining = Number(credit.promoRemaining);
      const used = Math.min(remaining, left);
      await tx.walletTransaction.update({ where: { id: credit.id }, data: { promoRemaining: Number((remaining - used).toFixed(2)) } });
      left = Number((left - used).toFixed(2));
    }
  }

  /** Takes back what is left of credits past their date. A wallet already below that amount gives up only what it holds. */
  async expirePromos(prisma: PrismaClient) {
    const expired = await prisma.walletTransaction.findMany({
      where: { type: 'PROMO_CREDIT', promoRemaining: { gt: 0 }, expiresAt: { lte: new Date() } },
      select: { id: true, userId: true, promoRemaining: true },
      take: 200,
    });
    for (const credit of expired) {
      await prisma.$transaction(async (tx) => {
        // Claimed first, so a second server instance sweeping at the same moment takes nothing.
        const claimed = await tx.walletTransaction.updateMany({ where: { id: credit.id, promoRemaining: { gt: 0 } }, data: { promoRemaining: 0 } });
        if (claimed.count === 0) return;
        const { walletBalance } = await tx.user.findUniqueOrThrow({ where: { id: credit.userId }, select: { walletBalance: true } });
        const amount = Math.min(Number(credit.promoRemaining), Number(walletBalance));
        if (amount > 0) {
          await this.apply(tx, { userId: credit.userId, amount: -amount, type: 'PROMO_EXPIRED', description: 'انتهاء صلاحية رصيد ترويجي' });
        }
      });
    }
    return expired.length;
  }
}

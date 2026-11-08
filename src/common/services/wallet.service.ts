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
}

@Injectable()
export class WalletService {
  /** Must run inside a transaction so the balance change and its ledger entry commit together. */
  async apply(tx: Prisma.TransactionClient, entry: WalletEntry) {
    const { userId, amount } = entry;
    if (amount < 0) {
      const debited = await tx.user.updateMany({
        where: { id: userId, walletBalance: { gte: -amount } },
        data: { walletBalance: { decrement: -amount } },
      });
      if (debited.count === 0) {
        throw new ConflictException('رصيد المحفظة غير كافٍ');
      }
      if (entry.type !== 'PROMO_EXPIRED') await this.consumePromo(tx, userId, -amount);
    } else {
      await tx.user.update({ where: { id: userId }, data: { walletBalance: { increment: amount } } });
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
        ...(entry.expiresAt && { expiresAt: entry.expiresAt, promoRemaining: amount }),
      },
    });
    return user.walletBalance;
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

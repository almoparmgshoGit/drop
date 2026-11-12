import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paymentFigures } from '../utils/payment.util';
import { LoyaltyTransactionType, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { formatSar, NotificationsService } from './notifications.service';
import { PrismaService } from './prisma.service';

const PROGRAM_KEY = 'loyaltyProgram';
const SWEEP_BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const TIER_WINDOW_DAYS = 365;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
/** Invite coupons: the new customer's welcome coupon and the inviter's reward, told apart by the start of the code. */
const WELCOME_PREFIX = 'RW';
const INVITER_PREFIX = 'RF';

export type ReferralReward = 'COUPON' | 'POINTS';

/** Everything the admin decides. New earning features start off, so nothing costs money until they turn it on. */
export const DEFAULT_PROGRAM = {
  enabled: true,
  pointsPerRiyal: 1,
  redeemPoints: 100,
  redeemValue: 5,
  minRedeemPoints: 100,
  maxRedeemPercent: 50,
  expiryMonths: 12,
  referral: {
    enabled: false,
    /** A coupon works without the points programme; points need it running. */
    rewardType: 'COUPON' as ReferralReward,
    referrerPoints: 200,
    refereePoints: 200,
    referrerCouponValue: 25,
    refereeCouponValue: 25,
    couponValidDays: 60,
    maxPerUser: 20,
  },
  tiers: { enabled: false, silverTrips: 5, silverMultiplier: 1.25, goldTrips: 15, goldMultiplier: 1.5 },
  challenge: { enabled: false, trips: 5, points: 500 },
};

export type LoyaltyProgram = typeof DEFAULT_PROGRAM;

type Money = Prisma.Decimal | number | null;

/**
 * The part of a booking's price that is its transport tickets, from 0 to 1: points are earned on the bus, not the hotel.
 * A stay sold on top is its housingAmount; a package's price holds its stay, so only the trip's own seat price counts from it.
 */
export function transportShare(booking: { subtotal: Money; housingAmount: Money; seats: number; trip: { price: Money; packageId: string | null } }) {
  const subtotal = Math.round(Number(booking.subtotal ?? 0) * 100);
  if (subtotal <= 0) return 1;
  let transport = subtotal - Math.round(Number(booking.housingAmount ?? 0) * 100);
  if (booking.trip.packageId) transport = Math.min(transport, Math.round(Number(booking.trip.price ?? 0) * 100) * booking.seats);
  return Math.min(1, Math.max(0, transport / subtotal));
}
type Db = Prisma.TransactionClient;

export interface EarnPlan {
  rate: number;
  bonus: number;
  rules: string[];
  tier: string | null;
}

const toHalalas = (sar: number) => Math.round(sar * 100);

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async getProgram(db: Db = this.prisma): Promise<LoyaltyProgram> {
    const row = await db.setting.findUnique({ where: { key: PROGRAM_KEY } });
    if (!row) return DEFAULT_PROGRAM;
    const saved = JSON.parse(row.value);
    return {
      ...DEFAULT_PROGRAM,
      ...saved,
      referral: { ...DEFAULT_PROGRAM.referral, ...saved.referral },
      tiers: { ...DEFAULT_PROGRAM.tiers, ...saved.tiers },
      challenge: { ...DEFAULT_PROGRAM.challenge, ...saved.challenge },
    };
  }

  async saveProgram(changes: Partial<LoyaltyProgram>) {
    const current = await this.getProgram();
    const next = {
      ...current,
      ...changes,
      referral: { ...current.referral, ...changes.referral },
      tiers: { ...current.tiers, ...changes.tiers },
      challenge: { ...current.challenge, ...changes.challenge },
    };
    if (next.minRedeemPoints < next.redeemPoints) throw new BadRequestException('أقل عدد للاستبدال لا يكون أقل من وحدة الاستبدال');
    if (next.tiers.goldTrips <= next.tiers.silverTrips) throw new BadRequestException('رحلات المستوى الذهبي يجب أن تزيد عن الفضي');
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({ where: { key: PROGRAM_KEY }, create: { key: PROGRAM_KEY, value }, update: { value } });
    return next;
  }

  /** The tier comes from trips actually completed in the last year. */
  async tierOf(db: Db, userId: string, program: LoyaltyProgram) {
    const { tiers } = program;
    const trips = await db.loyaltyTransaction.count({
      where: { userId, type: 'EARNED', createdAt: { gte: new Date(Date.now() - TIER_WINDOW_DAYS * DAY_MS) } },
    });
    if (!tiers.enabled) return { key: null, name: null, multiplier: 1, trips, nextName: null, tripsToNext: null };
    if (trips >= tiers.goldTrips) return { key: 'GOLD', name: 'ذهبي', multiplier: tiers.goldMultiplier, trips, nextName: null, tripsToNext: null };
    if (trips >= tiers.silverTrips) {
      return { key: 'SILVER', name: 'فضي', multiplier: tiers.silverMultiplier, trips, nextName: 'ذهبي', tripsToNext: tiers.goldTrips - trips };
    }
    return { key: 'BRONZE', name: 'برونزي', multiplier: 1, trips, nextName: 'فضي', tripsToNext: tiers.silverTrips - trips };
  }

  /** What a booking will earn, decided when it is made so later rule changes cannot alter it. */
  async earnPlan(db: Db, userId: string, program: LoyaltyProgram, trip: { id: string; departureTime: Date }, seatCount: number): Promise<EarnPlan> {
    if (!program.enabled || program.pointsPerRiyal <= 0) return { rate: 0, bonus: 0, rules: [], tier: null };
    const now = new Date();
    const rules = await db.loyaltyRule.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          { OR: [{ tripId: null }, { tripId: trip.id }] },
          { OR: [{ minSeats: null }, { minSeats: { lte: seatCount } }] },
        ],
      },
    });
    const weekday = new Date(trip.departureTime.getTime() + RIYADH_OFFSET_MS).getUTCDay();
    const daysBefore = (trip.departureTime.getTime() - now.getTime()) / DAY_MS;
    const matching = rules.filter((rule) => {
      if (rule.weekdays.length > 0 && !rule.weekdays.includes(weekday)) return false;
      if (rule.minDaysBefore !== null && daysBefore < rule.minDaysBefore) return false;
      return true;
    });

    // Multipliers do not stack with each other, so overlapping campaigns cannot multiply the cost.
    const multiplier = Math.max(1, ...matching.filter((r) => r.type === 'MULTIPLIER').map((r) => Number(r.value)));
    const percent = matching.filter((r) => r.type === 'BONUS_PERCENT').reduce((sum, r) => sum + Number(r.value), 0);
    const bonus = matching.filter((r) => r.type === 'BONUS_POINTS').reduce((sum, r) => sum + Math.floor(Number(r.value)), 0);
    const tier = await this.tierOf(db, userId, program);
    return {
      rate: program.pointsPerRiyal * multiplier * (1 + percent / 100) * tier.multiplier,
      bonus,
      rules: matching.map((r) => r.name),
      tier: tier.name,
    };
  }

  /** Validates a redemption and prices it in halalas; the customer never supplies an amount. */
  priceRedemption(program: LoyaltyProgram, balance: number, requested: number, totalHalalas: number) {
    const unitValue = toHalalas(program.redeemValue);
    const capHalalas = Math.floor((totalHalalas * program.maxRedeemPercent) / 100);
    const unitsByCap = unitValue > 0 ? Math.floor(capHalalas / unitValue) : 0;
    const unitsByBalance = Math.floor(balance / program.redeemPoints);
    const maxPoints = program.enabled ? Math.min(unitsByCap, unitsByBalance) * program.redeemPoints : 0;
    const usableMax = maxPoints >= program.minRedeemPoints ? maxPoints : 0;

    if (!requested) return { points: 0, discount: 0, maxPoints: usableMax };
    if (!program.enabled) throw new BadRequestException('استبدال النقاط غير متاح حاليًا');
    if (requested % program.redeemPoints !== 0) throw new BadRequestException(`يكون الاستبدال بمضاعفات ${program.redeemPoints} نقطة`);
    if (requested < program.minRedeemPoints) throw new BadRequestException(`أقل عدد للاستبدال ${program.minRedeemPoints} نقطة`);
    if (requested > balance) throw new BadRequestException('رصيد النقاط غير كافٍ');
    if (requested > usableMax) throw new BadRequestException(`أقصى ما يمكن استبداله في هذا الحجز ${usableMax} نقطة`);
    return { points: requested, discount: (requested / program.redeemPoints) * unitValue, maxPoints: usableMax };
  }

  /** Every balance change goes through here so the ledger and the balance can never disagree. */
  async grant(tx: Db, entry: { userId: string; points: number; type: LoyaltyTransactionType; description: string; bookingId?: string; uniqueKey?: string }) {
    const user = await tx.user.update({
      where: { id: entry.userId },
      data: { loyaltyPoints: { increment: entry.points }, loyaltyActivityAt: new Date() },
      select: { loyaltyPoints: true },
    });
    return tx.loyaltyTransaction.create({
      data: {
        userId: entry.userId,
        bookingId: entry.bookingId,
        type: entry.type,
        points: entry.points,
        balanceAfter: user.loyaltyPoints,
        description: entry.description,
        uniqueKey: entry.uniqueKey,
      },
    });
  }

  /** The conditional update is what stops two simultaneous requests spending the same points. */
  async spend(tx: Db, entry: { userId: string; points: number; type: LoyaltyTransactionType; description: string; bookingId?: string; uniqueKey?: string }) {
    const debited = await tx.user.updateMany({
      where: { id: entry.userId, loyaltyPoints: { gte: entry.points } },
      data: { loyaltyPoints: { decrement: entry.points }, loyaltyActivityAt: new Date() },
    });
    if (debited.count === 0) throw new ConflictException('رصيد النقاط غير كافٍ');
    const user = await tx.user.findUniqueOrThrow({ where: { id: entry.userId }, select: { loyaltyPoints: true } });
    return tx.loyaltyTransaction.create({
      data: {
        userId: entry.userId,
        bookingId: entry.bookingId,
        type: entry.type,
        points: -entry.points,
        balanceAfter: user.loyaltyPoints,
        description: entry.description,
        uniqueKey: entry.uniqueKey,
      },
    });
  }

  /** Gives back the points a cancelled booking used. Runs inside the cancellation transaction. */
  async restoreForCancelledBooking(tx: Db, booking: { id: string; userId: string; bookingReference: string; pointsRedeemed: number }) {
    if (booking.pointsRedeemed <= 0) return;
    await this.grant(tx, {
      userId: booking.userId,
      points: booking.pointsRedeemed,
      type: 'REFUNDED',
      description: `إعادة نقاط إلغاء • ${booking.bookingReference}`,
      bookingId: booking.id,
      uniqueKey: `refund:${booking.id}`,
    });
  }

  /** Settles completed trips; repeat runs are harmless because a booking settles only once. */
  async settleCompletedTrips() {
    const program = await this.getProgram();
    const bookings = await this.prisma.booking.findMany({
      where: {
        loyaltySettledAt: null,
        trip: { tripStatus: 'COMPLETED' },
        status: { in: ['CONFIRMED', 'BOARDED'] },
        tickets: { some: { isBoarded: true } },
      },
      take: SWEEP_BATCH,
      select: {
        id: true,
        userId: true,
        bookingReference: true,
        loyaltyPlan: true,
        subtotal: true,
        housingAmount: true,
        trip: { select: { price: true, packageId: true } },
        payment: { select: { amount: true, walletAmount: true, status: true } },
        collections: { select: { amount: true } },
        passengers: { select: { ticket: { select: { isBoarded: true } } } },
      },
    });

    let settled = 0;
    for (const booking of bookings) {
      // Bookings made before plans existed earn at the current base rate.
      const plan = (booking.loyaltyPlan as unknown as EarnPlan | null) ?? { rate: program.enabled ? program.pointsPerRiyal : 0, bonus: 0, rules: [], tier: null };
      // Points follow money actually received, not what a booking still owes.
      const { received, wallet } = paymentFigures(booking.payment, booking.collections);
      // Only what was paid for the tickets earns: the hotel's share is left out.
      const paid = ((received + wallet) / 100) * transportShare({ ...booking, seats: booking.passengers.length });
      const travelled = booking.passengers.filter((p) => p.ticket?.isBoarded).length;
      // Only seats that actually travelled earn points.
      const points = Math.floor((paid * plan.rate * travelled) / Math.max(1, booking.passengers.length)) + plan.bonus;
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.booking.update({ where: { id: booking.id }, data: { loyaltySettledAt: new Date() } });
          if (points > 0) {
            const earned = await this.grant(tx, {
              userId: booking.userId,
              points,
              type: 'EARNED',
              description: `رحلة مكتملة • ${booking.bookingReference}`,
              bookingId: booking.id,
              uniqueKey: `earn:${booking.id}`,
            });
            await this.notifications.toBookingOwners(tx, 'POINTS_EARNED', [booking.id], { points, pointsBalance: earned.balanceAfter });
          }
          await this.applyMilestones(tx, booking.userId, program);
        }, TX_OPTIONS);
        settled += 1;
      } catch (err) {
        // Another sweep got there first; the unique key rolled this one back.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          this.logger.error(`Loyalty settlement failed for ${booking.bookingReference}: ${(err as Error).message}`);
        }
      }
    }
    await this.expireInactive(program);
    return settled;
  }

  private async grantOnce(tx: Db, entry: Parameters<LoyaltyService['grant']>[1] & { uniqueKey: string }) {
    const exists = await tx.loyaltyTransaction.findUnique({ where: { uniqueKey: entry.uniqueKey }, select: { id: true } });
    if (exists || entry.points <= 0) return;
    const granted = await this.grant(tx, entry);
    await this.notifications.toUser(tx, 'POINTS_BONUS', entry.userId, { bonusName: entry.description, points: entry.points, pointsBalance: granted.balanceAfter });
  }

  /** Whether invites are on: coupons stand alone, points need the points programme running too. */
  referralActive(program: LoyaltyProgram) {
    return program.referral.enabled && (program.referral.rewardType === 'COUPON' || program.enabled);
  }

  /** One coupon per reason: its code is derived from the reason, so a repeat run finds it instead of issuing a second. */
  private async issueReferralCoupon(tx: Db, entry: { userId: string; prefix: string; reason: string; value: number; validDays: number; bonusName: string }) {
    if (!(entry.value > 0)) return null;
    const code = `${entry.prefix}${crypto.createHash('sha256').update(entry.reason).digest('hex').slice(0, 10).toUpperCase()}`;
    if (await tx.coupon.findUnique({ where: { code }, select: { id: true } })) return null;
    const coupon = await tx.coupon.create({
      data: {
        code,
        type: 'FIXED_TOTAL',
        value: entry.value,
        maxUses: 1,
        perUserLimit: 1,
        ownerUserId: entry.userId,
        validUntil: new Date(Date.now() + Math.max(1, entry.validDays) * DAY_MS),
      },
      select: { code: true, value: true, validUntil: true },
    });
    await this.notifications.toUser(tx, 'REFERRAL_COUPON', entry.userId, { bonusName: entry.bonusName, voucherValue: formatSar(entry.value), voucherCode: code });
    return { code: coupon.code, value: Number(coupon.value), validUntil: coupon.validUntil };
  }

  private welcomeCoupon(tx: Db, userId: string, program: LoyaltyProgram) {
    return this.issueReferralCoupon(tx, {
      userId,
      prefix: WELCOME_PREFIX,
      reason: `referral-in:${userId}`,
      value: program.referral.refereeCouponValue,
      validDays: program.referral.couponValidDays,
      bonusName: 'هدية الانضمام بدعوة صديق',
    });
  }

  private async applyMilestones(tx: Db, userId: string, program: LoyaltyProgram) {
    if (program.enabled && program.challenge.enabled) {
      const year = new Date(Date.now() + RIYADH_OFFSET_MS).getUTCFullYear();
      const trips = await tx.loyaltyTransaction.count({
        where: {
          userId,
          type: 'EARNED',
          createdAt: { gte: new Date(Date.UTC(year, 0, 1) - RIYADH_OFFSET_MS), lt: new Date(Date.UTC(year + 1, 0, 1) - RIYADH_OFFSET_MS) },
        },
      });
      if (trips >= program.challenge.trips) {
        await this.grantOnce(tx, {
          userId,
          points: program.challenge.points,
          type: 'BONUS',
          description: `تحدي ${program.challenge.trips} رحلات في ${year}`,
          uniqueKey: `challenge:${userId}:${year}`,
        });
      }
    }
    if (this.referralActive(program)) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { referredById: true } });
      if (!user?.referredById) return;
      if (program.referral.rewardType === 'COUPON') {
        // Normally issued when the code was entered; this covers a code entered while invites paid in points.
        await this.welcomeCoupon(tx, userId, program);
        // The inviter's coupon waits for the friend's first real trip, which is what makes fake accounts pointless.
        const rewarded = await tx.coupon.count({ where: { ownerUserId: user.referredById, code: { startsWith: INVITER_PREFIX } } });
        if (rewarded < program.referral.maxPerUser) {
          await this.issueReferralCoupon(tx, {
            userId: user.referredById,
            prefix: INVITER_PREFIX,
            reason: `referral-out:${userId}`,
            value: program.referral.referrerCouponValue,
            validDays: program.referral.couponValidDays,
            bonusName: 'مكافأة دعوة صديق',
          });
        }
        return;
      }
      // Rewards wait for the friend's first real trip, which is what makes fake accounts pointless.
      await this.grantOnce(tx, {
        userId,
        points: program.referral.refereePoints,
        type: 'REFERRAL',
        description: 'مكافأة الانضمام بدعوة',
        uniqueKey: `referral-in:${userId}`,
      });
      const rewarded = await tx.loyaltyTransaction.count({ where: { userId: user.referredById, type: 'REFERRAL' } });
      if (rewarded < program.referral.maxPerUser) {
        await this.grantOnce(tx, {
          userId: user.referredById,
          points: program.referral.referrerPoints,
          type: 'REFERRAL',
          description: 'مكافأة دعوة صديق',
          uniqueKey: `referral-out:${userId}`,
        });
      }
    }
  }

  private async expireInactive(program: LoyaltyProgram) {
    if (!(program.expiryMonths > 0)) return;
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - program.expiryMonths);
    const users = await this.prisma.user.findMany({
      where: { loyaltyPoints: { gt: 0 }, loyaltyActivityAt: { lt: cutoff } },
      take: SWEEP_BATCH,
      select: { id: true, loyaltyPoints: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    for (const user of users) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.spend(tx, {
            userId: user.id,
            points: user.loyaltyPoints,
            type: 'EXPIRED',
            description: `انتهاء صلاحية النقاط بعد ${program.expiryMonths} شهرًا بلا نشاط`,
            uniqueKey: `expired:${user.id}:${today}`,
          });
          await this.notifications.toUser(tx, 'POINTS_EXPIRED', user.id, { points: user.loyaltyPoints });
        });
      } catch (err) {
        this.logger.warn(`Point expiry skipped for a user: ${(err as Error).message}`);
      }
    }
  }

  private async referralCodeFor(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
    if (user.referralCode) return user.referralCode;
    const code = `DH${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
    return code;
  }

  /** Everything the customer's points screen shows. */
  async customerSummary(userId: string) {
    const program = await this.getProgram();
    const [user, transactions, tier, vouchers, myVouchers] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { loyaltyPoints: true, loyaltyActivityAt: true, referredById: true } }),
      this.prisma.loyaltyTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          type: true,
          points: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
          booking: { select: { bookingReference: true, trip: { select: { origin: true, destination: true } } } },
        },
      }),
      this.tierOf(this.prisma, userId, program),
      program.enabled ? this.prisma.loyaltyVoucher.findMany({ where: { isActive: true }, orderBy: { pointsCost: 'asc' } }) : Promise.resolve([]),
      this.prisma.coupon.findMany({
        where: { ownerUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, code: true, value: true, validUntil: true, usedCount: true, maxUses: true },
      }),
    ]);
    if (!user) throw new NotFoundException('User not found');

    let expiresAt: Date | null = null;
    if (program.expiryMonths > 0 && user.loyaltyPoints > 0 && user.loyaltyActivityAt) {
      expiresAt = new Date(user.loyaltyActivityAt);
      expiresAt.setUTCMonth(expiresAt.getUTCMonth() + program.expiryMonths);
    }
    const referral = this.referralActive(program)
      ? {
          code: await this.referralCodeFor(userId),
          rewardType: program.referral.rewardType,
          referrerPoints: program.referral.referrerPoints,
          refereePoints: program.referral.refereePoints,
          referrerCouponValue: program.referral.referrerCouponValue,
          refereeCouponValue: program.referral.refereeCouponValue,
          canEnterCode: !user.referredById && (await this.prisma.booking.count({ where: { userId } })) === 0,
        }
      : null;
    let challenge = null;
    if (program.challenge.enabled) {
      const year = new Date(Date.now() + RIYADH_OFFSET_MS).getUTCFullYear();
      challenge = {
        target: program.challenge.trips,
        points: program.challenge.points,
        done: await this.prisma.loyaltyTransaction.count({
          where: { userId, type: 'EARNED', createdAt: { gte: new Date(Date.UTC(year, 0, 1) - RIYADH_OFFSET_MS) } },
        }),
      };
    }

    return {
      enabled: program.enabled,
      points: user.loyaltyPoints,
      pointsPerRiyal: program.pointsPerRiyal,
      redeem: { points: program.redeemPoints, value: program.redeemValue, min: program.minRedeemPoints, maxPercent: program.maxRedeemPercent },
      expiresAt,
      tier: tier.key ? tier : null,
      challenge,
      referral,
      vouchers: vouchers.map((v) => ({ id: v.id, name: v.name, pointsCost: v.pointsCost, value: Number(v.value), validDays: v.validDays })),
      myVouchers: myVouchers.map((c) => ({
        id: c.id,
        code: c.code,
        value: Number(c.value),
        validUntil: c.validUntil,
        isUsed: c.maxUses !== null && c.usedCount >= c.maxUses,
      })),
      transactions,
    };
  }

  async applyReferralCode(userId: string, code: string) {
    const program = await this.getProgram();
    if (!this.referralActive(program)) throw new ConflictException('برنامج الدعوات غير متاح حاليًا');
    const normalized = code.trim().toUpperCase();
    return this.prisma.$transaction(async (tx) => {
      const [user, bookings, referrer] = await Promise.all([
        tx.user.findUniqueOrThrow({ where: { id: userId }, select: { referredById: true } }),
        tx.booking.count({ where: { userId } }),
        tx.user.findUnique({ where: { referralCode: normalized }, select: { id: true } }),
      ]);
      if (user.referredById) throw new ConflictException('سبق أن أدخلت رمز دعوة');
      if (bookings > 0) throw new ConflictException('رمز الدعوة للعملاء الجدد قبل أول حجز');
      if (!referrer) throw new BadRequestException('رمز الدعوة غير صحيح');
      if (referrer.id === userId) throw new BadRequestException('لا يمكنك استخدام رمزك');
      await tx.user.update({ where: { id: userId }, data: { referredById: referrer.id } });
      // The friend's discount is for their first booking, so it is theirs at once; the inviter's waits for that trip.
      const coupon = program.referral.rewardType === 'COUPON' ? await this.welcomeCoupon(tx, userId, program) : null;
      return { success: true, coupon };
    });
  }

  async redeemVoucher(userId: string, voucherId: string) {
    const program = await this.getProgram();
    if (!program.enabled) throw new ConflictException('برنامج النقاط غير متاح حاليًا');
    return this.prisma.$transaction(async (tx) => {
      const voucher = await tx.loyaltyVoucher.findUnique({ where: { id: voucherId } });
      if (!voucher || !voucher.isActive) throw new NotFoundException('القسيمة غير متاحة');
      await this.spend(tx, { userId, points: voucher.pointsCost, type: 'VOUCHER', description: `قسيمة ${voucher.name}` });
      const code = `LY${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const coupon = await tx.coupon.create({
        data: {
          code,
          type: 'FIXED_TOTAL',
          value: voucher.value,
          maxUses: 1,
          perUserLimit: 1,
          ownerUserId: userId,
          validUntil: new Date(Date.now() + voucher.validDays * DAY_MS),
        },
        select: { code: true, value: true, validUntil: true },
      });
      await this.notifications.toUser(tx, 'VOUCHER_REDEEMED', userId, {
        points: voucher.pointsCost,
        voucherName: voucher.name,
        voucherValue: formatSar(voucher.value),
        voucherCode: coupon.code,
      });
      return { code: coupon.code, value: Number(coupon.value), validUntil: coupon.validUntil };
    }, TX_OPTIONS);
  }
}

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { riyadhWeekday } from './recurrence.util';

/**
 * Flexible pricing on a trip's seat price. Every adjustment is a percent of the listed price, they add up, and the
 * result is kept between the trip's floor and ceiling. A trip without rules, or with them switched off, sells at its
 * listed price exactly as before. A package's trips never use it: a package is priced by group size.
 */
export interface PricingRules {
  enabled: boolean;
  /** Once this share of the seats is sold, the price moves by adjustPercent. The highest tier reached applies. */
  occupancyTiers: { fromPercent: number; adjustPercent: number }[];
  /** Booked at least this many days before departure. Usually a negative percent (a discount). */
  earlyBird: { minDays: number; adjustPercent: number } | null;
  /** Booked within this many hours of departure. */
  lastMinute: { withinHours: number; adjustPercent: number } | null;
  /** By the day the trip leaves (Riyadh): weekendDays are 0 Sunday to 6 Saturday, the rest are weekdays. */
  weekdayAdjustPercent: number;
  weekendAdjustPercent: number;
  weekendDays: number[];
  /** Guards in SAR: the price never goes below or above these. */
  minPrice: number | null;
  maxPrice: number | null;
}

export type PricingAdjustmentKind = 'OCCUPANCY' | 'EARLY_BIRD' | 'LAST_MINUTE' | 'WEEKDAY' | 'WEEKEND' | 'MIN_GUARD' | 'MAX_GUARD';

export interface PricingAdjustment {
  kind: PricingAdjustmentKind;
  label: string;
  percent: number;
}

export interface SeatPricing {
  /** Halalas. */
  base: number;
  /** Halalas: what one seat costs right now. */
  price: number;
  /** True when the rules are on, whether or not they moved the price today. */
  dynamic: boolean;
  adjustments: PricingAdjustment[];
}

/** Friday and Saturday, the Saudi weekend. */
export const DEFAULT_WEEKEND_DAYS = [5, 6];

/** The fields a trip needs for its price; every trip row loaded with its scalars has them. */
export interface PricedSeatTrip {
  price: Prisma.Decimal | number;
  pricingRules?: Prisma.JsonValue | null;
  totalSeats: number;
  availableSeats: number;
  departureTime: Date;
  packageId?: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Reads stored rules, ignoring anything damaged; null means the trip has none. */
export function parsePricingRules(value: Prisma.JsonValue | null | undefined): PricingRules | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const tiers = Array.isArray(raw.occupancyTiers) ? raw.occupancyTiers : [];
  const early = raw.earlyBird && typeof raw.earlyBird === 'object' ? raw.earlyBird : null;
  const late = raw.lastMinute && typeof raw.lastMinute === 'object' ? raw.lastMinute : null;
  const weekend = Array.isArray(raw.weekendDays) ? raw.weekendDays.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_WEEKEND_DAYS;
  return {
    enabled: raw.enabled === true,
    occupancyTiers: tiers
      .map((tier: any) => ({ fromPercent: num(tier?.fromPercent), adjustPercent: num(tier?.adjustPercent) }))
      .filter((tier: any): tier is { fromPercent: number; adjustPercent: number } => tier.fromPercent !== null && tier.adjustPercent !== null)
      .sort((a: { fromPercent: number }, b: { fromPercent: number }) => a.fromPercent - b.fromPercent),
    earlyBird: early && num(early.minDays) !== null && num(early.adjustPercent) !== null ? { minDays: num(early.minDays)!, adjustPercent: num(early.adjustPercent)! } : null,
    lastMinute: late && num(late.withinHours) !== null && num(late.adjustPercent) !== null ? { withinHours: num(late.withinHours)!, adjustPercent: num(late.adjustPercent)! } : null,
    weekdayAdjustPercent: num(raw.weekdayAdjustPercent) ?? 0,
    weekendAdjustPercent: num(raw.weekendAdjustPercent) ?? 0,
    weekendDays: weekend,
    minPrice: num(raw.minPrice),
    maxPrice: num(raw.maxPrice),
  };
}

/** Checks rules typed in the trip form and returns them as stored; null clears them. */
export function normalizePricingRules(input: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (input === null) return Prisma.DbNull;
  const rules = parsePricingRules(input as Prisma.JsonValue);
  if (!rules) return Prisma.DbNull;
  if (rules.minPrice !== null && rules.minPrice < 0) throw new BadRequestException('الحد الأدنى للسعر لا يمكن أن يكون سالبًا');
  if (rules.minPrice !== null && rules.maxPrice !== null && rules.minPrice > rules.maxPrice) {
    throw new BadRequestException('الحد الأدنى للسعر أكبر من الحد الأعلى في التسعير المرن');
  }
  if (new Set(rules.occupancyTiers.map((tier) => tier.fromPercent)).size !== rules.occupancyTiers.length) {
    throw new BadRequestException('يوجد أكثر من شريحة إشغال بنفس النسبة');
  }
  return rules as unknown as Prisma.InputJsonValue;
}

const roundToRiyal = (halalas: number) => Math.round(halalas / 100) * 100;

/**
 * THE price of one seat on a trip at a moment: the app's search, the trip page, the seat map, the quote and the
 * booking all read it from here, so what the customer is shown is what they are charged.
 */
export function seatPricing(trip: PricedSeatTrip, now = new Date()): SeatPricing {
  const base = Math.round(Number(trip.price) * 100);
  const rules = trip.packageId ? null : parsePricingRules(trip.pricingRules ?? null);
  if (!rules || !rules.enabled) return { base, price: base, dynamic: false, adjustments: [] };

  const adjustments: PricingAdjustment[] = [];
  const sold = trip.totalSeats > 0 ? ((trip.totalSeats - trip.availableSeats) / trip.totalSeats) * 100 : 0;
  const tier = [...rules.occupancyTiers].reverse().find((row) => sold >= row.fromPercent);
  if (tier && tier.adjustPercent) adjustments.push({ kind: 'OCCUPANCY', label: `بعد بيع ${tier.fromPercent}% من المقاعد`, percent: tier.adjustPercent });

  const untilDeparture = trip.departureTime.getTime() - now.getTime();
  if (rules.earlyBird && rules.earlyBird.adjustPercent && untilDeparture >= rules.earlyBird.minDays * DAY_MS) {
    adjustments.push({ kind: 'EARLY_BIRD', label: `حجز مبكر (قبل ${rules.earlyBird.minDays} يوم أو أكثر)`, percent: rules.earlyBird.adjustPercent });
  }
  if (rules.lastMinute && rules.lastMinute.adjustPercent && untilDeparture >= 0 && untilDeparture <= rules.lastMinute.withinHours * HOUR_MS) {
    adjustments.push({ kind: 'LAST_MINUTE', label: `اللحظة الأخيرة (خلال ${rules.lastMinute.withinHours} ساعة)`, percent: rules.lastMinute.adjustPercent });
  }
  const weekend = rules.weekendDays.includes(riyadhWeekday(trip.departureTime));
  const dayPercent = weekend ? rules.weekendAdjustPercent : rules.weekdayAdjustPercent;
  if (dayPercent) adjustments.push({ kind: weekend ? 'WEEKEND' : 'WEEKDAY', label: weekend ? 'رحلة نهاية الأسبوع' : 'رحلة وسط الأسبوع', percent: dayPercent });

  const totalPercent = adjustments.reduce((sum, row) => sum + row.percent, 0);
  let price = adjustments.length ? Math.max(0, roundToRiyal(base * (1 + totalPercent / 100))) : base;
  if (rules.minPrice !== null && price < Math.round(rules.minPrice * 100)) {
    price = Math.round(rules.minPrice * 100);
    adjustments.push({ kind: 'MIN_GUARD', label: 'الحد الأدنى للسعر', percent: 0 });
  }
  if (rules.maxPrice !== null && price > Math.round(rules.maxPrice * 100)) {
    price = Math.round(rules.maxPrice * 100);
    adjustments.push({ kind: 'MAX_GUARD', label: 'الحد الأعلى للسعر', percent: 0 });
  }
  return { base, price, dynamic: true, adjustments };
}

/** The same, in SAR, for the screens. */
export function seatPricingSar(trip: PricedSeatTrip, now = new Date()) {
  const pricing = seatPricing(trip, now);
  return { basePrice: pricing.base / 100, currentPrice: pricing.price / 100, dynamic: pricing.dynamic, adjustments: pricing.adjustments };
}

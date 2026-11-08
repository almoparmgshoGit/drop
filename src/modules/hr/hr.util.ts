import { BadRequestException } from '@nestjs/common';
import { Prisma, TerminationReason } from '@prisma/client';
import { riyadhDate } from '../../common/utils/time.util';

/** Calendar days are kept as YYYY-MM-DD strings in the code and as UTC midnights in @db.Date columns. */
export type Day = string;
export type Month = string;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const today = (): Day => riyadhDate(new Date());
export const currentMonth = (): Month => today().slice(0, 7);

export const toDbDate = (day: Day) => new Date(`${day}T00:00:00.000Z`);
export const fromDbDate = (date: Date): Day => date.toISOString().slice(0, 10);

/** Refuses 2026-02-31 and the like, which Date would quietly roll over. */
export function parseDay(value: string | undefined | null, label = 'التاريخ'): Day {
  if (!value || !DAY_RE.test(value) || fromDbDate(toDbDate(value)) !== value) throw new BadRequestException(`${label} غير صحيح`);
  return value;
}

export function parseMonth(value: string | undefined | null, label = 'الشهر'): Month {
  if (!value || !MONTH_RE.test(value)) throw new BadRequestException(`${label} غير صحيح، اكتبه بالشكل 2026-11`);
  return value;
}

export const addDays = (day: Day, count: number): Day => fromDbDate(new Date(toDbDate(day).getTime() + count * DAY_MS));
/** Both ends counted. */
export const daysBetween = (from: Day, to: Day) => Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS) + 1;
export const maxDay = (a: Day, b: Day) => (a > b ? a : b);
export const minDay = (a: Day, b: Day) => (a < b ? a : b);

export const monthOf = (day: Day): Month => day.slice(0, 7);
export const monthStart = (month: Month): Day => `${month}-01`;
export const daysInMonth = (month: Month) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
};
export const monthEnd = (month: Month): Day => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
export const nextMonth = (month: Month): Month => monthOf(addDays(monthEnd(month), 1));
export const addMonths = (month: Month, count: number): Month => {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + count, 1));
  return date.toISOString().slice(0, 7);
};
export function monthsFrom(first: Month, last: Month): Month[] {
  const months: Month[] = [];
  for (let month = first; month <= last; month = nextMonth(month)) months.push(month);
  return months;
}

/** Whole months of service, as the rules on advances and leave read it. */
export function serviceMonths(hireDate: Day, on: Day) {
  const [hy, hm, hd] = hireDate.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return (y - hy) * 12 + (m - hm) - (d < hd ? 1 : 0);
}

// ---------------------------------------------------------------- money

/** All arithmetic is done in halalas, so sums never drift by a fraction. */
export const halalas = (value: number | Prisma.Decimal | string | null | undefined) => Math.round(Number(value ?? 0) * 100);
export const riyals = (value: number) => Math.round(value) / 100;
export const formatRiyals = (value: number) => `${riyals(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;

export type Wage = { basic: number; housing: number; transport: number; other: number };
export const wageTotal = (wage: Wage) => wage.basic + wage.housing + wage.transport + wage.other;
export const wageOf = (row: { basic: Prisma.Decimal; housing: Prisma.Decimal; transport: Prisma.Decimal; other: Prisma.Decimal }): Wage => ({
  basic: halalas(row.basic),
  housing: halalas(row.housing),
  transport: halalas(row.transport),
  other: halalas(row.other),
});

/**
 * Days of a month paid on the 30-day basis the labour law uses: a whole month is 30 days whatever its length,
 * a part of one is its calendar days, never more than 30.
 */
export function paidDays(month: Month, from: Day, to: Day) {
  const start = maxDay(from, monthStart(month));
  const end = minDay(to, monthEnd(month));
  if (start > end) return 0;
  if (start === monthStart(month) && end === monthEnd(month)) return 30;
  return Math.min(30, daysBetween(start, end));
}

/** The weight one calendar day of this month carries: a whole 31-day month still pays 30 days. */
export function dayWeight(month: Month, employedWholeMonth: boolean) {
  return employedWholeMonth ? 30 / daysInMonth(month) : 1;
}

// ---------------------------------------------------------------- identity

/** A Saudi IBAN: SA, two check digits and 20 more, with a valid ISO 7064 checksum. */
export function normalizeIban(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(iban)) throw new BadRequestException('رقم الآيبان يبدأ بـ SA ويتبعه 22 رقمًا');
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  if (remainder !== 1) throw new BadRequestException('رقم الآيبان غير صحيح، تحقق من أرقامه');
  return iban;
}

export const SAUDI_NATIONALITY = 'سعودي';
export const isSaudi = (nationality: string | null | undefined) => nationality?.trim() === SAUDI_NATIONALITY;

// ---------------------------------------------------------------- codes and labels

export const advanceCode = (number: number) => `AD-${String(number).padStart(3, '0')}`;
export const leaveCode = (number: number) => `LV-${String(number).padStart(3, '0')}`;
export const adjustmentCode = (number: number) => `SA-${String(number).padStart(3, '0')}`;
export const settlementCode = (number: number) => `ES-${String(number).padStart(3, '0')}`;

export const TERMINATION_LABELS: Record<TerminationReason, string> = {
  RESIGNATION: 'استقالة',
  EMPLOYER_TERMINATION: 'إنهاء من صاحب العمل',
  CONTRACT_END: 'انتهاء العقد',
  ARTICLE_80: 'فصل وفق المادة 80',
  RETIREMENT: 'تقاعد',
  DEATH: 'وفاة',
  FORCE_MAJEURE: 'قوة قاهرة',
  MUTUAL_AGREEMENT: 'اتفاق الطرفين',
};

export const ADJUSTMENT_LABELS: Record<string, string> = {
  BONUS: 'مكافأة',
  OVERTIME: 'عمل إضافي',
  OTHER_EARNING: 'إضافة أخرى',
  PENALTY: 'خصم جزاء',
  ABSENCE: 'خصم غياب',
  CASH_SHORTAGE: 'عجز صندوق',
  DAMAGE: 'تلفيات',
  OTHER_DEDUCTION: 'خصم آخر',
};

export const EARNING_CATEGORIES = ['BONUS', 'OVERTIME', 'OTHER_EARNING'] as const;

/**
 * End-of-service award (labour law articles 84 and 85): half a month's wage for each of the first five years
 * and a full month for each year after, in proportion to part years. A resignation earns a third of it after
 * two years, two thirds after five and all of it after ten; dismissal under article 80 earns nothing.
 */
export function endOfServiceAward(monthlyWage: number, serviceDays: number, reason: TerminationReason, fullOverride: boolean) {
  const years = serviceDays / 365;
  const full = (monthlyWage / 2) * Math.min(years, 5) + monthlyWage * Math.max(years - 5, 0);
  let share = 1;
  if (!fullOverride) {
    if (reason === 'ARTICLE_80') share = 0;
    else if (reason === 'RESIGNATION') share = years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
  }
  return { years, share, full: Math.round(full), award: Math.round(full * share) };
}

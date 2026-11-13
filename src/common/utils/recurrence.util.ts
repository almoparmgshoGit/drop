import { TripCalendar } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

const HIJRI_FORMAT = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Riyadh' });

function hijriParts(date: Date) {
  const parts = HIJRI_FORMAT.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function nextGregorian(from: Date) {
  const riyadh = new Date(from.getTime() + RIYADH_OFFSET_MS);
  const year = riyadh.getUTCFullYear() + 1;
  const lastDay = new Date(Date.UTC(year, riyadh.getUTCMonth() + 1, 0)).getUTCDate();
  // 29 February falls back to the 28th in a year without it.
  const day = Math.min(riyadh.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, riyadh.getUTCMonth(), day, riyadh.getUTCHours(), riyadh.getUTCMinutes(), riyadh.getUTCSeconds()) - RIYADH_OFFSET_MS);
}

function nextHijri(from: Date) {
  const start = hijriParts(from);
  const target = { year: start.year + 1, month: start.month };
  // A Hijri year runs about 354 days, and the same date can land a few days either side of that.
  const candidates = Array.from({ length: 11 }, (_, idx) => new Date(from.getTime() + (349 + idx) * DAY_MS));
  const inMonth = candidates.map((date) => ({ date, parts: hijriParts(date) })).filter(({ parts }) => parts.year === target.year && parts.month === target.month);
  const exact = inMonth.find(({ parts }) => parts.day === start.day);
  if (exact) return exact.date;
  // The 30th falls back to the 29th when next year's month is shorter.
  const fallback = inMonth.find(({ parts }) => parts.day === start.day - 1);
  if (fallback) return fallback.date;
  throw new Error(`No Hijri date found one year after ${from.toISOString()}`);
}

/** The same day and month one year later on the chosen calendar, at the same time of day in Riyadh. */
export function nextYearlyDate(from: Date, calendar: TripCalendar) {
  return calendar === 'HIJRI' ? nextHijri(from) : nextGregorian(from);
}

/** The longest a temporary weekly trip may run. A fixed weekly one is drafted a month at a time instead (see TripsService.weeklyHorizon). */
export const WEEKLY_HORIZON_DAYS = 365;

const riyadhMsOfDay = (date: Date) => (((date.getTime() + RIYADH_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;

/** The weekday in Riyadh, 0 for Sunday to 6 for Saturday. */
export const riyadhWeekday = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).getUTCDay();

/**
 * The first departure after `after`, and after `notBefore`, that falls on one of the weekdays, at the Riyadh time of day of
 * `timeOf`. Riyadh keeps one offset all year, so a day is always 24 hours.
 */
export function nextWeeklyDate(after: Date, weekdays: number[], timeOf: Date, notBefore = after): Date | null {
  if (weekdays.length === 0) return null;
  const start = new Date(Math.max(after.getTime(), notBefore.getTime()));
  const dayStart = start.getTime() - riyadhMsOfDay(start);
  for (let day = 0; day <= 7; day++) {
    const candidate = new Date(dayStart + day * DAY_MS + riyadhMsOfDay(timeOf));
    if (candidate > start && weekdays.includes(riyadhWeekday(candidate))) return candidate;
  }
  return null;
}

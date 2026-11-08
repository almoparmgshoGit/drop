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

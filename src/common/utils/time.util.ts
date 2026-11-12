// Saudi Arabia is UTC+3 year-round with no daylight saving.
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses YYYY-M-D as a calendar day in Riyadh and returns its UTC bounds. */
export function riyadhDayRange(date: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const parsed = new Date(utcMidnight);
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  const start = new Date(utcMidnight - RIYADH_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function startOfRiyadhDay(now = new Date()): Date {
  const shifted = now.getTime() + RIYADH_OFFSET_MS;
  return new Date(shifted - (shifted % DAY_MS) - RIYADH_OFFSET_MS);
}

export function startOfRiyadhMonth(now = new Date()): Date {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - RIYADH_OFFSET_MS);
}

export const riyadhMonth = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 7);
export const riyadhDate = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

/** The instants a calendar month YYYY-MM covers in Riyadh. */
export function riyadhMonthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  return {
    gte: new Date(Date.UTC(year, monthNumber - 1, 1) - RIYADH_OFFSET_MS),
    lt: new Date(Date.UTC(year, monthNumber, 1) - RIYADH_OFFSET_MS),
  };
}

export function formatRiyadhTime(date: Date): string {
  return new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(11, 16);
}

export function formatRiyadhDate(date: Date): string {
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Riyadh',
  }).format(date);
}

export function toHijriLabel(date: Date): string {
  return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Riyadh',
  }).format(date);
}

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

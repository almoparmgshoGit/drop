import { Prisma } from '@prisma/client';
import { RIYADH_OFFSET_MS } from './time.util';

/**
 * Trip numbers start again at 001 every month. A trip and its return share one number: D001 is the way there, R001 the
 * way back, and together they are DR001, the journey the accounts are kept for. The month is part of the shown code, so
 * November's D001 and December's D001 never meet on a manifest or an invoice.
 */

type Leg = 'D' | 'R' | 'DR';

/** The month a departure's number belongs to, in Riyadh: 2026-11. */
export function codePeriodOf(departure: Date): string {
  return new Date(departure.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 7);
}

/** D001-11/2026. */
export function formatTripCode(leg: Leg, codeNumber: number, codePeriod: string): string {
  const [year, month] = codePeriod.split('-');
  return `${leg}${String(codeNumber).padStart(3, '0')}-${month}/${year}`;
}

/**
 * The next free number in the departure's month, with its code. Two trips created at once in one month take turns on a
 * lock, so they cannot both take the same number.
 */
export async function assignTripCode(tx: Prisma.TransactionClient, departure: Date) {
  const codePeriod = codePeriodOf(departure);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`trip-code:${codePeriod}`}))`;
  const top = await tx.trip.aggregate({ where: { codePeriod, reverseOfTripId: null }, _max: { codeNumber: true } });
  const codeNumber = (top._max.codeNumber ?? 0) + 1;
  return { tripCode: formatTripCode('D', codeNumber, codePeriod), codePeriod, codeNumber };
}

type Coded = { tripCode: string; codeNumber: number | null; codePeriod: string | null };

/** The return's code: R with its outbound's number. A trip numbered before monthly codes keeps its old -R form. */
export function reverseCodeOf(outbound: Coded) {
  if (outbound.codeNumber === null || outbound.codePeriod === null) return { tripCode: `${outbound.tripCode}-R`, codePeriod: null, codeNumber: null };
  return { tripCode: formatTripCode('R', outbound.codeNumber, outbound.codePeriod), codePeriod: outbound.codePeriod, codeNumber: outbound.codeNumber };
}

/** DR001-11/2026 for a trip or its return, or null for a trip numbered before monthly codes. */
export function journeyCodeOf(trip: Pick<Coded, 'codeNumber' | 'codePeriod'>): string | null {
  return trip.codeNumber === null || trip.codePeriod === null ? null : formatTripCode('DR', trip.codeNumber, trip.codePeriod);
}

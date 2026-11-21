import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { RIYADH_OFFSET_MS } from './time.util';

/**
 * Trip numbers start again at 001 every month. A trip and its return share one number: D001 is the way there, R001 the
 * way back, and together they are DR001, the journey the accounts are kept for. The month is part of the shown code, so
 * November's D001 and December's D001 never meet on a manifest or an invoice.
 *
 * The numbers follow the departure date, not the order the trips were made in: the month's earliest trip is D001, the next
 * D002, and so on. Adding a trip, moving one's date or deleting one renumbers the month (see renumberPeriods), and the
 * return, the other buses and their returns follow their trip's new number.
 *
 * A draft may be saved without a number. It then holds a placeholder code (DRAFT_CODE_PREFIX) and takes its place in the
 * month when it is given a number or published.
 */

type Leg = 'D' | 'R' | 'DR';

/** The code of a draft saved without a number, followed by a random tag so it stays unique. */
export const DRAFT_CODE_PREFIX = 'مسودة-';

/** The month a departure's number belongs to, in Riyadh: 2026-11. */
export function codePeriodOf(departure: Date): string {
  return new Date(departure.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 7);
}

/** D001-11/2026. */
export function formatTripCode(leg: Leg, codeNumber: number, codePeriod: string): string {
  const [year, month] = codePeriod.split('-');
  return `${leg}${String(codeNumber).padStart(3, '0')}-${month}/${year}`;
}

/** A new placeholder code for a draft saved without a number. */
export function draftPlaceholderCode(): string {
  return `${DRAFT_CODE_PREFIX}${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Whether the trip is a draft waiting for its number (not a trip numbered before monthly codes). */
export function isUncoded(trip: { tripCode: string; codePeriod: string | null }): boolean {
  return trip.codePeriod === null && trip.tripCode.startsWith(DRAFT_CODE_PREFIX);
}

/** Two writers renumbering one month take turns; months are always locked in the same order so two writers cannot deadlock. */
export async function lockPeriods(tx: Prisma.TransactionClient, periods: (string | null | undefined)[]) {
  for (const period of [...new Set(periods.filter((p): p is string => !!p))].sort()) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`trip-code:${period}`}))`;
  }
}

/**
 * A provisional number for a new trip: the month's next free one. The caller renumbers the month right after creating the
 * trip (renumberPeriods), which moves it to its place by date.
 */
export async function assignTripCode(tx: Prisma.TransactionClient, departure: Date) {
  const codePeriod = codePeriodOf(departure);
  await lockPeriods(tx, [codePeriod]);
  const top = await tx.trip.aggregate({ where: { codePeriod, reverseOfTripId: null, convoyLeadId: null }, _max: { codeNumber: true } });
  const codeNumber = (top._max.codeNumber ?? 0) + 1;
  return { tripCode: formatTripCode('D', codeNumber, codePeriod), codePeriod, codeNumber };
}

type Coded = { tripCode: string; codeNumber: number | null; codePeriod: string | null };

/** The return's code: R with its outbound's number. A trip numbered before monthly codes, or a draft without one, gets its code plus -R. */
export function reverseCodeOf(outbound: Coded) {
  if (outbound.codeNumber === null || outbound.codePeriod === null) return { tripCode: `${outbound.tripCode}-R`, codePeriod: null, codeNumber: null };
  return { tripCode: formatTripCode('R', outbound.codeNumber, outbound.codePeriod), codePeriod: outbound.codePeriod, codeNumber: outbound.codeNumber };
}

/** DR001-11/2026 for a trip or its return, or null for a trip numbered before monthly codes. */
export function journeyCodeOf(trip: Pick<Coded, 'codeNumber' | 'codePeriod'>): string | null {
  return trip.codeNumber === null || trip.codePeriod === null ? null : formatTripCode('DR', trip.codeNumber, trip.codePeriod);
}

type Target = { rootId: string; tripCode: string; codeNumber: number | null; codePeriod: string | null };
type Row = { id: string; tripCode: string; codeNumber: number | null; codePeriod: string | null };

/** The part of a bus's code after its trip's: -B2. */
function busSuffix(follower: { tripCode: string; convoyOrder: number }, leadCode: string) {
  return follower.tripCode.startsWith(`${leadCode}-`) ? follower.tripCode.slice(leadCode.length) : `-B${follower.convoyOrder}`;
}

/**
 * Gives each trip its new code, and its return, its other buses and their returns the codes that go with it. Codes are
 * swapped through temporary ones, so D001 and D002 can trade places without breaking the unique code.
 */
async function applyCodes(tx: Prisma.TransactionClient, targets: Target[]) {
  if (targets.length === 0) return;
  const families = await tx.trip.findMany({
    where: { id: { in: targets.map((t) => t.rootId) } },
    select: {
      id: true,
      tripCode: true,
      codeNumber: true,
      codePeriod: true,
      reverseTrip: { select: { id: true, tripCode: true, codeNumber: true, codePeriod: true } },
      convoyFollowers: { select: { id: true, tripCode: true, convoyOrder: true, codeNumber: true, codePeriod: true, reverseTrip: { select: { id: true, tripCode: true, codeNumber: true, codePeriod: true } } } },
    },
  });
  const byId = new Map(families.map((f) => [f.id, f]));
  const rows: Row[] = [];
  const keep = (current: Row, next: Row) => {
    if (current.tripCode !== next.tripCode || current.codeNumber !== next.codeNumber || current.codePeriod !== next.codePeriod) rows.push(next);
  };
  for (const target of targets) {
    const family = byId.get(target.rootId);
    if (!family) continue;
    keep(family, { id: family.id, tripCode: target.tripCode, codeNumber: target.codeNumber, codePeriod: target.codePeriod });
    const reverse = reverseCodeOf(target);
    if (family.reverseTrip) keep(family.reverseTrip, { id: family.reverseTrip.id, ...reverse });
    for (const bus of family.convoyFollowers) {
      const suffix = busSuffix(bus, family.tripCode);
      keep(bus, { id: bus.id, tripCode: `${target.tripCode}${suffix}`, codeNumber: null, codePeriod: null });
      if (bus.reverseTrip) keep(bus.reverseTrip, { id: bus.reverseTrip.id, tripCode: `${reverse.tripCode}${suffix}`, codeNumber: null, codePeriod: null });
    }
  }
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  await tx.$executeRaw`UPDATE "Trip" SET "tripCode" = '~' || "id" WHERE "id" IN (${Prisma.join(ids)})`;
  const values = rows.map((row) => Prisma.sql`(${row.id}, ${row.tripCode}, ${row.codeNumber}::int, ${row.codePeriod}::text)`);
  await tx.$executeRaw`
    UPDATE "Trip" AS t SET "tripCode" = v.code, "codeNumber" = v.num, "codePeriod" = v.period
    FROM (VALUES ${Prisma.join(values)}) AS v(id, code, num, period)
    WHERE t."id" = v.id`;
}

/**
 * Numbers each given month's trips by departure: the earliest is 001. Trips on the same minute keep the order they were
 * made in. Only trips whose number changes are written.
 */
export async function renumberPeriods(tx: Prisma.TransactionClient, periods: (string | null | undefined)[]) {
  const months = [...new Set(periods.filter((p): p is string => !!p))];
  if (months.length === 0) return;
  await lockPeriods(tx, months);
  const targets: Target[] = [];
  for (const codePeriod of months) {
    const trips = await tx.trip.findMany({
      where: { codePeriod, reverseOfTripId: null, convoyLeadId: null },
      orderBy: [{ departureTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, tripCode: true, codeNumber: true },
    });
    trips.forEach((trip, idx) => {
      const tripCode = formatTripCode('D', idx + 1, codePeriod);
      if (trip.codeNumber !== idx + 1 || trip.tripCode !== tripCode) targets.push({ rootId: trip.id, tripCode, codeNumber: idx + 1, codePeriod });
    });
  }
  await applyCodes(tx, targets);
}

/**
 * Brings a trip's number in line with its departure and status, after it was created or edited:
 * - a numbered trip whose date moved to another month leaves the old month and joins the new one;
 * - a draft without a number gets one when it is published or when `assign` asks for it;
 * - a numbered draft gives its number back when `assign` is false (only while it has no return opened);
 * then the months touched are renumbered by date. A return or another bus follows its trip, and a trip numbered before
 * monthly codes is left as it is.
 */
export async function syncTripCode(tx: Prisma.TransactionClient, tripId: string, assign?: boolean) {
  const trip = await tx.trip.findUnique({
    where: { id: tripId },
    select: { id: true, tripCode: true, codePeriod: true, codeNumber: true, departureTime: true, tripStatus: true, reverseOfTripId: true, convoyLeadId: true, reverseTrip: { select: { id: true } } },
  });
  if (!trip || trip.reverseOfTripId || trip.convoyLeadId) return;
  const period = codePeriodOf(trip.departureTime);

  if (isUncoded(trip)) {
    if (trip.tripStatus === 'DRAFT' && assign !== true) return;
    await lockPeriods(tx, [period]);
    // Last for now; the renumbering moves it to its place by date.
    await applyCodes(tx, [{ rootId: trip.id, tripCode: `~${trip.id}#`, codeNumber: 100000, codePeriod: period }]);
    await renumberPeriods(tx, [period]);
    return;
  }
  if (trip.codePeriod === null) return; // numbered before monthly codes

  if (trip.tripStatus === 'DRAFT' && assign === false && !trip.reverseTrip) {
    await lockPeriods(tx, [trip.codePeriod]);
    await applyCodes(tx, [{ rootId: trip.id, tripCode: draftPlaceholderCode(), codeNumber: null, codePeriod: null }]);
    await renumberPeriods(tx, [trip.codePeriod]);
    return;
  }

  if (trip.codePeriod !== period) {
    await lockPeriods(tx, [trip.codePeriod, period]);
    await applyCodes(tx, [{ rootId: trip.id, tripCode: `~${trip.id}#`, codeNumber: 100000, codePeriod: period }]);
  }
  await renumberPeriods(tx, [trip.codePeriod, period]);
}

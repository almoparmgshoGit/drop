import { Prisma } from '@prisma/client';

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The Riyadh month a booking is numbered in, as YYMM. */
export const bookingNumberPeriod = (now = new Date()) => {
  const riyadh = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return `${String(riyadh.getUTCFullYear() % 100).padStart(2, '0')}${String(riyadh.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * The next booking number for the app and the branches alike: DH-YYMM-NNNN, counting from 0001 each Riyadh month.
 * One atomic upsert hands out each number, so two bookings saved at the same moment never share one. Pass the plain
 * client rather than a booking's transaction: the counter row is then not held for the rest of that transaction, and
 * a booking that fails afterwards only leaves a gap, the same as a database sequence.
 * Bookings made before this keep their DR- and DRB- numbers, which search still finds.
 */
export async function nextBookingNumber(db: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date()) {
  const period = bookingNumberPeriod(now);
  const [{ last }] = await db.$queryRaw<{ last: number }[]>`
    INSERT INTO "BookingNumberCounter" ("period", "last") VALUES (${period}, 1)
    ON CONFLICT ("period") DO UPDATE SET "last" = "BookingNumberCounter"."last" + 1
    RETURNING "last"`;
  return `DH-${period}-${String(last).padStart(4, '0')}`;
}

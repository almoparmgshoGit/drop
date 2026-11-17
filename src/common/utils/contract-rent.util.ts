import { Prisma } from '@prisma/client';

export const routeKey = (origin: string, destination: string) => `${origin.trim()}→${destination.trim()}`;

/**
 * Gives every trip that has a bus but no rent yet the price of its route in that bus's office's rate table, so the rent
 * lands on the office's statement as soon as a bus is assigned. A price someone already entered is never touched, and a
 * route the table does not list stays empty for the accountant to fill. Returns how many trips were priced.
 */
export async function fillContractRent(db: Prisma.TransactionClient, where: Prisma.TripWhereInput = {}) {
  const trips = await db.trip.findMany({
    where: { AND: [where, { busRentalPrice: null, tripStatus: { not: 'CANCELLED' }, bus: { officeId: { not: null } } }] },
    select: { id: true, origin: true, destination: true, bus: { select: { officeId: true } } },
  });
  if (trips.length === 0) return 0;
  const officeIds = [...new Set(trips.map((trip) => trip.bus!.officeId!))];
  const rates = await db.busOfficeRate.findMany({ where: { officeId: { in: officeIds } }, select: { officeId: true, origin: true, destination: true, price: true } });
  const priceOf = new Map(rates.map((rate) => [`${rate.officeId}|${routeKey(rate.origin, rate.destination)}`, rate.price]));
  let filled = 0;
  for (const trip of trips) {
    const price = priceOf.get(`${trip.bus!.officeId}|${routeKey(trip.origin, trip.destination)}`);
    if (price === undefined) continue;
    // Only while still empty, so a price typed in at the same moment wins.
    const { count } = await db.trip.updateMany({ where: { id: trip.id, busRentalPrice: null }, data: { busRentalPrice: price } });
    filled += count;
  }
  return filled;
}

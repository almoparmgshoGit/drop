import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/** The trips a city's branch serves: those leaving from its city and those arriving at it. */
export const cityTripWhere = (city: string): Prisma.TripWhereInput => ({
  OR: [{ origin: { contains: city, mode: 'insensitive' } }, { destination: { contains: city, mode: 'insensitive' } }],
});

/** Whether a trip runs from or to the city, by the same rule as cityTripWhere. */
export const tripInCity = (trip: { origin: string; destination: string }, city: string) => {
  const wanted = city.trim().toLowerCase();
  return trip.origin.toLowerCase().includes(wanted) || trip.destination.toLowerCase().includes(wanted);
};

/**
 * The city whose trips and bookings an employee works with: their branch's city, unless they work across branches.
 * Null means no limit: someone with every branch, someone outside any branch, or a branch with no city entered.
 */
export async function servedCity(db: Db, actor: { userId: string; permissions: string[] }) {
  if (actor.permissions.includes('bookings.all_branches')) return null;
  const me = await db.user.findUnique({ where: { id: actor.userId }, select: { branch: { select: { city: true } } } });
  return me?.branch?.city?.trim() || null;
}

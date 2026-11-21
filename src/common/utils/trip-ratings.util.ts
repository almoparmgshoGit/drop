import { Prisma } from '@prisma/client';

export type TripRatingSummary = { count: number; average: number | null };

/** How many customers rated each trip and their average overall stars, one decimal. Trips nobody rated are left out. */
export async function tripRatingSummaries(db: Pick<Prisma.TransactionClient, 'tripRating'>, tripIds: string[]) {
  const summaries = new Map<string, TripRatingSummary>();
  if (tripIds.length === 0) return summaries;
  const groups = await db.tripRating.groupBy({ by: ['tripId'], where: { tripId: { in: tripIds } }, _count: { _all: true }, _avg: { rating: true } });
  for (const group of groups) {
    const average = group._avg.rating;
    summaries.set(group.tripId, { count: group._count._all, average: average === null ? null : Math.round(average * 10) / 10 });
  }
  return summaries;
}

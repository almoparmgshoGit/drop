import { Prisma } from '@prisma/client';

export type HotelRatingSummary = { count: number; average: number | null };

export const NO_RATINGS: HotelRatingSummary = { count: 0, average: null };

/**
 * How many customers rated each hotel stay and their average stars, one decimal. A hidden comment still counts its stars:
 * staff hide abusive words, not the customer's verdict. Hotels nobody rated are left out.
 */
export async function hotelRatingSummaries(db: Pick<Prisma.TransactionClient, 'hotelRating'>, hotelIds: string[]) {
  const summaries = new Map<string, HotelRatingSummary>();
  if (hotelIds.length === 0) return summaries;
  const groups = await db.hotelRating.groupBy({ by: ['hotelId'], where: { hotelId: { in: hotelIds } }, _count: { _all: true }, _avg: { rating: true } });
  for (const group of groups) {
    const average = group._avg.rating;
    summaries.set(group.hotelId, { count: group._count._all, average: average === null ? null : Math.round(average * 10) / 10 });
  }
  return summaries;
}

/** Each hotel with its rating summary beside it. */
export async function withHotelRatings<T extends { id: string }>(db: Pick<Prisma.TransactionClient, 'hotelRating'>, hotels: T[]) {
  const summaries = await hotelRatingSummaries(db, hotels.map((hotel) => hotel.id));
  return hotels.map((hotel) => ({ ...hotel, rating: summaries.get(hotel.id) ?? NO_RATINGS }));
}

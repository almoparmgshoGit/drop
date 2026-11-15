/**
 * A trip on more than one bus is a set of trips: the first bus's trip, and one trip per extra bus pointing at it through
 * convoyLeadId, each with its own seats, crew, manifest and tracking.
 */

/**
 * A trip on several buses is offered one bus at a time: the first bus that still has a free seat, in order, so the next bus
 * opens only once the one before it is full. With every bus full, the first is shown, as a full trip.
 */
export function oneBusPerConvoy<T extends { id: string; convoyLeadId: string | null; convoyOrder: number; availableSeats: number }>(trips: T[]): T[] {
  const chosen = new Map<string, T>();
  for (const trip of trips) {
    const key = trip.convoyLeadId ?? trip.id;
    const best = chosen.get(key);
    const hasRoom = trip.availableSeats > 0;
    const bestHasRoom = !!best && best.availableSeats > 0;
    if (!best || (hasRoom && !bestHasRoom) || (hasRoom === bestHasRoom && trip.convoyOrder < best.convoyOrder)) chosen.set(key, trip);
  }
  const offered = new Set(chosen.values());
  return trips.filter((trip) => offered.has(trip));
}

import { ConflictException } from '@nestjs/common';
import { BookingKind, BookingStatus, Prisma } from '@prisma/client';
import { BOOKING_KIND_PARTS } from './booking-kinds.util';

const HOLDS_A_SEAT: BookingStatus[] = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];

/** Kinds bought for one direction only (ذهاب فقط, عودة فقط): on a round trip they get off at the destination and do not ride back. */
const ONE_WAY_KINDS = (Object.keys(BOOKING_KIND_PARTS) as BookingKind[]).filter((kind) => !(BOOKING_KIND_PARTS[kind].outbound && BOOKING_KIND_PARTS[kind].return));

/**
 * Whether a booking on a round trip rides back on its reverse: bought as a round journey, or saved before bookings recorded
 * their direction (no kind), which kept the old rule that everyone aboard a round trip comes back.
 */
export const ridesBack = (kind: BookingKind | string | null | undefined) => !kind || !ONE_WAY_KINDS.includes(kind as BookingKind);
const RIDES_BACK: Prisma.BookingWhereInput = { OR: [{ kind: null }, { kind: { notIn: ONE_WAY_KINDS } }] };

/**
 * A trip and its reverse run on one bus and share seat numbers. Passengers of a round trip stay aboard, so its reverse
 * opens on the seats it had not sold and a seat sold on either one is taken on the other: nobody loses a seat coming back.
 * Passengers of a one-way trip get off at the destination, so the two directions sell their seats independently.
 */
async function linkedTripId(tx: Prisma.TransactionClient, tripId: string) {
  const trip = await tx.trip.findUnique({
    where: { id: tripId },
    select: { direction: true, reverseOfTripId: true, reverseOf: { select: { direction: true } }, reverseTrip: { select: { id: true } } },
  });
  const linkedId = trip?.reverseOfTripId ?? trip?.reverseTrip?.id;
  if (!linkedId || (trip.reverseOf?.direction ?? trip.direction) === 'ONE_WAY') return null;
  const linked = await tx.trip.findUnique({ where: { id: linkedId }, select: { tripStatus: true } });
  return linked && linked.tripStatus !== 'CANCELLED' ? linkedId : null;
}

/** Keeps only the bookings with no active leg on another trip, which means this trip is all they have. */
async function withoutOtherLeg<T extends { tripId: string; groupReference: string | null }>(db: Pick<Prisma.TransactionClient, 'booking'>, bookings: T[]) {
  const groups = bookings.flatMap((booking) => booking.groupReference ?? []);
  const legs = await db.booking.findMany({
    where: { groupReference: { in: groups }, status: { in: HOLDS_A_SEAT } },
    select: { tripId: true, groupReference: true },
  });
  return bookings.filter((booking) => !legs.some((leg) => leg.groupReference === booking.groupReference && leg.tripId !== booking.tripId));
}

/** The linked reverse of a way there, or null for a reverse itself and for trips with no link (see linkedTripId). */
async function reverseOfOutbound(tx: Prisma.TransactionClient, tripId: string) {
  const trip = await tx.trip.findUnique({ where: { id: tripId }, select: { reverseOfTripId: true } });
  return trip && !trip.reverseOfTripId ? linkedTripId(tx, tripId) : null;
}

/** Whether the booking has an active leg on another trip, so it rides that leg and not this trip's linked one. */
export async function hasOtherLeg(db: Pick<Prisma.TransactionClient, 'booking'>, booking: { tripId: string; groupReference: string | null }) {
  return (await withoutOtherLeg(db, [booking])).length === 0;
}

/**
 * Places, not seats. The counter may save a passenger without a seat number, and the seat link above only works by number,
 * so such a passenger of a linked pair took nothing on the other trip: the reverse kept selling the place of every seatless
 * round-trip rider. They take a place there by count instead, as the trip's own capacity counts them. A booking with its own
 * leg on another trip rides that leg and takes nothing. `soft` takes what is left rather than refusing, for a journey sent
 * home on its own trip again after a cancellation, which must not fail.
 * Only from a way there to its reverse: a return-only passenger without a seat is not on the way there at all.
 */
export async function takeLinkedPlaces(tx: Prisma.TransactionClient, tripId: string, count: number, options: { hasOtherLeg?: boolean; soft?: boolean; ridesBack?: boolean } = {}) {
  if (count <= 0 || options.hasOtherLeg || options.ridesBack === false) return;
  const linkedId = await reverseOfOutbound(tx, tripId);
  if (!linkedId) return;
  if (options.soft) {
    const linked = await tx.trip.findUnique({ where: { id: linkedId }, select: { availableSeats: true } });
    const take = Math.min(count, Math.max(0, linked?.availableSeats ?? 0));
    if (take > 0) await tx.trip.update({ where: { id: linkedId }, data: { availableSeats: { decrement: take } } });
    return;
  }
  const taken = await tx.trip.updateMany({ where: { id: linkedId, availableSeats: { gte: count } }, data: { availableSeats: { decrement: count } } });
  if (taken.count !== 1) {
    const linked = await tx.trip.findUnique({ where: { id: linkedId }, select: { tripCode: true } });
    throw new ConflictException(`لا توجد أماكن كافية في الرحلة المرتبطة ${linked?.tripCode ?? ''}، فلا مكان لهؤلاء الركاب في طريق العودة`);
  }
}

/** Gives back the places takeLinkedPlaces took: a seatless rider cancelled, or given a seat, which now holds their place. */
export async function releaseLinkedPlaces(tx: Prisma.TransactionClient, tripId: string, count: number) {
  if (count <= 0) return;
  const linkedId = await reverseOfOutbound(tx, tripId);
  if (!linkedId) return;
  await tx.trip.update({ where: { id: linkedId }, data: { availableSeats: { increment: count } } });
}

/** Passengers riding this trip back without a seat number and with no leg elsewhere: the places they hold on its linked trip. */
export async function seatlessRiders(db: Pick<Prisma.TransactionClient, 'booking'>, tripId: string) {
  const bookings = await db.booking.findMany({
    where: { tripId, status: { in: HOLDS_A_SEAT }, passengers: { some: { seatNumber: null, cancelled: false } }, AND: [RIDES_BACK] },
    select: { tripId: true, groupReference: true, passengers: { where: { seatNumber: null, cancelled: false }, select: { id: true } } },
  });
  return (await withoutOtherLeg(db, bookings)).reduce((sum, booking) => sum + booking.passengers.length, 0);
}

/** The seat numbers of this round trip's passengers who ride back on its reverse, so those seats stay closed there. */
export async function ridingBackSeats(db: Pick<Prisma.TransactionClient, 'booking'>, tripId: string) {
  const bookings = await db.booking.findMany({
    where: { tripId, status: { in: HOLDS_A_SEAT }, AND: [RIDES_BACK] },
    select: { tripId: true, groupReference: true, passengers: { select: { seatNumber: true } } },
  });
  return new Set((await withoutOtherLeg(db, bookings)).flatMap((booking) => booking.passengers.flatMap((p) => p.seatNumber ?? [])));
}

/**
 * Bookings with no return leg that do not come back on the trip's reverse, and how many seats they free coming back: every
 * such booking on a one-way trip with a reverse enabled, and on a round trip those bought for one direction only.
 */
export async function goOnlyBookings(db: Pick<Prisma.TransactionClient, 'booking'>, tripIds: string[]) {
  const bookings = await db.booking.findMany({
    where: {
      tripId: { in: tripIds },
      status: { in: HOLDS_A_SEAT },
      OR: [{ trip: { direction: 'ONE_WAY', reverseEnabled: true } }, { trip: { direction: 'ROUND_TRIP', reverseEnabled: true }, kind: { in: ONE_WAY_KINDS } }],
    },
    select: { id: true, tripId: true, groupReference: true, _count: { select: { passengers: { where: { cancelled: false } } } } },
  });

  const bookingIds = new Set<string>();
  const seatsByTrip = new Map<string, number>();
  for (const booking of await withoutOtherLeg(db, bookings)) {
    bookingIds.add(booking.id);
    seatsByTrip.set(booking.tripId, (seatsByTrip.get(booking.tripId) ?? 0) + booking._count.passengers);
  }
  return { bookingIds, seatsByTrip };
}

/**
 * Bookings on this round trip that ride back on its reverse. They bought the whole journey, so they have no booking on the
 * reverse: the outbound ticket carries them home. A booking with its own leg on another trip goes back on that leg instead,
 * and one bought for one direction only (ذهاب فقط) does not come back at all.
 */
export async function returningBookingIds(db: Pick<Prisma.TransactionClient, 'booking'>, outboundId: string) {
  const bookings = await db.booking.findMany({
    where: { tripId: outboundId, status: { in: HOLDS_A_SEAT }, trip: { direction: 'ROUND_TRIP' }, AND: [RIDES_BACK] },
    select: { id: true, tripId: true, groupReference: true },
  });
  return (await withoutOtherLeg(db, bookings)).map((booking) => booking.id);
}

/** The reverse this booking rides back on, or null when it has none: one-way trips, a cancelled reverse, or a return leg elsewhere. */
export async function returnRideOf(db: Pick<Prisma.TransactionClient, 'booking' | 'trip'>, booking: { id: string; tripId: string }) {
  const outbound = await db.trip.findUnique({
    where: { id: booking.tripId },
    select: {
      direction: true,
      reverseTrip: {
        select: {
          tripCode: true,
          origin: true,
          destination: true,
          departureTime: true,
          tripStatus: true,
          executedAt: true,
          boardingPoints: { select: { name: true, time: true }, take: 1 },
        },
      },
    },
  });
  const reverse = outbound?.reverseTrip;
  if (outbound?.direction !== 'ROUND_TRIP' || !reverse || !['PUBLISHED', 'COMPLETED'].includes(reverse.tripStatus)) return null;
  if (!(await returningBookingIds(db, booking.tripId)).includes(booking.id)) return null;
  const { boardingPoints, tripStatus: _status, ...details } = reverse;
  return { ...details, boardingPointName: boardingPoints[0]?.name ?? null, boardingPointTime: boardingPoints[0]?.time ?? null };
}

/** Seats and money of the people who actually booked these trips, unlike totalSeats - availableSeats, which also counts seats closed by the link. */
export async function bookedOnTrips(db: Pick<Prisma.TransactionClient, 'booking'>, tripIds: string[]) {
  const bookings = await db.booking.findMany({
    where: { tripId: { in: tripIds }, status: { not: 'CANCELLED' } },
    select: { tripId: true, totalPrice: true, _count: { select: { passengers: { where: { cancelled: false } } } } },
  });
  const totals = new Map<string, { seats: number; revenue: number }>();
  for (const booking of bookings) {
    const total = totals.get(booking.tripId) ?? { seats: 0, revenue: 0 };
    totals.set(booking.tripId, { seats: total.seats + booking._count.passengers, revenue: total.revenue + Number(booking.totalPrice) });
  }
  return totals;
}

/**
 * How many passengers each trip's manifest lists, counted the manifest's way: its own bookings holding a seat, and on an
 * opened reverse of a round trip also the outbound's passengers riding back on it. totalSeats - availableSeats can be more,
 * because a seat sold on the linked trip is closed here too without anyone of this trip sitting in it.
 */
export async function manifestSeatsByTrip(
  db: Pick<Prisma.TransactionClient, 'booking'>,
  trips: { id: string; tripStatus: string; reverseOfTripId: string | null; reverseOf?: { direction: string } | null }[],
) {
  const seats = new Map<string, number>(trips.map((trip) => [trip.id, 0]));
  const own = await db.booking.findMany({
    where: { tripId: { in: trips.map((trip) => trip.id) }, status: { in: HOLDS_A_SEAT } },
    select: { tripId: true, _count: { select: { passengers: { where: { cancelled: false } } } } },
  });
  for (const booking of own) seats.set(booking.tripId, (seats.get(booking.tripId) ?? 0) + booking._count.passengers);

  // The same rule as returningBookingIds, for every opened reverse in one go.
  const reverseOf = new Map(
    trips
      .filter((trip) => trip.reverseOfTripId && trip.reverseOf?.direction === 'ROUND_TRIP' && ['PUBLISHED', 'COMPLETED'].includes(trip.tripStatus))
      .map((trip) => [trip.reverseOfTripId!, trip.id]),
  );
  if (reverseOf.size > 0) {
    const outbound = await db.booking.findMany({
      where: { tripId: { in: [...reverseOf.keys()] }, status: { in: HOLDS_A_SEAT }, AND: [RIDES_BACK] },
      select: { tripId: true, groupReference: true, _count: { select: { passengers: { where: { cancelled: false } } } } },
    });
    for (const booking of await withoutOtherLeg(db, outbound)) {
      const reverseId = reverseOf.get(booking.tripId)!;
      seats.set(reverseId, (seats.get(reverseId) ?? 0) + booking._count.passengers);
    }
  }
  return seats;
}

/** What the trip's passenger and booking sheets show about its reverse. Null when the trip has none. */
export async function reverseSeatsSummary(db: Pick<Prisma.TransactionClient, 'booking' | 'trip'>, tripId: string) {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: { direction: true, reverseEnabled: true, reverseTrip: { select: { id: true, tripCode: true, tripStatus: true, availableSeats: true } } },
  });
  if (!trip?.reverseEnabled) return null;
  const { seatsByTrip } = await goOnlyBookings(db, [tripId]);
  const reverse = trip.reverseTrip;
  const booked = reverse ? await bookedOnTrips(db, [reverse.id]) : null;
  // A round trip's passengers ride back on the reverse, so its sheet says how many; a one-way trip's say how many seats they free.
  const returning = trip.direction === 'ROUND_TRIP' ? await returningBookingIds(db, tripId) : [];
  const returningSeats = returning.length ? await db.booking.findMany({ where: { id: { in: returning } }, select: { _count: { select: { passengers: { where: { cancelled: false } } } } } }) : [];
  return {
    direction: trip.direction,
    returningSeats: returningSeats.reduce((sum, booking) => sum + booking._count.passengers, 0),
    goOnlySeats: seatsByTrip.get(tripId) ?? 0,
    isOpen: reverse?.tripStatus === 'PUBLISHED',
    tripCode: reverse?.tripCode ?? null,
    bookedSeats: reverse ? booked?.get(reverse.id)?.seats ?? 0 : 0,
    availableSeats: reverse?.availableSeats ?? 0,
  };
}

/**
 * Locks these trips and their linked trips, always in id order so two transactions cannot deadlock on them.
 * Whatever reads a trip's status or seats after this sees the result of any cancellation that was in progress.
 */
export async function lockTripsWithLinked(tx: Prisma.TransactionClient, tripIds: string[]) {
  await tx.$queryRaw`
    SELECT "id" FROM "Trip"
    WHERE "id" IN (${Prisma.join(tripIds)})
       OR "reverseOfTripId" IN (${Prisma.join(tripIds)})
       OR "id" IN (SELECT "reverseOfTripId" FROM "Trip" WHERE "id" IN (${Prisma.join(tripIds)}))
    ORDER BY "id"
    FOR UPDATE`;
}

/**
 * Takes places on the trip, seated or not. A counter booking may leave passengers without a seat number, so the free seats on
 * the plan are not the trip's whole story: the count is what stops a trip from being sold past its capacity.
 */
export async function takeTripCapacity(tx: Prisma.TransactionClient, tripId: string, tripCode: string, count: number) {
  if (count <= 0) return;
  const taken = await tx.trip.updateMany({ where: { id: tripId, availableSeats: { gte: count } }, data: { availableSeats: { decrement: count } } });
  if (taken.count !== 1) throw new ConflictException(`لا توجد أماكن كافية في الرحلة ${tripCode}`);
}

/**
 * Takes the same seat numbers on the linked trip. A number it never had, because it was sold before the reverse opened, needs nothing.
 * A round-trip booking that comes back on another date (its group has a return leg elsewhere) leaves its seat on this trip's
 * reverse free to sell, which is how one DR trip can carry more passengers than the bus has seats.
 */
export async function takeLinkedSeats(
  tx: Prisma.TransactionClient,
  tripId: string,
  seatNumbers: string[],
  available: Prisma.SeatWhereInput,
  options: { returnsOnOtherLeg?: boolean; ridesBack?: boolean } = {},
): Promise<number> {
  // A way-there passenger who comes back elsewhere, or not at all (ذهاب فقط), leaves the seat on the reverse for sale.
  if (options.returnsOnOtherLeg || options.ridesBack === false) {
    const trip = await tx.trip.findUnique({ where: { id: tripId }, select: { reverseOfTripId: true } });
    if (trip && !trip.reverseOfTripId) return 0;
  }
  const linkedId = await linkedTripId(tx, tripId);
  if (!linkedId) return 0;
  const existing = await tx.seat.findMany({ where: { tripId: linkedId, seatNumber: { in: seatNumbers } }, select: { seatNumber: true } });
  if (existing.length === 0) return 0;
  const taken = await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: seatNumbers }, ...available },
    data: { isBooked: true, heldByUserId: null, heldUntil: null },
  });
  if (taken.count !== existing.length) {
    // Sold from the reverse: a seat on the way there taken by a passenger who does not ride back is already closed there,
    // and that passenger gets off before this one boards, so it is no conflict.
    const trip = await tx.trip.findUnique({ where: { id: tripId }, select: { reverseOfTripId: true } });
    const closedByRider = trip?.reverseOfTripId ? await ridingBackSeats(tx, linkedId) : null;
    const closedByGoOnly = trip?.reverseOfTripId
      ? await tx.bookingPassenger.count({ where: { seatNumber: { in: seatNumbers.filter((seat) => !closedByRider?.has(seat)) }, booking: { tripId: linkedId, status: { in: HOLDS_A_SEAT } } } })
      : 0;
    if (taken.count + closedByGoOnly !== existing.length) throw new ConflictException('بعض المقاعد المختارة لم تعد متاحة، يرجى اختيار مقاعد أخرى');
  }
  await tx.trip.update({ where: { id: linkedId }, data: { availableSeats: { decrement: taken.count } } });
  // How many places it took there, so a seatless rider given a seat can hand back the place they held by count.
  return taken.count;
}

/**
 * Gives the seats back on the linked trip, except any that a passenger of that trip actually holds.
 * A seat sold before the reverse opened was never on it, so freeing that seat is what puts it on sale there.
 */
export async function releaseLinkedSeats(tx: Prisma.TransactionClient, tripId: string, seatNumbers: string[]) {
  const linkedId = await linkedTripId(tx, tripId);
  if (!linkedId) return;
  const holders = await tx.bookingPassenger.findMany({
    where: { seatNumber: { in: seatNumbers }, booking: { tripId: linkedId, status: { not: 'CANCELLED' } } },
    select: { seatNumber: true },
  });
  const held = new Set(holders.map((passenger) => passenger.seatNumber));
  const free = seatNumbers.filter((seat) => !held.has(seat));
  const released = await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: free }, isBooked: true },
    data: { isBooked: false, heldByUserId: null, heldUntil: null },
  });
  const onLinked = await tx.seat.findMany({ where: { tripId: linkedId, seatNumber: { in: free } }, select: { seatNumber: true } });
  const known = new Set(onLinked.map((seat) => seat.seatNumber));
  const added = free.filter((seat) => !known.has(seat));
  if (added.length > 0) await tx.seat.createMany({ data: added.map((seatNumber) => ({ tripId: linkedId, seatNumber })) });
  if (released.count + added.length > 0) {
    await tx.trip.update({
      where: { id: linkedId },
      data: { availableSeats: { increment: released.count + added.length }, totalSeats: { increment: added.length } },
    });
  }
}

/**
 * A round-trip booking whose return leg elsewhere was cancelled rides back on its own trip's reverse again, so it takes back
 * whichever of its seat numbers are still free there. A number sold meanwhile stays with its buyer; the office reseats them.
 */
export async function retakeReturnSeats(tx: Prisma.TransactionClient, outboundId: string, seatNumbers: string[]) {
  if (seatNumbers.length === 0) return;
  const linkedId = await linkedTripId(tx, outboundId);
  if (!linkedId) return;
  const outbound = await tx.trip.findUnique({ where: { id: outboundId }, select: { reverseOfTripId: true } });
  if (outbound?.reverseOfTripId) return;
  const taken = await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: seatNumbers }, isBooked: false },
    data: { isBooked: true, heldByUserId: null, heldUntil: null },
  });
  if (taken.count > 0) await tx.trip.update({ where: { id: linkedId }, data: { availableSeats: { decrement: taken.count } } });
}

/** Holds the same numbers on the linked trip too, so two customers cannot each hold one seat from opposite directions and block each other at checkout. */
export async function holdLinkedSeats(tx: Prisma.TransactionClient, tripId: string, seatNumbers: string[], hold: { userId: string; heldUntil: Date }, available: Prisma.SeatWhereInput) {
  const linkedId = await linkedTripId(tx, tripId);
  if (!linkedId) return;
  const existing = await tx.seat.count({ where: { tripId: linkedId, seatNumber: { in: seatNumbers } } });
  if (existing === 0) return;
  const held = await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: seatNumbers }, ...available },
    data: { heldByUserId: hold.userId, heldUntil: hold.heldUntil },
  });
  if (held.count !== existing) throw new ConflictException('بعض المقاعد المختارة لم تعد متاحة، يرجى اختيار مقاعد أخرى');
}

/** Lets go of what holdLinkedSeats took. Only these numbers: the same customer may hold other seats on the linked trip for its own leg. */
export async function releaseLinkedHolds(tx: Prisma.TransactionClient, tripId: string, seatNumbers: string[], userId: string) {
  if (seatNumbers.length === 0) return;
  const linkedId = await linkedTripId(tx, tripId);
  if (!linkedId) return;
  await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: seatNumbers }, heldByUserId: userId, isBooked: false },
    data: { heldByUserId: null, heldUntil: null },
  });
}

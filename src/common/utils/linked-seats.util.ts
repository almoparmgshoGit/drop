import { ConflictException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';

const HOLDS_A_SEAT: BookingStatus[] = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];

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

/** Bookings on one-way trips with a reverse enabled that have no return leg, and how many seats they free coming back. */
export async function goOnlyBookings(db: Pick<Prisma.TransactionClient, 'booking'>, tripIds: string[]) {
  const bookings = await db.booking.findMany({
    where: { tripId: { in: tripIds }, status: { in: HOLDS_A_SEAT }, trip: { direction: 'ONE_WAY', reverseEnabled: true } },
    select: { id: true, tripId: true, groupReference: true, _count: { select: { passengers: true } } },
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
 * reverse: the outbound ticket carries them home. A booking with its own leg on another trip goes back on that leg instead.
 */
export async function returningBookingIds(db: Pick<Prisma.TransactionClient, 'booking'>, outboundId: string) {
  const bookings = await db.booking.findMany({
    where: { tripId: outboundId, status: { in: HOLDS_A_SEAT }, trip: { direction: 'ROUND_TRIP' } },
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
    select: { tripId: true, totalPrice: true, _count: { select: { passengers: true } } },
  });
  const totals = new Map<string, { seats: number; revenue: number }>();
  for (const booking of bookings) {
    const total = totals.get(booking.tripId) ?? { seats: 0, revenue: 0 };
    totals.set(booking.tripId, { seats: total.seats + booking._count.passengers, revenue: total.revenue + Number(booking.totalPrice) });
  }
  return totals;
}

/** What the trip's passenger and booking sheets show about its reverse. Null when the trip has none. */
export async function reverseSeatsSummary(db: Pick<Prisma.TransactionClient, 'booking' | 'trip'>, tripId: string) {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: { reverseEnabled: true, reverseTrip: { select: { id: true, tripCode: true, tripStatus: true, availableSeats: true } } },
  });
  if (!trip?.reverseEnabled) return null;
  const { seatsByTrip } = await goOnlyBookings(db, [tripId]);
  const reverse = trip.reverseTrip;
  const booked = reverse ? await bookedOnTrips(db, [reverse.id]) : null;
  return {
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

/** Takes the same seat numbers on the linked trip. A number it never had, because it was sold before the reverse opened, needs nothing. */
export async function takeLinkedSeats(tx: Prisma.TransactionClient, tripId: string, seatNumbers: string[], available: Prisma.SeatWhereInput) {
  const linkedId = await linkedTripId(tx, tripId);
  if (!linkedId) return;
  const existing = await tx.seat.count({ where: { tripId: linkedId, seatNumber: { in: seatNumbers } } });
  if (existing === 0) return;
  const taken = await tx.seat.updateMany({
    where: { tripId: linkedId, seatNumber: { in: seatNumbers }, ...available },
    data: { isBooked: true, heldByUserId: null, heldUntil: null },
  });
  if (taken.count !== existing) throw new ConflictException('بعض المقاعد المختارة لم تعد متاحة، يرجى اختيار مقاعد أخرى');
  await tx.trip.update({ where: { id: linkedId }, data: { availableSeats: { decrement: taken.count } } });
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

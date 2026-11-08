import { Prisma } from '@prisma/client';
import { CREW_WINDOW_SELECT, crewWindow } from './crew-window.util';
import { inTravelOrder } from './trip-route.util';

/** Bookings that still hold a seat and can still board. */
const CAN_BOARD_STATUSES = ['CONFIRMED', 'PENDING_CANCELLATION_REVIEW'];

export const TICKET_BOARDING_TRIP_SELECT = {
  id: true,
  tripStatus: true,
  liveStatus: true,
  arrivalTime: true,
  currentBoardingPointId: true,
  ...CREW_WINDOW_SELECT,
  boardingPoints: { select: { id: true, name: true, time: true } },
  statusUpdates: { where: { status: 'AT_POINT' }, orderBy: { createdAt: 'desc' }, select: { boardingPointId: true, pointName: true } },
} satisfies Prisma.TripSelect;

type TripFacts = Prisma.TripGetPayload<{ select: typeof TICKET_BOARDING_TRIP_SELECT }>;
type PointOfBooking = { boardingPointId: string | null; boardingPointName: string | null };

export type TicketBoardingState = 'WAITING' | 'LATE' | 'STOPPED';

/**
 * How many of the route's points the bus has left. The crew's latest word decides, not the furthest point
 * ever reported, so a mistaken tap on the last point does not stop every ticket once it is corrected.
 */
function pointsLeftBehind(trip: TripFacts, ordered: { id: string; name: string }[]) {
  if (trip.liveStatus === 'ARRIVED') return ordered.length;
  if (trip.liveStatus === 'AT_POINT') return Math.max(ordered.findIndex((point) => point.id === trip.currentBoardingPointId), 0);
  if (trip.liveStatus !== 'ON_ROAD') return 0;
  for (const update of trip.statusUpdates) {
    const index = ordered.findIndex((point) => point.id === update.boardingPointId || point.name === update.pointName);
    if (index >= 0) return index + 1;
  }
  return 0;
}

/**
 * Worked out from the trip each time and never stored, so correcting the crew's status corrects the tickets.
 * A LATE ticket still boards at a later point; a STOPPED one has nowhere left to board.
 */
export function ticketBoarding(booking: PointOfBooking, trip: TripFacts, now = Date.now()) {
  const ordered = inTravelOrder(trip.boardingPoints);
  const leftBehind = pointsLeftBehind(trip, ordered);

  if (trip.liveStatus === 'ARRIVED' || (ordered.length > 0 && leftBehind >= ordered.length)) {
    return { state: 'STOPPED' as TicketBoardingState, reason: 'BUS_LEFT' as const, otherPoints: [] };
  }
  if (trip.tripStatus === 'COMPLETED' || now > trip.arrivalTime.getTime() || now > crewWindow(trip, now).boardingClosesAt.getTime()) {
    return { state: 'STOPPED' as TicketBoardingState, reason: 'TIME_OVER' as const, otherPoints: [] };
  }
  const mine = ordered.findIndex((point) => point.id === booking.boardingPointId || point.name === booking.boardingPointName);
  if (mine < 0 || mine >= leftBehind) return { state: 'WAITING' as TicketBoardingState, reason: null, otherPoints: [] };
  return {
    state: 'LATE' as TicketBoardingState,
    reason: null,
    otherPoints: ordered.slice(leftBehind).map((point) => ({ name: point.name, time: point.time, isCurrent: point.id === trip.currentBoardingPointId })),
  };
}

export type BookingBoarding = Omit<ReturnType<typeof ticketBoarding>, 'reason'> & { reason: 'BUS_LEFT' | 'TIME_OVER' | 'COMPENSATED' | null; isPartial: boolean; compensationAmount?: number };

/** Only bookings with someone still waiting to board get an answer: the rest have nothing to show. */
export async function boardingOfBookings(
  db: {
    trip: { findMany: (args: { where: { id: { in: string[] } }; select: typeof TICKET_BOARDING_TRIP_SELECT }) => Promise<TripFacts[]> };
    ticketCompensation: { findMany: (args: { where: { bookingId: { in: string[] } }; select: { bookingId: true; amount: true } }) => Promise<{ bookingId: string; amount: unknown }[]> };
  },
  bookings: (PointOfBooking & { id: string; status: string; tripId: string; passengers: { ticket: { isBoarded: boolean } | null }[] })[],
) {
  const waiting = bookings.filter((booking) => CAN_BOARD_STATUSES.includes(booking.status) && booking.passengers.some((passenger) => passenger.ticket && !passenger.ticket.isBoarded));
  const result = new Map<string, BookingBoarding>();
  if (waiting.length === 0) return result;
  const trips = await db.trip.findMany({ where: { id: { in: [...new Set(waiting.map((booking) => booking.tripId))] } }, select: TICKET_BOARDING_TRIP_SELECT });
  const tripById = new Map(trips.map((trip) => [trip.id, trip]));
  const compensated = new Map((await db.ticketCompensation.findMany({ where: { bookingId: { in: waiting.map((booking) => booking.id) } }, select: { bookingId: true, amount: true } })).map((row) => [row.bookingId, Number(row.amount)]));
  const now = Date.now();
  for (const booking of waiting) {
    const trip = tripById.get(booking.tripId);
    if (!trip || trip.tripStatus === 'CANCELLED' || trip.tripStatus === 'DRAFT') continue;
    const isPartial = booking.passengers.some((passenger) => passenger.ticket?.isBoarded);
    // Compensated means settled: the crew moving the bus back must not reopen a ticket already paid for.
    if (compensated.has(booking.id)) result.set(booking.id, { state: 'STOPPED', reason: 'COMPENSATED', otherPoints: [], isPartial, compensationAmount: compensated.get(booking.id) });
    else result.set(booking.id, { ...ticketBoarding(booking, trip, now), isPartial });
  }
  return result;
}

import { addDays, startOfRiyadhDay } from './time.util';

const HOUR_MS = 60 * 60 * 1000;
// Unpaid and cancelled bookings have no seat on the bus, so they have no trip to follow.
const TRAVELING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];

interface TripDayInput {
  bookingStatus: string;
  departureTime: Date;
  arrivalTime: Date;
  tripStatus: string;
  liveStatus: string;
}

/**
 * When a passenger can open the "my trip now" page: the Saudi calendar days the trip runs on.
 * A bus the crew says is moving keeps it open past those days, up to the same limit as location sharing,
 * so a delay past midnight or a bus that sets off just before its departure day does not lock the page.
 */
export function tripDayWindow(trip: TripDayInput, closesAfterHours: number, now = new Date()) {
  const opensAt = startOfRiyadhDay(trip.departureTime);
  const time = now.getTime();
  const isOnTripDays = time >= opensAt.getTime() && time < addDays(startOfRiyadhDay(trip.arrivalTime), 1).getTime();
  const isBusMoving = (trip.liveStatus === 'AT_POINT' || trip.liveStatus === 'ON_ROAD') && time <= trip.arrivalTime.getTime() + closesAfterHours * HOUR_MS;
  const isOpen = TRAVELING_STATUSES.includes(trip.bookingStatus) && trip.tripStatus !== 'CANCELLED' && (isOnTripDays || isBusMoving);
  return { isOpen, opensAt };
}

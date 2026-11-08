const MINUTE_MS = 60_000;

export const MAX_CREW_OPENS_BEFORE_MINUTES = 7 * 24 * 60;
// A boarded booking cannot be cancelled, so opening boarding earlier than this could be used to lock a refund.
export const MAX_BOARDING_OPENS_BEFORE_MINUTES = 24 * 60;
export const MAX_BOARDING_CLOSES_AFTER_MINUTES = 24 * 60;

export interface CrewWindowSettings {
  departureTime: Date;
  crewOpensBeforeMinutes: number;
  boardingOpensBeforeMinutes: number;
  boardingClosesAfterMinutes: number;
}

/** When a trip opens to its crew and when its boarding runs, from the minutes set on the trip. */
export function crewWindow(trip: CrewWindowSettings, now = Date.now()) {
  const departure = trip.departureTime.getTime();
  const tripOpensAt = new Date(departure - trip.crewOpensBeforeMinutes * MINUTE_MS);
  const boardingOpensAt = new Date(departure - trip.boardingOpensBeforeMinutes * MINUTE_MS);
  const boardingClosesAt = new Date(departure + trip.boardingClosesAfterMinutes * MINUTE_MS);
  return {
    tripOpensAt,
    boardingOpensAt,
    boardingClosesAt,
    isTripOpen: now >= tripOpensAt.getTime(),
    isBoardingOpen: now >= boardingOpensAt.getTime() && now <= boardingClosesAt.getTime(),
  };
}

export const CREW_WINDOW_SELECT = {
  departureTime: true,
  crewOpensBeforeMinutes: true,
  boardingOpensBeforeMinutes: true,
  boardingClosesAfterMinutes: true,
} as const;

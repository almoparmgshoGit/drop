const MINUTE_MS = 60_000;

export const MAX_CREW_OPENS_BEFORE_MINUTES = 7 * 24 * 60;
// A boarded booking cannot be cancelled, so opening boarding earlier than this could be used to lock a refund.
// Staff can still open it earlier by hand for one trip, which is recorded in the audit log.
export const MAX_BOARDING_OPENS_BEFORE_MINUTES = 24 * 60;
export const MAX_BOARDING_CLOSES_AFTER_MINUTES = 24 * 60;

export interface CrewWindowSettings {
  departureTime: Date;
  crewOpensBeforeMinutes: number;
  boardingOpensBeforeMinutes: number;
  boardingClosesAfterMinutes: number;
  boardingOpenedManuallyAt?: Date | null;
}

/**
 * When a trip opens to its crew and when its boarding runs, from the minutes set on the trip.
 * Boarding opened by hand starts then instead, and opens the trip to its crew with it.
 */
export function crewWindow(trip: CrewWindowSettings, now = Date.now()) {
  const departure = trip.departureTime.getTime();
  const manual = trip.boardingOpenedManuallyAt?.getTime();
  const scheduledTripOpens = departure - trip.crewOpensBeforeMinutes * MINUTE_MS;
  const scheduledBoardingOpens = departure - trip.boardingOpensBeforeMinutes * MINUTE_MS;
  const tripOpensAt = new Date(manual !== undefined ? Math.min(scheduledTripOpens, manual) : scheduledTripOpens);
  const boardingOpensAt = new Date(manual !== undefined ? Math.min(scheduledBoardingOpens, manual) : scheduledBoardingOpens);
  const boardingClosesAt = new Date(departure + trip.boardingClosesAfterMinutes * MINUTE_MS);
  return {
    tripOpensAt,
    boardingOpensAt,
    boardingClosesAt,
    isBoardingOpenedManually: manual !== undefined,
    isTripOpen: now >= tripOpensAt.getTime(),
    isBoardingOpen: now >= boardingOpensAt.getTime() && now <= boardingClosesAt.getTime(),
  };
}

export const CREW_WINDOW_SELECT = {
  departureTime: true,
  crewOpensBeforeMinutes: true,
  boardingOpensBeforeMinutes: true,
  boardingClosesAfterMinutes: true,
  boardingOpenedManuallyAt: true,
} as const;

import { Prisma } from '@prisma/client';
import { CrewWindowSettings, MAX_BOARDING_CLOSES_AFTER_MINUTES, crewWindow } from './crew-window.util';
import { inTravelOrder, minutesAfterDeparture } from './trip-route.util';

const MINUTE_MS = 60_000;

/** The crew's reports the app reads to know which points the bus has already left. */
export const APP_SALES_STATUS_UPDATES = {
  where: { status: 'AT_POINT' },
  orderBy: { createdAt: 'desc' },
  select: { boardingPointId: true, pointName: true },
} satisfies Prisma.Trip$statusUpdatesArgs;

/** What a trip query adds to tell which points the app still sells (the trip's own fields come with it). */
export const APP_SALES_INCLUDE = {
  boardingPoints: { select: { id: true, name: true, time: true } },
  statusUpdates: APP_SALES_STATUS_UPDATES,
} satisfies Prisma.TripInclude;

/**
 * The trips the app may still sell, before the per-point check: not started and not yet due, or under way (or due with no
 * word from the crew) on a trip with boarding points, while its boarding window can still be open.
 */
export function appSellingWindowWhere(now: Date): Prisma.TripWhereInput {
  return {
    OR: [
      { liveStatus: 'NOT_STARTED', departureTime: { gt: now } },
      {
        liveStatus: { in: ['NOT_STARTED', 'ON_ROAD', 'AT_POINT'] },
        departureTime: { gt: new Date(now.getTime() - MAX_BOARDING_CLOSES_AFTER_MINUTES * MINUTE_MS) },
        arrivalTime: { gt: now },
        boardingPoints: { some: {} },
      },
    ],
  };
}

type Point = { id: string; name: string; time: string };
export type AppSalesTrip = CrewWindowSettings & {
  liveStatus: string;
  arrivalTime: Date;
  currentBoardingPointId: string | null;
  boardingPoints: Point[];
  statusUpdates?: { boardingPointId: string | null; pointName: string | null }[];
};

/** Whether the bus has set off, by the crew's word or by the clock. */
export const hasSetOff = (trip: { liveStatus: string; departureTime: Date }, now = Date.now()) =>
  trip.liveStatus !== 'NOT_STARTED' || trip.departureTime.getTime() <= now;

/**
 * The boarding points a customer can still book from in the app. Before the bus sets off, every point. Once it has, only
 * the points ahead of it: the point it stands at and every point it left are closed, and with no word from the crew a
 * point whose time has passed is closed too. Nothing once the trip's boarding window has closed, as its tickets stop then.
 */
export function appOpenPoints<T extends Point>(trip: AppSalesTrip & { boardingPoints: T[] }, now = Date.now()): T[] {
  if (!hasSetOff(trip, now)) return trip.boardingPoints;
  if (!['NOT_STARTED', 'ON_ROAD', 'AT_POINT'].includes(trip.liveStatus)) return [];
  if (now >= trip.arrivalTime.getTime() || now > crewWindow(trip, now).boardingClosesAt.getTime()) return [];
  const ordered = inTravelOrder(trip.boardingPoints);
  let passed = 0;
  if (trip.liveStatus === 'AT_POINT') {
    passed = ordered.findIndex((point) => point.id === trip.currentBoardingPointId) + 1;
  } else if (trip.liveStatus === 'ON_ROAD') {
    // The crew's latest point decides, as on the tickets, so a mistaken tap that was corrected does not close the route.
    for (const update of trip.statusUpdates ?? []) {
      const index = ordered.findIndex((point) => point.id === update.boardingPointId || point.name === update.pointName);
      if (index >= 0) {
        passed = index + 1;
        break;
      }
    }
  }
  const ahead = ordered.slice(passed);
  // Under way, the crew's word is what counts, so a late bus does not close points it has not reached.
  if (trip.liveStatus !== 'NOT_STARTED') return ahead;
  const departure = trip.departureTime.getTime();
  return ahead.filter((point) => departure + minutesAfterDeparture(point.time, trip.departureTime) * MINUTE_MS > now);
}

/** Whether the app still sells the trip from at least one point. */
export const appStillSells = (trip: AppSalesTrip, now = Date.now()) => !hasSetOff(trip, now) || appOpenPoints(trip, now).length > 0;

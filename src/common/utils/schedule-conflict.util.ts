import { Prisma, TripStatus } from '@prisma/client';
import { riyadhDate } from './time.util';

/**
 * The rules a trip's bus and crew are checked against, shared by the save-time guard (assertNoScheduleConflict), the
 * availability the trip form asks for while it is filled in, and the operations board. Keeping them here means the
 * warnings the office sees beforehand are the same refusals the server gives on saving.
 */

/** Only drafts and published trips hold their bus and crew; a cancelled or completed trip frees them. */
export const SCHEDULED_TRIP_STATUSES: TripStatus[] = ['DRAFT', 'PUBLISHED'];

/** Trips that hold a bus or crew at some moment of [start, end), leaving out the given trips. */
export const scheduleOverlapWhere = (start: Date, end: Date, excludeTripIds?: string[]): Prisma.TripWhereInput => ({
  id: excludeTripIds?.length ? { notIn: excludeTripIds } : undefined,
  tripStatus: { in: SCHEDULED_TRIP_STATUSES },
  departureTime: { lt: end },
  arrivalTime: { gt: start },
});

/** Approved leave counts in Riyadh calendar days, so any day the trip touches is a day the person must be at work. */
export const approvedLeaveWhere = (start: Date, end: Date): Prisma.LeaveRequestWhereInput => ({
  status: 'APPROVED',
  startDate: { lte: new Date(`${riyadhDate(end)}T00:00:00.000Z`) },
  endDate: { gte: new Date(`${riyadhDate(start)}T00:00:00.000Z`) },
});

/**
 * What another trip must share with this one to clash. A supervisor may look after several trips at once, but a driver
 * is behind one wheel: whoever drives a trip at that time cannot join another, and whoever is to drive this one cannot be
 * on another trip.
 */
export const crewClashResources = (busId: string | null | undefined, driverIds: string[], supervisorIds: string[]): Prisma.TripWhereInput[] => {
  const people = [...driverIds, ...supervisorIds];
  const resources: Prisma.TripWhereInput[] = [];
  if (busId) resources.push({ busId });
  if (people.length > 0) resources.push({ drivers: { some: { userId: { in: people } } } });
  if (driverIds.length > 0) resources.push({ supervisors: { some: { userId: { in: driverIds } } } });
  return resources;
};

type Timed = { departureTime: Date; arrivalTime: Date };

/** Whether two trips are on the road at the same moment, by the same half-open rule as scheduleOverlapWhere. */
export const tripsOverlap = (a: Timed, b: Timed) => a.departureTime < b.arrivalTime && a.arrivalTime > b.departureTime;

/** Whether a leave from startDate to endDate (calendar days) covers any Riyadh day of the trip, as approvedLeaveWhere. */
export const leaveCoversTrip = (leave: { startDate: Date; endDate: Date }, trip: Timed) =>
  leave.startDate.getTime() <= new Date(`${riyadhDate(trip.arrivalTime)}T00:00:00.000Z`).getTime() &&
  leave.endDate.getTime() >= new Date(`${riyadhDate(trip.departureTime)}T00:00:00.000Z`).getTime();

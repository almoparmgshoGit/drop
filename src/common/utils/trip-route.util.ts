const HOUR_MS = 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * HOUR_MS;
/** A boarding point's time can fall before departure, because passengers gather first. */
const GATHERS_BEFORE_DEPARTURE_MINUTES = 6 * 60;
const MINUTES_IN_DAY = 1440;

export const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minutes from departure to a clock time carrying no date, which may fall before departure while passengers gather. */
export function minutesAfterDeparture(time: string, departureTime: Date) {
  const departureClock = clockMinutes(new Date(departureTime.getTime() + RIYADH_OFFSET_MS).toISOString().slice(11, 16));
  // Times are free text on the trip form, and one that is not a clock time must not scramble the order.
  return ((clockMinutes(time) - departureClock + GATHERS_BEFORE_DEPARTURE_MINUTES + MINUTES_IN_DAY) % MINUTES_IN_DAY) - GATHERS_BEFORE_DEPARTURE_MINUTES || 0;
}

/**
 * Points in the order the bus reaches them, from their own times: the journey starts after the longest gap round the clock,
 * so 23:00 comes before 01:00. Stopping a ticket hangs on this, so it does not depend on how long before departure passengers gather.
 */
export function inTravelOrder<T extends { time: string }>(points: T[]) {
  const minutes = (point: T) => clockMinutes(point.time) || 0;
  const byClock = [...points].sort((a, b) => minutes(a) - minutes(b));
  let start = 0;
  let widestGap = -1;
  byClock.forEach((point, index) => {
    const previous = byClock[(index - 1 + byClock.length) % byClock.length];
    const gap = (minutes(point) - minutes(previous) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
    if (gap > widestGap) {
      widestGap = gap;
      start = index;
    }
  });
  return [...byClock.slice(start), ...byClock.slice(0, start)];
}

export interface RoutePointInput {
  id: string;
  name: string;
  time: string;
  isMine?: boolean;
  isCurrent: boolean;
  reached: boolean;
}

export interface RouteStopInput {
  id: string;
  title: string;
  time: string;
  kind: string;
}

/** Boarding points and stops in travel order, so a stop falls between the points either side of it. */
export function orderRouteLegs(points: RoutePointInput[], stops: RouteStopInput[], destination: string, departureTime: Date) {
  return [
    ...points.map((point) => ({ id: point.id, kind: 'POINT', name: point.name, time: point.time, isMine: !!point.isMine, isCurrent: point.isCurrent, reached: point.reached })),
    ...stops.filter((stop) => stop.title !== destination).map((stop) => ({ id: stop.id, kind: stop.kind, name: stop.title, time: stop.time, isMine: false, isCurrent: false, reached: false })),
  ].sort((a, b) => minutesAfterDeparture(a.time, departureTime) - minutesAfterDeparture(b.time, departureTime));
}

/** Only the crew's word moves the bus along the route: anything before the last place it reported has been passed. */
export function markPassedLegs<T extends { isCurrent: boolean; reached: boolean }>(legs: T[], hasArrived: boolean) {
  const lastReported = legs.reduce((last, leg, index) => (leg.isCurrent || leg.reached ? index : last), -1);
  return legs.map(({ reached: _reached, ...leg }, index) => ({ ...leg, isPassed: hasArrived || index < lastReported || (index === lastReported && !leg.isCurrent) }));
}

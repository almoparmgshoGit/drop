import { Prisma } from '@prisma/client';

/**
 * The company's one bus plan, supplied by the client and the same for every bus. The panel and the app draw it from here,
 * so nothing else decides where a seat sits. Rows run front to back; each reads from the door side (the right of the bus)
 * across the aisle. Null is an empty place: the aisle, or the gap beside the middle door in rows 6 and 7.
 */
export const BUS_SEAT_LAYOUT: readonly (readonly (string | null)[])[] = [
  ['1', '2', null, '3', '4'],
  ['5', '6', null, '7', '8'],
  ['9', '10', null, '11', '12'],
  ['13', '14', null, '15', '16'],
  ['17', '18', null, '19', '20'],
  [null, null, null, '21', '22'],
  [null, null, null, '23', '24'],
  ['25', '26', null, '27', '28'],
  ['29', '30', null, '31', '32'],
  ['33', '34', null, '35', '36'],
  ['37', '38', null, '39', '40'],
  ['41', '42', null, '43', '44'],
  ['45', '46', '47', '48', '49'],
];

export const BUS_SEAT_NUMBERS = BUS_SEAT_LAYOUT.flat().filter((seat): seat is string => seat !== null);

export const BUS_SEAT_COUNT = BUS_SEAT_NUMBERS.length;

export type SeatLayout = (string | null)[][];

/** A van or minibus holds at least this many and fewer than a bus. */
export const MIN_SMALL_VEHICLE_SEATS = 4;
export const MAX_SMALL_VEHICLE_SEATS = 48;

/**
 * Draws a van's or a minibus's seats from its count, on the same five columns as the bus so every screen draws it alike:
 * two by the door, the aisle, two by the driver. Five seats left over make a back bench across the aisle, as on the bus.
 */
export function generateSeatLayout(count: number): SeatLayout {
  const rows: SeatLayout = [];
  let next = 1;
  const seat = () => String(next++);
  for (let remaining = count; remaining > 0; ) {
    if (remaining === 5) {
      rows.push([seat(), seat(), seat(), seat(), seat()]);
      remaining = 0;
      continue;
    }
    const inRow = Math.min(4, remaining);
    // A short last row fills the door side first.
    const row = [null, null, null, null, null] as (string | null)[];
    [0, 1, 3, 4].slice(0, inRow).forEach((column) => (row[column] = seat()));
    rows.push(row);
    remaining -= inRow;
  }
  return rows;
}

/** The plan a vehicle seats passengers on: the fixed one for a bus, one drawn from the count for anything smaller. */
export function seatLayoutFor(vehicle: { kind: string; seatCount: number } | null | undefined): SeatLayout {
  return !vehicle || vehicle.kind === 'BUS' ? (BUS_SEAT_LAYOUT as SeatLayout) : generateSeatLayout(vehicle.seatCount);
}

export const seatNumbersOf = (layout: SeatLayout) => layout.flat().filter((seat): seat is string => seat !== null);

/** A trip keeps the plan it was set up for; one saved before vehicles had their own plans is on the standard bus. */
export const tripSeatLayout = (trip: { seatLayout?: unknown }): SeatLayout =>
  Array.isArray(trip.seatLayout) ? (trip.seatLayout as SeatLayout) : (BUS_SEAT_LAYOUT as SeatLayout);

export const sameSeatLayout = (a: SeatLayout, b: SeatLayout) => JSON.stringify(a) === JSON.stringify(b);

/** What goes in Trip.seatLayout: nothing for the standard plan, so those trips read like the ones saved before. */
export const storedSeatLayout = (layout: SeatLayout) => (sameSeatLayout(layout, BUS_SEAT_LAYOUT as SeatLayout) ? Prisma.DbNull : (layout as Prisma.InputJsonValue));

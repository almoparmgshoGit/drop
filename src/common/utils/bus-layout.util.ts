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

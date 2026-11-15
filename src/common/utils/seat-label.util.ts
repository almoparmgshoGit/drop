/** How a passenger saved without a seat reads on every booking list, manifest and ticket until the office gives them one. */
export const NO_SEAT_LABEL = 'بدون مقعد';

export const seatLabel = (seat: string | null | undefined) => seat || NO_SEAT_LABEL;

/** Seats in number order, the passengers without one last. */
export const compareSeats = (a: string | null | undefined, b: string | null | undefined) => (a ? (b ? Number(a) - Number(b) : -1) : b ? 1 : 0);

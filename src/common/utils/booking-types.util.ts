export const BOOKING_TYPES = ['TRANSPORT_ONLY', 'WITH_HOTEL', 'WITH_VISITS', 'WITH_HOTEL_VISITS'];

const HOUSING_TYPES = ['WITH_HOTEL', 'WITH_HOTEL_VISITS'];

export const HOUSING_BOOKING_TYPES = HOUSING_TYPES;

export const includesHousing = (bookingType: string) => HOUSING_TYPES.includes(bookingType);

/** A branch can sell a stay on a transport trip, or transport alone on a housing trip, so the booking decides and not only the trip. */
export const bookingHasStay = (tripBookingType: string, booking: { kind: string | null; roomChoice: string | null; stayHotelId: string | null }) =>
  !!booking.stayHotelId || !!booking.roomChoice || (includesHousing(tripBookingType) && !booking.kind);

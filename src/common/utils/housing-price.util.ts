import { HousingPriceMode, HousingPricePeriod, Prisma, PrivateRoomPriceBasis, RoomType } from '@prisma/client';

type Money = Prisma.Decimal | number | null;

/** How a trip charges for housing; copied from its hotel when chosen, then editable per trip. */
export type HousingTerms = {
  housingPrice: Money;
  privateRoomPrice: Money;
  privateRoomCapacity: number | null;
  housingPriceMode: HousingPriceMode;
  privateRoomPriceBasis: PrivateRoomPriceBasis;
  housingPricePeriod: HousingPricePeriod;
};

const toHalalas = (value: Money) => Math.round(Number(value ?? 0) * 100);

/** A hotel sold on its own customer prices, with no trip: housing is charged in full, never folded into a seat price. */
export const hotelHousingTerms = (hotel: {
  bedPrice: Money;
  privateRoomPrice: Money;
  privateRoomCapacity: number | null;
  privateRoomPriceBasis: PrivateRoomPriceBasis;
  housingPricePeriod: HousingPricePeriod;
}): HousingTerms => ({
  housingPrice: hotel.bedPrice,
  privateRoomPrice: hotel.privateRoomPrice,
  privateRoomCapacity: hotel.privateRoomCapacity,
  housingPriceMode: 'ADDED_TO_BASE',
  privateRoomPriceBasis: hotel.privateRoomPriceBasis,
  housingPricePeriod: hotel.housingPricePeriod,
});

const stayUnits = (terms: HousingTerms, nights: number) => (terms.housingPricePeriod === 'PER_NIGHT' ? Math.max(1, nights) : 1);

/** When housing is added to the base price, a room type without a price cannot be sold, or it would be free. */
export const isRoomSellable = (terms: HousingTerms, room: RoomType) =>
  terms.housingPriceMode === 'INCLUDED_IN_BASE' || (room === 'SHARED' ? terms.housingPrice : terms.privateRoomPrice) !== null;

/** Halalas charged on top of the seat prices. When housing is included in the base price, only a private room's extra is charged. */
export function housingCharge(terms: HousingTerms, room: RoomType, seats: number, nights: number, privateRooms = 1) {
  const units = stayUnits(terms, nights);
  if (room === 'SHARED') return terms.housingPriceMode === 'ADDED_TO_BASE' ? toHalalas(terms.housingPrice) * seats * units : 0;

  // A private room is the booking owner's: one nightly price for the whole booking, however many companions share it,
  // so a family pays for its one room times the nights, never a room per person nor one price for the whole stay.
  // A group larger than the room may take more rooms, each at the hotel's price for one.
  return toHalalas(terms.privateRoomPrice) * Math.max(1, nights) * Math.max(1, privateRooms);
}

/** How many private rooms the travellers need to fit, from the hotel's room capacity; one when it is not set. */
export const privateRoomsNeeded = (capacity: number | null | undefined, persons: number) =>
  capacity && capacity > 0 ? Math.max(1, Math.ceil(persons / capacity)) : 1;

/**
 * How a booking's price splits across its passengers, in their entered order: each seat the same, and a private room all on the
 * first passenger, the booking's owner, so the companions carry their transport only.
 */
export function passengerWeights(booking: { roomChoice: RoomType | null; housingAmount: Money; subtotal: Money; passengers: unknown[] }) {
  const equal = booking.passengers.map(() => 1);
  const room = booking.roomChoice === 'PRIVATE' ? toHalalas(booking.housingAmount) : 0;
  const seats = toHalalas(booking.subtotal) - room;
  if (room <= 0 || seats < 0 || booking.passengers.length === 0) return equal;
  return booking.passengers.map((_, idx) => seats / booking.passengers.length + (idx === 0 ? room : 0));
}

/** What housing is worth per person inside the base price, for the sales report; nothing is charged for it. */
export const includedBedValue = (terms: HousingTerms, nights: number) =>
  terms.housingPriceMode === 'INCLUDED_IN_BASE' ? (toHalalas(terms.housingPrice) * stayUnits(terms, nights)) / 100 : 0;

/** The lowest seat price a customer can expect, so a trip card does not show less than they will pay. */
export const startingSeatPrice = (seatPrice: number, terms: HousingTerms, nights: number) =>
  terms.housingPriceMode === 'ADDED_TO_BASE' ? seatPrice + (toHalalas(terms.housingPrice) * stayUnits(terms, nights)) / 100 : seatPrice;

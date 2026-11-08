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

const stayUnits = (terms: HousingTerms, nights: number) => (terms.housingPricePeriod === 'PER_NIGHT' ? Math.max(1, nights) : 1);

/** When housing is added to the base price, a room type without a price cannot be sold, or it would be free. */
export const isRoomSellable = (terms: HousingTerms, room: RoomType) =>
  terms.housingPriceMode === 'INCLUDED_IN_BASE' || (room === 'SHARED' ? terms.housingPrice : terms.privateRoomPrice) !== null;

/** Halalas charged on top of the seat prices. When housing is included in the base price, only a private room's extra is charged. */
export function housingCharge(terms: HousingTerms, room: RoomType, seats: number, nights: number) {
  const units = stayUnits(terms, nights);
  if (room === 'SHARED') return terms.housingPriceMode === 'ADDED_TO_BASE' ? toHalalas(terms.housingPrice) * seats * units : 0;

  const price = toHalalas(terms.privateRoomPrice) * units;
  if (terms.privateRoomPriceBasis === 'PER_PERSON') return price * seats;
  if (terms.privateRoomPriceBasis === 'PER_BOOKING') return price;
  return price * Math.ceil(seats / Math.max(1, terms.privateRoomCapacity ?? seats));
}

/** What housing is worth per person inside the base price, for the sales report; nothing is charged for it. */
export const includedBedValue = (terms: HousingTerms, nights: number) =>
  terms.housingPriceMode === 'INCLUDED_IN_BASE' ? (toHalalas(terms.housingPrice) * stayUnits(terms, nights)) / 100 : 0;

/** The lowest seat price a customer can expect, so a trip card does not show less than they will pay. */
export const startingSeatPrice = (seatPrice: number, terms: HousingTerms, nights: number) =>
  terms.housingPriceMode === 'ADDED_TO_BASE' ? seatPrice + (toHalalas(terms.housingPrice) * stayUnits(terms, nights)) / 100 : seatPrice;

import { HotelRateUnit, RoomType } from '@prisma/client';
type Money = number | string | { toString(): string };

export const PAID_PAYMENT_STATUSES = ['COMPLETED', 'SIMULATED'];

export const halalas = (value: Money) => Math.round(Number(value) * 100);

/**
 * What a booking has really brought in, in halalas. Payment.amount is only what is due until the
 * payment is marked paid, so nothing may treat it as money received before then.
 */
export function paymentFigures(
  payment: { amount: Money; walletAmount: Money; status: string } | null | undefined,
  collections: { amount: Money }[] = [],
) {
  if (!payment) return { received: 0, wallet: 0, remaining: 0, isPaid: false };
  const due = halalas(payment.amount);
  const isPaid = PAID_PAYMENT_STATUSES.includes(payment.status);
  const collected = collections.reduce((sum, row) => sum + halalas(row.amount), 0);
  return {
    received: isPaid ? due : collected,
    wallet: halalas(payment.walletAmount),
    remaining: isPaid ? 0 : Math.max(0, due - collected),
    isPaid,
  };
}

/**
 * What the company holds and is still owed on a booking, in halalas, after any refund.
 * A cancelled booking is owed nothing, whatever was left unpaid on it.
 */
export function netBookingFigures(booking: {
  status: string;
  refundAmount: Money | null;
  externalRefunded: Money;
  payment: { amount: Money; walletAmount: Money; status: string } | null;
  collections: { amount: Money }[];
  cashMovements: { amount: Money }[];
}) {
  const { received, wallet, remaining } = paymentFigures(booking.payment, booking.collections);
  const cashRefunded = booking.cashMovements.reduce((sum, row) => sum + halalas(row.amount), 0);
  const held = Math.max(0, received + wallet - halalas(booking.refundAmount ?? 0) - halalas(booking.externalRefunded) - cashRefunded);
  return { held, remaining: booking.status === 'CANCELLED' ? 0 : remaining };
}

/**
 * How a refund to the original payment method divides, in halalas. Money paid from the wallet can
 * only return to the wallet, so whatever exceeds the money received goes back there.
 */
export function splitOriginalRefund(refund: number, received: number, collections: { amount: Money; method: string }[]) {
  const collectedCash = collections.filter((row) => row.method === 'CASH').reduce((sum, row) => sum + halalas(row.amount), 0);
  const original = Math.min(refund, received);
  const cash = Math.min(original, collectedCash);
  return { wallet: refund - original, cash, external: original - cash };
}

type BilledRoom = { type: RoomType; _count: { occupants: number } };
type CostedHotelBooking = { nightlyRate: Money; privateNightlyRate?: Money | null; rateUnit: HotelRateUnit; extraCost: Money; checkIn: Date; checkOut: Date; rooms: BilledRoom[] };

/** What the hotel bills on: each room with someone in it, or each person when the contract is by the bed. */
export function billedUnits(booking: { rateUnit: HotelRateUnit; rooms: { _count: { occupants: number } }[] }) {
  const occupied = booking.rooms.filter((room) => room._count.occupants > 0);
  return booking.rateUnit === 'BED' ? occupied.reduce((sum, room) => sum + room._count.occupants, 0) : occupied.length;
}

/** Nights between check-in and check-out. */
export const hotelNights = (booking: { checkIn: Date; checkOut: Date }) =>
  Math.round((booking.checkOut.getTime() - booking.checkIn.getTime()) / (24 * 60 * 60 * 1000));

/**
 * The stay's cost by room type, in halalas: shared rooms at nightlyRate, private ones at
 * privateNightlyRate (or nightlyRate when the hotel has no separate private cost). Without extraCost.
 */
export function hotelCostByType(booking: CostedHotelBooking) {
  const nights = hotelNights(booking);
  return (['SHARED', 'PRIVATE'] as RoomType[])
    .map((type) => {
      const rooms = booking.rooms.filter((room) => room.type === type);
      const rate = halalas(type === 'PRIVATE' ? (booking.privateNightlyRate ?? booking.nightlyRate) : booking.nightlyRate);
      const units = billedUnits({ rateUnit: booking.rateUnit, rooms });
      const occupied = rooms.filter((room) => room._count.occupants > 0).length;
      return { type, rooms: occupied, units, nights, rate, amount: rate * units * nights };
    })
    .filter((row) => row.rooms > 0);
}

/** The billed units for every night of the stay at their room type's rate, plus any extra charge. In halalas. */
export function hotelBookingCost(booking: CostedHotelBooking) {
  return hotelCostByType(booking).reduce((sum, row) => sum + row.amount, 0) + halalas(booking.extraCost);
}

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BUS_SEAT_COUNT } from './bus-layout.util';

export interface SinglesRange {
  from: number;
  to: number;
}

export const isSinglesSeat = (seat: string | number, range: SinglesRange) => Number(seat) >= range.from && Number(seat) <= range.to;

export const describeSinglesRange = (range: SinglesRange) => `من ${range.from} إلى ${range.to}`;

/** Checked against the fixed plan wherever a range is saved, on a bus or in the settings. */
export function assertValidSinglesRange(range: SinglesRange) {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1 || range.to > BUS_SEAT_COUNT || range.from > range.to) {
    throw new BadRequestException(`نطاق مقاعد العزّاب يجب أن يكون بين 1 و${BUS_SEAT_COUNT}، وبدايته لا تتجاوز نهايته`);
  }
}

/**
 * A bus can reach a trip after it went on sale, and a range can change while bookings exist. Nobody already seated is
 * moved silently: the change is refused and names who is in the way, so staff can move that passenger first.
 */
export async function assertSinglesFitRange(db: Pick<Prisma.TransactionClient, 'bookingPassenger'>, trips: Prisma.TripWhereInput, range: SinglesRange) {
  const passengers = await db.bookingPassenger.findMany({
    where: { booking: { category: 'SINGLES', status: { not: 'CANCELLED' }, trip: trips } },
    select: { seatNumber: true, booking: { select: { trip: { select: { tripCode: true } } } } },
  });
  const outside = passengers.find((passenger) => !isSinglesSeat(passenger.seatNumber, range));
  if (outside) {
    throw new ConflictException(
      `المقعد ${outside.seatNumber} في الرحلة ${outside.booking.trip.tripCode} محجوز لعزّاب وهو خارج النطاق ${describeSinglesRange(range)}. انقل الراكب أولًا`,
    );
  }
}

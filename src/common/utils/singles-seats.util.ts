import { BadRequestException, ConflictException } from '@nestjs/common';
import { BookingCategory, Gender, Prisma } from '@prisma/client';
import { BUS_SEAT_COUNT } from './bus-layout.util';

export interface SinglesRange {
  from: number;
  to: number;
}

export const isSinglesSeat = (seat: string | number, range: SinglesRange) => Number(seat) >= range.from && Number(seat) <= range.to;

export const describeSinglesRange = (range: SinglesRange) => `من ${range.from} إلى ${range.to}`;

/**
 * Who the booking is decides its section: a booking with a woman in it is a family booking, wherever she sits and however
 * few travel, and one of men only sits with the individuals. Null while a traveller's gender is still unknown, as on a seat
 * hold before the passenger details, so the section picked stands until the booking itself is checked.
 */
export function categoryForGenders(genders: (Gender | null | undefined)[]): BookingCategory | null {
  if (genders.some((gender) => gender === 'FEMALE')) return 'FAMILY';
  if (genders.length > 0 && genders.every((gender) => gender === 'MALE')) return 'SINGLES';
  return null;
}

export function assertCategoryMatchesGenders(category: BookingCategory, genders: (Gender | null | undefined)[]) {
  const expected = categoryForGenders(genders);
  if (!expected || expected === category) return;
  throw new BadRequestException(
    expected === 'FAMILY'
      ? 'الحجز الذي فيه أنثى حجز عائلات: اختر المقاعد من مقاعد العائلات'
      : 'المسافرون كلهم ذكور فالحجز حجز أفراد: اختر المقاعد من مقاعد الأفراد',
  );
}

/** Checked against the vehicle's seats wherever a range is saved, on a bus or in the settings (which follow the standard bus). */
export function assertValidSinglesRange(range: SinglesRange, capacity = BUS_SEAT_COUNT) {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1 || range.to > capacity || range.from > range.to) {
    throw new BadRequestException(`نطاق مقاعد الأفراد يجب أن يكون بين 1 و${capacity}، وبدايته لا تتجاوز نهايته`);
  }
}

/**
 * Where singles start on a new vehicle of this size. The settings describe the standard bus: a vehicle they fit keeps them,
 * a smaller one they do not fit starts with singles on its back half, and a larger bus keeps the same share of its seats at
 * the back, running to its last seat when the settings run to the standard bus's last.
 */
export function singlesRangeFor(settings: SinglesRange, seatCount: number): SinglesRange {
  if (seatCount === BUS_SEAT_COUNT || (seatCount < BUS_SEAT_COUNT && settings.to <= seatCount)) return settings;
  if (seatCount < BUS_SEAT_COUNT) return { from: Math.floor(seatCount / 2) + 1, to: seatCount };
  const scale = (seat: number) => Math.round((seat * seatCount) / BUS_SEAT_COUNT);
  const from = Math.min(seatCount, scale(settings.from - 1) + 1);
  const to = settings.to === BUS_SEAT_COUNT ? seatCount : Math.min(seatCount, Math.max(from, scale(settings.to)));
  return { from, to };
}

/**
 * A bus can reach a trip after it went on sale, and a range can change while bookings exist. Nobody already seated is
 * moved silently: the change is refused and names who is in the way, so staff can move that passenger first.
 */
export async function assertSinglesFitRange(db: Pick<Prisma.TransactionClient, 'bookingPassenger'>, trips: Prisma.TripWhereInput, range: SinglesRange) {
  const passengers = await db.bookingPassenger.findMany({
    where: { seatNumber: { not: null }, booking: { category: 'SINGLES', status: { not: 'CANCELLED' }, trip: trips } },
    select: { seatNumber: true, booking: { select: { trip: { select: { tripCode: true } } } } },
  });
  const outside = passengers.find((passenger) => !isSinglesSeat(passenger.seatNumber!, range));
  // A family already seated where the new singles section would start is refused the same way.
  const families = await db.bookingPassenger.findMany({
    where: { seatNumber: { not: null }, booking: { category: 'FAMILY', status: { not: 'CANCELLED' }, trip: trips } },
    select: { seatNumber: true, booking: { select: { trip: { select: { tripCode: true } } } } },
  });
  const inside = families.find((passenger) => isSinglesSeat(passenger.seatNumber!, range));
  if (inside) {
    throw new ConflictException(
      `المقعد ${inside.seatNumber} في الرحلة ${inside.booking.trip.tripCode} محجوز لعائلة وسيصبح من مقاعد الأفراد (${describeSinglesRange(range)}). انقل الراكب أولًا`,
    );
  }
  if (outside) {
    throw new ConflictException(
      `المقعد ${outside.seatNumber} في الرحلة ${outside.booking.trip.tripCode} محجوز للأفراد وهو خارج النطاق ${describeSinglesRange(range)}. انقل الراكب أولًا`,
    );
  }
}

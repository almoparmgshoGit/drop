import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SeatLayout, sameSeatLayout, seatNumbersOf, storedSeatLayout, tripSeatLayout } from './bus-layout.util';

/**
 * Puts a trip on another vehicle's seat plan: seats the new vehicle lacks are removed and the ones it adds go on sale.
 * Nobody is moved silently, so a seat that is sold or being held on the way out stops the change and is named.
 * A trip linked to a reverse shares its seat numbers with it, so the two cannot be put on different plans.
 */
export async function applySeatLayout(tx: Prisma.TransactionClient, tripId: string, layout: SeatLayout) {
  const trip = await tx.trip.findUniqueOrThrow({
    where: { id: tripId },
    select: {
      tripCode: true,
      seatLayout: true,
      reverseOfTripId: true,
      reverseTrip: { select: { tripStatus: true } },
      seats: { select: { id: true, seatNumber: true, isBooked: true, heldUntil: true } },
    },
  });
  if (sameSeatLayout(tripSeatLayout(trip), layout)) return;
  if (trip.reverseOfTripId || (trip.reverseTrip && trip.reverseTrip.tripStatus !== 'CANCELLED')) {
    throw new ConflictException(`الرحلة ${trip.tripCode} مرتبطة برحلة عكسية، فلا يمكن نقلها إلى مركبة بعدد مقاعد مختلف`);
  }

  const wanted = new Set(seatNumbersOf(layout));
  const now = new Date();
  const dropping = trip.seats.filter((seat) => !wanted.has(seat.seatNumber));
  const taken = dropping.find((seat) => seat.isBooked || (seat.heldUntil && seat.heldUntil > now));
  if (taken) {
    throw new ConflictException(`المقعد ${taken.seatNumber} في الرحلة ${trip.tripCode} محجوز ولا يوجد في المركبة الجديدة. انقل الراكب أولًا`);
  }
  const have = new Set(trip.seats.map((seat) => seat.seatNumber));
  const adding = [...wanted].filter((seatNumber) => !have.has(seatNumber));

  if (dropping.length) await tx.seat.deleteMany({ where: { id: { in: dropping.map((seat) => seat.id) } } });
  if (adding.length) await tx.seat.createMany({ data: adding.map((seatNumber) => ({ tripId, seatNumber })) });
  // Every seat that leaves was free and every seat that comes is free, so both counts move by the same amount.
  const change = adding.length - dropping.length;
  await tx.trip.update({
    where: { id: tripId },
    data: { seatLayout: storedSeatLayout(layout), totalSeats: { increment: change }, availableSeats: { increment: change } },
  });
}

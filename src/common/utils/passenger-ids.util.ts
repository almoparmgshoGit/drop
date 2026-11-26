import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** An ID as typed, compared without spaces or case, so "2451855718 " and a passport's "a1234" match their stored form. */
const normalizeId = (id: string | null | undefined) => (id ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * One ID number belongs to one person, so it is on a trip once. Checked among the passengers being saved and against
 * everyone not cancelled on the same trips, every bus of a trip on several buses included. `exceptPassengerId` is the
 * passenger being edited, whose own number is not a clash with itself.
 */
export async function assertIdsFreeOnTrips(
  db: Pick<Prisma.TransactionClient, 'trip' | 'bookingPassenger'>,
  tripIds: string[],
  nationalIds: (string | null | undefined)[],
  exceptPassengerId?: string,
) {
  const ids = nationalIds.map(normalizeId).filter(Boolean);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated) throw new ConflictException(`رقم الهوية ${repeated} مكرر بين ركاب الحجز، لكل راكب رقم هويته`);
  if (ids.length === 0) return;

  const trips = await db.trip.findMany({ where: { id: { in: tripIds } }, select: { id: true, convoyLeadId: true } });
  const leads = [...new Set(trips.map((trip) => trip.convoyLeadId ?? trip.id))];
  const clash = await db.bookingPassenger.findFirst({
    where: {
      ...(exceptPassengerId && { id: { not: exceptPassengerId } }),
      cancelled: false,
      nationalId: { in: [...new Set(ids)], mode: 'insensitive' },
      booking: { status: { not: 'CANCELLED' }, trip: { OR: [{ id: { in: leads } }, { convoyLeadId: { in: leads } }] } },
    },
    select: { fullName: true, nationalId: true, booking: { select: { bookingReference: true, trip: { select: { tripCode: true } } } } },
  });
  if (clash) {
    throw new ConflictException(
      `رقم الهوية ${clash.nationalId} مسجل للراكب «${clash.fullName}» في الرحلة ${clash.booking.trip.tripCode} (حجز ${clash.booking.bookingReference})`,
    );
  }
}

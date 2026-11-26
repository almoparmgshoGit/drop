import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * A trip whose account was closed has had its profit posted to the branches, so what decides that profit is frozen until the
 * owner reopens the account. The account lives on the way there, so a way back follows its way there's closing.
 */
export async function assertTripAccountOpen(db: Pick<Prisma.TransactionClient, 'trip'>, tripId: string, what = 'تعديل حساب هذه الرحلة') {
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { financeClosedAt: true, reverseOf: { select: { financeClosedAt: true } } } });
  if (trip?.financeClosedAt || trip?.reverseOf?.financeClosedAt) {
    throw new ConflictException(`أُغلق حساب هذه الرحلة ورُحّل ربحها، فلا يمكن ${what} إلا بعد أن يعيد المالك فتح الحساب`);
  }
}

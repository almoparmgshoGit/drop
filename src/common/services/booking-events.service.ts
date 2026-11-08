import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type BookingEventAction =
  | 'BRANCH_BOOKING_CREATED'
  | 'PRICE_OVERRIDDEN'
  | 'PASSENGER_UPDATED'
  | 'SEAT_CHANGED'
  | 'BOARDING_POINT_CHANGED'
  | 'ROOM_ASSIGNED'
  | 'ROOM_UNASSIGNED'
  | 'BOARDED'
  | 'UNBOARDED'
  | 'RETURN_BOARDED'
  | 'RETURN_UNBOARDED'
  | 'NOTE'
  | 'CREW_NOTICE'
  | 'PAYMENT_COLLECTED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLATION_REJECTED'
  | 'CANCELLED'
  | 'REFUND_EXECUTED'
  | 'REFUND_MOVED_TO_WALLET'
  | 'COMPENSATED';

export interface BookingEventEntry {
  bookingId: string;
  action: BookingEventAction;
  actorId?: string;
  reason?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
}

@Injectable()
export class BookingEventsService {
  /** Serializes every change to one booking until the surrounding transaction ends. */
  async lock(tx: Prisma.TransactionClient, bookingId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
  }

  /** Written inside the caller's transaction, so a change can never commit without its history. */
  async record(tx: Prisma.TransactionClient, entry: BookingEventEntry) {
    // The name and role come from the database and are copied, so the record survives later account edits.
    const actor = entry.actorId
      ? await tx.user.findUnique({ where: { id: entry.actorId }, select: { name: true, role: true } })
      : null;
    await tx.bookingEvent.create({
      data: {
        bookingId: entry.bookingId,
        action: entry.action,
        actorId: entry.actorId,
        actorName: actor?.name,
        actorRole: actor?.role,
        reason: entry.reason,
        before: entry.before,
        after: entry.after,
        ip: entry.ip,
      },
    });
  }
}

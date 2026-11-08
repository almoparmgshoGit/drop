import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TICKET_BOARDING_TRIP_SELECT, ticketBoarding } from '../utils/ticket-boarding.util';
import { NotificationsService } from './notifications.service';

const CAN_BOARD_STATUSES = ['CONFIRMED', 'PENDING_CANCELLATION_REVIEW'] as const;

@Injectable()
export class TicketAlertsService {
  constructor(private notifications: NotificationsService) {}

  /**
   * Tells each customer the moment their ticket turns late or stopped. Run inside the transaction that moved the bus,
   * after the move. Returns who was just told, so the same moment does not also send them the general bus alert.
   */
  async announce(tx: Prisma.TransactionClient, tripId: string) {
    const newlyTold = new Set<string>();
    const trip = await tx.trip.findUnique({ where: { id: tripId }, select: TICKET_BOARDING_TRIP_SELECT });
    if (!trip || trip.tripStatus === 'CANCELLED' || trip.tripStatus === 'DRAFT') return newlyTold;

    const bookings = await tx.booking.findMany({
      where: { tripId, status: { in: [...CAN_BOARD_STATUSES] }, tickets: { some: { isBoarded: false } }, compensation: { is: null } },
      select: { id: true, boardingPointId: true, boardingPointName: true, lateAlertAt: true, stoppedAlertAt: true },
    });
    const now = Date.now();
    const lateIds: string[] = [];
    const stoppedIds: string[] = [];
    let nextPoints = '';
    for (const booking of bookings) {
      const { state, otherPoints } = ticketBoarding(booking, trip, now);
      if (state === 'LATE' && !booking.lateAlertAt) {
        lateIds.push(booking.id);
        nextPoints = otherPoints.map((point) => `${point.name} (${point.time})`).join('، ');
      }
      if (state === 'STOPPED' && !booking.stoppedAlertAt) stoppedIds.push(booking.id);
    }

    const at = new Date(now);
    // Written directly because a message going out is not an edit: Prisma would move updatedAt, and staff with the booking open would be told someone changed it.
    if (lateIds.length > 0) {
      await tx.$executeRaw`UPDATE "Booking" SET "lateAlertAt" = ${at} WHERE "id" = ANY(${lateIds}::text[])`;
      await this.notifications.toBookingOwners(tx, 'TICKET_LATE', lateIds, { nextPoints });
    }
    if (stoppedIds.length > 0) {
      await tx.$executeRaw`UPDATE "Booking" SET "stoppedAlertAt" = ${at} WHERE "id" = ANY(${stoppedIds}::text[])`;
      await this.notifications.toBookingOwners(tx, 'TICKET_STOPPED', stoppedIds);
    }
    [...lateIds, ...stoppedIds].forEach((id) => newlyTold.add(id));
    return newlyTold;
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { riyadhDayRange } from '../../common/utils/time.util';
import { AdminTicketsQuery } from './ticket-list.dto';

/**
 * The tickets table: one row per passenger's ticket, with its status and, once cancelled, when, by whom and why.
 * Scoped to the employee's branch the same way the bookings table is.
 */
@Injectable()
export class TicketListService {
  constructor(private prisma: PrismaService) {}

  async list(scope: Prisma.BookingWhereInput, query: AdminTicketsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const base: Prisma.TicketWhereInput = { booking: { ...scope, ...(query.tripId && { tripId: query.tripId }) } };
    const search = query.search?.trim();
    if (search) {
      base.OR = [
        { ticketNumber: { contains: search, mode: 'insensitive' } },
        { passenger: { fullName: { contains: search, mode: 'insensitive' } } },
        { booking: { bookingReference: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const from = query.cancelledFrom ? riyadhDayRange(query.cancelledFrom)?.start : undefined;
    const to = query.cancelledTo ? riyadhDayRange(query.cancelledTo)?.end : undefined;
    const cancelledIn: Prisma.TicketWhereInput = from || to ? { cancelledAt: { ...(from && { gte: from }), ...(to && { lt: to }) } } : {};

    const where: Prisma.TicketWhereInput = {
      ...base,
      ...(query.status && { status: query.status }),
      // A cancellation period only makes sense for cancelled tickets.
      ...(from || to ? { status: 'CANCELLED', ...cancelledIn } : {}),
    };

    const [rows, total, confirmed, cancelled] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        // The latest cancellations first when looking at cancelled tickets; otherwise the newest tickets.
        orderBy: query.status === 'CANCELLED' || from || to ? [{ cancelledAt: 'desc' }, { createdAt: 'desc' }] : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          ticketNumber: true,
          status: true,
          isBoarded: true,
          boardedAt: true,
          noShowAt: true,
          cancelledAt: true,
          cancelledByName: true,
          cancelReason: true,
          cancelledSeatNumber: true,
          refundAmount: true,
          keptAmount: true,
          createdAt: true,
          passenger: { select: { id: true, fullName: true, phone: true, seatNumber: true, cancelled: true } },
          booking: {
            select: {
              id: true,
              bookingReference: true,
              status: true,
              source: true,
              branch: { select: { name: true } },
              user: { select: { name: true, phone: true } },
              trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true } },
            },
          },
        },
      }),
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.count({ where: { ...base, status: 'CONFIRMED' } }),
      this.prisma.ticket.count({ where: { ...base, status: 'CANCELLED', ...cancelledIn } }),
    ]);

    return {
      page,
      limit,
      total,
      counts: { confirmed, cancelled },
      items: rows.map(({ passenger, ...ticket }) => ({
        ...ticket,
        refundAmount: Number(ticket.refundAmount),
        keptAmount: Number(ticket.keptAmount),
        // Cancelled on its own (the booking still runs) or together with its whole booking.
        cancelledAlone: passenger.cancelled,
        passenger: { id: passenger.id, fullName: passenger.fullName, phone: passenger.phone },
        // A ticket cancelled on its own gave its seat back; the one it held is kept on the ticket.
        seatNumber: passenger.seatNumber ?? ticket.cancelledSeatNumber,
      })),
    };
  }
}

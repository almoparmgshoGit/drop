import { Prisma } from '@prisma/client';
import { halalas, paymentFigures } from './payment.util';

type Db = Pick<Prisma.TransactionClient, 'booking'>;

/** A passenger still travelling: a cancelled ticket keeps its passenger on the booking for the record only. */
export const LIVE_PASSENGER = { cancelled: false } as const satisfies Prisma.BookingPassengerWhereInput;

/**
 * What cancelled tickets of a still-live booking already took out of what was paid, in halalas: the part given back and the
 * part the company kept as its fee. The rest of the paid money belongs to the tickets still active, so a later cancellation of
 * the whole booking can never give the same money back twice.
 */
export async function cancelledTicketsTake(db: Db, bookingId: string) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { tickets: { where: { status: 'CANCELLED' }, select: { refundAmount: true, keptAmount: true } } },
  });
  return (booking?.tickets ?? []).reduce((sum, ticket) => sum + halalas(ticket.refundAmount) + halalas(ticket.keptAmount), 0);
}

/**
 * What cancelling one ticket of a booking moves, in halalas. A ticket is worth an equal share of the booking's invoiced price
 * (the price before any ticket was cancelled), and of what was paid it owns an equal share of what the active tickets still
 * hold. The unpaid rest of its price is no longer owed. Cancelling the last active ticket is cancelling the booking.
 */
export async function ticketCancelFigures(db: Db, bookingId: string) {
  const booking = await db.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      totalPrice: true,
      invoice: { select: { total: true } },
      payment: { select: { amount: true, walletAmount: true, status: true } },
      collections: { select: { amount: true } },
      compensation: { select: { amount: true } },
      passengers: { select: { cancelled: true } },
      tickets: { where: { status: 'CANCELLED' }, select: { refundAmount: true, keptAmount: true } },
    },
  });
  const all = booking.passengers.length;
  const active = booking.passengers.filter((passenger) => !passenger.cancelled).length;
  const { received, wallet, remaining, isPaid } = paymentFigures(booking.payment, booking.collections);
  const taken = booking.tickets.reduce((sum, ticket) => sum + halalas(ticket.refundAmount) + halalas(ticket.keptAmount), 0);
  // What was already paid out as compensation is not paid out a second time as a refund.
  const pool = Math.max(0, received + wallet - halalas(booking.compensation?.amount ?? 0) - taken);
  // The invoice keeps the price the booking was sold at; before one exists no ticket was cancelled, so the price is unchanged.
  const price = Math.round(halalas(booking.invoice?.total ?? booking.totalPrice) / Math.max(1, all));
  const paidShare = active <= 1 ? pool : Math.min(price, Math.floor(pool / Math.max(1, active)));
  const debtCut = isPaid ? 0 : Math.min(remaining, Math.max(0, price - paidShare));
  return { all, active, price, paidShare, debtCut, received, taken };
}

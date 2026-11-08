import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { halalas } from '../utils/payment.util';
import { INVOICE_SETTING_DEFAULTS, InvoiceSettings, vatInside } from '../utils/invoice.util';

const DEFAULT_VAT_RATE = 15;

type Db = Prisma.TransactionClient;

/** Issues invoices and credit notes inside the caller's transaction, so a document cannot exist without the sale or refund behind it. */
@Injectable()
export class InvoiceLedgerService {
  /** Issues the booking's invoice unless it already has one. */
  async ensure(tx: Db, bookingId: string) {
    const existing = await tx.invoice.findUnique({ where: { bookingId } });
    if (existing) return existing;

    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        id: true,
        subtotal: true,
        vatAmount: true,
        totalPrice: true,
        tripId: true,
        trip: { select: { tripCode: true, destination: true, departureTime: true } },
        user: { select: { name: true } },
        passengers: { select: { fullName: true, nationalId: true, seatNumber: true } },
      },
    });
    const [settings, vatRate] = await Promise.all([this.invoiceSettings(tx), this.vatRate(tx)]);
    const first = [...booking.passengers].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber))[0];
    const total = halalas(booking.totalPrice);
    // The rate is whatever was in force when the booking was priced, so a saved figure wins over today's setting.
    const vat = halalas(booking.vatAmount) > 0 ? halalas(booking.vatAmount) : vatInside(total, vatRate);

    return tx.invoice.create({
      data: {
        bookingId: booking.id,
        tripId: booking.tripId,
        tripCode: booking.trip.tripCode,
        destination: booking.trip.destination,
        tripDate: booking.trip.departureTime,
        passengerName: first?.fullName ?? booking.user.name,
        nationalId: first?.nationalId ?? null,
        subtotal: Math.max(halalas(booking.subtotal), total) / 100,
        total: total / 100,
        taxable: (total - vat) / 100,
        vat: vat / 100,
        vatRate,
        seller: { name: settings.sellerName, vatNumber: settings.vatNumber, crNumber: settings.crNumber, city: settings.sellerCity },
      },
    });
  }

  /**
   * Reverses part of an invoice, never more than is left on it. VAT is worked out on the running
   * total, so several partial notes still add up to exactly the VAT on the invoice.
   */
  async credit(tx: Db, input: { bookingId: string; amount: number; reason?: string | null; actorId?: string | null }) {
    if (input.amount <= 0) return null;
    const invoice = await this.ensure(tx, input.bookingId);
    const notes = await tx.creditNote.findMany({ where: { invoiceId: invoice.id }, select: { total: true, vat: true } });
    const creditedTotal = notes.reduce((sum, note) => sum + halalas(note.total), 0);
    const creditedVat = notes.reduce((sum, note) => sum + halalas(note.vat), 0);
    const invoiceTotal = halalas(invoice.total);
    const amount = Math.min(input.amount, invoiceTotal - creditedTotal);
    if (amount <= 0) return null;

    const vat = Math.round((halalas(invoice.vat) * (creditedTotal + amount)) / invoiceTotal) - creditedVat;
    return tx.creditNote.create({
      data: {
        invoiceId: invoice.id,
        bookingId: input.bookingId,
        tripCode: invoice.tripCode,
        total: amount / 100,
        taxable: (amount - vat) / 100,
        vat: vat / 100,
        reason: input.reason ?? null,
        createdById: input.actorId ?? null,
      },
    });
  }

  async invoiceSettings(db: Db): Promise<InvoiceSettings> {
    const rows = await db.setting.findMany({ where: { key: { in: Object.keys(INVOICE_SETTING_DEFAULTS) } } });
    return { ...INVOICE_SETTING_DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
  }

  async vatRate(db: Db) {
    const setting = await db.setting.findUnique({ where: { key: 'vatRate' } });
    return setting ? Number(setting.value) : DEFAULT_VAT_RATE;
  }
}

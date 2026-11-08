import { ConfigService } from '@nestjs/config';
import { signPaperCode } from '../../common/utils/ticket-token.util';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { BOOKING_KIND_LABELS } from '../../common/utils/booking-kinds.util';
import { includesHousing } from '../../common/utils/booking-types.util';
import { amountInWords, creditNoteNumber, invoiceNumber, vatInside, zatcaQr } from '../../common/utils/invoice.util';
import { halalas, hotelBookingCost, netBookingFigures } from '../../common/utils/payment.util';
import { riyadhMonth, riyadhMonthRange } from '../../common/utils/time.util';
import { CashActor } from '../cash/cash.service';
import { CollectionsService } from '../cash/collections.service';
import { InvoicesQuery, TaxReportQuery } from './invoices.dto';

const PAGE_SIZE = 50;
const sar = (value: number) => Math.round(value) / 100;

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'نقدًا',
  network: 'شبكة',
  mada: 'مدى',
  card: 'بطاقة',
  transfer: 'تحويل',
  wallet_balance: 'المحفظة',
  mixed: 'طرق متعددة',
};
const ROOM_LABELS: Record<string, string> = { SHARED: 'غرفة مشتركة', PRIVATE: 'غرفة خاصة' };
const TRANSPORT_LABELS: Record<string, string> = { TRANSPORT_ONLY: 'نقل', WITH_HOTEL: 'نقل مع سكن', WITH_VISITS: 'نقل مع زيارة معالم', WITH_HOTEL_VISITS: 'نقل مع سكن وزيارة معالم' };

/** The three months of a quarter such as 2026-Q4. */
const quarterMonths = (quarter: string) => {
  const [year, q] = quarter.split('-Q').map(Number);
  return [0, 1, 2].map((offset) => `${year}-${String((q - 1) * 3 + 1 + offset).padStart(2, '0')}`);
};

type TaxFigures = { salesCount: number; sales: number; outputVat: number; credits: number; creditsVat: number; inputVat: number };

const toReport = (figures: TaxFigures) => {
  const netOutputVat = figures.outputVat - figures.creditsVat;
  return {
    salesCount: figures.salesCount,
    sales: sar(figures.sales),
    outputVat: sar(figures.outputVat),
    credits: sar(figures.credits),
    creditsVat: sar(figures.creditsVat),
    netOutputVat: sar(netOutputVat),
    inputVat: sar(figures.inputVat),
    netDue: sar(netOutputVat - figures.inputVat),
  };
};

@Injectable()
export class InvoicesService {
  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private ledger: InvoiceLedgerService,
    private collections: CollectionsService,
  ) {}

  async list(actor: CashActor, query: InvoicesQuery) {
    const month = query.month ?? riyadhMonth(new Date());
    const scope = await this.collections.branchScope(actor);
    const inMonth: Prisma.InvoiceWhereInput = { issuedAt: riyadhMonthRange(month), booking: scope };
    const where: Prisma.InvoiceWhereInput = { ...inMonth, ...(query.tripId && { tripId: query.tripId }) };

    const [invoices, trips, vatRate] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { number: 'desc' },
        include: {
          creditNotes: { select: { total: true } },
          booking: {
            select: {
              id: true,
              bookingReference: true,
              status: true,
              refundAmount: true,
              externalRefunded: true,
              payment: { select: { amount: true, walletAmount: true, status: true } },
              collections: { select: { amount: true } },
              cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
            },
          },
        },
      }),
      this.prisma.invoice.groupBy({ where: inMonth, by: ['tripId', 'tripCode'], orderBy: { tripCode: 'asc' } }),
      this.ledger.vatRate(this.prisma),
    ]);

    const totals = { taxable: 0, vat: 0, total: 0, collected: 0, remaining: 0 };
    const rows = invoices.map((invoice) => {
      const { held, remaining } = netBookingFigures(invoice.booking);
      totals.taxable += halalas(invoice.taxable);
      totals.vat += halalas(invoice.vat);
      totals.total += halalas(invoice.total);
      totals.collected += held;
      totals.remaining += remaining;
      return {
        id: invoice.id,
        number: invoiceNumber(invoice.tripCode, invoice.number),
        bookingId: invoice.booking.id,
        reference: invoice.booking.bookingReference,
        tripCode: invoice.tripCode,
        passengerName: invoice.passengerName,
        nationalId: invoice.nationalId,
        tripDate: invoice.tripDate,
        destination: invoice.destination,
        subtotal: Number(invoice.subtotal),
        taxable: Number(invoice.taxable),
        vat: Number(invoice.vat),
        total: Number(invoice.total),
        paid: sar(held),
        remaining: sar(remaining),
        isCancelled: invoice.booking.status === 'CANCELLED',
        credited: sar(invoice.creditNotes.reduce((sum, note) => sum + halalas(note.total), 0)),
      };
    });

    const page = query.page ?? 1;
    const owed = totals.collected + totals.remaining;
    return {
      month,
      vatRate,
      summary: {
        count: rows.length,
        taxable: sar(totals.taxable),
        vat: sar(totals.vat),
        total: sar(totals.total),
        collected: sar(totals.collected),
        remaining: sar(totals.remaining),
        rate: owed > 0 ? Math.round((totals.collected / owed) * 1000) / 10 : null,
      },
      trips: trips.map((trip) => ({ id: trip.tripId, tripCode: trip.tripCode })),
      items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: rows.length,
      page,
    };
  }

  async printable(actor: CashActor, bookingId: string) {
    await this.collections.assertBookingVisible(actor, bookingId);
    const invoice = await this.prisma.invoice.findUnique({
      where: { bookingId },
      include: {
        creditNotes: { orderBy: { number: 'asc' } },
        booking: {
          select: {
            bookingReference: true,
            source: true,
            status: true,
            refundAmount: true,
            externalRefunded: true,
            groupReference: true,
            tripId: true,
            roomChoice: true,
            kind: true,
            stayNights: true,
            stayHotel: { select: { name: true } },
            branch: { select: { name: true } },
            payment: { select: { amount: true, walletAmount: true, status: true, method: true } },
            collections: { select: { amount: true } },
            cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
            passengers: { select: { fullName: true, seatNumber: true, hotelRoom: { select: { type: true } } } },
            trip: { select: { bookingType: true, direction: true, departureTime: true, arrivalTime: true, reverseDepartureAt: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('لا توجد فاتورة لهذا الحجز');

    const { booking } = invoice;
    const settings = await this.ledger.invoiceSettings(this.prisma);
    const frozen = (invoice.seller ?? {}) as { name?: string; vatNumber?: string; crNumber?: string; city?: string };
    const seller = {
      name: frozen.name || settings.sellerName,
      tagline: settings.sellerTagline,
      vatNumber: frozen.vatNumber || settings.vatNumber,
      crNumber: frozen.crNumber || settings.crNumber,
      city: frozen.city || settings.sellerCity,
    };
    const passengers = [...booking.passengers].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));
    const { held, remaining } = netBookingFigures(booking);
    const total = Number(invoice.total);
    const vat = Number(invoice.vat);
    const roomType = passengers.find((p) => p.hotelRoom)?.hotelRoom?.type ?? booking.roomChoice;

    return {
      number: invoiceNumber(invoice.tripCode, invoice.number),
      reference: booking.bookingReference,
      issuedAt: invoice.issuedAt,
      passengerName: invoice.passengerName,
      passengerCount: passengers.length,
      seats: passengers.map((p) => p.seatNumber),
      tripCode: invoice.tripCode,
      destination: invoice.destination,
      tripDate: invoice.tripDate,
      departureTime: booking.trip.departureTime,
      returnTime: await this.returnTime(booking),
      bookingType: booking.kind ? BOOKING_KIND_LABELS[booking.kind] : TRANSPORT_LABELS[booking.trip.bookingType] ?? 'نقل',
      housing: booking.stayHotel
        ? `${booking.stayHotel.name} · ${roomType ? ROOM_LABELS[roomType] : ''} · ${booking.stayNights} ليالٍ`
        : includesHousing(booking.trip.bookingType) ? (roomType ? ROOM_LABELS[roomType] : 'يُحدد لاحقًا') : 'لا يوجد سكن',
      branchName: booking.branch?.name ?? null,
      // Only where it can board anyone. Everything else prints the plain reference, which only finds the booking.
      boardingCode: booking.source === 'BRANCH' && booking.status !== 'CANCELLED' ? signPaperCode(booking.bookingReference, this.config.getOrThrow('TICKET_SIGNING_SECRET')) : null,
      subtotal: Number(invoice.subtotal),
      discount: sar(halalas(invoice.subtotal) - halalas(invoice.total)),
      taxable: Number(invoice.taxable),
      vat,
      vatRate: Number(invoice.vatRate),
      total,
      paid: sar(held),
      remaining: sar(remaining),
      paymentLabel: PAYMENT_LABELS[booking.payment?.method ?? ''] ?? null,
      paymentState: booking.status === 'CANCELLED' ? 'ملغى' : remaining === 0 ? 'مكتمل' : held > 0 ? 'جزئي' : 'غير مدفوع',
      isCancelled: booking.status === 'CANCELLED',
      amountInWords: amountInWords(total),
      creditNotes: invoice.creditNotes.map((note) => ({
        number: creditNoteNumber(note.tripCode, note.number),
        total: Number(note.total),
        vat: Number(note.vat),
        issuedAt: note.issuedAt,
      })),
      seller,
      // Without a VAT number the code would be invalid, so the page asks for the number instead.
      qr: seller.vatNumber ? zatcaQr({ seller: seller.name, vatNumber: seller.vatNumber, issuedAt: invoice.issuedAt, total, vat }) : null,
      contacts: settings.invoiceContacts.split('\n').map((line) => line.trim()).filter(Boolean),
      notice: settings.invoiceTripNotice,
      footer: settings.invoiceFooter,
    };
  }

  /** The other leg of a round-trip booking if there is one, else whatever the trip itself says about coming back. */
  private async returnTime(booking: {
    groupReference: string | null;
    tripId: string;
    trip: { direction: string; departureTime: Date; arrivalTime: Date; reverseDepartureAt: Date | null };
  }) {
    if (booking.groupReference) {
      const legs = await this.prisma.booking.findMany({
        where: { groupReference: booking.groupReference, tripId: { not: booking.tripId } },
        select: { trip: { select: { departureTime: true } } },
      });
      const later = legs.map((leg) => leg.trip.departureTime).filter((time) => time > booking.trip.departureTime).sort((a, b) => a.getTime() - b.getTime())[0];
      if (later) return later;
    }
    if (booking.trip.reverseDepartureAt) return booking.trip.reverseDepartureAt;
    return booking.trip.direction === 'ROUND_TRIP' ? booking.trip.arrivalTime : null;
  }

  /** The return covers the whole company, whichever branch or trip the screen is showing. */
  async taxReport(query: TaxReportQuery) {
    const months = query.quarter ? quarterMonths(query.quarter) : [query.month ?? riyadhMonth(new Date())];
    const figures = await Promise.all(months.map((month) => this.monthTax(month)));
    const totals = figures.reduce<TaxFigures>(
      (sum, row) => ({
        salesCount: sum.salesCount + row.salesCount,
        sales: sum.sales + row.sales,
        outputVat: sum.outputVat + row.outputVat,
        credits: sum.credits + row.credits,
        creditsVat: sum.creditsVat + row.creditsVat,
        inputVat: sum.inputVat + row.inputVat,
      }),
      { salesCount: 0, sales: 0, outputVat: 0, credits: 0, creditsVat: 0, inputVat: 0 },
    );
    return { months: figures.map((row, index) => ({ month: months[index], ...toReport(row) })), totals: toReport(totals) };
  }

  private async monthTax(month: string): Promise<TaxFigures> {
    const issued = riyadhMonthRange(month);
    const [year, monthNumber] = month.split('-').map(Number);
    const days = { gte: new Date(Date.UTC(year, monthNumber - 1, 1)), lt: new Date(Date.UTC(year, monthNumber, 1)) };

    const [sales, credits, entries, custodyExpenses, trips, rate] = await Promise.all([
      this.prisma.invoice.aggregate({ where: { issuedAt: issued }, _count: true, _sum: { total: true, vat: true } }),
      this.prisma.creditNote.aggregate({ where: { issuedAt: issued }, _sum: { total: true, vat: true } }),
      this.prisma.tripAccountEntry.aggregate({ where: { hasTaxInvoice: true, voidedAt: null, spentOn: days }, _sum: { vat: true } }),
      // Only once settled: until then the office has not checked the invoice behind it.
      this.prisma.custodyExpense.aggregate({ where: { hasTaxInvoice: true, voidedAt: null, spentOn: days, custody: { status: 'SETTLED' } }, _sum: { vat: true } }),
      this.prisma.trip.findMany({
        where: {
          departureTime: issued,
          tripStatus: { in: ['PUBLISHED', 'COMPLETED'] },
          OR: [{ busCost: { rentHasTaxInvoice: true } }, { hotelBookings: { some: { status: 'CONFIRMED', hasTaxInvoice: true } } }],
        },
        select: {
          busRentalPrice: true,
          busCost: { select: { rentHasTaxInvoice: true } },
          hotelBookings: {
            where: { status: 'CONFIRMED', hasTaxInvoice: true },
            select: { nightlyRate: true, rateUnit: true, extraCost: true, checkIn: true, checkOut: true, rooms: { select: { _count: { select: { occupants: true } } } } },
          },
        },
      }),
      this.ledger.vatRate(this.prisma),
    ]);

    const automatic = trips.reduce((sum, trip) => {
      const rent = trip.busCost?.rentHasTaxInvoice ? halalas(trip.busRentalPrice ?? 0) : 0;
      const hotels = trip.hotelBookings.reduce((total, booking) => total + hotelBookingCost(booking), 0);
      return sum + vatInside(rent, rate) + vatInside(hotels, rate);
    }, 0);

    return {
      salesCount: sales._count,
      sales: halalas(sales._sum.total ?? 0),
      outputVat: halalas(sales._sum.vat ?? 0),
      credits: halalas(credits._sum.total ?? 0),
      creditsVat: halalas(credits._sum.vat ?? 0),
      inputVat: halalas(entries._sum.vat ?? 0) + halalas(custodyExpenses._sum.vat ?? 0) + automatic,
    };
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountCategoryGroup, Prisma, TripStatus } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { vatInside } from '../../common/utils/invoice.util';
import { halalas, hotelBookingCost, netBookingFigures } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDayRange, riyadhMonthRange } from '../../common/utils/time.util';
import { readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { AccountView, CreateCategoryDto, CreateEntryDto, TripAccountsQuery, UpdateCategoryDto, UpdateTaxFlagsDto } from './trip-accounts.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const BY_TRIP_LIMIT = 100;
const sar = (value: number) => Math.round(value) / 100;
const AUTOMATIC_GROUPS: AccountCategoryGroup[] = ['HOTEL', 'BUS'];

const ACCOUNT_SELECT = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  tripStatus: true,
  totalSeats: true,
  busRentalPrice: true,
  bookings: {
    select: {
      status: true,
      totalPrice: true,
      refundAmount: true,
      payment: { select: { amount: true, walletAmount: true, status: true } },
      collections: { select: { amount: true } },
      externalRefunded: true,
      cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
      _count: { select: { passengers: true } },
    },
  },
  hotelBookings: {
    where: { status: 'CONFIRMED' as const },
    select: {
      id: true,
      nightlyRate: true,
      rateUnit: true,
      extraCost: true,
      checkIn: true,
      checkOut: true,
      hasTaxInvoice: true,
      hotel: { select: { name: true } },
      rooms: { select: { _count: { select: { occupants: true } } } },
    },
  },
  accountEntries: { where: { voidedAt: null }, select: { amount: true, category: { select: { group: true } } } },
  custodies: {
    where: { status: 'SETTLED' as const },
    select: {
      number: true,
      purpose: true,
      spentAmount: true,
      recipientName: true,
      settledAt: true,
      expenses: { where: { voidedAt: null }, select: { amount: true, category: { select: { group: true } } } },
    },
  },
} satisfies Prisma.TripSelect;

type AccountTrip = Prisma.TripGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/**
 * Sold value rather than cash in hand: a seat sold and not yet collected is still the trip's revenue,
 * and only what was kept counts from a cancelled booking. Collections are tracked beside it.
 *
 * TripBusCost is left out on purpose: its driver and delegation expenses are deducted from what the
 * bus office is owed, so they are already inside the rent. Adding them would count them twice.
 */
function accountFigures(trip: AccountTrip) {
  const live = trip.tripStatus !== TripStatus.CANCELLED;
  let tickets = 0;
  let collected = 0;
  let remaining = 0;
  let passengers = 0;
  for (const booking of trip.bookings) {
    const figures = netBookingFigures(booking);
    collected += figures.held;
    remaining += figures.remaining;
    if (booking.status === 'CANCELLED') {
      tickets += figures.held;
    } else {
      tickets += halalas(booking.totalPrice);
      passengers += booking._count.passengers;
    }
  }
  const entered = (group: AccountCategoryGroup) =>
    trip.accountEntries.filter((entry) => entry.category.group === group).reduce((sum, entry) => sum + halalas(entry.amount), 0);

  // A cancelled trip does not run, so the bus and the hotels are not owed for it.
  const bus = live ? halalas(trip.busRentalPrice ?? 0) : 0;
  const hotels = live ? trip.hotelBookings.reduce((sum, booking) => sum + hotelBookingCost(booking), 0) : 0;
  // A settled custody spreads over the columns of its expenses; whatever was settled without a line stays under other.
  const fromCustody = { DRIVER: 0, ADMIN: 0, OTHER: 0 };
  for (const row of trip.custodies) {
    let unlisted = halalas(row.spentAmount ?? 0);
    for (const expense of row.expenses) {
      const amount = halalas(expense.amount);
      unlisted -= amount;
      const group = expense.category.group;
      if (group === 'DRIVER' || group === 'ADMIN') fromCustody[group] += amount;
      else fromCustody.OTHER += amount;
    }
    fromCustody.OTHER += Math.max(0, unlisted);
  }
  const driver = entered('DRIVER') + fromCustody.DRIVER;
  const admin = entered('ADMIN') + fromCustody.ADMIN;
  const other = entered('OTHER') + fromCustody.OTHER;
  const otherIncome = entered('INCOME');
  const expenses = hotels + bus + driver + admin + other;
  return { tickets, otherIncome, revenue: tickets + otherIncome, hotels, bus, driver, admin, other, expenses, net: tickets + otherIncome - expenses, collected, remaining, passengers };
}

type Figures = ReturnType<typeof accountFigures>;

const figuresInSar = (figures: Figures) => ({
  tickets: sar(figures.tickets),
  otherIncome: sar(figures.otherIncome),
  revenue: sar(figures.revenue),
  hotels: sar(figures.hotels),
  bus: sar(figures.bus),
  driver: sar(figures.driver),
  admin: sar(figures.admin),
  other: sar(figures.other),
  expenses: sar(figures.expenses),
  net: sar(figures.net),
  collected: sar(figures.collected),
  remaining: sar(figures.remaining),
  passengers: figures.passengers,
});

/** The instants a view covers. A week here runs Saturday to Friday. */
function viewRange(view: Exclude<AccountView, 'trip'>, date: string) {
  const day = riyadhDayRange(date);
  if (!day) throw new BadRequestException('التاريخ غير صحيح');
  if (view === 'day') return { gte: day.start, lt: day.end };
  if (view === 'month') return riyadhMonthRange(date.slice(0, 7));
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const start = new Date(day.start.getTime() - ((weekday + 1) % 7) * DAY_MS);
  return { gte: start, lt: new Date(start.getTime() + 7 * DAY_MS) };
}

@Injectable()
export class TripAccountsService {
  constructor(
    private prisma: PrismaService,
    private ledger: InvoiceLedgerService,
  ) {}

  async list(query: TripAccountsQuery) {
    const view = query.view ?? 'week';
    const date = query.date ?? riyadhDate(new Date());
    const range = view === 'trip' ? null : viewRange(view, date);

    const where: Prisma.TripWhereInput = {
      ...(range && { departureTime: range }),
      ...(query.destination && { destination: query.destination }),
      ...(query.q && { tripCode: { contains: query.q, mode: 'insensitive' } }),
      // A cancelled trip only belongs here if money was spent or kept on it.
      OR: [
        { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
        { tripStatus: 'CANCELLED', accountEntries: { some: { voidedAt: null } } },
        { tripStatus: 'CANCELLED', custodies: { some: { status: 'SETTLED' } } },
      ],
    };

    const [trips, total, destinations] = await Promise.all([
      this.prisma.trip.findMany({
        where,
        orderBy: { departureTime: view === 'trip' ? 'desc' : 'asc' },
        ...(view === 'trip' && { take: BY_TRIP_LIMIT }),
        select: ACCOUNT_SELECT,
      }),
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({ where: { tripStatus: { not: 'DRAFT' } }, distinct: ['destination'], select: { destination: true }, orderBy: { destination: 'asc' } }),
    ]);

    const rows = trips.map((trip) => ({ trip, figures: accountFigures(trip) }));
    const revenue = rows.reduce((sum, row) => sum + row.figures.revenue, 0);
    const expenses = rows.reduce((sum, row) => sum + row.figures.expenses, 0);
    const best = rows.reduce<(typeof rows)[number] | null>((top, row) => (!top || row.figures.net > top.figures.net ? row : top), null);
    const now = new Date();

    return {
      view,
      date,
      range: range && { from: riyadhDate(range.gte), to: riyadhDate(new Date(range.lt.getTime() - 1)) },
      destinations: destinations.map((row) => row.destination),
      total,
      summary: {
        trips: rows.length,
        revenue: sar(revenue),
        expenses: sar(expenses),
        net: sar(revenue - expenses),
        unfinished: rows.filter((row) => row.trip.tripStatus === 'PUBLISHED' && row.trip.departureTime > now).length,
        best: best && { tripCode: best.trip.tripCode, net: sar(best.figures.net) },
      },
      items: rows.map(({ trip, figures }) => ({
        id: trip.id,
        tripCode: trip.tripCode,
        destination: trip.destination,
        departureTime: trip.departureTime,
        tripStatus: trip.tripStatus,
        rentMissing: trip.tripStatus !== 'CANCELLED' && trip.busRentalPrice === null,
        ...figuresInSar(figures),
      })),
    };
  }

  /**
   * Profit on money actually received, for the trips list: what paid bookings brought in (after refunds), plus other income,
   * less the trip's costs as they stand. Unlike the accounts page's net, an unpaid seat adds nothing here yet.
   */
  async currentProfits() {
    const trips = await this.prisma.trip.findMany({ where: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } }, select: ACCOUNT_SELECT });
    return Object.fromEntries(
      trips.map((trip) => {
        const figures = accountFigures(trip);
        const paid = figures.collected + figures.otherIncome;
        return [trip.id, { collected: sar(figures.collected), expenses: sar(figures.expenses), profit: sar(paid - figures.expenses) }];
      }),
    );
  }

  async detail(id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      select: { ...ACCOUNT_SELECT, busCost: { select: { rentHasTaxInvoice: true } }, bus: { select: { plateNumber: true, office: { select: { name: true } } } } },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');

    const [pendingCustody, entries, vatRate] = await Promise.all([
      this.prisma.custodyExpense.aggregate({ where: { voidedAt: null, custody: { tripId: id, status: 'OPEN' } }, _sum: { amount: true } }),
      this.prisma.tripAccountEntry.findMany({
        where: { tripId: id },
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
        // The file bytes stay out: they are fetched one at a time, and only when asked for.
        include: { category: { select: { name: true, group: true } }, attachments: { select: { id: true, fileName: true, size: true }, orderBy: { createdAt: 'asc' } } },
      }),
      this.ledger.vatRate(this.prisma),
    ]);
    const figures = accountFigures(trip);
    const live = trip.tripStatus !== 'CANCELLED';

    return {
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        origin: trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        tripStatus: trip.tripStatus,
        totalSeats: trip.totalSeats,
        busPlate: trip.bus?.plateNumber ?? null,
        officeName: trip.bus?.office?.name ?? null,
      },
      vatRate,
      figures: figuresInSar(figures),
      pendingCustody: Number(pendingCustody._sum.amount ?? 0),
      rent: live ? { amount: sar(figures.bus), missing: trip.busRentalPrice === null, hasTaxInvoice: trip.busCost?.rentHasTaxInvoice ?? false } : null,
      hotels: live
        ? trip.hotelBookings.map((booking) => ({ id: booking.id, name: booking.hotel.name, amount: sar(hotelBookingCost(booking)), hasTaxInvoice: booking.hasTaxInvoice }))
        : [],
      custodies: trip.custodies.map((row) => ({ number: row.number, purpose: row.purpose, recipientName: row.recipientName, settledAt: row.settledAt, spent: Number(row.spentAmount ?? 0) })),
      entries: entries.map((entry) => ({
        id: entry.id,
        categoryName: entry.category.name,
        group: entry.category.group,
        amount: Number(entry.amount),
        vat: Number(entry.vat),
        hasTaxInvoice: entry.hasTaxInvoice,
        supplierName: entry.supplierName,
        attachments: entry.attachments,
        notes: entry.notes,
        spentOn: entry.spentOn.toISOString().slice(0, 10),
        createdByName: entry.createdByName,
        voidedAt: entry.voidedAt,
        voidedByName: entry.voidedByName,
        voidReason: entry.voidReason,
      })),
    };
  }

  async addEntry(actor: { userId: string; name?: string | null }, tripId: string, dto: CreateEntryDto, files: UploadedInvoice[] = []) {
    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;
    const repeated = await this.prisma.tripAccountEntry.findUnique({ where: { idempotencyKey } });
    if (repeated) return repeated;

    const [trip, category, vatRate] = await Promise.all([
      this.prisma.trip.findUnique({ where: { id: tripId }, select: { tripStatus: true } }),
      this.prisma.accountCategory.findUnique({ where: { id: dto.categoryId } }),
      this.ledger.vatRate(this.prisma),
    ]);
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    if (trip.tripStatus === 'DRAFT') throw new ConflictException('هذه الرحلة ما زالت مسودة');
    if (!category || !category.isActive) throw new BadRequestException('هذا البند غير متاح');
    if (AUTOMATIC_GROUPS.includes(category.group)) throw new BadRequestException('هذا البند يُحسب تلقائيًا من بيانات الرحلة، فلا يُسجّل يدويًا');

    const day = riyadhDayRange(dto.spentOn);
    if (!day) throw new BadRequestException('التاريخ غير صحيح');
    if (day.start > new Date()) throw new BadRequestException('لا يمكن تسجيل مصروف بتاريخ لاحق');

    // Only an expense with a tax invoice behind it reduces the VAT owed.
    const taxInvoice = dto.hasTaxInvoice && category.group !== 'INCOME';
    // Reclaiming VAT needs a document the authority can ask for.
    if (taxInvoice && files.length === 0) throw new BadRequestException('ارفع الفاتورة الضريبية');
    const invoices = readInvoiceFiles(files, actor.userId);
    const vat = taxInvoice ? vatInside(halalas(dto.amount), vatRate) : 0;

    try {
      return await this.prisma.tripAccountEntry.create({
        data: {
          tripId,
          categoryId: category.id,
          amount: dto.amount,
          vat: vat / 100,
          hasTaxInvoice: taxInvoice,
          supplierName: dto.supplierName || null,
          notes: dto.notes || null,
          spentOn: new Date(`${dto.spentOn}T00:00:00Z`),
          idempotencyKey,
          createdById: actor.userId,
          createdByName: actor.name ?? null,
          ...(invoices.length && { attachments: { create: invoices } }),
        },
      });
    } catch (err) {
      // Two identical submits raced; the winner's entry is the answer to both.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.tripAccountEntry.findUnique({ where: { idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  async attachment(id: string) {
    const file = await this.prisma.tripAccountAttachment.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  async voidEntry(actor: { name?: string | null }, id: string, reason: string) {
    const voided = await this.prisma.tripAccountEntry.updateMany({
      where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidedByName: actor.name ?? null, voidReason: reason },
    });
    if (voided.count === 0) {
      const exists = await this.prisma.tripAccountEntry.count({ where: { id } });
      if (!exists) throw new NotFoundException('هذا القيد غير موجود');
      throw new ConflictException('هذا القيد ملغى مسبقًا');
    }
    return { success: true };
  }

  async updateTaxFlags(tripId: string, dto: UpdateTaxFlagsDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { id: true, hotelBookings: { select: { id: true } } } });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const own = new Set(trip.hotelBookings.map((booking) => booking.id));
    if (dto.hotels?.some((hotel) => !own.has(hotel.id))) throw new BadRequestException('حجز الفندق لا يخص هذه الرحلة');

    await this.prisma.$transaction(async (tx) => {
      if (dto.rentHasTaxInvoice !== undefined) {
        await tx.tripBusCost.upsert({
          where: { tripId },
          create: { tripId, rentHasTaxInvoice: dto.rentHasTaxInvoice },
          update: { rentHasTaxInvoice: dto.rentHasTaxInvoice },
        });
      }
      for (const hotel of dto.hotels ?? []) {
        await tx.hotelBooking.update({ where: { id: hotel.id }, data: { hasTaxInvoice: hotel.hasTaxInvoice } });
      }
    });
    return { success: true };
  }

  categories() {
    return this.prisma.accountCategory.findMany({ orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }] });
  }

  async createCategory(dto: CreateCategoryDto) {
    const taken = await this.prisma.accountCategory.count({ where: { name: dto.name } });
    if (taken) throw new ConflictException('يوجد بند بهذا الاسم');
    return this.prisma.accountCategory.create({ data: dto });
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.accountCategory.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('هذا البند غير موجود');
    if (AUTOMATIC_GROUPS.includes(category.group)) throw new ConflictException('هذا البند يُحسب تلقائيًا ولا يمكن إيقافه');
    return this.prisma.accountCategory.update({ where: { id }, data: { isActive: dto.isActive } });
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountCategoryGroup, AccountParty, EntrySettlement, Prisma, TripStatus } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { vatInside } from '../../common/utils/invoice.util';
import { halalas, hotelBookingCost, hotelCostByType, netBookingFigures } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDayRange, riyadhDaysRange, riyadhMonthRange } from '../../common/utils/time.util';
import { journeyCodeOf } from '../../common/utils/trip-code.util';
import { readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { EXPENSE_CATEGORY_LABELS } from '../closings/general-expenses.service';
import { AccountView, CreateCategoryDto, CreateEntryDto, TripAccountsQuery, UpdateCategoryDto, UpdateTaxFlagsDto } from './trip-accounts.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const BY_TRIP_LIMIT = 100;
const sar = (value: number) => Math.round(value) / 100;
const AUTOMATIC_GROUPS: AccountCategoryGroup[] = ['HOTEL', 'BUS'];
const POSTING_TX_OPTIONS = { timeout: 20_000 };

const ACCOUNT_SELECT = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  tripStatus: true,
  executedAt: true,
  financeClosedAt: true,
  financeClosedByName: true,
  totalSeats: true,
  busRentalPrice: true,
  bookings: {
    select: {
      status: true,
      source: true,
      branchId: true,
      totalPrice: true,
      /** Wallet credit for a stopped ticket: a credit note on the sale, so it comes off the ticket revenue. */
      compensation: { select: { amount: true } },
      refundAmount: true,
      payment: { select: { amount: true, walletAmount: true, status: true } },
      collections: { select: { amount: true } },
      externalRefunded: true,
      cashMovements: { where: { type: 'BOOKING_REFUND' as const }, select: { amount: true } },
      _count: { select: { passengers: { where: { cancelled: false } } } },
    },
  },
  hotelBookings: {
    where: { status: 'CONFIRMED' as const },
    select: {
      id: true,
      nightlyRate: true,
      privateNightlyRate: true,
      rateUnit: true,
      extraCost: true,
      checkIn: true,
      checkOut: true,
      hasTaxInvoice: true,
      hotel: { select: { name: true } },
      rooms: { select: { type: true, _count: { select: { occupants: true } } } },
    },
  },
  accountEntries: { where: { voidedAt: null }, select: { amount: true, chargedTo: true, settlement: true, category: { select: { group: true } } } },
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

type PostedLine = { chargedTo: AccountParty; settlement: EntrySettlement };

/**
 * A line that sits inside a bill the account already counts, so adding it would count it twice: anything posted to the bus
 * company comes out of its rent, and a hotel prepayment is offset against the hotel's bill. A cancelled trip owes no hotel
 * bill, so its hotel prepayment is a cost of its own.
 */
const insideBill = (line: PostedLine, live: boolean) => line.chargedTo === 'BUS_COMPANY' || (live && line.chargedTo === 'HOTEL' && line.settlement === 'PREPAID');

/** Each party's side of one trip's lines, in halalas. */
function partyTotals(lines: (PostedLine & { amount: Prisma.Decimal; group: AccountCategoryGroup })[], rent: number, hotelBills: number) {
  const parties = {
    BUS_COMPANY: { amount: 0, dueMonthEnd: 0, prepaid: 0 },
    HOTEL: { amount: 0, dueMonthEnd: 0, prepaid: 0 },
    OFFICE: { amount: 0, dueMonthEnd: 0, prepaid: 0 },
  };
  for (const line of lines) {
    if (line.group === 'INCOME') continue;
    const amount = halalas(line.amount);
    const party = parties[line.chargedTo];
    party.amount += amount;
    if (line.settlement === 'DUE_MONTH_END') party.dueMonthEnd += amount;
    if (line.settlement === 'PREPAID') party.prepaid += amount;
  }
  const hotelExtras = parties.HOTEL.amount - parties.HOTEL.prepaid;
  return {
    busCompany: {
      rent: sar(rent),
      /** Paid by the office on the company's behalf or ahead of the rent; it comes out of what the company is owed. */
      deducted: sar(parties.BUS_COMPANY.amount),
      balance: sar(rent - parties.BUS_COMPANY.amount),
      dueMonthEnd: sar(parties.BUS_COMPANY.dueMonthEnd),
      prepaid: sar(parties.BUS_COMPANY.prepaid),
    },
    hotel: {
      bills: sar(hotelBills),
      /** Fines and extras beyond the room bills. */
      extras: sar(hotelExtras),
      prepaid: sar(parties.HOTEL.prepaid),
      balance: sar(hotelBills + hotelExtras - parties.HOTEL.prepaid),
      dueMonthEnd: sar(parties.HOTEL.dueMonthEnd),
    },
    office: { amount: sar(parties.OFFICE.amount), dueMonthEnd: sar(parties.OFFICE.dueMonthEnd), prepaid: sar(parties.OFFICE.prepaid) },
    dueMonthEnd: sar(parties.BUS_COMPANY.dueMonthEnd + parties.HOTEL.dueMonthEnd + parties.OFFICE.dueMonthEnd),
    prepaid: sar(parties.BUS_COMPANY.prepaid + parties.HOTEL.prepaid + parties.OFFICE.prepaid),
  };
}

/** A DR journey: the way there with its way back, whose money is one account. */
const JOURNEY_SELECT = {
  ...ACCOUNT_SELECT,
  codeNumber: true,
  codePeriod: true,
  reverseTrip: { select: ACCOUNT_SELECT },
} satisfies Prisma.TripSelect;

/**
 * What one booking adds to the ticket revenue, in halalas: its price (already less any ticket cancelled on its own) less a
 * compensation credited on it, or, once cancelled, only the money kept. Credit notes are covered either way.
 */
export function soldOf(booking: AccountTrip['bookings'][number]) {
  const kept = netBookingFigures(booking).held;
  if (booking.status === 'CANCELLED') return kept;
  return halalas(booking.totalPrice) - halalas(booking.compensation?.amount ?? 0);
}

/** Whose column a booking's sale belongs to in the branch statements: the app's, its branch's, or the head office's. */
export const APP_COLUMN = 'APP';
export const HQ_COLUMN = 'HQ';
/** A journey nobody sold: its result is the company's, shared out in the settlement like head-office costs. */
export const SHARED_COLUMN = 'SHARED';
export const columnOf = (booking: { source: string; branchId: string | null }) => (booking.source === 'APP' ? APP_COLUMN : booking.branchId ?? HQ_COLUMN);

/** Shares `total` by `weights`, rounding so the parts add up to it exactly (the largest weight takes the halalas left over). */
function shareOut(total: number, weights: Map<string, number>) {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const parts = new Map<string, number>();
  if (sum <= 0) return parts;
  let given = 0;
  let largest = '';
  for (const [key, weight] of weights) {
    const part = Math.round((total * weight) / sum);
    parts.set(key, part);
    given += part;
    if (!largest || weight > weights.get(largest)!) largest = key;
  }
  parts.set(largest, parts.get(largest)! + total - given);
  return parts;
}

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
    tickets += soldOf(booking);
    if (booking.status !== 'CANCELLED') passengers += booking._count.passengers;
  }
  const counted = trip.accountEntries.filter((entry) => !insideBill(entry, live));
  // A line posted to a hotel (a fine, an extra) is part of the hotels' cost; the office's own lines keep their columns.
  const entered = (group: AccountCategoryGroup) =>
    counted.filter((entry) => entry.chargedTo === 'OFFICE' && entry.category.group === group).reduce((sum, entry) => sum + halalas(entry.amount), 0);
  const hotelExtras = counted.filter((entry) => entry.chargedTo === 'HOTEL' && entry.category.group !== 'INCOME').reduce((sum, entry) => sum + halalas(entry.amount), 0);

  // A cancelled trip does not run, so the bus and the hotels are not owed for it.
  const bus = live ? halalas(trip.busRentalPrice ?? 0) : 0;
  const hotels = (live ? trip.hotelBookings.reduce((sum, booking) => sum + hotelBookingCost(booking), 0) : 0) + hotelExtras;
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

/**
 * The DR journey's account: revenue and expenses of the way there (D) and the way back (R) together. Each leg keeps its own
 * manifest and its own entries, but the journey is what earns or loses.
 */
function journeyFigures(legs: AccountTrip[]): Figures {
  const all = legs.map(accountFigures);
  const sum = (key: keyof Figures) => all.reduce((total, figures) => total + figures[key], 0);
  return {
    tickets: sum('tickets'),
    otherIncome: sum('otherIncome'),
    revenue: sum('revenue'),
    hotels: sum('hotels'),
    bus: sum('bus'),
    driver: sum('driver'),
    admin: sum('admin'),
    other: sum('other'),
    expenses: sum('expenses'),
    net: sum('net'),
    collected: sum('collected'),
    remaining: sum('remaining'),
    passengers: sum('passengers'),
  };
}

/** A way back counts once it ran or sold; one cancelled with nothing on it is left out of the journey. */
function legsOf(trip: AccountTrip & { reverseTrip: AccountTrip | null }) {
  const back = trip.reverseTrip;
  const counts = back && (back.tripStatus !== 'CANCELLED' || back.bookings.length > 0 || back.accountEntries.length > 0 || back.custodies.length > 0);
  return counts ? [trip, back] : [trip];
}

/** A leg is over once executed (an hour after departure), completed, or cancelled. */
const legEnded = (leg: { executedAt: Date | null; tripStatus: TripStatus }) => !!leg.executedAt || leg.tripStatus === 'COMPLETED' || leg.tripStatus === 'CANCELLED';
const ENDED_LEG: Prisma.TripWhereInput = { OR: [{ executedAt: { not: null } }, { tripStatus: { in: ['COMPLETED', 'CANCELLED'] } }] };

export type ClosingState = 'OPEN' | 'AWAITING_CLOSE' | 'CLOSED';

/** Where a DR journey is in its financial closing: still running, executed and waiting for the office to close it, or closed. */
function closingOf(outbound: { financeClosedAt: Date | null }, legs: { executedAt: Date | null; tripStatus: TripStatus }[]): ClosingState {
  if (outbound.financeClosedAt) return 'CLOSED';
  return legs.every(legEnded) ? 'AWAITING_CLOSE' : 'OPEN';
}

/** The same as closingOf, as a query on the way there; a way back that never ran does not hold the journey open. */
const CLOSING_WHERE: Record<ClosingState, Prisma.TripWhereInput> = {
  CLOSED: { financeClosedAt: { not: null } },
  AWAITING_CLOSE: { financeClosedAt: null, AND: [ENDED_LEG, { OR: [{ reverseTrip: null }, { reverseTrip: ENDED_LEG }] }] },
  OPEN: { financeClosedAt: null, OR: [{ NOT: ENDED_LEG }, { reverseTrip: { NOT: ENDED_LEG } }] },
};

/** A cancelled trip only belongs on the accounts page if money was spent or kept on it, or its way back still runs. */
const ON_ACCOUNTS_PAGE: Prisma.TripWhereInput = {
  OR: [
    { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
    { tripStatus: 'CANCELLED', accountEntries: { some: { voidedAt: null } } },
    { tripStatus: 'CANCELLED', custodies: { some: { status: 'SETTLED' } } },
    { tripStatus: 'CANCELLED', reverseTrip: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } } },
  ],
};

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

/** A chosen period (from/to, both included) for the month view; capped so one request cannot sweep years of trips. */
const MAX_PERIOD_DAYS = 366;
function daysRange(from: string, to: string) {
  const range = riyadhDaysRange(from, to);
  if (!range) throw new BadRequestException('التاريخ غير صحيح');
  if (range.lt.getTime() - range.gte.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw new BadRequestException('الفترة أطول من سنة');
  return range;
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
    const range = view === 'trip' ? null : view === 'month' && query.from && query.to ? daysRange(query.from, query.to) : viewRange(view, date);

    const where: Prisma.TripWhereInput = {
      // One row per DR journey: a way back is counted inside the trip it returns from.
      reverseOfTripId: null,
      ...(range && { departureTime: range }),
      ...(query.destination && { destination: query.destination }),
      AND: [
        ...(query.closing ? [CLOSING_WHERE[query.closing]] : []),
        ...(query.q
          ? [{ OR: [{ tripCode: { contains: query.q, mode: 'insensitive' as const } }, { reverseTrip: { tripCode: { contains: query.q, mode: 'insensitive' as const } } }] }]
          : []),
        ON_ACCOUNTS_PAGE,
      ],
    };

    const [trips, total, destinations, awaitingClose] = await Promise.all([
      this.prisma.trip.findMany({
        where,
        orderBy: { departureTime: view === 'trip' ? 'desc' : 'asc' },
        ...(view === 'trip' && { take: BY_TRIP_LIMIT }),
        select: JOURNEY_SELECT,
      }),
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({ where: { tripStatus: { not: 'DRAFT' } }, distinct: ['destination'], select: { destination: true }, orderBy: { destination: 'asc' } }),
      // Whatever the period shown, the office sees how many executed trips still wait for their closing.
      this.prisma.trip.count({ where: { reverseOfTripId: null, AND: [ON_ACCOUNTS_PAGE, CLOSING_WHERE.AWAITING_CLOSE] } }),
    ]);

    // "By trip" fetches the latest trips (newest first, capped), then lists them oldest → newest like every other view.
    if (view === 'trip') trips.reverse();
    const rows = trips.map((trip) => ({ trip, legs: legsOf(trip), figures: journeyFigures(legsOf(trip)) }));
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
        awaitingClose,
      },
      items: rows.map(({ trip, legs, figures }) => ({
        id: trip.id,
        tripCode: trip.tripCode,
        journeyCode: journeyCodeOf(trip),
        destination: trip.destination,
        departureTime: trip.departureTime,
        tripStatus: trip.tripStatus,
        executedAt: trip.executedAt,
        closing: closingOf(trip, legs),
        financeClosedAt: trip.financeClosedAt,
        financeClosedByName: trip.financeClosedByName,
        rentMissing: legs.some((leg) => leg.tripStatus !== 'CANCELLED' && leg.busRentalPrice === null),
        // Each leg's own share, for the row that opens up into D and R.
        legs: legs.map((leg, index) => ({
          id: leg.id,
          tripCode: leg.tripCode,
          role: index === 0 ? 'OUTBOUND' : 'RETURN',
          departureTime: leg.departureTime,
          tripStatus: leg.tripStatus,
          ...figuresInSar(accountFigures(leg)),
        })),
        ...figuresInSar(figures),
      })),
    };
  }

  /**
   * Profit on money actually received, for the trips list: what paid bookings brought in (after refunds), plus other income,
   * less the trip's costs as they stand. Unlike the accounts page's net, an unpaid seat adds nothing here yet.
   */
  async currentProfits() {
    const trips = await this.prisma.trip.findMany({
      where: { reverseOfTripId: null, OR: [{ tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } }, { reverseTrip: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } } }] },
      select: JOURNEY_SELECT,
    });
    const profitOf = (figures: Figures) => {
      const paid = figures.collected + figures.otherIncome;
      return { collected: sar(figures.collected), expenses: sar(figures.expenses), profit: sar(paid - figures.expenses) };
    };
    // The journey's profit sits on its way there; the way back shows its own share and which journey it belongs to.
    return Object.fromEntries(
      trips.flatMap((trip) => {
        const legs = legsOf(trip);
        const journey = { ...profitOf(journeyFigures(legs)), journeyCode: journeyCodeOf(trip), isJourney: legs.length > 1 };
        const back = legs[1];
        return [
          [trip.id, journey],
          ...(back ? [[back.id, { ...profitOf(accountFigures(back)), journeyCode: journeyCodeOf(trip), partOfTripId: trip.id }]] : []),
        ];
      }),
    );
  }

  async detail(id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      select: {
        ...ACCOUNT_SELECT,
        codeNumber: true,
        codePeriod: true,
        busCost: { select: { rentHasTaxInvoice: true } },
        bus: { select: { plateNumber: true, office: { select: { name: true } } } },
        reverseTrip: { select: ACCOUNT_SELECT },
        reverseOf: { select: { ...ACCOUNT_SELECT, reverseTrip: { select: ACCOUNT_SELECT } } },
      },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    // Either leg opens the same DR journey's account.
    const outbound = trip.reverseOf ?? { ...trip, reverseTrip: trip.reverseTrip };
    const journeyLegs = legsOf(outbound);

    const [pendingCustody, entries, vatRate, branchExpenses] = await Promise.all([
      this.prisma.custodyExpense.aggregate({ where: { voidedAt: null, custody: { tripId: id, status: 'OPEN' } }, _sum: { amount: true } }),
      this.prisma.tripAccountEntry.findMany({
        where: { tripId: id },
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
        // The file bytes stay out: they are fetched one at a time, and only when asked for.
        include: { category: { select: { name: true, group: true } }, attachments: { select: { id: true, fileName: true, size: true }, orderBy: { createdAt: 'asc' } } },
      }),
      this.ledger.vatRate(this.prisma),
      // Recorded on the expenses page with this trip named: shown here for reference, they stay general expenses outside the profit.
      this.prisma.generalExpense.findMany({
        where: { tripId: id, voidedAt: null },
        orderBy: [{ spentOn: 'desc' }, { number: 'desc' }],
        select: { id: true, number: true, category: true, description: true, supplierName: true, amount: true, spentOn: true, branch: { select: { name: true } } },
      }),
    ]);
    const figures = accountFigures(trip);
    const live = trip.tripStatus !== 'CANCELLED';
    const hotelBills = live ? trip.hotelBookings.reduce((sum, booking) => sum + hotelBookingCost(booking), 0) : 0;
    const standing = entries.filter((entry) => !entry.voidedAt).map((entry) => ({ ...entry, group: entry.category.group }));

    return {
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        origin: trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        tripStatus: trip.tripStatus,
        executedAt: trip.executedAt,
        totalSeats: trip.totalSeats,
        busPlate: trip.bus?.plateNumber ?? null,
        officeName: trip.bus?.office?.name ?? null,
      },
      vatRate,
      // The journey closes as one account, on its way there.
      closing: {
        state: closingOf(outbound, journeyLegs),
        tripId: outbound.id,
        closedAt: outbound.financeClosedAt,
        closedByName: outbound.financeClosedByName,
      },
      figures: figuresInSar(figures),
      journey:
        journeyLegs.length > 1
          ? {
              journeyCode: journeyCodeOf(trip),
              legs: journeyLegs.map((leg, index) => ({ id: leg.id, tripCode: leg.tripCode, role: index === 0 ? 'OUTBOUND' : 'RETURN', tripStatus: leg.tripStatus, departureTime: leg.departureTime })),
              figures: figuresInSar(journeyFigures(journeyLegs)),
            }
          : null,
      pendingCustody: Number(pendingCustody._sum.amount ?? 0),
      rent: live ? { amount: sar(figures.bus), missing: trip.busRentalPrice === null, hasTaxInvoice: trip.busCost?.rentHasTaxInvoice ?? false } : null,
      hotels: live
        ? trip.hotelBookings.map((booking) => ({
            id: booking.id,
            name: booking.hotel.name,
            amount: sar(hotelBookingCost(booking)),
            hasTaxInvoice: booking.hasTaxInvoice,
            rateUnit: booking.rateUnit,
            extraCost: Number(booking.extraCost),
            /** The room bill by room type: rooms × nights × that type's rate. */
            byType: hotelCostByType(booking).map((row) => ({ ...row, rate: sar(row.rate), amount: sar(row.amount) })),
          }))
        : [],
      parties: partyTotals(standing, figures.bus, hotelBills),
      branchExpenses: branchExpenses.map((row) => ({
        id: row.id,
        number: row.number,
        categoryLabel: EXPENSE_CATEGORY_LABELS[row.category],
        description: row.description,
        supplierName: row.supplierName,
        branchName: row.branch?.name ?? null,
        amount: Number(row.amount),
        spentOn: row.spentOn.toISOString().slice(0, 10),
      })),
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
        chargedTo: entry.chargedTo,
        settlement: entry.settlement,
        settledAt: entry.settledAt,
        settledByName: entry.settledByName,
        /** Already inside the rent or a hotel bill, so not added to the expenses again. */
        insideBill: insideBill(entry, live),
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
    await this.assertAccountOpen(tripId);
    if (!category || !category.isActive) throw new BadRequestException('هذا البند غير متاح');
    if (AUTOMATIC_GROUPS.includes(category.group)) throw new BadRequestException('هذا البند يُحسب تلقائيًا من بيانات الرحلة، فلا يُسجّل يدويًا');
    const chargedTo = dto.chargedTo ?? 'OFFICE';
    const settlement = dto.settlement ?? 'PAID';
    if (category.group === 'INCOME' && (chargedTo !== 'OFFICE' || settlement !== 'PAID')) throw new BadRequestException('الإيراد يُسجّل للمكتب ومقبوضًا');

    const day = riyadhDayRange(dto.spentOn);
    if (!day) throw new BadRequestException('التاريخ غير صحيح');
    if (day.start > new Date()) throw new BadRequestException('لا يمكن تسجيل مصروف بتاريخ لاحق');

    // Only an expense with a tax invoice behind it reduces the VAT owed. A line inside the rent or a hotel bill is covered by that bill's own invoice.
    const taxInvoice = dto.hasTaxInvoice && category.group !== 'INCOME' && !insideBill({ chargedTo, settlement }, true);
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
          chargedTo,
          settlement,
          settledAt: settlement === 'DUE_MONTH_END' ? null : new Date(),
          ...(settlement !== 'DUE_MONTH_END' && { settledByName: actor.name ?? null }),
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
    const entry = await this.prisma.tripAccountEntry.findUnique({ where: { id }, select: { tripId: true } });
    if (entry) await this.assertAccountOpen(entry.tripId);
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

  /** A closed account is final: reopen it before changing its lines. */
  private async assertAccountOpen(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { financeClosedAt: true, reverseOf: { select: { financeClosedAt: true } } } });
    if (trip?.financeClosedAt || trip?.reverseOf?.financeClosedAt) throw new ConflictException('تم الإغلاق المالي لهذه الرحلة، أعد فتح حسابها أولًا');
  }

  /** The journey's outbound with both legs, whichever leg was asked for. */
  private async journeyOf(tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        executedAt: true,
        tripStatus: true,
        financeClosedAt: true,
        reverseTrip: { select: { executedAt: true, tripStatus: true } },
        reverseOf: { select: { id: true, executedAt: true, tripStatus: true, financeClosedAt: true, reverseTrip: { select: { executedAt: true, tripStatus: true } } } },
      },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const outbound = trip.reverseOf ?? trip;
    return { outbound, legs: [outbound, ...(outbound.reverseTrip ? [outbound.reverseTrip] : [])] };
  }

  /** Financial closing: once the journey was executed, the office reviews its account and closes it. */
  async close(actor: { name?: string | null }, tripId: string) {
    const { outbound, legs } = await this.journeyOf(tripId);
    if (outbound.tripStatus === 'DRAFT') throw new ConflictException('هذه الرحلة ما زالت مسودة');
    if (outbound.financeClosedAt) throw new ConflictException('تم الإغلاق المالي لهذه الرحلة مسبقًا');
    if (!legs.every(legEnded)) throw new ConflictException('لا يُغلق حساب الرحلة ماليًا قبل تنفيذها');
    // Closing and posting the profit are one step: a closed account always has its profit posted, exactly once.
    return this.prisma.$transaction(async (tx) => {
      const closedAt = new Date();
      const closed = await tx.trip.updateMany({ where: { id: outbound.id, financeClosedAt: null }, data: { financeClosedAt: closedAt, financeClosedByName: actor.name ?? null } });
      if (closed.count === 0) throw new ConflictException('تم الإغلاق المالي لهذه الرحلة مسبقًا');
      const posted = await this.postProfit(tx, outbound.id, { at: closedAt, byName: actor.name ?? null });
      return { success: true, posted };
    }, POSTING_TX_OPTIONS);
  }

  /** The owner reopens a closed account. What was posted stays; closing again posts only the difference. */
  async reopen(actor: { name?: string | null }, tripId: string) {
    const { outbound } = await this.journeyOf(tripId);
    const reopened = await this.prisma.trip.updateMany({ where: { id: outbound.id, financeClosedAt: { not: null } }, data: { financeClosedAt: null, financeClosedByName: null } });
    if (reopened.count === 0) throw new ConflictException('حساب هذه الرحلة مفتوح');
    return { success: true, reopenedBy: actor.name ?? null };
  }

  /**
   * Posts the journey's net profit (or loss) to the branches by their share of its bookings. Whatever was posted before is
   * taken into account, so the first closing posts the whole and every later closing posts only what changed (ADJUSTMENT).
   * A journey nobody sold is shared by the settlement like head-office costs. Run inside a transaction holding the journey's closing.
   */
  async postProfit(tx: Prisma.TransactionClient, outboundId: string, options: { at: Date; byName: string | null }) {
    // One posting at a time for a journey, so two closings can never both post the same profit.
    await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${outboundId} FOR UPDATE`;
    const trip = await tx.trip.findUniqueOrThrow({ where: { id: outboundId }, select: JOURNEY_SELECT });
    const legs = legsOf(trip);
    const figures = journeyFigures(legs);

    const weights = new Map<string, number>();
    for (const leg of legs) {
      for (const booking of leg.bookings) {
        const sold = soldOf(booking);
        if (sold > 0) weights.set(columnOf(booking), (weights.get(columnOf(booking)) ?? 0) + sold);
      }
    }
    if (weights.size === 0) weights.set(SHARED_COLUMN, 1);
    const revenue = shareOut(figures.revenue, weights);
    const costs = shareOut(figures.expenses, weights);

    const before = await tx.tripProfitPosting.groupBy({ by: ['columnKey'], where: { tripId: outboundId }, _sum: { revenue: true, costs: true } });
    const posted = new Map(before.map((row) => [row.columnKey, { revenue: halalas(row._sum.revenue ?? 0), costs: halalas(row._sum.costs ?? 0) }]));
    const keys = new Set([...weights.keys(), ...posted.keys()]);
    const branchIds = [...keys].filter((key) => key !== APP_COLUMN && key !== HQ_COLUMN && key !== SHARED_COLUMN);
    const branches = await tx.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } });
    const nameOf = (key: string) => (key === APP_COLUMN ? 'التطبيق' : key === HQ_COLUMN ? 'الإدارة العامة' : key === SHARED_COLUMN ? 'مشتركة على الفروع (لم يُبع منها شيء)' : branches.find((branch) => branch.id === key)?.name ?? 'فرع');

    const kind = before.length > 0 ? 'ADJUSTMENT' : 'CLOSE';
    const rows: Prisma.TripProfitPostingCreateManyInput[] = [];
    for (const key of keys) {
      const deltaRevenue = (revenue.get(key) ?? 0) - (posted.get(key)?.revenue ?? 0);
      const deltaCosts = (costs.get(key) ?? 0) - (posted.get(key)?.costs ?? 0);
      // The first closing records every column, even at zero, so the account shows where its profit went.
      if (kind === 'ADJUSTMENT' && deltaRevenue === 0 && deltaCosts === 0) continue;
      rows.push({
        tripId: outboundId,
        columnKey: key,
        columnName: nameOf(key),
        kind,
        revenue: sar(deltaRevenue),
        costs: sar(deltaCosts),
        net: sar(deltaRevenue - deltaCosts),
        postedAt: options.at,
        postedByName: options.byName,
      });
    }
    if (rows.length) await tx.tripProfitPosting.createMany({ data: rows });
    return { kind, net: sar(rows.reduce((sum, row) => sum + halalas(row.net as number), 0)), columns: rows.length };
  }

  /**
   * Accounts closed before profits were posted have nothing on record: they are posted now, dated when they were closed, so
   * the settlement of that month still sees them. Safe to run any number of times.
   */
  async postMissing() {
    const missing = await this.prisma.trip.findMany({
      where: { reverseOfTripId: null, financeClosedAt: { not: null }, profitPostings: { none: {} } },
      select: { id: true, financeClosedAt: true, financeClosedByName: true },
    });
    for (const trip of missing) {
      await this.prisma.$transaction(async (tx) => {
        // Another request may have posted it meanwhile; the lock inside postProfit makes the check below reliable.
        await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${trip.id} FOR UPDATE`;
        if ((await tx.tripProfitPosting.count({ where: { tripId: trip.id } })) > 0) return;
        await this.postProfit(tx, trip.id, { at: trip.financeClosedAt!, byName: trip.financeClosedByName });
      }, POSTING_TX_OPTIONS);
    }
    return missing.length;
  }

  /** The journey's postings, newest first, with each column's running total. */
  async postings(tripId: string) {
    const { outbound } = await this.journeyOf(tripId);
    const rows = await this.prisma.tripProfitPosting.findMany({ where: { tripId: outbound.id }, orderBy: [{ postedAt: 'desc' }, { columnName: 'asc' }] });
    const totals = new Map<string, { columnKey: string; columnName: string; revenue: number; costs: number; net: number }>();
    for (const row of rows) {
      const total = totals.get(row.columnKey) ?? { columnKey: row.columnKey, columnName: row.columnName, revenue: 0, costs: 0, net: 0 };
      total.revenue += halalas(row.revenue);
      total.costs += halalas(row.costs);
      total.net += halalas(row.net);
      totals.set(row.columnKey, total);
    }
    return {
      tripId: outbound.id,
      items: rows.map((row) => ({ ...row, revenue: Number(row.revenue), costs: Number(row.costs), net: Number(row.net) })),
      totals: [...totals.values()].map((total) => ({ ...total, revenue: sar(total.revenue), costs: sar(total.costs), net: sar(total.net) })),
      net: sar([...totals.values()].reduce((sum, total) => sum + total.net, 0)),
    };
  }

  /** A line left for the month's end has now been paid. */
  async settleEntry(actor: { name?: string | null }, id: string) {
    const settled = await this.prisma.tripAccountEntry.updateMany({
      where: { id, voidedAt: null, settlement: 'DUE_MONTH_END' },
      data: { settlement: 'PAID', settledAt: new Date(), settledByName: actor.name ?? null },
    });
    if (settled.count === 0) {
      const entry = await this.prisma.tripAccountEntry.findUnique({ where: { id }, select: { voidedAt: true } });
      if (!entry) throw new NotFoundException('هذا القيد غير موجود');
      if (entry.voidedAt) throw new ConflictException('هذا القيد ملغى');
      throw new ConflictException('هذا القيد ليس مستحقًا آخر الشهر');
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

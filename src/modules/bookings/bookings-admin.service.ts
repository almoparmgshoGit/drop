import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { lockBookingWithTrip } from '../../common/services/booking-cancellation.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { AppSettingsService, withinHours } from '../../common/services/app-settings.service';
import { csvCell } from '../../common/utils/csv.util';
import { invoiceNumber } from '../../common/utils/invoice.util';
import { tripSeatLayout } from '../../common/utils/bus-layout.util';
import { goOnlyBookings, lockTripsWithLinked, releaseLinkedSeats, returnRideOf, reverseSeatsSummary, takeLinkedSeats } from '../../common/utils/linked-seats.util';
import { passengerWeights } from '../../common/utils/housing-price.util';
import { paymentFigures } from '../../common/utils/payment.util';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { CustomerLookup, parseCustomerLookup } from '../../common/utils/identity.util';
import { CustomerLookupService, LOOKUP_RESULT_LIMIT } from '../../common/services/customer-lookup.service';
import { signTicketToken } from '../../common/utils/ticket-token.util';
import { AdminBookingsQuery, BoardingOverrideDto, ChangeBoardingPointDto, ChangeSeatDto, QUICK_SEARCH_FIELDS, QuickSearchField, UpdatePassengerDto } from './bookings.dto';
import { cityTripWhere, tripInCity } from '../../common/utils/branch-city.util';
import { startOfRiyadhMonth } from '../../common/utils/time.util';
import { allocate, BookingsService, holdAvailableTo, randomCode, toHalalas, toSar } from './bookings.service';

const EDIT_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const EXPORT_LIMIT = 5000;
const SEARCH_LIMIT = 100;
const PAID_STATUSES = ['COMPLETED', 'SIMULATED'];

// Signed tokens are what a passenger scans to board, so they never leave through the panel endpoints.
const TICKET_SELECT = { select: { id: true, ticketNumber: true, isBoarded: true, boardedAt: true, returnBoardedAt: true } };

export interface BookingsActor {
  userId: string;
  permissions: string[];
}

const LIST_INCLUDE = {
  branch: { select: { id: true, name: true } },
  trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, estimatedArrivalAt: true, busType: true, bookingType: true } },
  passengers: { orderBy: { position: 'asc' }, select: { id: true, fullName: true, phone: true, nationalId: true, gender: true, nationality: true, seatNumber: true, hotelRoom: { select: { number: true, type: true, hotelBooking: { select: { hotel: { select: { id: true, name: true } } } } } }, ticket: TICKET_SELECT } },
  payment: true,
  collections: { select: { amount: true } },
  user: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.BookingInclude;

const PAPER_CODE = /^([A-Za-z]+-\d+)\.[\w-]+$/;

/**
 * A search-only employee's search, matched whole: the customer's or a passenger's full phone or ID number, a name of
 * at least two words, or one booking, group or ticket code. A trip code is left out on purpose: it would list a whole bus.
 */
function bookingLookupWhere(lookup: CustomerLookup): Prisma.BookingWhereInput {
  if (lookup.kind === 'phone') {
    const local = lookup.phone.slice(4);
    // A passenger's phone is stored as typed at the counter, so the usual spellings of the same number are all tried.
    const phones = [lookup.phone, `0${local}`, local, `966${local}`];
    return { OR: [{ user: { phone: lookup.phone } }, { passengers: { some: { phone: { in: phones } } } }] };
  }
  if (lookup.kind === 'idNumber') {
    return { OR: [{ user: { idNumber: lookup.idNumber } }, { passengers: { some: { nationalId: { equals: lookup.idNumber, mode: 'insensitive' } } } }] };
  }
  if (lookup.kind === 'name') {
    return { OR: [{ user: { name: { contains: lookup.name, mode: 'insensitive' } } }, { passengers: { some: { fullName: { contains: lookup.name, mode: 'insensitive' } } } }] };
  }
  const code = lookup.code.replace(PAPER_CODE, '$1');
  return {
    OR: [
      { bookingReference: { equals: code, mode: 'insensitive' } },
      { groupReference: { equals: code, mode: 'insensitive' } },
      { tickets: { some: { ticketNumber: { equals: code, mode: 'insensitive' } } } },
    ],
  };
}

@Injectable()
export class BookingsAdminService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private events: BookingEventsService,
    private bookings: BookingsService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
    private lookups: CustomerLookupService,
  ) {}

  /** Without bookings.list the table stays empty until one exact search, which is counted and logged like a customer search. */
  private async lookupScope(actor: BookingsActor, search: string, ip?: string): Promise<{ where: Prisma.BookingWhereInput; done: (rows: number) => Promise<void> } | null> {
    if (!search.trim()) return null;
    const lookup = parseCustomerLookup(search, { allowCodes: true });
    await this.lookups.consume(actor);
    return {
      where: { ...(await this.branchScope(actor)), ...bookingLookupWhere(lookup) },
      done: (rows) => this.lookups.record(actor, 'GET /bookings/admin/lookup', lookup, rows, ip),
    };
  }

  /** Limits a query to the employee's branch. The branch is read from the database, so moving someone applies immediately. */
  /** A branch with a city also serves its city's trips: their bookings from the app and other branches show there too. */
  private async branchScope(actor: BookingsActor, requested?: string): Promise<Prisma.BookingWhereInput> {
    if (actor.permissions.includes('bookings.all_branches')) return requested ? { branchId: requested } : {};
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true, branch: { select: { city: true } } } });
    if (!me?.branchId || (requested && requested !== me.branchId)) throw new ForbiddenException('لا يمكنك عرض حجوزات خارج فرعك');
    const city = me.branch?.city?.trim();
    // Under AND, so it never replaces an OR the search itself builds.
    return city ? { AND: [{ OR: [{ branchId: me.branchId }, { trip: cityTripWhere(city) }] }] } : { branchId: me.branchId };
  }

  /** A booking of another branch reads as missing or refused the same way everywhere on these routes. */
  async assertVisible(actor: BookingsActor, bookingId: string) {
    if (actor.permissions.includes('bookings.all_branches')) return;
    const [booking, me] = await Promise.all([
      this.prisma.booking.findUnique({ where: { id: bookingId }, select: { branchId: true, trip: { select: { origin: true, destination: true } } } }),
      this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true, branch: { select: { city: true } } } }),
    ]);
    if (!booking) throw new NotFoundException('Booking not found');
    const city = me?.branch?.city?.trim();
    const inMyCity = !!city && tripInCity(booking.trip, city);
    if (!me?.branchId || (booking.branchId !== me.branchId && !inMyCity)) throw new ForbiddenException('هذا الحجز خارج نطاق فرعك');
  }

  private buildWhere(query: AdminBookingsQuery): Prisma.BookingWhereInput {
    const where: Prisma.BookingWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.tripId) where.tripId = query.tripId;
    if (query.search) {
      where.OR = [
        { bookingReference: { contains: query.search, mode: 'insensitive' } },
        { user: { phone: { contains: query.search } } },
        { user: { name: { contains: query.search, mode: 'insensitive' } } },
        { passengers: { some: { fullName: { contains: query.search, mode: 'insensitive' } } } },
      ];
    }
    if (query.payment === 'PAID') where.payment = { status: { in: PAID_STATUSES } };
    if (query.payment === 'PENDING') where.payment = { status: 'PENDING' };
    if (query.payment === 'REFUNDED') where.paymentTransactions = { some: { type: 'REFUND', status: 'SUCCEEDED' } };
    if (query.boarding === 'WAITING') where.tickets = { none: { isBoarded: true } };
    if (query.boarding === 'BOARDED') where.AND = [{ tickets: { some: {} } }, { tickets: { none: { isBoarded: false } } }];
    if (query.boarding === 'PARTIAL') where.AND = [{ tickets: { some: { isBoarded: true } } }, { tickets: { some: { isBoarded: false } } }];
    if (query.month) {
      const [year, month] = query.month.split('-').map(Number);
      const offset = 3 * 60 * 60 * 1000;
      where.trip = {
        departureTime: {
          gte: new Date(Date.UTC(year, month - 1, 1) - offset),
          lt: new Date(Date.UTC(year, month, 1) - offset),
        },
      };
    } else if (query.from === 'currentMonth') {
      where.trip = { departureTime: { gte: startOfRiyadhMonth() } };
    }
    return where;
  }

  async list(actor: BookingsActor, query: AdminBookingsQuery, ip?: string) {
    if (!actor.permissions.includes('bookings.list')) {
      const empty = { items: [] as unknown[], total: 0, page: 1, limit: LOOKUP_RESULT_LIMIT, reverse: null, restricted: true, tooMany: false, summary: null };
      const scoped = await this.lookupScope(actor, query.search ?? '', ip);
      if (!scoped) return empty;
      const [items, total] = await Promise.all([
        this.prisma.booking.findMany({ where: scoped.where, include: LIST_INCLUDE, orderBy: { createdAt: 'desc' }, take: LOOKUP_RESULT_LIMIT }),
        this.prisma.booking.count({ where: scoped.where }),
      ]);
      await scoped.done(items.length);
      const { bookingIds: goOnly } = await goOnlyBookings(this.prisma, [...new Set(items.map((item) => item.tripId))]);
      return { ...empty, items: items.map((item) => ({ ...item, goOnly: goOnly.has(item.id) })), total: items.length, tooMany: total > LOOKUP_RESULT_LIMIT };
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const scope = await this.branchScope(actor, query.branchId);
    const where = { ...this.buildWhere(query), ...scope };
    const [items, total, pendingPayment, cancellationRequests] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
      this.prisma.booking.count({ where: { ...scope, payment: { status: 'PENDING' }, status: { not: 'CANCELLED' } } }),
      this.prisma.booking.count({ where: { ...scope, status: 'PENDING_CANCELLATION_REVIEW' } }),
    ]);
    const [{ bookingIds: goOnly }, reverse] = await Promise.all([
      goOnlyBookings(this.prisma, [...new Set(items.map((item) => item.tripId))]),
      query.tripId ? reverseSeatsSummary(this.prisma, query.tripId) : null,
    ]);
    return {
      items: items.map((item) => ({ ...item, goOnly: goOnly.has(item.id) })),
      total,
      page,
      limit,
      reverse,
      restricted: false,
      summary: { pendingPayment, cancellationRequests },
    };
  }

  async quickSearch(actor: BookingsActor, typed: string, ip?: string, fields?: QuickSearchField[]) {
    // A printed branch ticket scans as its reference plus a signature; only the reference is searchable.
    const q = typed.replace(PAPER_CODE, '$1');
    const restricted = !actor.permissions.includes('bookings.list');
    const scoped = restricted ? await this.lookupScope(actor, typed, ip) : null;
    if (restricted && !scoped) throw new BadRequestException('اكتب ما تبحث عنه');
    // "البحث في": each field the user leaves on adds its own conditions; none chosen means all of them.
    const byField: Record<QuickSearchField, Prisma.BookingWhereInput[]> = {
      name: [{ passengers: { some: { fullName: { contains: q, mode: 'insensitive' } } } }],
      nationalId: [
        { passengers: { some: { nationalId: { contains: q, mode: 'insensitive' } } } },
        { user: { idNumber: { contains: q.toUpperCase() } } },
      ],
      phone: [{ user: { phone: { contains: q } } }, { passengers: { some: { phone: { contains: q } } } }],
      reference: [
        { bookingReference: { contains: q, mode: 'insensitive' } },
        { tickets: { some: { ticketNumber: { equals: q, mode: 'insensitive' } } } },
      ],
      trip: [{ trip: { tripCode: { equals: q, mode: 'insensitive' } } }],
    };
    const chosen = fields?.length ? fields : QUICK_SEARCH_FIELDS;
    const where: Prisma.BookingWhereInput = scoped?.where ?? {
      ...(await this.branchScope(actor)),
      OR: chosen.flatMap((field) => byField[field]),
    };
    const take = restricted ? LOOKUP_RESULT_LIMIT : SEARCH_LIMIT;
    const [bookings, total] = await Promise.all([
      this.prisma.booking.findMany({ where, include: { ...LIST_INCLUDE, invoice: { select: { number: true, tripCode: true } } }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.booking.count({ where }),
    ]);
    await scoped?.done(bookings.length);

    const rows = bookings.flatMap((booking) => {
      const isCancelled = booking.status === 'CANCELLED';
      // A private room is the owner's alone, so it shows on the first passenger and not on the companions.
      const weights = passengerWeights(booking);
      const shares = allocate(toHalalas(booking.totalPrice), weights);
      const figures = paymentFigures(booking.payment, booking.collections);
      const owed = allocate(isCancelled ? 0 : figures.remaining, weights);
      return booking.passengers.map((passenger, idx) => ({
        passengerId: passenger.id,
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        invoiceNumber: booking.invoice ? invoiceNumber(booking.invoice.tripCode, booking.invoice.number) : null,
        fullName: passenger.fullName,
        phone: passenger.phone ?? booking.user.phone,
        nationalId: passenger.nationalId,
        seatNumber: passenger.seatNumber,
        tripCode: booking.trip.tripCode,
        departureTime: booking.trip.departureTime,
        status: booking.status,
        price: toSar(shares[idx]),
        paid: toSar(shares[idx] - owed[idx]),
        remaining: toSar(owed[idx]),
      }));
    });
    return {
      items: rows,
      totalBookings: total,
      truncated: total > take,
      restricted,
      remainingTotal: toSar(rows.reduce((sum, row) => sum + toHalalas(row.remaining), 0)),
    };
  }

  /** The quick search results as CSV, one line per passenger, audited like the bookings export. */
  async exportQuickSearch(actor: BookingsActor, typed: string, ip?: string, fields?: QuickSearchField[]) {
    const result = await this.quickSearch(actor, typed, ip, fields);
    await this.prisma.auditLog.create({
      data: {
        userId: actor.userId,
        action: 'GET /bookings/admin/search/export',
        entity: 'Bookings',
        ip,
        details: { q: typed, fields: fields ?? null, rows: result.items.length } as Prisma.InputJsonValue,
      },
    });
    const payState = (row: (typeof result.items)[number]) =>
      row.status === 'CANCELLED' ? 'ملغى' : row.remaining <= 0 ? 'مكتمل' : row.paid > 0 ? 'غير مكتمل' : 'غير مدفوع';
    const header = ['اسم الراكب', 'رقم الهوية', 'رقم الجوال', 'الإيصال', 'الرحلة', 'تاريخ الرحلة', 'سعر التذكرة', 'المدفوع', 'المتبقي', 'حالة الدفع', 'رقم الفاتورة'];
    const lines = result.items.map((row) =>
      [
        row.fullName,
        row.nationalId ?? '',
        row.phone ?? '',
        row.bookingReference,
        row.tripCode,
        row.departureTime.toISOString().slice(0, 10),
        row.price.toFixed(2),
        row.paid.toFixed(2),
        row.remaining.toFixed(2),
        payState(row),
        row.invoiceNumber ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    return '﻿' + `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}`;
  }

  async exportCsv(actor: BookingsActor, query: AdminBookingsQuery, ip?: string) {
    const actorId = actor.userId;
    const where = { ...this.buildWhere(query), ...(await this.branchScope(actor, query.branchId)) };
    const bookings = await this.prisma.booking.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });
    // Exports carry customer data out of the system, and the audit interceptor only covers writes.
    await this.prisma.auditLog.create({
      data: {
        userId: actorId,
        action: 'GET /bookings/admin/export',
        entity: 'Bookings',
        ip,
        details: { filters: { ...query }, rows: bookings.length } as Prisma.InputJsonValue,
      },
    });

    const header = ['رقم الحجز', 'العميل', 'الجوال', 'الرحلة', 'الانطلاق', 'المقاعد', 'المبلغ', 'الدفع', 'الحالة', 'الصعود'];
    const lines = bookings.map((b) => {
      const boarded = b.passengers.filter((p) => p.ticket?.isBoarded).length;
      return [
        b.bookingReference,
        b.user.name,
        b.user.phone,
        b.trip.tripCode,
        b.trip.departureTime.toISOString(),
        b.passengers.map((p) => p.seatNumber).join(' '),
        Number(b.totalPrice).toFixed(2),
        b.payment?.status,
        b.status,
        `${boarded}/${b.passengers.length}`,
      ]
        .map(csvCell)
        .join(',');
    });
    // The byte order mark makes Excel read the Arabic text as UTF-8.
    return `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}`;
  }

  async details(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        trip: {
          include: {
            bus: { select: { plateNumber: true } },
            boardingPoints: true,
            supervisors: { where: { isPrimary: true }, select: { user: { select: { name: true } } } },
            drivers: { where: { isPrimary: true }, select: { user: { select: { name: true } } } },
          },
        },
        passengers: { select: { id: true, fullName: true, phone: true, nationalId: true, notes: true, roomNote: true, seatNumber: true, hotelRoom: { select: { number: true, type: true, hotelBooking: { select: { hotel: { select: { id: true, name: true } } } } } }, ticket: TICKET_SELECT } },
        payment: true,
        paymentTransactions: { where: { type: 'REFUND' }, orderBy: { number: 'asc' } },
        collections: { orderBy: { createdAt: 'asc' }, select: { id: true, method: true, amount: true, reference: true, createdByName: true, createdAt: true } },
        coupon: { select: { code: true } },
        user: { select: { id: true, name: true, phone: true, walletBalance: true } },
        events: { orderBy: { createdAt: 'asc' } },
        branch: { select: { id: true, name: true } },
        stayHotel: { select: { id: true, name: true, city: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const counts = await this.prisma.booking.groupBy({ by: ['status'], where: { userId: booking.userId }, _count: true });
    const customerBookings = {
      total: counts.reduce((sum, row) => sum + row._count, 0),
      cancelled: counts.find((row) => row.status === 'CANCELLED')?._count ?? 0,
    };
    return {
      ...booking,
      passengers: [...booking.passengers].sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber)),
      customerBookings,
    };
  }

  async seatMap(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: { category: true, trip: { select: { busType: true, busId: true, seatLayout: true, seats: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const now = new Date();
    return {
      category: booking.category,
      busType: booking.trip.busType,
      layout: tripSeatLayout(booking.trip),
      // A singles booking may only move within this range.
      singlesRange: booking.category === 'SINGLES' ? await this.appSettings.singlesRange(booking.trip.busId) : null,
      seats: booking.trip.seats
        .map((seat) => ({
          seatNumber: seat.seatNumber,
          status: seat.isBooked ? 'booked' : seat.heldUntil && seat.heldUntil > now ? 'held' : 'available',
        }))
        .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber)),
    };
  }

  /** Locks the booking, then rejects the edit if someone changed it since the admin opened it. */
  private async loadForEdit(tx: Prisma.TransactionClient, bookingId: string, expectedUpdatedAt: string, options: { outboundMayBeOver?: boolean; lockTrip?: boolean } = {}) {
    // An edit that touches seats locks the trip first, the order trip-wide actions use, so the two cannot deadlock.
    if (options.lockTrip) await lockBookingWithTrip(tx, bookingId);
    else await this.events.lock(tx, bookingId);
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { trip: true, passengers: { include: { ticket: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ConflictException('عُدّل هذا الحجز للتو من مستخدم آخر. أعد تحميل الصفحة وراجع البيانات ثم حاول مجددًا');
    }
    if (booking.status === 'CANCELLED') throw new ConflictException('لا يمكن تعديل حجز ملغى');
    if ((booking.trip.tripStatus === 'COMPLETED' && !options.outboundMayBeOver) || booking.trip.tripStatus === 'CANCELLED') {
      throw new ConflictException('لا يمكن تعديل حجز في رحلة منتهية أو ملغاة');
    }
    return booking;
  }

  private findPassenger<T extends { id: string }>(booking: { passengers: T[] }, passengerId: string): T {
    // Looked up inside the booking so an id from another booking can never be edited through this one.
    const passenger = booking.passengers.find((p) => p.id === passengerId);
    if (!passenger) throw new NotFoundException('المسافر لا يتبع هذا الحجز');
    return passenger;
  }

  private assertBeforeDeparture(booking: { status: string; trip: { departureTime: Date } }) {
    if (booking.status !== 'CONFIRMED') throw new ConflictException('يمكن إجراء هذا التعديل على الحجوزات المؤكدة فقط');
    if (booking.trip.departureTime <= new Date()) throw new ConflictException('انطلقت الرحلة ولا يمكن إجراء هذا التعديل');
  }

  async updatePassenger(actorId: string, bookingId: string, passengerId: string, dto: UpdatePassengerDto, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt);
      const passenger = this.findPassenger(booking, passengerId);

      const fullName = dto.fullName ?? passenger.fullName;
      const phone = dto.phone === undefined ? passenger.phone : dto.phone ? normalizeSaudiPhone(dto.phone) : null;
      const nationalId = dto.nationalId === undefined ? passenger.nationalId : dto.nationalId || null;
      const notes = dto.notes === undefined ? passenger.notes : dto.notes || null;
      if (fullName === passenger.fullName && phone === passenger.phone && nationalId === passenger.nationalId && notes === passenger.notes) {
        throw new BadRequestException('لا يوجد تغيير للحفظ');
      }

      await tx.bookingPassenger.update({ where: { id: passengerId }, data: { fullName, phone, nationalId, notes } });
      await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
      await this.events.record(tx, {
        bookingId,
        action: 'PASSENGER_UPDATED',
        actorId,
        reason: dto.reason,
        before: { fullName: passenger.fullName, phone: passenger.phone, nationalId: passenger.nationalId, notes: passenger.notes },
        after: { fullName, phone, nationalId, notes },
        ip,
      });
      // National id and staff notes are not the customer's concern, the same rule as the booking updates.
      if (fullName !== passenger.fullName || phone !== passenger.phone) {
        await this.notifications.toBookingOwners(tx, 'PASSENGER_DETAILS_UPDATED', [bookingId], { passengerName: fullName });
      }
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  async changeSeat(actorId: string, bookingId: string, passengerId: string, dto: ChangeSeatDto, ip?: string) {
    const seatNumber = String(parseInt(dto.seatNumber, 10));
    await this.prisma.$transaction(async (tx) => {
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt, { lockTrip: true });
      this.assertBeforeDeparture(booking);
      const passenger = this.findPassenger(booking, passengerId);
      if (passenger.ticket?.isBoarded) throw new ConflictException('لا يمكن تغيير مقعد مسافر صعد إلى الحافلة');
      if (passenger.seatNumber === seatNumber) throw new BadRequestException('هذا هو مقعد المسافر الحالي');
      await this.bookings.assertSeatRules(booking.trip, [seatNumber], booking.category);

      await lockTripsWithLinked(tx, [booking.tripId]);
      // The conditional update is what prevents selling one seat twice.
      const claimed = await tx.seat.updateMany({
        where: { tripId: booking.tripId, seatNumber, ...holdAvailableTo(actorId, new Date()) },
        data: { isBooked: true, heldByUserId: null, heldUntil: null },
      });
      if (claimed.count !== 1) throw new ConflictException(`المقعد ${seatNumber} غير متاح`);
      await tx.seat.updateMany({
        where: { tripId: booking.tripId, seatNumber: passenger.seatNumber },
        data: { isBooked: false, heldByUserId: null, heldUntil: null },
      });
      await takeLinkedSeats(tx, booking.tripId, [seatNumber], holdAvailableTo(actorId, new Date()));
      await releaseLinkedSeats(tx, booking.tripId, [passenger.seatNumber]);
      await tx.bookingPassenger.update({ where: { id: passengerId }, data: { seatNumber } });

      // A new number retires the old one, so a saved copy of the previous ticket stops working at the door.
      const ticketNumber = `TKT-${randomCode(10)}`;
      if (passenger.ticket) {
        await tx.ticket.update({
          where: { id: passenger.ticket.id },
          data: {
            ticketNumber,
            signedToken: signTicketToken(
              { ticketNumber, tripId: booking.tripId, seat: seatNumber },
              this.config.getOrThrow<string>('TICKET_SIGNING_SECRET'),
            ),
          },
        });
      }
      await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
      await this.events.record(tx, {
        bookingId,
        action: 'SEAT_CHANGED',
        actorId,
        reason: dto.reason,
        before: { passenger: passenger.fullName, seat: passenger.seatNumber, ticketNumber: passenger.ticket?.ticketNumber },
        after: { passenger: passenger.fullName, seat: seatNumber, ticketNumber },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'SEAT_CHANGED', [bookingId], { passengerName: passenger.fullName, oldSeat: passenger.seatNumber, newSeat: seatNumber });
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  async changeBoardingPoint(actorId: string, bookingId: string, dto: ChangeBoardingPointDto, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt);
      this.assertBeforeDeparture(booking);
      if (booking.passengers.some((p) => p.ticket?.isBoarded)) {
        throw new ConflictException('لا يمكن تغيير نقطة التجمع بعد صعود أحد الركاب');
      }
      const point = await tx.boardingPoint.findFirst({ where: { id: dto.boardingPointId, tripId: booking.tripId } });
      if (!point) throw new BadRequestException('نقطة التجمع لا تخص هذه الرحلة');
      if (point.id === booking.boardingPointId) throw new BadRequestException('هذه هي نقطة التجمع الحالية');

      await tx.booking.update({
        where: { id: bookingId },
        data: { boardingPointId: point.id, boardingPointName: point.name, boardingPointTime: point.time },
      });
      await this.events.record(tx, {
        bookingId,
        action: 'BOARDING_POINT_CHANGED',
        actorId,
        reason: dto.reason,
        before: { name: booking.boardingPointName, time: booking.boardingPointTime },
        after: { name: point.name, time: point.time },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'BOARDING_POINT_CHANGED', [bookingId], { oldBoardingPoint: booking.boardingPointName, oldBoardingTime: booking.boardingPointTime });
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  /** The office's record of a return boarding. It never touches the booking's status, which belongs to the outbound. */
  private async setReturnBoarded(actorId: string, bookingId: string, passengerId: string, dto: BoardingOverrideDto, boarded: boolean, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      // The way out may be over and done while the way back is still ahead.
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt, { outboundMayBeOver: true });
      const ride = await returnRideOf(tx, booking);
      if (!ride) throw new ConflictException('هذا الحجز لا يعود على رحلة عكسية');
      const passenger = this.findPassenger(booking, passengerId);
      if (!passenger.ticket) throw new ConflictException('لا توجد تذكرة لهذا المسافر');
      if (!!passenger.ticket.returnBoardedAt === boarded) throw new ConflictException(boarded ? 'تم تسجيل صعود هذا المسافر مسبقًا' : 'هذا المسافر لم يصعد');

      const now = new Date();
      await tx.ticket.update({ where: { id: passenger.ticket.id }, data: { returnBoardedAt: boarded ? now : null } });
      await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: now } });
      await this.events.record(tx, {
        bookingId,
        action: boarded ? 'RETURN_BOARDED' : 'RETURN_UNBOARDED',
        actorId,
        reason: dto.reason,
        after: { passenger: passenger.fullName, seat: passenger.seatNumber, ticketNumber: passenger.ticket.ticketNumber, tripCode: ride.tripCode },
        ip,
      });
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  async board(actorId: string, bookingId: string, passengerId: string, dto: BoardingOverrideDto, ip?: string) {
    if (dto.returning) return this.setReturnBoarded(actorId, bookingId, passengerId, dto, true, ip);
    const opensBeforeHours = await this.appSettings.number('boardingOpensBeforeHours');
    await this.prisma.$transaction(async (tx) => {
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt);
      if (booking.status !== 'CONFIRMED') throw new ConflictException('يمكن تسجيل الصعود للحجوزات المؤكدة فقط');
      if (await tx.ticketCompensation.count({ where: { bookingId } })) throw new ConflictException('تم تعويض هذا الحجز، فلا يُسجَّل صعوده');
      // A boarded booking can no longer be cancelled, so early boarding could be used to lock a refund.
      // Boarding opened by hand on the trip lifts this limit for it.
      if (!booking.trip.boardingOpenedManuallyAt && booking.trip.departureTime.getTime() - Date.now() > opensBeforeHours * 60 * 60 * 1000) {
        throw new ConflictException(`يُفتح تسجيل الصعود قبل موعد الرحلة ${withinHours(opensBeforeHours)}`);
      }
      const passenger = this.findPassenger(booking, passengerId);
      if (!passenger.ticket) throw new ConflictException('لا توجد تذكرة لهذا المسافر');
      if (passenger.ticket.isBoarded) throw new ConflictException('تم تسجيل صعود هذا المسافر مسبقًا');

      const now = new Date();
      await tx.ticket.update({ where: { id: passenger.ticket.id }, data: { isBoarded: true, boardedAt: now } });
      const allBoarded = booking.passengers.every((p) => p.id === passengerId || p.ticket?.isBoarded);
      await tx.booking.update({ where: { id: bookingId }, data: allBoarded ? { status: 'BOARDED' } : { updatedAt: now } });
      await this.events.record(tx, {
        bookingId,
        action: 'BOARDED',
        actorId,
        reason: dto.reason,
        after: { passenger: passenger.fullName, seat: passenger.seatNumber, ticketNumber: passenger.ticket.ticketNumber },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'PASSENGER_BOARDED', [bookingId], { passengerName: passenger.fullName, seatNumber: passenger.seatNumber });
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  async unboard(actorId: string, bookingId: string, passengerId: string, dto: BoardingOverrideDto, ip?: string) {
    if (dto.returning) return this.setReturnBoarded(actorId, bookingId, passengerId, dto, false, ip);
    await this.prisma.$transaction(async (tx) => {
      const booking = await this.loadForEdit(tx, bookingId, dto.expectedUpdatedAt);
      const passenger = this.findPassenger(booking, passengerId);
      if (!passenger.ticket?.isBoarded) throw new ConflictException('هذا المسافر لم يصعد');

      await tx.ticket.update({ where: { id: passenger.ticket.id }, data: { isBoarded: false, boardedAt: null } });
      await tx.booking.update({
        where: { id: bookingId },
        data: booking.status === 'BOARDED' ? { status: 'CONFIRMED' } : { updatedAt: new Date() },
      });
      await this.events.record(tx, {
        bookingId,
        action: 'UNBOARDED',
        actorId,
        reason: dto.reason,
        before: { boardedAt: passenger.ticket.boardedAt?.toISOString() ?? null },
        after: { passenger: passenger.fullName, seat: passenger.seatNumber },
        ip,
      });
    }, EDIT_TX_OPTIONS);
    return this.details(bookingId);
  }

  async addNote(actorId: string, bookingId: string, text: string, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const exists = await tx.booking.count({ where: { id: bookingId } });
      if (exists === 0) throw new NotFoundException('Booking not found');
      await this.events.record(tx, { bookingId, action: 'NOTE', actorId, reason: text, ip });
    });
    return this.details(bookingId);
  }
}

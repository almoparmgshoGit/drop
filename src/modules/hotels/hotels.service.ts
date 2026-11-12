import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, HotelRateUnit, Prisma, RoomType } from '@prisma/client';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RoomAllocationService } from '../../common/services/room-allocation.service';
import { BOOKING_KIND_LABELS } from '../../common/utils/booking-kinds.util';
import { includedBedValue } from '../../common/utils/housing-price.util';
import { HOUSING_BOOKING_TYPES, includesHousing } from '../../common/utils/booking-types.util';
import { CREW_WINDOW_SELECT, crewWindow } from '../../common/utils/crew-window.util';
import { hotelBookingCost } from '../../common/utils/payment.util';
import { SERVICE_SELECT, withHotelServices } from '../../common/utils/services.util';
import { suggestServiceIcon } from '../../common/service-icons';
import { AssignBookingRoomDto, AssignRoomDto, CrewAssignRoomDto, CreateHotelBookingDto, UpdateHotelBookingDto, CreateHotelComplaintDto, CreateHotelDto, CreateRoomBlockDto, CreateTravelerComplaintDto, UpdateHotelDto } from './hotels.dto';

const HOTEL_SERVICES = { services: SERVICE_SELECT } as const;

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DEFAULT_ROOM_CAPACITY = 4;
const HOUSED_STATUSES: BookingStatus[] = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];
// A cancelled traveler may have stayed before cancelling, so a complaint can still name them; an unpaid booking never stayed.
const COMPLAINT_BOOKING_STATUSES: BookingStatus[] = [...HOUSED_STATUSES, 'CANCELLED'];
const MAX_OPEN_TRAVELER_COMPLAINTS = 5;

interface OverviewRow {
  key: string;
  tripId: string;
  tripCode: string;
  status: 'NOT_BOOKED' | 'CONFIRMED' | 'CANCELLED';
  reference: string | null;
  hotelName: string | null;
  city: string | null;
  checkIn: Date | null;
  checkOut: Date | null;
  nights: number;
  rooms: number;
  nightlyRate: number | null;
  rateUnit: HotelRateUnit | null;
  cost: number;
  sales: number;
  profit: number;
  housed: number;
  notes: string | null;
}

export interface HotelActor {
  userId: string;
  role: string;
  permissions: string[];
}

const toDate = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  // Rejects dates like 02-31, which JavaScript would otherwise roll over silently.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('التاريخ غير صحيح');
  }
  return date;
};

const nightsBetween = (checkIn: Date, checkOut: Date) => Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
const riyadhDate = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
const money = (value: Prisma.Decimal | number | null | undefined) => Math.round(Number(value ?? 0) * 100) / 100;

const bookingCost = (booking: Parameters<typeof hotelBookingCost>[0]) => hotelBookingCost(booking) / 100;

export const hotelBookingReference = (number: number) => `HB-${number}`;
const complaintReference = (number: number) => `HC-${number}`;

@Injectable()
export class HotelsService {
  constructor(
    private prisma: PrismaService,
    private events: BookingEventsService,
    private rooms: RoomAllocationService,
    private notifications: NotificationsService,
  ) {}

  async listHotels(actor: HotelActor) {
    const hotels = (await this.prisma.hotel.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], include: HOTEL_SERVICES })).map(withHotelServices);
    // The contract rate is a purchase price, so only ranks allowed to see costs get it.
    return actor.permissions.includes('hotels.rates') ? hotels : hotels.map(({ nightlyRate, ...hotel }) => hotel);
  }

  /** Every registered hotel, booked or not, with what is happening in it today. */
  async registry(actor: HotelActor) {
    const today = toDate(riyadhDate(new Date()));
    const hotels = await this.prisma.hotel.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        bookings: {
          where: { status: 'CONFIRMED', checkOut: { gt: today } },
          select: { checkIn: true, rooms: { select: { _count: { select: { occupants: true } } } } },
        },
        roomBlocks: { where: { fromDate: { lte: today }, OR: [{ untilDate: null }, { untilDate: { gt: today } }] }, select: { id: true } },
        _count: { select: { complaints: { where: { status: 'OPEN' } } } },
        ...HOTEL_SERVICES,
      },
    });
    const canSeeRates = actor.permissions.includes('hotels.rates');
    return hotels.map(withHotelServices).map(({ bookings, roomBlocks, _count, nightlyRate, ...hotel }) => {
      const current = bookings.filter((b) => b.checkIn <= today).flatMap((b) => b.rooms);
      return {
        ...hotel,
        ...(canSeeRates && { nightlyRate }),
        occupiedRooms: current.filter((r) => r._count.occupants > 0).length,
        guests: current.reduce((sum, r) => sum + r._count.occupants, 0),
        upcomingBookings: bookings.filter((b) => b.checkIn > today).length,
        blockedRooms: roomBlocks.length,
        openComplaints: _count.complaints,
      };
    });
  }

  /** One hotel's whole picture: its bookings, each room's occupants, and complaints from either side. */
  async hotelDetail(actor: HotelActor, id: string) {
    const hotel = await this.prisma.hotel.findUnique({
      where: { id },
      include: {
        bookings: {
          orderBy: { checkIn: 'desc' },
          include: {
            trip: { select: { id: true, tripCode: true, origin: true, destination: true } },
            rooms: {
              orderBy: { number: 'asc' },
              select: {
                id: true,
                number: true,
                type: true,
                capacity: true,
                occupants: {
                  select: {
                    id: true,
                    fullName: true,
                    phone: true,
                    seatNumber: true,
                    roomNote: true,
                    booking: { select: { id: true, bookingReference: true, user: { select: { phone: true } }, passengers: { take: 1, select: { id: true } } } },
                  },
                },
              },
            },
          },
        },
        complaints: {
          orderBy: { createdAt: 'desc' },
          include: { hotelBooking: { select: { number: true, trip: { select: { tripCode: true } } } } },
        },
        roomBlocks: { orderBy: { fromDate: 'desc' } },
        ...HOTEL_SERVICES,
      },
    });
    if (!hotel) throw new NotFoundException('الفندق غير موجود');

    const canSeeRates = actor.permissions.includes('hotels.rates');
    const { bookings, complaints, roomBlocks, nightlyRate, ...details } = withHotelServices(hotel);
    return {
      hotel: { ...details, ...(canSeeRates && { nightlyRate }) },
      roomBlocks,
      bookings: bookings.map((b) => {
        const occupied = b.rooms.filter((r) => r.occupants.length > 0).length;
        return {
          id: b.id,
          reference: hotelBookingReference(b.number),
          status: b.status,
          cancelReason: b.cancelReason,
          trip: b.trip,
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          nights: nightsBetween(b.checkIn, b.checkOut),
          mealPlan: b.mealPlan,
          notes: b.notes,
          occupiedRooms: occupied,
          rooms: b.rooms.map((r) => ({
            id: r.id,
            number: r.number,
            type: r.type,
            capacity: r.capacity,
            occupants: r.occupants.map((o) => ({
              passengerId: o.id,
              fullName: o.fullName,
              // The account phone belongs to whoever booked, so it only represents the first passenger.
              phone: o.phone ?? (o.booking.passengers[0]?.id === o.id ? o.booking.user.phone : null),
              seatNumber: o.seatNumber,
              roomNote: o.roomNote,
              bookingId: o.booking.id,
              bookingReference: o.booking.bookingReference,
            })),
          })),
          ...(canSeeRates && {
            nightlyRate: money(b.nightlyRate),
            rateUnit: b.rateUnit,
            cost: bookingCost({ ...b, rooms: b.rooms.map((r) => ({ _count: { occupants: r.occupants.length } })) }),
          }),
        };
      }),
      complaints: complaints.map(({ hotelBooking, number, ...complaint }) => ({
        ...complaint,
        reference: complaintReference(number),
        hotelBookingReference: hotelBooking ? hotelBookingReference(hotelBooking.number) : null,
        tripCode: hotelBooking?.trip.tripCode ?? null,
      })),
    };
  }

  /** Anyone on a trip booked at this hotel, with or without a room now, newest trips first. */
  async complaintTravelers(hotelId: string, query?: string) {
    const passengers = await this.prisma.bookingPassenger.findMany({
      where: {
        booking: { status: { in: COMPLAINT_BOOKING_STATUSES }, trip: { hotelBookings: { some: { hotelId } } } },
        ...(query && {
          OR: [
            { fullName: { contains: query, mode: 'insensitive' as const } },
            { phone: { contains: query } },
            { nationalId: { contains: query } },
            { booking: { bookingReference: { contains: query, mode: 'insensitive' as const } } },
          ],
        }),
      },
      orderBy: [{ booking: { trip: { departureTime: 'desc' } } }, { seatNumber: 'asc' }],
      take: 30,
      select: {
        id: true,
        fullName: true,
        phone: true,
        booking: { select: { bookingReference: true, status: true, trip: { select: { tripCode: true } } } },
        hotelRoom: { select: { number: true, hotelBooking: { select: { hotelId: true } } } },
      },
    });
    return passengers.map((p) => ({
      passengerId: p.id,
      fullName: p.fullName,
      phone: p.phone,
      bookingReference: p.booking.bookingReference,
      bookingCancelled: p.booking.status === 'CANCELLED',
      tripCode: p.booking.trip.tripCode,
      roomNumber: p.hotelRoom?.hotelBooking.hotelId === hotelId ? p.hotelRoom.number : null,
    }));
  }

  private async travelerOfHotel(hotelId: string, passengerId: string) {
    const passenger = await this.prisma.bookingPassenger.findUnique({
      where: { id: passengerId },
      select: {
        id: true,
        fullName: true,
        bookingId: true,
        booking: { select: { status: true, trip: { select: { hotelBookings: { where: { hotelId }, select: { id: true } } } } } },
        hotelRoom: { select: { number: true, hotelBooking: { select: { hotelId: true } } } },
      },
    });
    if (!passenger) throw new NotFoundException('المسافر غير موجود');
    const stay = passenger.booking.trip.hotelBookings[0];
    if (!stay || !COMPLAINT_BOOKING_STATUSES.includes(passenger.booking.status)) throw new BadRequestException('هذا المسافر ليس على رحلة في هذا الفندق');
    return {
      passengerId: passenger.id,
      bookingId: passenger.bookingId,
      travelerName: passenger.fullName,
      roomNumber: passenger.hotelRoom?.hotelBooking.hotelId === hotelId ? passenger.hotelRoom.number : null,
      hotelBookingId: stay.id,
    };
  }

  private saveComplaint(data: Prisma.HotelComplaintUncheckedCreateInput) {
    return this.prisma.$transaction(async (tx) => {
      const complaint = await tx.hotelComplaint.create({ data, include: { hotel: { select: { name: true } } } });
      await this.notifications.toStaff(
        tx,
        'STAFF_HOTEL_COMPLAINT',
        ['hotels.view'],
        { hotelName: complaint.hotel.name, complaintReference: complaintReference(complaint.number), complaintSubject: data.subject, complaintAuthor: data.createdByName },
        { exceptUserId: data.createdById ?? undefined },
      );
      return { id: complaint.id, reference: complaintReference(complaint.number) };
    }, TX_OPTIONS);
  }

  async createComplaint(actor: HotelActor, hotelId: string, dto: CreateHotelComplaintDto) {
    const hotel = await this.prisma.hotel.count({ where: { id: hotelId } });
    if (hotel === 0) throw new NotFoundException('الفندق غير موجود');

    const traveler = dto.passengerId ? await this.travelerOfHotel(hotelId, dto.passengerId) : { travelerName: dto.travelerName || null, roomNumber: dto.roomNumber || null };
    const author = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return this.saveComplaint({ hotelId, source: dto.source, subject: dto.subject, details: dto.details, ...traveler, createdById: actor.userId, createdByName: author?.name ?? null });
  }

  /** A customer only reaches their own booking; someone else's looks like it does not exist. */
  private async ownBookingForComplaint(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: {
        id: true,
        status: true,
        user: { select: { name: true } },
        passengers: { select: { id: true, fullName: true, hotelRoom: { select: { number: true, hotelBookingId: true } } } },
        trip: { select: { hotelBookings: { where: { status: 'CONFIRMED' }, orderBy: { number: 'asc' }, select: { id: true, hotelId: true, hotel: { select: { name: true, city: true } } } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  /** What the customer sees: only complaints they sent themselves, never one the hotel raised about them. */
  async travelerComplaints(userId: string, bookingId: string) {
    const booking = await this.ownBookingForComplaint(userId, bookingId);
    const complaints = await this.prisma.hotelComplaint.findMany({
      where: { bookingId, submittedByTraveler: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, status: true, subject: true, details: true, travelerName: true, resolution: true, resolvedAt: true, createdAt: true, hotel: { select: { name: true } } },
    });
    return {
      hotels: HOUSED_STATUSES.includes(booking.status) ? booking.trip.hotelBookings.map((b) => ({ hotelBookingId: b.id, name: b.hotel.name, city: b.hotel.city })) : [],
      complaints: complaints.map(({ number, hotel, ...complaint }) => ({ ...complaint, reference: complaintReference(number), hotelName: hotel.name })),
    };
  }

  async createTravelerComplaint(userId: string, bookingId: string, dto: CreateTravelerComplaintDto) {
    const booking = await this.ownBookingForComplaint(userId, bookingId);
    if (!HOUSED_STATUSES.includes(booking.status)) throw new ConflictException('هذا الحجز ملغى');
    const stay = booking.trip.hotelBookings.find((b) => b.id === dto.hotelBookingId);
    if (!stay) throw new BadRequestException('هذا الفندق ليس ضمن رحلتك');
    const passenger = dto.passengerId ? booking.passengers.find((p) => p.id === dto.passengerId) : undefined;
    if (dto.passengerId && !passenger) throw new BadRequestException('هذا المسافر ليس في حجزك');

    const open = await this.prisma.hotelComplaint.count({ where: { bookingId, submittedByTraveler: true, status: 'OPEN' } });
    if (open >= MAX_OPEN_TRAVELER_COMPLAINTS) throw new ConflictException('لديك شكاوى قيد المراجعة على هذا الحجز، وسنرد عليها قريبًا');

    const travelerName = passenger?.fullName ?? booking.user.name ?? booking.passengers[0]?.fullName ?? null;
    return this.saveComplaint({
      hotelId: stay.hotelId,
      source: 'TRAVELER',
      submittedByTraveler: true,
      bookingId,
      hotelBookingId: stay.id,
      passengerId: passenger?.id ?? null,
      travelerName,
      roomNumber: passenger?.hotelRoom?.hotelBookingId === stay.id ? passenger.hotelRoom.number : null,
      subject: dto.subject,
      details: dto.details,
      createdById: userId,
      createdByName: travelerName,
    });
  }

  async resolveComplaint(actor: HotelActor, hotelId: string, complaintId: string, resolution: string) {
    const author = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    await this.prisma.$transaction(async (tx) => {
      // Conditional on the status, so two employees closing it together cannot overwrite each other's note.
      const { count } = await tx.hotelComplaint.updateMany({
        where: { id: complaintId, hotelId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolution, resolvedAt: new Date(), resolvedById: actor.userId, resolvedByName: author?.name ?? null },
      });
      if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مغلقة مسبقًا');
      const complaint = await tx.hotelComplaint.findUniqueOrThrow({ where: { id: complaintId }, include: { hotel: { select: { name: true } } } });
      if (complaint.submittedByTraveler && complaint.bookingId) {
        await this.notifications.toBookingOwners(tx, 'HOTEL_COMPLAINT_RESOLVED', [complaint.bookingId], {
          hotelName: complaint.hotel.name,
          complaintReference: complaintReference(complaint.number),
          complaintSubject: complaint.subject,
          complaintResolution: resolution,
        });
      }
    }, TX_OPTIONS);
    return { success: true };
  }

  async createRoomBlock(actor: HotelActor, hotelId: string, dto: CreateRoomBlockDto) {
    const fromDate = toDate(dto.fromDate);
    const untilDate = dto.untilDate ? toDate(dto.untilDate) : null;
    if (fromDate < toDate(riyadhDate(new Date()))) throw new BadRequestException('لا يمكن أن تبدأ الفترة في تاريخ مضى');
    if (untilDate && untilDate <= fromDate) throw new BadRequestException('تاريخ العودة للخدمة يجب أن يكون بعد تاريخ البداية');
    const hotel = await this.prisma.hotel.count({ where: { id: hotelId } });
    if (hotel === 0) throw new NotFoundException('الفندق غير موجود');
    const author = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });

    return this.prisma.$transaction(async (tx) => {
      await this.rooms.clearRoomForBlock(tx, hotelId, dto.roomNumber, fromDate, untilDate);
      const overlapping = await tx.hotelRoomBlock.count({
        where: { hotelId, roomNumber: dto.roomNumber, ...(untilDate && { fromDate: { lt: untilDate } }), OR: [{ untilDate: null }, { untilDate: { gt: fromDate } }] },
      });
      if (overlapping > 0) throw new ConflictException(`الغرفة ${dto.roomNumber} خارج الخدمة بالفعل في هذه الفترة`);
      return tx.hotelRoomBlock.create({
        data: { hotelId, roomNumber: dto.roomNumber, type: dto.type, fromDate, untilDate, notes: dto.notes || null, createdById: actor.userId, createdByName: author?.name ?? null },
      });
    }, TX_OPTIONS);
  }

  /** Ends a running period today, so past dates still show why the room was out; one starting today or later just goes. */
  async releaseRoomBlock(actor: HotelActor, hotelId: string, blockId: string) {
    const today = toDate(riyadhDate(new Date()));
    const block = await this.prisma.hotelRoomBlock.findFirst({ where: { id: blockId, hotelId, OR: [{ untilDate: null }, { untilDate: { gt: today } }] } });
    if (!block) throw new ConflictException('هذه الفترة منتهية بالفعل');
    if (block.fromDate >= today) {
      await this.prisma.hotelRoomBlock.delete({ where: { id: blockId } });
      return { success: true };
    }
    const author = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    await this.prisma.hotelRoomBlock.update({ where: { id: blockId }, data: { untilDate: today, releasedAt: new Date(), releasedByName: author?.name ?? null } });
    return { success: true };
  }

  async reopenComplaint(hotelId: string, complaintId: string) {
    const { count } = await this.prisma.hotelComplaint.updateMany({
      where: { id: complaintId, hotelId, status: 'RESOLVED' },
      data: { status: 'OPEN', resolution: null, resolvedAt: null, resolvedById: null, resolvedByName: null },
    });
    if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مفتوحة بالفعل');
    return { success: true };
  }

  /** Customers must have something to choose from. */
  private assertOffersRoomType(offersShared: boolean, offersPrivate: boolean) {
    if (!offersShared && !offersPrivate) throw new BadRequestException('اختر نوع غرفة واحدًا على الأقل يظهر للعميل');
  }

  /** The number of rooms cannot be worked out from a room price without knowing how many fit in one. */
  /**
   * The service ids a hotel form asks for, or undefined when it did not touch the list. Names from older
   * clients join the service of that name, which is created, with a guessed icon, when missing.
   */
  private async resolveHotelServices(tx: Prisma.TransactionClient, dto: { serviceIds?: string[]; features?: string[] }) {
    if (dto.serviceIds === undefined && dto.features === undefined) return undefined;
    const ids = new Set(dto.serviceIds ?? []);
    if (ids.size > 0 && (await tx.service.count({ where: { id: { in: [...ids] } } })) !== ids.size) {
      throw new BadRequestException('إحدى الخدمات المختارة غير موجودة');
    }
    for (const raw of dto.features ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const service = await tx.service.upsert({ where: { name }, create: { name, icon: suggestServiceIcon(name) }, update: {}, select: { id: true } });
      ids.add(service.id);
    }
    return [...ids];
  }

  async createHotel(dto: CreateHotelDto) {
    this.assertOffersRoomType(dto.offersSharedRoom ?? true, dto.offersPrivateRoom ?? true);
    const { serviceIds: _ids, features: _names, ...fields } = dto;
    return this.prisma.$transaction(async (tx) => {
      const serviceIds = await this.resolveHotelServices(tx, dto);
      const hotel = await tx.hotel.create({
        data: { ...fields, nightlyRate: dto.nightlyRate ?? 0, ...(serviceIds?.length && { services: { create: serviceIds.map((serviceId) => ({ serviceId })) } }) },
        include: HOTEL_SERVICES,
      });
      return withHotelServices(hotel);
    });
  }

  async updateHotel(id: string, dto: UpdateHotelDto) {
    const hotel = await this.prisma.hotel.findUnique({ where: { id }, select: { offersSharedRoom: true, offersPrivateRoom: true } });
    if (!hotel) throw new NotFoundException('الفندق غير موجود');
    this.assertOffersRoomType(dto.offersSharedRoom ?? hotel.offersSharedRoom, dto.offersPrivateRoom ?? hotel.offersPrivateRoom);
    const { serviceIds: _ids, features: _names, ...fields } = dto;
    return this.prisma.$transaction(async (tx) => {
      const serviceIds = await this.resolveHotelServices(tx, dto);
      if (serviceIds) await tx.hotelService.deleteMany({ where: { hotelId: id } });
      const hotel = await tx.hotel.update({
        where: { id },
        data: { ...fields, ...(serviceIds?.length && { services: { create: serviceIds.map((serviceId) => ({ serviceId })) } }) },
        include: HOTEL_SERVICES,
      });
      return withHotelServices(hotel);
    });
  }

  async overview(month?: string) {
    const [year, monthNumber] = (month ?? riyadhDate(new Date()).slice(0, 7)).split('-').map(Number);
    const trips = await this.prisma.trip.findMany({
      where: {
        departureTime: {
          gte: new Date(Date.UTC(year, monthNumber - 1, 1) - RIYADH_OFFSET_MS),
          lt: new Date(Date.UTC(year, monthNumber, 1) - RIYADH_OFFSET_MS),
        },
        OR: [
          { bookingType: { in: HOUSING_BOOKING_TYPES }, tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
          { hotelBookings: { some: {} } },
          { bookings: { some: { stayHotelId: { not: null }, status: { not: 'CANCELLED' } } } },
        ],
      },
      orderBy: { departureTime: 'asc' },
      select: {
        id: true,
        tripCode: true,
        housingPrice: true,
        privateRoomPrice: true,
        privateRoomCapacity: true,
        housingPriceMode: true,
        privateRoomPriceBasis: true,
        housingPricePeriod: true,
        accommodations: { select: { nights: true } },
        bookings: { where: { status: { in: HOUSED_STATUSES } }, select: { housingAmount: true, _count: { select: { passengers: true } } } },
        hotelBookings: {
          orderBy: { number: 'asc' },
          include: {
            hotel: { select: { id: true, name: true, city: true } },
            rooms: { select: { _count: { select: { occupants: true } } } },
          },
        },
      },
    });

    const rows = trips.flatMap((trip): OverviewRow[] => {
      const housed = trip.bookings.reduce((sum, b) => sum + b._count.passengers, 0);
      // What customers were charged for housing, plus its value inside the base price when it is included there.
      const charged = trip.bookings.reduce((sum, b) => sum + Number(b.housingAmount), 0);
      const includedValue = includedBedValue(trip, trip.accommodations[0]?.nights ?? 1);
      const price = housed > 0 ? charged / housed + includedValue : includedValue;
      const confirmed = trip.hotelBookings.filter((b) => b.status === 'CONFIRMED');
      if (confirmed.length === 0 && trip.hotelBookings.length === 0) {
        return [{
          key: trip.id,
          tripId: trip.id,
          tripCode: trip.tripCode,
          status: 'NOT_BOOKED',
          reference: null,
          hotelName: null,
          city: null,
          checkIn: null,
          checkOut: null,
          nights: 0,
          rooms: 0,
          nightlyRate: null,
          rateUnit: null,
          cost: 0,
          sales: money(housed * price),
          profit: money(housed * price),
          housed,
          notes: null,
        }];
      }
      const assigned = confirmed.reduce((sum, b) => sum + b.rooms.reduce((s, r) => s + r._count.occupants, 0), 0);
      // Passengers still without a room count toward the trip's first hotel, so the month's sales stay complete.
      let unassigned = Math.max(0, housed - assigned);
      return trip.hotelBookings.map((booking) => {
        const isConfirmed = booking.status === 'CONFIRMED';
        const occupied = booking.rooms.filter((r) => r._count.occupants > 0);
        const occupants = occupied.reduce((s, r) => s + r._count.occupants, 0);
        const cost = isConfirmed ? bookingCost(booking) : 0;
        const sales = isConfirmed ? money((occupants + unassigned) * price) : 0;
        if (isConfirmed) unassigned = 0;
        return {
          key: booking.id,
          tripId: trip.id,
          tripCode: trip.tripCode,
          status: booking.status,
          reference: hotelBookingReference(booking.number),
          hotelName: booking.hotel.name,
          city: booking.hotel.city,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          nights: nightsBetween(booking.checkIn, booking.checkOut),
          rooms: occupied.length,
          nightlyRate: money(booking.nightlyRate),
          rateUnit: booking.rateUnit,
          cost,
          sales,
          profit: money(sales - cost),
          housed: occupants,
          notes: booking.notes,
        };
      });
    });

    const noHotel = trips.filter((t) => !t.hotelBookings.some((b) => b.status === 'CONFIRMED')).map((t) => t.tripCode);
    return {
      rows,
      summary: {
        cost: money(rows.reduce((sum, r) => sum + r.cost, 0)),
        sales: money(rows.reduce((sum, r) => sum + r.sales, 0)),
        profit: money(rows.reduce((sum, r) => sum + r.profit, 0)),
        tripsWithoutHotel: noHotel,
      },
    };
  }

  async tripRooming(actor: HotelActor, tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        tripCode: true,
        origin: true,
        destination: true,
        departureTime: true,
        arrivalTime: true,
        bookingType: true,
        tripStatus: true,
        accommodations: { select: { name: true, nights: true } },
        hotelBookings: {
          orderBy: { number: 'asc' },
          include: {
            hotel: { select: { id: true, name: true, city: true } },
            rooms: { orderBy: { number: 'asc' }, select: { id: true, number: true, type: true, capacity: true, _count: { select: { occupants: true } } } },
          },
        },
        bookings: {
          where: { status: { in: HOUSED_STATUSES } },
          select: {
            id: true,
            bookingReference: true,
            status: true,
            roomChoice: true,
            kind: true,
            stayNights: true,
            stayCheckIn: true,
            stayCheckOut: true,
            stayHotel: { select: { id: true, name: true } },
            user: { select: { name: true, phone: true } },
            passengers: {
              select: {
                id: true,
                fullName: true,
                phone: true,
                seatNumber: true,
                roomNote: true,
                hotelRoom: { select: { id: true, number: true, type: true, hotelBookingId: true } },
              },
            },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const canSeeRates = actor.permissions.includes('hotels.rates');
    const passengers = trip.bookings
      .flatMap((booking) =>
        booking.passengers.map((p, idx) => ({
          passengerId: p.id,
          bookingId: booking.id,
          bookingReference: booking.bookingReference,
          roomChoice: booking.roomChoice,
          bookingKind: booking.kind ? BOOKING_KIND_LABELS[booking.kind] : null,
          stayHotel: booking.stayHotel,
          stayCheckIn: booking.stayCheckIn,
          stayCheckOut: booking.stayCheckOut,
          stayNights: booking.stayNights,
          fullName: p.fullName,
          phone: p.phone ?? (idx === 0 ? booking.user.phone : null),
          seatNumber: p.seatNumber,
          roomNote: p.roomNote,
          room: p.hotelRoom,
        })),
      )
      .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));

    return {
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        origin: trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        arrivalTime: trip.arrivalTime,
        bookingType: trip.bookingType,
        tripStatus: trip.tripStatus,
        hasHousing: includesHousing(trip.bookingType) || trip.bookings.some((booking) => booking.stayHotel),
        suggestedHotel: trip.accommodations[0]?.name ?? trip.bookings.find((booking) => booking.stayHotel)?.stayHotel?.name ?? null,
        suggestedNights: trip.accommodations[0]?.nights ?? 1,
      },
      hotelBookings: trip.hotelBookings.map((b) => {
        return {
          id: b.id,
          reference: hotelBookingReference(b.number),
          status: b.status,
          hotel: b.hotel,
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          nights: nightsBetween(b.checkIn, b.checkOut),
          supplierReference: b.supplierReference,
          mealPlan: b.mealPlan,
          notes: b.notes,
          rooms: b.rooms
            .map((r) => ({ id: r.id, number: r.number, type: r.type, capacity: r.capacity, occupants: r._count.occupants }))
            .sort((x, y) => (parseInt(x.number, 10) || 0) - (parseInt(y.number, 10) || 0)),
          ...(canSeeRates && { nightlyRate: money(b.nightlyRate), rateUnit: b.rateUnit, extraCost: money(b.extraCost), cost: bookingCost(b) }),
        };
      }),
      passengers,
    };
  }

  async createBooking(actor: HotelActor, dto: CreateHotelBookingDto) {
    const checkIn = toDate(dto.checkIn);
    const checkOut = toDate(dto.checkOut);
    if (checkOut <= checkIn) throw new BadRequestException('تاريخ الخروج يجب أن يكون بعد تاريخ الدخول');
    const canSetRates = actor.permissions.includes('hotels.rates');

    return this.prisma.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({ where: { id: dto.tripId }, select: { bookingType: true, tripStatus: true } });
      if (!trip) throw new NotFoundException('Trip not found');
      await this.assertTripOpen(tx, dto.tripId, trip);
      const hotel = await tx.hotel.findUnique({ where: { id: dto.hotelId } });
      if (!hotel) throw new NotFoundException('الفندق غير موجود');
      if (!hotel.isActive) throw new ConflictException('هذا الفندق غير متاح للحجز');

      const data = {
        checkIn,
        checkOut,
        nightlyRate: canSetRates && dto.nightlyRate !== undefined ? dto.nightlyRate : hotel.nightlyRate,
        rateUnit: hotel.rateUnit,
        extraCost: canSetRates ? dto.extraCost ?? 0 : 0,
        supplierReference: dto.supplierReference || null,
        mealPlan: dto.mealPlan || null,
        notes: dto.notes || null,
        status: 'CONFIRMED' as const,
      };
      const existing = await tx.hotelBooking.findUnique({ where: { tripId_hotelId: { tripId: dto.tripId, hotelId: dto.hotelId } } });
      if (existing?.status === 'CONFIRMED') throw new ConflictException('يوجد حجز قائم لهذا الفندق في هذه الرحلة');
      const saved = existing
        ? await tx.hotelBooking.update({ where: { id: existing.id }, data })
        : await tx.hotelBooking.create({ data: { ...data, tripId: dto.tripId, hotelId: dto.hotelId, createdById: actor.userId } });
      return { id: saved.id, reference: hotelBookingReference(saved.number) };
    }, TX_OPTIONS);
  }

  /**
   * Changes a confirmed stay in place. New dates are checked as a new booking would be: every room already
   * holding guests must be free of blocks and of other trips' guests on the new nights.
   */
  async updateBooking(actor: HotelActor, id: string, dto: UpdateHotelBookingDto) {
    const canSetRates = actor.permissions.includes('hotels.rates');
    if (!canSetRates && (dto.nightlyRate !== undefined || dto.extraCost !== undefined)) {
      throw new ForbiddenException('تعديل الأسعار يحتاج صلاحية أسعار الفنادق');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "HotelBooking" WHERE "id" = ${id} FOR UPDATE`;
      const booking = await tx.hotelBooking.findUnique({
        where: { id },
        include: { trip: { select: { id: true, bookingType: true, tripStatus: true } }, rooms: { where: { occupants: { some: {} } }, select: { number: true } } },
      });
      if (!booking) throw new NotFoundException('حجز الفندق غير موجود');
      if (booking.status !== 'CONFIRMED') throw new ConflictException('لا يمكن تعديل حجز فندق ملغى');
      await this.assertTripOpen(tx, booking.trip.id, booking.trip);

      const checkIn = dto.checkIn ? toDate(dto.checkIn) : booking.checkIn;
      const checkOut = dto.checkOut ? toDate(dto.checkOut) : booking.checkOut;
      if (checkOut <= checkIn) throw new BadRequestException('تاريخ الخروج يجب أن يكون بعد تاريخ الدخول');
      const datesChanged = checkIn.getTime() !== booking.checkIn.getTime() || checkOut.getTime() !== booking.checkOut.getTime();

      if (datesChanged && booking.rooms.length > 0) {
        const numbers = booking.rooms.map((room) => room.number);
        const blocked = await this.rooms.blockedNumbers(tx, booking.hotelId, checkIn, checkOut);
        const blockedRoom = numbers.find((number) => blocked.has(number));
        if (blockedRoom) throw new ConflictException(`الغرفة ${blockedRoom} خارج الخدمة في التواريخ الجديدة`);
        // The same lock as placing guests, so a room cannot be taken by another trip while these dates move onto it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hotel-rooms:${booking.hotelId}`}))`;
        const clash = await tx.hotelRoom.findFirst({
          where: {
            number: { in: numbers },
            occupants: { some: {} },
            hotelBooking: { id: { not: id }, hotelId: booking.hotelId, status: 'CONFIRMED', checkIn: { lt: checkOut }, checkOut: { gt: checkIn } },
          },
          select: { number: true, hotelBooking: { select: { trip: { select: { tripCode: true } } } } },
        });
        if (clash) throw new ConflictException(`الغرفة ${clash.number} مشغولة في التواريخ الجديدة لرحلة أخرى (${clash.hotelBooking.trip.tripCode})`);
      }

      const optionalText = (value: string | undefined) => (value === undefined ? undefined : value || null);
      const saved = await tx.hotelBooking.update({
        where: { id },
        data: {
          checkIn,
          checkOut,
          nightlyRate: dto.nightlyRate,
          extraCost: dto.extraCost,
          supplierReference: optionalText(dto.supplierReference),
          mealPlan: optionalText(dto.mealPlan),
          notes: optionalText(dto.notes),
        },
      });
      return { id: saved.id, reference: hotelBookingReference(saved.number) };
    }, TX_OPTIONS);
  }

  /** A plain transport trip still needs rooms once a branch sold a stay on it. */
  private async assertTripOpen(tx: Prisma.TransactionClient, tripId: string, trip: { bookingType: string; tripStatus: string }) {
    if (!includesHousing(trip.bookingType)) {
      const stays = await tx.booking.count({ where: { tripId, stayHotelId: { not: null }, status: { not: 'CANCELLED' } } });
      if (stays === 0) throw new ConflictException('هذه الرحلة لا تتضمن سكنًا');
    }
    if (trip.tripStatus === 'COMPLETED' || trip.tripStatus === 'CANCELLED') {
      throw new ConflictException('لا يمكن تعديل سكن رحلة منتهية أو ملغاة');
    }
  }

  /** Assigns one or more passengers to a room inside a transaction that also records each change. */
  private async assignInTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    hotelBookingId: string,
    dto: { passengerIds: string[]; roomNumber: string; roomType: RoomType; capacity?: number; newRoomCapacity?: number; keepRoomType?: boolean; roomNote?: string },
    ip?: string,
  ) {
    // One writer per hotel booking at a time, so two employees cannot both take a room's last bed.
    await tx.$queryRaw`SELECT "id" FROM "HotelBooking" WHERE "id" = ${hotelBookingId} FOR UPDATE`;
    const hotelBooking = await tx.hotelBooking.findUnique({
      where: { id: hotelBookingId },
      include: { hotel: { select: { name: true } }, trip: { select: { bookingType: true, tripStatus: true } } },
    });
    if (!hotelBooking) throw new NotFoundException('حجز الفندق غير موجود');
    if (hotelBooking.status !== 'CONFIRMED') throw new ConflictException('حجز الفندق ملغى');
    await this.assertTripOpen(tx, hotelBooking.tripId, hotelBooking.trip);

    const passengerIds = [...new Set(dto.passengerIds)];
    const passengers = await tx.bookingPassenger.findMany({
      where: { id: { in: passengerIds } },
      include: {
        booking: { select: { id: true, tripId: true, status: true } },
        hotelRoom: { select: { id: true, number: true, type: true, hotelBookingId: true } },
      },
    });
    if (passengers.length !== passengerIds.length) throw new NotFoundException('أحد المسافرين غير موجود');
    if (passengers.some((p) => p.booking.tripId !== hotelBooking.tripId)) {
      throw new BadRequestException('أحد المسافرين ليس على هذه الرحلة');
    }

    // Sorted so that overlapping requests always take the locks in the same order and cannot deadlock.
    const bookingIds = [...new Set(passengers.map((p) => p.booking.id))].sort();
    for (const bookingId of bookingIds) await this.events.lock(tx, bookingId);
    const statuses = await tx.booking.findMany({ where: { id: { in: bookingIds } }, select: { status: true } });
    if (statuses.some((b) => !HOUSED_STATUSES.includes(b.status))) throw new ConflictException('أحد الحجوزات ملغى');

    const number = dto.roomNumber;
    const blocked = await this.rooms.blockedNumbers(tx, hotelBooking.hotelId, hotelBooking.checkIn, hotelBooking.checkOut);
    if (blocked.has(number)) throw new ConflictException(`الغرفة ${number} خارج الخدمة في تواريخ هذا الحجز`);
    // Another trip's stay at the same hotel on overlapping nights may already hold this physical room.
    // One writer per hotel, so two trips cannot each place guests in the same room at the same time.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hotel-rooms:${hotelBooking.hotelId}`}))`;
    const elsewhere = await tx.hotelRoom.findFirst({
      where: {
        number,
        occupants: { some: {} },
        hotelBooking: {
          id: { not: hotelBookingId },
          hotelId: hotelBooking.hotelId,
          status: 'CONFIRMED',
          checkIn: { lt: hotelBooking.checkOut },
          checkOut: { gt: hotelBooking.checkIn },
        },
      },
      select: { hotelBooking: { select: { trip: { select: { tripCode: true } } } } },
    });
    if (elsewhere) {
      throw new ConflictException(`الغرفة ${number} مشغولة في نفس التواريخ لرحلة أخرى (${elsewhere.hotelBooking.trip.tripCode})`);
    }
    const existing = await tx.hotelRoom.findUnique({
      where: { hotelBookingId_number: { hotelBookingId, number } },
      include: { occupants: { select: { id: true, bookingId: true } } },
    });
    if (dto.keepRoomType && existing && existing.type !== dto.roomType) {
      throw new ConflictException(`الغرفة ${number} مسجلة ${existing.type === 'PRIVATE' ? 'غرفة خاصة' : 'غرفة مشتركة'}، اختر غرفة أخرى`);
    }
    const room = existing
      ? await tx.hotelRoom.update({ where: { id: existing.id }, data: { type: dto.roomType, capacity: dto.capacity ?? existing.capacity } })
      : await tx.hotelRoom.create({ data: { hotelBookingId, number, type: dto.roomType, capacity: dto.capacity ?? dto.newRoomCapacity ?? DEFAULT_ROOM_CAPACITY } });

    const stayingOccupants = (existing?.occupants ?? []).filter((o) => !passengerIds.includes(o.id));
    // A private room is the booking's own, so nobody from another booking may share it.
    if (dto.roomType === 'PRIVATE' && new Set([...stayingOccupants.map((o) => o.bookingId), ...bookingIds]).size > 1) {
      throw new ConflictException(`الغرفة ${number} خاصة ولا تجمع أكثر من حجز`);
    }
    const staying = stayingOccupants.length;
    if (staying + passengerIds.length > room.capacity) {
      throw new ConflictException(`الغرفة ${number} تتسع لـ ${room.capacity} وبها ${staying} بالفعل`);
    }

    for (const passenger of passengers) {
      await tx.bookingPassenger.update({
        where: { id: passenger.id },
        data: { hotelRoomId: room.id, roomNote: dto.roomNote === undefined ? passenger.roomNote : dto.roomNote || null },
      });
      await this.events.record(tx, {
        bookingId: passenger.booking.id,
        action: 'ROOM_ASSIGNED',
        actorId,
        before: passenger.hotelRoom ? { room: passenger.hotelRoom.number, roomType: passenger.hotelRoom.type } : undefined,
        after: { passenger: passenger.fullName, hotel: hotelBooking.hotel.name, room: number, roomType: dto.roomType },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'ROOM_ASSIGNED', [passenger.booking.id], { passengerName: passenger.fullName, hotelName: hotelBooking.hotel.name, roomNumber: number });
    }
    for (const bookingId of bookingIds) await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
    const arrived = passengers.filter((p) => p.hotelRoom?.id !== room.id).map((p) => p.id);
    await this.tellRoommates(tx, room.id, number, hotelBooking.hotel.name, arrived);
    await this.removeEmptyRooms(tx, passengers.map((p) => p.hotelRoom?.id).filter((id): id is string => !!id && id !== room.id));
  }

  /**
   * Gives everyone in a shared room the names of the people from other bookings who share it with them. Only the
   * bookings that just moved in, and those already there when someone new arrives, hear about it, so nobody is told twice.
   */
  private async tellRoommates(tx: Prisma.TransactionClient, roomId: string, roomNumber: string, hotelName: string, arrivedIds: string[]) {
    if (arrivedIds.length === 0) return;
    const occupants = await tx.bookingPassenger.findMany({
      where: { hotelRoomId: roomId, booking: { status: { in: HOUSED_STATUSES } } },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, bookingId: true },
    });
    const arrived = new Set(arrivedIds);
    const extras = new Map<string, { passengerName: string; roomNumber: string; hotelName: string; roommates: string }>();
    for (const bookingId of new Set(occupants.map((o) => o.bookingId))) {
      const own = occupants.filter((o) => o.bookingId === bookingId);
      const others = occupants.filter((o) => o.bookingId !== bookingId);
      if (others.length === 0) continue;
      if (!occupants.some((o) => arrived.has(o.id))) continue;
      extras.set(bookingId, {
        passengerName: own.map((o) => o.fullName).join('، '),
        roomNumber,
        hotelName,
        roommates: others.map((o) => o.fullName).join('، '),
      });
    }
    await this.notifications.toBookingOwnersEach(tx, 'ROOMMATES_UPDATED', extras);
  }

  private removeEmptyRooms(tx: Prisma.TransactionClient, roomIds: string[]) {
    return this.rooms.tidyEmptyRooms(tx, roomIds);
  }

  async assignRoom(actor: HotelActor, hotelBookingId: string, dto: AssignRoomDto, ip?: string) {
    await this.prisma.$transaction((tx) => this.assignInTx(tx, actor.userId, hotelBookingId, dto, ip), TX_OPTIONS);
    return { success: true };
  }

  /** The supervisor only gives a room number: the room's type comes from what the customer booked, and the shared capacity from the trip. */
  async assignRoomByCrew(actor: HotelActor, tripId: string, passengerId: string, dto: CrewAssignRoomDto, ip?: string) {
    if (actor.role !== 'ADMIN') {
      const assigned = await this.prisma.tripSupervisor.count({ where: { tripId, userId: actor.userId } });
      if (assigned === 0) throw new ForbiddenException('التسكين متاح لمشرف الرحلة فقط');
    }
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { id: true, departureTime: true, sharedRoomCapacity: true, ...CREW_WINDOW_SELECT } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (actor.role !== 'ADMIN' && !crewWindow(trip).isTripOpen) throw new ConflictException('لم تُفتح هذه الرحلة لك بعد');

    return this.prisma.$transaction(async (tx) => {
      const passenger = await tx.bookingPassenger.findFirst({
        where: { id: passengerId, booking: { tripId } },
        select: {
          booking: { select: { roomChoice: true, stayHotelId: true, stayNights: true, passengers: { select: { id: true, hotelRoom: { select: { number: true } } } } } },
        },
      });
      if (!passenger) throw new NotFoundException('هذا المسافر ليس على هذه الرحلة');
      const { booking } = passenger;

      const roomType = booking.roomChoice ?? 'SHARED';
      if (dto.wholeBooking && roomType !== 'PRIVATE') throw new BadRequestException('تسكين الحجز كاملًا في غرفة واحدة متاح للغرف الخاصة فقط');

      const open = await tx.hotelBooking.findMany({ where: { tripId, status: 'CONFIRMED' }, select: { hotelId: true } });
      const hotelId = booking.stayHotelId ?? (open.length === 1 ? open[0].hotelId : null);
      if (!hotelId) throw new ConflictException('لم يُحدد فندق هذا المسافر، راجع الإدارة');
      // A branch can sell a stay before anyone opened that hotel on the trip. A cancelled stay is found here and refused, not reopened.
      const stay = (await tx.hotelBooking.findUnique({ where: { tripId_hotelId: { tripId, hotelId } } })) ?? (await this.rooms.openForTrip(tx, trip, hotelId, booking.stayNights ?? 1));

      const targets = dto.wholeBooking ? booking.passengers : booking.passengers.filter((p) => p.id === passengerId);
      if (targets.every((p) => p.hotelRoom?.number === dto.roomNumber)) throw new ConflictException(`مسكّن بالفعل في الغرفة ${dto.roomNumber}`);

      await this.assignInTx(
        tx,
        actor.userId,
        stay.id,
        {
          passengerIds: targets.map((p) => p.id),
          roomNumber: dto.roomNumber,
          roomType,
          keepRoomType: true,
          // A private room fits whoever the booking has; the shared limit is the trip's, and a room in use keeps its own.
          capacity: roomType === 'PRIVATE' ? booking.passengers.length : undefined,
          newRoomCapacity: trip.sharedRoomCapacity,
        },
        ip,
      );
      return { roomNumber: dto.roomNumber, roomType, passengers: targets.length };
    }, TX_OPTIONS);
  }

  /** Booking-table shortcut: works out the trip and passengers, and opens the hotel booking if needed. */
  async assignBookingRoom(actor: HotelActor, dto: AssignBookingRoomDto, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: dto.bookingId },
        select: {
          tripId: true,
          status: true,
          passengers: { select: { id: true } },
          trip: { select: { bookingType: true, tripStatus: true, departureTime: true, accommodations: { select: { nights: true } } } },
        },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      await this.assertTripOpen(tx, booking.tripId, booking.trip);

      const owned = booking.passengers.map((p) => p.id);
      const passengerIds = dto.passengerIds?.length ? dto.passengerIds : owned;
      if (passengerIds.some((id) => !owned.includes(id))) throw new BadRequestException('أحد المسافرين لا يتبع هذا الحجز');

      const hotel = await tx.hotel.findUnique({ where: { id: dto.hotelId } });
      if (!hotel) throw new NotFoundException('الفندق غير موجود');
      if (!hotel.isActive) throw new ConflictException('هذا الفندق غير متاح للحجز');

      let hotelBooking = await tx.hotelBooking.findUnique({ where: { tripId_hotelId: { tripId: booking.tripId, hotelId: dto.hotelId } } });
      if (!hotelBooking) {
        const checkIn = toDate(riyadhDate(booking.trip.departureTime));
        const nights = booking.trip.accommodations[0]?.nights ?? 1;
        hotelBooking = await tx.hotelBooking.create({
          data: {
            tripId: booking.tripId,
            hotelId: dto.hotelId,
            checkIn,
            checkOut: new Date(checkIn.getTime() + nights * DAY_MS),
            nightlyRate: hotel.nightlyRate,
            rateUnit: hotel.rateUnit,
            createdById: actor.userId,
          },
        });
      }
      await this.assignInTx(tx, actor.userId, hotelBooking.id, { ...dto, passengerIds }, ip);
    }, TX_OPTIONS);
    return { success: true };
  }

  async unassign(actor: HotelActor, passengerId: string, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.bookingPassenger.findUnique({ where: { id: passengerId }, select: { bookingId: true } });
      if (!found) throw new NotFoundException('المسافر غير موجود');
      await this.events.lock(tx, found.bookingId);
      const passenger = await tx.bookingPassenger.findUniqueOrThrow({
        where: { id: passengerId },
        include: {
          hotelRoom: { select: { id: true, number: true, hotelBooking: { select: { hotel: { select: { name: true } } } } } },
          booking: { select: { trip: { select: { tripStatus: true } } } },
        },
      });
      if (!passenger.hotelRoom) throw new ConflictException('هذا المسافر ليس له غرفة');
      // A finished trip's rooms are what the hotel billed, so they stay as they were.
      if (['COMPLETED', 'CANCELLED'].includes(passenger.booking.trip.tripStatus)) {
        throw new ConflictException('لا يمكن تعديل سكن رحلة منتهية أو ملغاة');
      }

      await tx.bookingPassenger.update({ where: { id: passengerId }, data: { hotelRoomId: null, roomNote: null } });
      await tx.booking.update({ where: { id: passenger.bookingId }, data: { updatedAt: new Date() } });
      await this.events.record(tx, {
        bookingId: passenger.bookingId,
        action: 'ROOM_UNASSIGNED',
        actorId: actor.userId,
        before: { passenger: passenger.fullName, hotel: passenger.hotelRoom.hotelBooking.hotel.name, room: passenger.hotelRoom.number },
        ip,
      });
      await this.notifications.toBookingOwners(tx, 'ROOM_UNASSIGNED', [passenger.bookingId], {
        passengerName: passenger.fullName,
        hotelName: passenger.hotelRoom.hotelBooking.hotel.name,
        roomNumber: passenger.hotelRoom.number,
      });
      await this.removeEmptyRooms(tx, [passenger.hotelRoom.id]);
    }, TX_OPTIONS);
    return { success: true };
  }

  async cancelBooking(actor: HotelActor, id: string, reason: string, ip?: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "HotelBooking" WHERE "id" = ${id} FOR UPDATE`;
      const hotelBooking = await tx.hotelBooking.findUnique({
        where: { id },
        include: {
          hotel: { select: { name: true } },
          rooms: { include: { occupants: { select: { id: true, fullName: true, bookingId: true } } } },
          trip: { select: { tripStatus: true, departureTime: true } },
        },
      });
      if (!hotelBooking) throw new NotFoundException('حجز الفندق غير موجود');
      if (hotelBooking.status === 'CANCELLED') throw new ConflictException('حجز الفندق ملغى مسبقًا');
      // Once the trip has left, the stay is being used or was used, and its cost is what the hotel will bill.
      if (hotelBooking.trip.tripStatus === 'COMPLETED' || hotelBooking.trip.departureTime <= new Date()) {
        throw new ConflictException('لا يمكن إلغاء سكن رحلة انطلقت أو اكتملت');
      }

      const occupants = hotelBooking.rooms.flatMap((room) => room.occupants.map((o) => ({ ...o, room: room.number })));
      for (const bookingId of [...new Set(occupants.map((o) => o.bookingId))].sort()) {
        await this.events.lock(tx, bookingId);
        await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
      }
      for (const occupant of occupants) {
        await tx.bookingPassenger.update({ where: { id: occupant.id }, data: { hotelRoomId: null, roomNote: null } });
        await this.events.record(tx, {
          bookingId: occupant.bookingId,
          action: 'ROOM_UNASSIGNED',
          actorId: actor.userId,
          reason,
          before: { passenger: occupant.fullName, hotel: hotelBooking.hotel.name, room: occupant.room },
          ip,
        });
        await this.notifications.toBookingOwners(tx, 'ROOM_UNASSIGNED', [occupant.bookingId], { passengerName: occupant.fullName, hotelName: hotelBooking.hotel.name, roomNumber: occupant.room });
      }
      await tx.hotelRoom.deleteMany({ where: { hotelBookingId: id } });
      await tx.hotelBooking.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason } });
    }, TX_OPTIONS);
    return { success: true };
  }
}


import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { bookingTypeLabel } from '../../common/utils/booking-kinds.util';
import { bookingHasStay, includesHousing } from '../../common/utils/booking-types.util';
import { tripSeatLayout } from '../../common/utils/bus-layout.util';
import { goOnlyBookings, returningBookingIds, reverseSeatsSummary } from '../../common/utils/linked-seats.util';
import { hotelBookingCost, paymentFigures } from '../../common/utils/payment.util';
import { passengerWeights } from '../../common/utils/housing-price.util';
import { tripInCity } from '../../common/utils/branch-city.util';
import { allocate, toHalalas, toSar } from '../bookings/bookings.service';

export type ManifestActor = { userId: string; permissions: string[] };

const ON_MANIFEST: BookingStatus[] = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];

type PaymentChannel = 'cash' | 'network' | 'transfer';
const CHANNEL_BY_METHOD: Record<string, PaymentChannel> = { cash: 'cash', transfer: 'transfer', mada: 'network', card: 'network', network: 'network' };
const CHANNEL_BY_COLLECTION: Record<string, PaymentChannel> = { CASH: 'cash', NETWORK: 'network', TRANSFER: 'transfer' };

const SOURCE_LABELS: Record<string, string> = { APP: 'التطبيق', BRANCH: 'الفرع' };

/** The passenger's name and room type are always printed; these are what staff may add or leave out for the hotel. */
export const HOUSING_SHEET_COLUMNS = ['booking', 'seat', 'nationalId', 'phone', 'hotel', 'nights', 'room', 'hotelNote', 'staffNotes'];
// Staff notes are internal, so they reach a hotel only if someone chooses to send them.
const DEFAULT_SHEET_COLUMNS = ['booking', 'nationalId', 'phone', 'room', 'hotelNote'];
const MAX_PASSENGER_NOTE = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

const MANIFEST_BOOKING_SELECT = {
  id: true,
  bookingReference: true,
  status: true,
  updatedAt: true,
  boardingPointName: true,
  kind: true,
  serviceType: true,
  leg: true,
  roomChoice: true,
  stayNights: true,
  stayHotelId: true,
  stayHotel: { select: { name: true } },
  branchId: true,
  branch: { select: { name: true } },
  user: { select: { phone: true } },
  passengers: {
    // The booking's owner first, so the account phone below lands on them.
    orderBy: { position: 'asc' },
    // Signed ticket tokens stay out on purpose: a manifest is printed and passed around.
    select: {
      id: true,
      fullName: true,
      phone: true,
      nationalId: true,
      notes: true,
      seatNumber: true,
      hotelRoom: { select: { id: true, number: true, type: true, hotelBooking: { select: { hotel: { select: { name: true } } } } } },
      ticket: { select: { isBoarded: true, boardedAt: true, returnBoardedAt: true, noShowAt: true, returnNoShowAt: true } },
    },
  },
} satisfies Prisma.BookingSelect;

@Injectable()
export class ManifestsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** The branch whose passengers this employee may see on a manifest, or null for every branch, the same rule as branch bookings. */
  private async visibleBranch(actor: ManifestActor): Promise<{ branchId: string; city: string | null } | null> {
    if (actor.permissions.includes('bookings.all_branches')) return null;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true, branch: { select: { city: true } } } });
    if (!me?.branchId) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    return { branchId: me.branchId, city: me.branch?.city?.trim() || null };
  }

  async getManifest(actor: ManifestActor, tripId: string) {
    const visible = await this.visibleBranch(actor);
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        bus: { select: { plateNumber: true, model: true } },
        accommodations: { select: { name: true, nights: true } },
        hotelBookings: { where: { status: 'CONFIRMED' }, orderBy: { number: 'asc' }, select: { checkIn: true, checkOut: true, hotel: { select: { name: true } } } },
        housingSheet: true,
        drivers: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true, driverProfile: { select: { iqamaNumber: true } } } } } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true } } } },
        seats: { select: { seatNumber: true, isBooked: true, heldUntil: true } },
        bookings: { where: { status: { in: ON_MANIFEST } }, select: MANIFEST_BOOKING_SELECT },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const [{ bookingIds: goOnly }, reverse] = await Promise.all([goOnlyBookings(this.prisma, [tripId]), reverseSeatsSummary(this.prisma, tripId)]);

    // A round trip's passengers ride back on the reverse under their outbound booking, so its sheet must list them too.
    const isReverseOpen = trip.reverseOfTripId && ['PUBLISHED', 'COMPLETED'].includes(trip.tripStatus);
    const returningIds = isReverseOpen ? await returningBookingIds(this.prisma, trip.reverseOfTripId!) : [];
    const returning = returningIds.length > 0
      ? await this.prisma.booking.findMany({ where: { id: { in: returningIds } }, select: MANIFEST_BOOKING_SELECT })
      : [];

    const everyone = [...trip.bookings.map((booking) => ({ booking, isReturning: false })), ...returning.map((booking) => ({ booking, isReturning: true }))];
    // A seat sold by another branch still shows as taken, but whose it is stays with that branch.
    const takenSeats = new Set(everyone.flatMap(({ booking }) => booking.passengers.map((p) => p.seatNumber)));
    const passengers = everyone
      // A city's branch serves every passenger of its city's trips; elsewhere it sees its own sales.
      .filter(({ booking }) => visible === null || booking.branchId === visible.branchId || (!!visible.city && tripInCity(trip, visible.city)))
      .flatMap(({ booking, isReturning }) =>
        booking.passengers.map((p, idx) => ({
          isReturning,
          passengerId: p.id,
          bookingId: booking.id,
          bookingReference: booking.bookingReference,
          bookingStatus: booking.status,
          bookingUpdatedAt: booking.updatedAt,
          // The booking's own type, the same words as the bookings list, its page, the invoice and the app.
          bookingKind: bookingTypeLabel(booking),
          leg: booking.leg,
          goOnly: goOnly.has(booking.id),
          branchName: booking.branch?.name ?? null,
          // The stay was on the way out; it is not this sheet's business.
          isHoused: !isReturning && bookingHasStay(trip.bookingType, booking),
          stayHotelName: isReturning ? null : booking.stayHotel?.name ?? null,
          stayNights: isReturning ? null : booking.stayNights,
          roomChoice: isReturning ? null : booking.roomChoice,
          fullName: p.fullName,
          // The account phone belongs to whoever booked, so it only represents the first passenger.
          phone: p.phone ?? (idx === 0 ? booking.user.phone : null),
          nationalId: p.nationalId,
          notes: p.notes,
          seatNumber: p.seatNumber,
          roomType: isReturning ? null : p.hotelRoom?.type ?? null,
          roomLabel: isReturning ? null : p.hotelRoom?.number ?? null,
          roomId: isReturning ? null : p.hotelRoom?.id ?? null,
          hotelName: isReturning ? null : p.hotelRoom?.hotelBooking.hotel.name ?? null,
          boardingPointName: isReturning ? null : booking.boardingPointName,
          isBoarded: isReturning ? !!p.ticket?.returnBoardedAt : p.ticket?.isBoarded ?? false,
          boardedAt: isReturning ? p.ticket?.returnBoardedAt ?? null : p.ticket?.boardedAt ?? null,
          /** The trip was executed without this passenger aboard (لم يحضر). */
          isNoShow: isReturning ? !!p.ticket?.returnNoShowAt && !p.ticket?.returnBoardedAt : !!p.ticket?.noShowAt && !p.ticket?.isBoarded,
        })),
      )
      .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));

    const bySeat = new Map(passengers.map((p) => [p.seatNumber, p]));
    const now = new Date();
    const seats = trip.seats
      .map((seat) => {
        const passenger = bySeat.get(seat.seatNumber);
        return {
          seatNumber: seat.seatNumber,
          status: passenger || takenSeats.has(seat.seatNumber) ? 'booked' : seat.isBooked ? 'blocked' : seat.heldUntil && seat.heldUntil > now ? 'held' : 'available',
          passengerName: passenger?.fullName ?? null,
          isBoarded: passenger?.isBoarded ?? false,
        };
      })
      // A seat sold before the reverse opened was never on it, but its passenger still sits there.
      .concat(
        passengers
          .filter((p) => p.isReturning && !trip.seats.some((seat) => seat.seatNumber === p.seatNumber))
          .map((p) => ({ seatNumber: p.seatNumber, status: 'booked', passengerName: p.fullName, isBoarded: p.isBoarded })),
      )
      .sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber));

    const housed = passengers.filter((p) => p.isHoused);
    const rooms = (type: 'SHARED' | 'PRIVATE') => new Set(housed.filter((p) => p.roomType === type).map((p) => p.roomId)).size;
    const sharedBeds = housed.filter((p) => p.roomChoice === 'SHARED').length;
    const privateByBooking = Object.values(
      housed.filter((p) => p.roomChoice === 'PRIVATE').reduce<Record<string, number>>((counts, p) => ({ ...counts, [p.bookingId]: (counts[p.bookingId] ?? 0) + 1 }), {}),
    );
    // Without a capacity on the trip, each private booking counts as one room until the supervisor decides.
    const estimatedPrivateRooms = privateByBooking.reduce((total, people) => total + Math.ceil(people / Math.max(1, trip.privateRoomCapacity ?? people)), 0);

    return {
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        title: trip.title,
        origin: trip.origin,
        destination: trip.destination,
        departureTime: trip.departureTime,
        arrivalTime: trip.arrivalTime,
        tripStatus: trip.tripStatus,
        executedAt: trip.executedAt,
        bookingType: trip.bookingType,
        busType: trip.busType,
        totalSeats: trip.totalSeats,
        busPlate: trip.bus?.plateNumber ?? null,
        hotelName: trip.hotelBookings.map((b) => b.hotel.name).join('، ') || trip.accommodations[0]?.name || null,
        driver: trip.drivers[0]
          ? { name: trip.drivers[0].user.name, phone: trip.drivers[0].user.phone, iqamaNumber: trip.drivers[0].user.driverProfile?.iqamaNumber ?? null }
          : null,
        supervisors: trip.supervisors.map((s) => s.user.name).filter(Boolean),
        manifestSentAt: trip.manifestSentAt,
        manifestSentByName: trip.manifestSentByName,
        crew: [
          ...trip.drivers.map((d, idx) => ({ name: d.user.name, phone: d.user.phone, label: idx === 0 ? 'السائق الأول' : 'السائق الثاني' })),
          ...trip.supervisors.map((s) => ({ name: s.user.name, phone: s.user.phone, label: 'مشرف' })),
        ],
      },
      passengers,
      layout: tripSeatLayout(trip),
      seats,
      reverse,
      summary: {
        total: passengers.length,
        boarded: passengers.filter((p) => p.isBoarded).length,
        noShow: passengers.filter((p) => p.isNoShow).length,
        available: seats.filter((s) => s.status === 'available').length,
      },
      housing: {
        hasHousing: housed.length > 0 || includesHousing(trip.bookingType),
        persons: housed.length,
        sharedBeds,
        privateBeds: privateByBooking.reduce((total, people) => total + people, 0),
        privateBookings: privateByBooking.length,
        undecided: housed.filter((p) => !p.roomChoice).length,
        sharedRoomCapacity: trip.sharedRoomCapacity,
        privateRoomCapacity: trip.privateRoomCapacity,
        estimatedSharedRooms: Math.ceil(sharedBeds / Math.max(1, trip.sharedRoomCapacity)),
        estimatedPrivateRooms,
        sharedRooms: rooms('SHARED'),
        privateRooms: rooms('PRIVATE'),
        unassigned: housed.filter((p) => !p.roomType).length,
        stays: trip.hotelBookings.map((stay) => ({
          hotelName: stay.hotel.name,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          nights: Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / DAY_MS),
        })),
        sheet: {
          availableColumns: HOUSING_SHEET_COLUMNS,
          columns: trip.housingSheet?.columns ?? DEFAULT_SHEET_COLUMNS,
          note: trip.housingSheet?.note ?? '',
          passengerNotes: Object.fromEntries(
            Object.entries((trip.housingSheet?.passengerNotes ?? {}) as Record<string, string>).filter(([id]) => passengers.some((p) => p.passengerId === id)),
          ),
        },
      },
    };
  }

  /**
   * Hands the passenger list to the trip's drivers and supervisors in the app, before the trip opens for them.
   * They read it without phone numbers; sending again only reminds them, since the list they open is always the current one.
   */
  async sendToCrew(actor: { userId: string }, tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { tripStatus: true, _count: { select: { drivers: true, supervisors: true } } },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.tripStatus !== 'PUBLISHED') throw new ConflictException('يُرسل الكشف لرحلة قائمة فقط');
    if (trip._count.drivers + trip._count.supervisors === 0) throw new ConflictException('أسند سائقًا أو مشرفًا للرحلة أولًا');

    const sender = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const passengerCount = await this.prisma.bookingPassenger.count({ where: { booking: { tripId, status: { in: ON_MANIFEST } } } });
    const sentAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.trip.update({ where: { id: tripId }, data: { manifestSentAt: sentAt, manifestSentByName: sender?.name ?? null } });
      await this.notifications.toTripCrew(tx, 'CREW_MANIFEST_SENT', tripId, { extra: { senderName: sender?.name ?? 'المكتب', passengerCount } });
    });
    return { manifestSentAt: sentAt, crew: trip._count.drivers + trip._count.supervisors };
  }

  /** Only notes of passengers really on this trip are kept, so the stored object stays small and cannot be filled with anything else. */
  async saveHousingSheet(tripId: string, dto: { columns: string[]; note?: string; passengerNotes?: Record<string, unknown> }) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { id: true } });
    if (!trip) throw new NotFoundException('Trip not found');
    const unknown = dto.columns.find((column) => !HOUSING_SHEET_COLUMNS.includes(column));
    if (unknown) throw new BadRequestException('عمود غير معروف في كشف التسكين');

    const onTrip = await this.prisma.bookingPassenger.findMany({ where: { booking: { tripId } }, select: { id: true } });
    const notes = dto.passengerNotes ?? {};
    const passengerNotes = Object.fromEntries(
      onTrip.flatMap(({ id }) => {
        const text = typeof notes[id] === 'string' ? (notes[id] as string).trim().slice(0, MAX_PASSENGER_NOTE) : '';
        return text ? [[id, text]] : [];
      }),
    );
    const data = { columns: [...new Set(dto.columns)], note: dto.note?.trim() || null, passengerNotes };
    await this.prisma.tripHousingSheet.upsert({ where: { tripId }, create: { tripId, ...data }, update: data });
    return { success: true };
  }

  async getInventory(tripId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        busRentalPrice: true,
        accommodations: { select: { nights: true } },
        hotelBookings: {
          where: { status: 'CONFIRMED' },
          select: { nightlyRate: true, rateUnit: true, extraCost: true, checkIn: true, checkOut: true, rooms: { select: { _count: { select: { occupants: true } } } } },
        },
        bookings: {
          select: {
            bookingReference: true,
            status: true,
            source: true,
            branch: { select: { name: true } },
            totalPrice: true,
            refundAmount: true,
            externalRefunded: true,
            payment: { select: { amount: true, walletAmount: true, status: true, method: true } },
            collections: { select: { amount: true, method: true } },
            cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
            roomChoice: true,
            kind: true,
            serviceType: true,
            housingAmount: true,
            subtotal: true,
            passengers: { orderBy: { position: 'asc' }, select: { id: true, fullName: true, notes: true, seatNumber: true } },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    const totals = { cash: 0, network: 0, transfer: 0, wallet: 0, retained: 0 };
    const places = new Map<string, { place: string; cash: number; network: number; transfer: number; wallet: number }>();
    const rows: unknown[] = [];

    for (const booking of trip.bookings) {
      const { isPaid, received: online, wallet } = paymentFigures(booking.payment, booking.collections);

      if (booking.status === 'CANCELLED') {
        // Whatever was not refunded stays with the company even though the seats went back on sale.
        const cashRefunded = booking.cashMovements.reduce((sum, row) => sum + toHalalas(row.amount), 0);
        totals.retained += Math.max(0, online + wallet - toHalalas(booking.refundAmount ?? 0) - toHalalas(booking.externalRefunded) - cashRefunded);
        continue;
      }

      // Money taken by staff is split by how each payment came in; anything else came in one way.
      const byChannel: Record<PaymentChannel, number> = { cash: 0, network: 0, transfer: 0 };
      if (booking.collections.length > 0) {
        booking.collections.forEach((row) => { byChannel[CHANNEL_BY_COLLECTION[row.method]] += toHalalas(row.amount); });
      } else {
        byChannel[CHANNEL_BY_METHOD[booking.payment?.method ?? ''] ?? 'network'] = online;
      }
      const weights = passengerWeights(booking);
      const prices = allocate(toHalalas(booking.totalPrice), weights);
      const cashShares = allocate(byChannel.cash, weights);
      const networkShares = allocate(byChannel.network, weights);
      const transferShares = allocate(byChannel.transfer, weights);
      const walletShares = allocate(wallet, weights);
      const place = booking.branch?.name ?? SOURCE_LABELS[booking.source] ?? 'غير محدد';
      const tally = places.get(place) ?? { place, cash: 0, network: 0, transfer: 0, wallet: 0 };

      booking.passengers.forEach((passenger, idx) => {
        totals.cash += cashShares[idx];
        totals.network += networkShares[idx];
        totals.transfer += transferShares[idx];
        totals.wallet += walletShares[idx];
        tally.cash += cashShares[idx];
        tally.network += networkShares[idx];
        tally.transfer += transferShares[idx];
        tally.wallet += walletShares[idx];
        rows.push({
          passengerId: passenger.id,
          fullName: passenger.fullName,
          seatNumber: passenger.seatNumber,
          bookingReference: booking.bookingReference,
          bookingType: bookingTypeLabel(booking),
          nights: trip.accommodations[0]?.nights ?? null,
          price: toSar(prices[idx]),
          cash: toSar(cashShares[idx]),
          network: toSar(networkShares[idx]),
          transfer: toSar(transferShares[idx]),
          wallet: toSar(walletShares[idx]),
          isPaid,
          place,
          notes: passenger.notes,
        });
      });
      places.set(place, tally);
    }

    const collected = totals.cash + totals.network + totals.transfer + totals.wallet;
    const income = collected + totals.retained;
    const busRental = toHalalas(trip.busRentalPrice ?? 0);
    const hotelCost = trip.hotelBookings.reduce((sum, b) => sum + hotelBookingCost(b), 0);
    return {
      rows: (rows as { seatNumber: string }[]).sort((a, b) => Number(a.seatNumber) - Number(b.seatNumber)),
      places: [...places.values()].map((p) => ({
        place: p.place,
        cash: toSar(p.cash),
        network: toSar(p.network),
        transfer: toSar(p.transfer),
        wallet: toSar(p.wallet),
        total: toSar(p.cash + p.network + p.transfer + p.wallet),
      })),
      totals: {
        passengers: rows.length,
        cash: toSar(totals.cash),
        network: toSar(totals.network),
        transfer: toSar(totals.transfer),
        wallet: toSar(totals.wallet),
        retained: toSar(totals.retained),
        income: toSar(income),
        busRental: toSar(busRental),
        hotelCost: toSar(hotelCost),
        net: toSar(income - busRental - hotelCost),
      },
    };
  }
}

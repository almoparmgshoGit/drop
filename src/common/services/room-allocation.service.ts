import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** A trip's stay at a hotel. Rooms are not stock: staff create them as they place passengers. */
@Injectable()
export class RoomAllocationService {
  /** Rooms out of service at any point of a stay. */
  async blockedNumbers(db: Prisma.TransactionClient, hotelId: string, checkIn: Date, checkOut: Date) {
    const blocks = await db.hotelRoomBlock.findMany({
      where: { hotelId, fromDate: { lt: checkOut }, OR: [{ untilDate: null }, { untilDate: { gt: checkIn } }] },
      select: { roomNumber: true },
    });
    return new Set(blocks.map((block) => block.roomNumber));
  }

  /** Takes a room off every overlapping stay: empty ones are removed so nobody can be placed there, and occupied ones refuse. */
  async clearRoomForBlock(tx: Prisma.TransactionClient, hotelId: string, roomNumber: string, fromDate: Date, untilDate: Date | null) {
    const stays = await tx.hotelBooking.findMany({
      where: { hotelId, status: 'CONFIRMED', checkOut: { gt: fromDate }, ...(untilDate && { checkIn: { lt: untilDate } }) },
      select: { id: true },
    });
    const stayIds = stays.map((stay) => stay.id);
    if (stayIds.length > 0) await tx.$queryRaw`SELECT "id" FROM "HotelBooking" WHERE "id" IN (${Prisma.join(stayIds)}) ORDER BY "id" FOR UPDATE`;

    const rooms = await tx.hotelRoom.findMany({
      where: { hotelBookingId: { in: stayIds }, number: roomNumber },
      select: { id: true, _count: { select: { occupants: true } }, hotelBooking: { select: { trip: { select: { tripCode: true } } } } },
    });
    const occupied = rooms.find((room) => room._count.occupants > 0);
    if (occupied) throw new ConflictException(`الغرفة ${roomNumber} بها نزلاء في الرحلة ${occupied.hotelBooking.trip.tripCode}، انقلهم أولًا`);
    await tx.hotelRoom.deleteMany({ where: { id: { in: rooms.map((room) => room.id) } } });
  }

  /** The hotel chosen on the trip, which customers then read about and pick a room type for. Reopens a stay cancelled earlier. */
  async openForTrip(tx: Prisma.TransactionClient, trip: { id: string; departureTime: Date }, hotelId: string, nights: number) {
    const hotel = await tx.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel) throw new NotFoundException('الفندق غير موجود');
    if (!hotel.isActive) throw new ConflictException('هذا الفندق غير متاح للحجز');
    const dates = this.stayDates(trip.departureTime, nights);
    const terms = { ...dates, nightlyRate: hotel.nightlyRate, rateUnit: hotel.rateUnit, status: 'CONFIRMED' as const, cancelReason: null };
    return tx.hotelBooking.upsert({
      where: { tripId_hotelId: { tripId: trip.id, hotelId } },
      create: { tripId: trip.id, hotelId, ...terms },
      update: terms,
    });
  }

  /** A stay starts on the Riyadh date the trip leaves. */
  stayDates(departure: Date, nights: number) {
    const checkIn = new Date(`${new Date(departure.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00.000Z`);
    return { checkIn, checkOut: new Date(checkIn.getTime() + nights * DAY_MS) };
  }

  /** A room nobody sleeps in stops existing, so it stops counting toward the hotel's bill. */
  async tidyEmptyRooms(tx: Prisma.TransactionClient, roomIds: string[]) {
    if (roomIds.length === 0) return;
    await tx.hotelRoom.deleteMany({ where: { id: { in: roomIds }, occupants: { none: {} } } });
  }
}

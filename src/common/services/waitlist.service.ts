import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WaitlistStatus } from '@prisma/client';
import { lockTripsWithLinked } from '../utils/linked-seats.util';
import { PACKAGE_MAX_PERSONS } from '../utils/package-price.util';
import { AppSettingsService } from './app-settings.service';
import { NotificationsService, tripValues } from './notifications.service';
import { PrismaService } from './prisma.service';

type Db = Prisma.TransactionClient;

const MINUTE_MS = 60_000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const ACTIVE: WaitlistStatus[] = ['WAITING', 'OFFERED'];
const SWEEP_BATCH = 200;

const TRIP_FOR_WAITLIST = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  hijriDate: true,
  tripStatus: true,
  channelApp: true,
  bookingOpensAt: true,
  maxSeatsPerBooking: true,
  totalSeats: true,
  availableSeats: true,
  packageId: true,
  package: { select: { status: true } },
} satisfies Prisma.TripSelect;

type WaitlistTrip = Prisma.TripGetPayload<{ select: typeof TRIP_FOR_WAITLIST }>;

/** A trip the app still sells: the same conditions as booking it. */
const isOnSale = (trip: WaitlistTrip, now: Date) =>
  trip.tripStatus === 'PUBLISHED' &&
  trip.channelApp &&
  trip.departureTime > now &&
  (!trip.packageId || trip.package?.status === 'PUBLISHED') &&
  (!trip.bookingOpensAt || trip.bookingOpensAt <= now);

/** Seats nobody has bought or is holding right now, lowest number first. */
async function freeSeats(db: Db, tripId: string, now: Date) {
  const seats = await db.seat.findMany({
    where: { tripId, isBooked: false, OR: [{ heldUntil: null }, { heldUntil: { lt: now } }] },
    select: { seatNumber: true },
  });
  return seats.map((seat) => seat.seatNumber).sort((a, b) => Number(a) - Number(b));
}

/**
 * The waiting list of full trips. When seats free up (a cancellation, a hold that ran out, more seats on the bus) the
 * first entry in the queue whose group fits is offered them: the seats are held in its name for a set window and the
 * customer is told. Unbooked when the window ends, the seats pass to the next entry. Every change runs under the trip's
 * lock, the same one booking takes, so a seat is never offered and sold at once.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
  ) {}

  // ---------------------------------------------------------------- customer

  async join(userId: string, tripId: string, seats: number) {
    await this.appSettings.assertBookingsOpen();
    if (!(await this.appSettings.flag('waitlistEnabled'))) throw new BadRequestException('قائمة الانتظار غير متاحة حاليًا');
    return this.prisma.$transaction(async (tx) => {
      await lockTripsWithLinked(tx, [tripId]);
      const now = new Date();
      const trip = await tx.trip.findUnique({ where: { id: tripId }, select: TRIP_FOR_WAITLIST });
      if (!trip || !isOnSale(trip, now)) throw new NotFoundException('الرحلة غير متاحة للحجز');
      const max = trip.packageId ? Math.min(trip.maxSeatsPerBooking, PACKAGE_MAX_PERSONS) : trip.maxSeatsPerBooking;
      if (seats < 1 || seats > max) throw new BadRequestException(`عدد المقاعد في قائمة الانتظار من 1 إلى ${max}`);
      const free = await freeSeats(tx, tripId, now);
      if (free.length >= seats) throw new BadRequestException('توجد مقاعد متاحة الآن، يمكنك الحجز مباشرة');
      const existing = await tx.waitlistEntry.findFirst({ where: { tripId, userId, status: { in: ACTIVE } } });
      if (existing) throw new ConflictException('أنت مسجل في قائمة الانتظار لهذه الرحلة');
      const last = await tx.waitlistEntry.aggregate({ where: { tripId }, _max: { position: true } });
      const entry = await tx.waitlistEntry.create({ data: { tripId, userId, seats, position: (last._max.position ?? 0) + 1 } });
      return this.withQueuePlace(tx, entry);
    }, TX_OPTIONS);
  }

  async mine(userId: string) {
    const entries = await this.prisma.waitlistEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { trip: { select: { id: true, title: true, origin: true, destination: true, departureTime: true, hijriDate: true, busType: true } } },
    });
    return Promise.all(entries.map((entry) => this.withQueuePlace(this.prisma, entry)));
  }

  async leave(userId: string, id: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({ where: { id } });
    if (!entry || entry.userId !== userId) throw new NotFoundException('الطلب غير موجود');
    return this.close(entry.id, 'CANCELLED');
  }

  /** Booking while waiting or while offered seats closes the place in the queue. */
  async markBooked(db: Db, userId: string, tripIds: string[]) {
    if (tripIds.length === 0) return;
    await db.waitlistEntry.updateMany({
      where: { userId, tripId: { in: tripIds }, status: { in: ACTIVE } },
      data: { status: 'BOOKED', bookedAt: new Date(), expiresAt: null },
    });
  }

  /** While a customer checks out on seats offered to them, their hold lasts at least as long as the offer. */
  async offerHoldUntil(db: Db, userId: string, tripId: string, now = new Date()) {
    const entry = await db.waitlistEntry.findFirst({ where: { userId, tripId, status: 'OFFERED', expiresAt: { gt: now } }, select: { expiresAt: true } });
    return entry?.expiresAt ?? null;
  }

  // ---------------------------------------------------------------- admin

  async listForTrip(tripId: string) {
    const entries = await this.prisma.waitlistEntry.findMany({
      where: { tripId },
      orderBy: [{ position: 'asc' }],
      include: { user: { select: { id: true, name: true, phone: true } } },
    });
    const order: WaitlistStatus[] = ['OFFERED', 'WAITING', 'BOOKED', 'EXPIRED', 'CANCELLED'];
    let place = 0;
    return entries
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.position - b.position)
      .map((entry) => ({ ...entry, queuePlace: entry.status === 'WAITING' ? ++place : null }));
  }

  /** Staff offer free seats to an entry now, out of turn if they choose. */
  async offerNow(id: string, actorName?: string | null) {
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await tx.waitlistEntry.findUnique({ where: { id }, select: { tripId: true } });
      if (!found) throw new NotFoundException('الطلب غير موجود');
      await lockTripsWithLinked(tx, [found.tripId]);
      const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id } });
      if (entry.status !== 'WAITING') throw new BadRequestException('لا يمكن العرض إلا على طلب في الانتظار');
      const now = new Date();
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: entry.tripId }, select: TRIP_FOR_WAITLIST });
      if (!isOnSale(trip, now)) throw new BadRequestException('الرحلة لم تعد متاحة للحجز');
      const free = await freeSeats(tx, entry.tripId, now);
      if (free.length < entry.seats) throw new BadRequestException(`المقاعد الشاغرة الآن ${free.length} ولا تكفي هذا الطلب (${entry.seats})`);
      const minutes = await this.appSettings.number('waitlistOfferMinutes');
      await this.offer(tx, entry, trip, free.slice(0, entry.seats), minutes, now, actorName);
      return tx.waitlistEntry.findUniqueOrThrow({ where: { id } });
    }, TX_OPTIONS);
    return result;
  }

  async remove(id: string, actorName?: string | null) {
    const entry = await this.prisma.waitlistEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('الطلب غير موجود');
    return this.close(id, 'CANCELLED', actorName);
  }

  // ---------------------------------------------------------------- offering

  /**
   * Offers the trip's free seats down the queue, in order, to each entry whose group fits. Run inside the caller's
   * transaction after seats were freed; it takes the trip's lock itself, which the caller may already hold.
   */
  async offerFreedSeats(db: Db, tripId: string, now = new Date()) {
    const waiting = await db.waitlistEntry.findMany({ where: { tripId, status: 'WAITING' }, orderBy: { position: 'asc' } });
    if (waiting.length === 0) return 0;
    await lockTripsWithLinked(db, [tripId]);
    const trip = await db.trip.findUnique({ where: { id: tripId }, select: TRIP_FOR_WAITLIST });
    if (!trip || !isOnSale(trip, now)) return 0;
    let free = await freeSeats(db, tripId, now);
    if (free.length === 0) return 0;
    const minutes = await this.appSettings.number('waitlistOfferMinutes');
    let offered = 0;
    for (const entry of waiting) {
      if (free.length === 0) break;
      if (entry.seats > free.length) continue;
      await this.offer(db, entry, trip, free.slice(0, entry.seats), minutes, now);
      free = free.slice(entry.seats);
      offered++;
    }
    return offered;
  }

  private async offer(db: Db, entry: { id: string; userId: string; tripId: string; seats: number }, trip: WaitlistTrip, seats: string[], minutes: number, now: Date, actorName?: string | null) {
    const expiresAt = new Date(now.getTime() + minutes * MINUTE_MS);
    const held = await db.seat.updateMany({
      where: { tripId: entry.tripId, seatNumber: { in: seats }, isBooked: false, OR: [{ heldUntil: null }, { heldUntil: { lt: now } }] },
      data: { heldByUserId: entry.userId, heldUntil: expiresAt },
    });
    if (held.count !== seats.length) throw new ConflictException('تغيرت المقاعد الشاغرة للتو، حاول مرة أخرى');
    await db.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: 'OFFERED', offeredAt: now, expiresAt, heldSeats: seats, ...(actorName !== undefined && { handledByName: actorName }) },
    });
    await this.notifications.toUser(
      db,
      'WAITLIST_OFFERED',
      entry.userId,
      { ...tripValues(trip), seats: seats.join('، '), passengerCount: seats.length, minutes },
      { tripId: entry.tripId },
    );
  }

  /** Ends an entry; an offered one gives its held seats back, and they go to the next in line. */
  private async close(id: string, status: 'CANCELLED' | 'EXPIRED', actorName?: string | null, notify = false) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.waitlistEntry.findUniqueOrThrow({ where: { id }, select: { tripId: true } });
      await lockTripsWithLinked(tx, [found.tripId]);
      const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id } });
      if (!ACTIVE.includes(entry.status)) throw new BadRequestException('هذا الطلب لم يعد في قائمة الانتظار');
      const now = new Date();
      if (entry.status === 'OFFERED') await this.releaseOffer(tx, entry);
      const closed = await tx.waitlistEntry.update({
        where: { id },
        data: { status, expiresAt: null, ...(status === 'CANCELLED' && { cancelledAt: now }), ...(actorName !== undefined && { handledByName: actorName }) },
      });
      if (notify) {
        const trip = await tx.trip.findUniqueOrThrow({ where: { id: entry.tripId }, select: TRIP_FOR_WAITLIST });
        await this.notifications.toUser(tx, 'WAITLIST_EXPIRED', entry.userId, tripValues(trip), { tripId: entry.tripId });
      }
      if (entry.status === 'OFFERED') await this.offerFreedSeats(tx, entry.tripId, now);
      return closed;
    }, TX_OPTIONS);
  }

  /** The seats this offer held and nobody bought; seats the customer picked again at checkout last until the offer ends too. */
  private async releaseOffer(db: Db, entry: { userId: string; tripId: string; expiresAt: Date | null }) {
    await db.seat.updateMany({
      where: { tripId: entry.tripId, heldByUserId: entry.userId, isBooked: false, ...(entry.expiresAt && { heldUntil: { lte: entry.expiresAt } }) },
      data: { heldByUserId: null, heldUntil: null },
    });
  }

  private async withQueuePlace<T extends { tripId: string; status: WaitlistStatus; position: number }>(db: Pick<Db, 'waitlistEntry'>, entry: T) {
    const ahead = entry.status === 'WAITING' ? await db.waitlistEntry.count({ where: { tripId: entry.tripId, status: 'WAITING', position: { lt: entry.position } } }) : null;
    return { ...entry, queuePlace: ahead === null ? null : ahead + 1 };
  }

  // ---------------------------------------------------------------- sweep

  /**
   * Run on a timer: ends offers whose window passed (and passes their seats on), closes entries of trips no longer on
   * sale, and offers any seats that freed up without a cancellation, such as a hold running out or a bigger bus.
   */
  async sweep(now = new Date()) {
    const expired = await this.prisma.waitlistEntry.findMany({ where: { status: 'OFFERED', expiresAt: { lt: now } }, select: { id: true }, take: SWEEP_BATCH });
    for (const { id } of expired) {
      await this.close(id, 'EXPIRED', undefined, true).catch((err) => this.logger.warn(`Waitlist expiry ${id}: ${(err as Error).message}`));
    }

    const stale = await this.prisma.waitlistEntry.findMany({
      where: {
        status: { in: ACTIVE },
        trip: { OR: [{ tripStatus: { not: 'PUBLISHED' } }, { departureTime: { lte: now } }, { channelApp: false }] },
      },
      select: { id: true },
      take: SWEEP_BATCH,
    });
    for (const { id } of stale) {
      await this.close(id, 'EXPIRED').catch((err) => this.logger.warn(`Waitlist close ${id}: ${(err as Error).message}`));
    }

    const trips = await this.prisma.waitlistEntry.findMany({ where: { status: 'WAITING' }, distinct: ['tripId'], select: { tripId: true }, take: SWEEP_BATCH });
    let offered = 0;
    for (const { tripId } of trips) {
      offered += await this.prisma
        .$transaction((tx) => this.offerFreedSeats(tx, tripId, new Date()), TX_OPTIONS)
        .catch((err) => {
          this.logger.warn(`Waitlist offer on ${tripId}: ${(err as Error).message}`);
          return 0;
        });
    }
    return { expired: expired.length, closed: stale.length, offered };
  }
}

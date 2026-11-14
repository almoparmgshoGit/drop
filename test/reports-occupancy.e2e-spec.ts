import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

/** Riyadh wall-clock time as the UTC instant stored, Saudi Arabia being UTC+3 all year. */
const riyadh = (local: string) => new Date(`${local}:00+03:00`);
const MARCH = 'from=2026-03-01&to=2026-03-31';

describe('Reports: occupancy by weekday and hour, and route reliability', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let userId: string;

  const http = () => request(app.getHttpServer());

  /** Created through the API so it is a real trip, then moved to the day, seats and state the test needs. */
  async function trip(input: {
    origin: string;
    destination: string;
    departure: string;
    totalSeats: number;
    availableSeats: number;
    tripStatus?: 'PUBLISHED' | 'COMPLETED' | 'CANCELLED' | 'DRAFT';
    executed?: boolean;
    reverseOfTripId?: string;
  }) {
    const created = await http().post(`${API}/trips`).set(admin.auth).send(tripPayload({ origin: input.origin, destination: input.destination })).expect(201);
    const departureTime = riyadh(input.departure);
    await prisma.trip.update({
      where: { id: created.body.id },
      data: {
        departureTime,
        arrivalTime: new Date(departureTime.getTime() + 5 * 3_600_000),
        totalSeats: input.totalSeats,
        availableSeats: input.availableSeats,
        tripStatus: input.tripStatus ?? 'PUBLISHED',
        executedAt: input.executed ? new Date(departureTime.getTime() + 3_600_000) : null,
        reverseOfTripId: input.reverseOfTripId ?? null,
      },
    });
    return created.body.id as string;
  }

  type Rider = 'boarded' | 'noShow' | 'waiting' | 'returned' | 'returnNoShow';

  /** Inserted directly with a ticket per passenger: the booking flow has its own suites, and these tests are about the counts. */
  async function book(tripId: string, input: { status: 'CONFIRMED' | 'BOARDED' | 'CANCELLED'; riders: Rider[]; customerCancelled?: boolean }) {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `O${randomUUID().slice(0, 10)}`,
        tripId,
        userId,
        status: input.status,
        totalPrice: 100 * input.riders.length,
        cancelRequestedAt: input.customerCancelled ? new Date() : null,
        passengers: { create: input.riders.map((_, index) => ({ fullName: `راكب ${index + 1}`, seatNumber: String(index + 1), position: index })) },
      },
      include: { passengers: true },
    });
    if (input.status === 'CANCELLED') return booking;
    const now = new Date();
    for (const [index, passenger] of booking.passengers.entries()) {
      const rider = input.riders[index];
      await prisma.ticket.create({
        data: {
          bookingId: booking.id,
          passengerId: passenger.id,
          ticketNumber: `TK${randomUUID().slice(0, 12)}`,
          signedToken: 'test',
          isBoarded: rider === 'boarded' || rider === 'returned' || rider === 'returnNoShow',
          boardedAt: rider === 'boarded' ? now : null,
          noShowAt: rider === 'noShow' ? now : null,
          returnBoardedAt: rider === 'returned' ? now : null,
          returnNoShowAt: rider === 'returnNoShow' ? now : null,
        },
      });
    }
    return booking;
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const staff = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, staff.phone);
    userId = (await loginPassenger(app)).user.id;

    // Sunday 1 March, 08:30 and Sunday 8 March, 09:15 in Riyadh.
    const sundayMorning = await trip({ origin: 'الرياض', destination: 'مكة المكرمة', departure: '2026-03-01T08:30', totalSeats: 40, availableSeats: 10, executed: true });
    const sundayLater = await trip({ origin: 'الرياض', destination: 'مكة المكرمة', departure: '2026-03-08T09:15', totalSeats: 40, availableSeats: 30 });
    // Cancelled and draft trips never ran, so they hold no seats.
    const cancelled = await trip({ origin: 'الرياض', destination: 'مكة المكرمة', departure: '2026-03-02T20:00', totalSeats: 40, availableSeats: 20, tripStatus: 'CANCELLED' });
    await trip({ origin: 'الرياض', destination: 'مكة المكرمة', departure: '2026-03-02T21:00', totalSeats: 40, availableSeats: 0, tripStatus: 'DRAFT' });
    // 01:00 Wednesday in Riyadh is still Tuesday in UTC: the report must read Riyadh's day.
    await trip({ origin: 'جدة', destination: 'المدينة المنورة', departure: '2026-03-04T01:00', totalSeats: 50, availableSeats: 0 });
    // The way back of the first trip, empty, executed on Thursday.
    const reverse = await trip({ origin: 'مكة المكرمة', destination: 'الرياض', departure: '2026-03-05T10:00', totalSeats: 40, availableSeats: 40, executed: true, reverseOfTripId: sundayMorning });

    await book(sundayMorning, { status: 'CONFIRMED', riders: ['returned', 'returnNoShow', 'noShow'] });
    await book(sundayMorning, { status: 'BOARDED', riders: ['boarded'] });
    await book(sundayMorning, { status: 'CANCELLED', riders: ['waiting', 'waiting'], customerCancelled: true });
    await book(sundayMorning, { status: 'CANCELLED', riders: ['waiting'] });
    await book(cancelled, { status: 'CANCELLED', riders: ['waiting', 'waiting'] });
    // Not executed yet: nobody is a no-show until boarding closes.
    await book(sundayLater, { status: 'CONFIRMED', riders: ['waiting', 'waiting'] });
    expect(reverse).toBeDefined();
  });

  afterAll(async () => {
    await app.close();
  });

  it('needs the reports permission', async () => {
    const customer = await loginPassenger(app);
    await http().get(`${API}/reports/occupancy?${MARCH}`).set(customer.auth).expect(403);
    await http().get(`${API}/reports/reliability?${MARCH}`).expect(401);
    await http().get(`${API}/reports/occupancy?from=2026-03-31&to=2026-03-01`).set(admin.auth).expect(400);
    await http().get(`${API}/reports/occupancy?${MARCH}&bookingType=NOPE`).set(admin.auth).expect(400);
  });

  it('adds up seats by Riyadh weekday, hour and two-hour band, over the trips that ran', async () => {
    const { body } = await http().get(`${API}/reports/occupancy?${MARCH}`).set(admin.auth).expect(200);
    expect(body.total).toEqual({ trips: 4, offered: 170, taken: 90, occupancy: 52.9 });
    expect(body.byWeekday).toHaveLength(7);
    expect(body.byWeekday[0]).toMatchObject({ weekday: 0, label: 'الأحد', trips: 2, offered: 80, taken: 40, occupancy: 50 });
    expect(body.byWeekday[1]).toMatchObject({ trips: 0, occupancy: 0 });
    expect(body.byWeekday[3]).toMatchObject({ trips: 1, occupancy: 100 });
    expect(body.byHour).toHaveLength(24);
    expect(body.byHour[8]).toMatchObject({ trips: 1, occupancy: 75 });
    expect(body.byHour[9]).toMatchObject({ trips: 1, occupancy: 25 });
    expect(body.byHour[1]).toMatchObject({ trips: 1, occupancy: 100 });
    expect(body.heatmap).toHaveLength(7 * 12);
    expect(body.heatmap.find((cell: { weekday: number; band: number }) => cell.weekday === 0 && cell.band === 4)).toMatchObject({ fromHour: 8, trips: 2, occupancy: 50 });
    expect(body.best).toMatchObject({ weekday: 3, band: 0, occupancy: 100 });
    expect(body.worst).toMatchObject({ weekday: 4, band: 5, occupancy: 0 });
    expect(body.options.origins).toEqual(expect.arrayContaining(['الرياض', 'جدة', 'مكة المكرمة']));
  });

  it('narrows to a route', async () => {
    const { body } = await http().get(`${API}/reports/occupancy?${MARCH}&origin=${encodeURIComponent('الرياض')}&destination=${encodeURIComponent('مكة المكرمة')}`).set(admin.auth).expect(200);
    expect(body.total).toEqual({ trips: 2, offered: 80, taken: 40, occupancy: 50 });
  });

  it('counts cancellations by who cancelled and no-shows on executed trips, worst route first', async () => {
    const { body } = await http().get(`${API}/reports/reliability?${MARCH}`).set(admin.auth).expect(200);
    const outbound = body.routes.find((row: { label: string }) => row.label === 'الرياض ← مكة المكرمة');
    expect(outbound).toMatchObject({
      trips: 2,
      cancelledTrips: 1,
      executedTrips: 1,
      bookings: 6,
      passengers: 6,
      cancelled: 3,
      cancelledByCustomer: 1,
      cancelledByOffice: 1,
      cancelledByTrip: 1,
      cancelRate: 50,
      expected: 4,
      noShows: 1,
      noShowRate: 25,
    });
    // The way back counts the return riders: one came back, one did not.
    const back = body.routes.find((row: { label: string }) => row.label === 'مكة المكرمة ← الرياض');
    expect(back).toMatchObject({ trips: 1, executedTrips: 1, bookings: 0, expected: 2, noShows: 1, noShowRate: 50 });
    expect(body.routes.map((row: { label: string }) => row.label)).toEqual(['الرياض ← مكة المكرمة', 'مكة المكرمة ← الرياض', 'جدة ← المدينة المنورة']);
    expect(body.totals).toMatchObject({ bookings: 6, cancelled: 3, cancelRate: 50, expected: 6, noShows: 2, noShowRate: 33.3 });
  });

  it('reads zero, not a division by zero, in an empty period', async () => {
    const { body } = await http().get(`${API}/reports/reliability?from=2020-01-01&to=2020-01-31`).set(admin.auth).expect(200);
    expect(body.routes).toEqual([]);
    expect(body.totals).toMatchObject({ cancelRate: 0, noShowRate: 0 });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/common/services/prisma.service';
import { riyadhDate } from '../src/common/utils/time.util';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const today = () => riyadhDate(new Date());

describe('Reports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };

  const http = () => request(app.getHttpServer());
  const range = () => `from=${today()}&to=${today()}`;

  const sendEvent = (deviceId: string, type: string, route: { origin?: string; destination?: string } = {}, platform = 'android') =>
    http().post(`${API}/app-events`).send({ deviceId, type, platform, ...route });

  /** Inserted directly: the booking flow has its own suite, and these tests are about the sums. */
  async function createBooking(input: {
    tripId: string;
    userId: string;
    status?: 'CONFIRMED' | 'CANCELLED';
    total: number;
    payment: { amount: number; wallet?: number; status: string; method: string };
    refundAmount?: number;
    externalRefunded?: number;
    groupReference?: string;
  }) {
    return prisma.booking.create({
      data: {
        bookingReference: `R${randomUUID().slice(0, 10)}`,
        tripId: input.tripId,
        userId: input.userId,
        status: input.status ?? 'CONFIRMED',
        totalPrice: input.total,
        walletAmount: input.payment.wallet ?? 0,
        refundAmount: input.refundAmount,
        externalRefunded: input.externalRefunded ?? 0,
        groupReference: input.groupReference,
        payment: { create: { amount: input.payment.amount, walletAmount: input.payment.wallet ?? 0, status: input.payment.status, method: input.payment.method } },
      },
    });
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const staff = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, staff.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    it('refuses a customer and an employee whose rank lacks the permission', async () => {
      const customer = await loginPassenger(app);
      await http().get(`${API}/reports/revenue?${range()}`).set(customer.auth).expect(403);

      const clerk = await createStaff(prisma, 'STAFF');
      const clerkSession = await loginStaff(app, clerk.phone);
      await http().get(`${API}/reports/app`).set(clerkSession.auth).expect(403);
    });

    it('needs a sign-in to read a report', async () => {
      await http().get(`${API}/reports/bookings?${range()}`).expect(401);
    });

    it('rejects a backwards period, and one over a year', async () => {
      await http().get(`${API}/reports/revenue?from=2026-02-02&to=2026-02-01`).set(admin.auth).expect(400);
      await http().get(`${API}/reports/revenue?from=2024-01-01&to=2026-01-01`).set(admin.auth).expect(400);
      await http().get(`${API}/reports/revenue?from=2026-13-40&to=2026-13-41`).set(admin.auth).expect(400);
    });
  });

  describe('figures', () => {
    let tripId: string;

    beforeAll(async () => {
      const customer = await loginPassenger(app);
      const created = await http()
        .post(`${API}/trips`)
        .set(admin.auth)
        .send(tripPayload({ origin: 'الرياض', destination: 'مكة المكرمة', departureTime: new Date(Date.now() + 3_600_000).toISOString(), arrivalTime: new Date(Date.now() + 7_200_000).toISOString() }))
        .expect(201);
      tripId = created.body.id;
      const userId = customer.user.id;

      await createBooking({ tripId, userId, total: 300, payment: { amount: 300, status: 'SIMULATED', method: 'mada' } });
      await createBooking({ tripId, userId, total: 200, payment: { amount: 150, wallet: 50, status: 'COMPLETED', method: 'card' } });
      // Paid 100, of which 40 was returned to the card, and the booking was cancelled.
      await createBooking({ tripId, userId, status: 'CANCELLED', total: 100, payment: { amount: 100, status: 'COMPLETED', method: 'card' }, externalRefunded: 40 });
    });

    it('counts sold value, what a cancelled booking kept, and the refunds apart', async () => {
      const { body } = await http().get(`${API}/reports/revenue?${range()}`).set(admin.auth).expect(200);
      expect(body.gross).toBe(600);
      expect(body.refunds).toBe(40);
      expect(body.net).toBe(560);
      expect(body.simulated).toBe(300);
      expect(body.averageBooking).toBe(250);
      expect(body.byRoute).toEqual([{ label: 'الرياض ← مكة المكرمة', amount: 560 }]);
    });

    it('splits money by the method it came through, with the wallet on its own', async () => {
      const { body } = await http().get(`${API}/reports/revenue?${range()}`).set(admin.auth).expect(200);
      expect(body.wallet).toBe(50);
      expect(body.methods).toEqual([
        { method: 'mada', amount: 300, share: 54.5 },
        { method: 'card', amount: 250, share: 45.5 },
      ]);
    });

    it('a period with no bookings reads zero and does not divide by it', async () => {
      const { body } = await http().get(`${API}/reports/revenue?from=2020-01-01&to=2020-01-31`).set(admin.auth).expect(200);
      expect(body).toMatchObject({ gross: 0, net: 0, averageBooking: 0, occupancy: 0, changePercent: null, byRoute: [] });
    });

    it('counts a round trip as one booking, and keeps the days with nothing in them', async () => {
      const customer = await loginPassenger(app);
      const group = `G-${randomUUID()}`;
      await createBooking({ tripId, userId: customer.user.id, total: 80, payment: { amount: 80, status: 'COMPLETED', method: 'mada' }, groupReference: group });
      await createBooking({ tripId, userId: customer.user.id, total: 80, payment: { amount: 80, status: 'COMPLETED', method: 'mada' }, groupReference: group });

      const { body } = await http().get(`${API}/reports/bookings?${range()}`).set(admin.auth).expect(200);
      expect(body.total).toBe(4);
      expect(body.cancelled).toBe(1);
      expect(body.cancelRate).toBe(25);
      expect(body.series).toEqual([{ key: today(), value: 4 }]);

      const longer = await http().get(`${API}/reports/bookings?from=2020-01-01&to=2020-01-10`).set(admin.auth).expect(200);
      expect(longer.body.series).toHaveLength(10);
    });

    it('draws a long period by month', async () => {
      const { body } = await http().get(`${API}/reports/bookings?from=2020-01-01&to=2020-06-30`).set(admin.auth).expect(200);
      expect(body.series.map((row: { key: string }) => row.key)).toEqual(['2020-01', '2020-02', '2020-03', '2020-04', '2020-05', '2020-06']);
    });

    it('measures occupancy on trips that run', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { totalSeats: 40, availableSeats: 10 } });
      const { body } = await http().get(`${API}/reports/trips?${range()}`).set(admin.auth).expect(200);
      expect(body).toMatchObject({ total: 1, taken: 30, offered: 40, occupancy: 75 });
      expect(body.routes[0]).toMatchObject({ label: 'الرياض ← مكة المكرمة', occupancy: 75 });
    });
  });

  describe('app statistics', () => {
    const route = { origin: 'ينبع', destination: 'مكة المكرمة' };

    beforeAll(() => prisma.appEvent.deleteMany());

    it('takes an event from a device with no account', async () => {
      await sendEvent(randomUUID(), 'APP_OPEN').expect(204);
    });

    it('refuses a made-up step or a device id that is not one', async () => {
      await sendEvent(randomUUID(), 'HACK').expect(400);
      await sendEvent('12345', 'APP_OPEN').expect(400);
      await sendEvent(randomUUID(), 'APP_OPEN', {}, 'windows').expect(400);
    });

    it('counts a repeated step once a day, and builds the funnel and the routes', async () => {
      await prisma.appEvent.deleteMany();
      const first = randomUUID();
      const second = randomUUID();

      await sendEvent(first, 'APP_OPEN').expect(204);
      await sendEvent(first, 'APP_OPEN').expect(204);
      await sendEvent(second, 'APP_OPEN', {}, 'ios').expect(204);
      await sendEvent(first, 'TRIP_SEARCH', route).expect(204);
      await sendEvent(first, 'TRIP_SEARCH', route).expect(204);
      // Looking at another route is one more search for that route, but not a second step for the device.
      await sendEvent(first, 'TRIP_SEARCH', { origin: 'جدة', destination: 'مكة المكرمة' }).expect(204);
      await sendEvent(second, 'TRIP_SEARCH', route, 'ios').expect(204);
      await sendEvent(first, 'TRIP_VIEW', route).expect(204);
      await sendEvent(first, 'BOOKING_START', route).expect(204);
      await sendEvent(first, 'BOOKING_PAID', route).expect(204);

      const { body } = await http().get(`${API}/reports/app?days=7`).set(admin.auth).expect(200);
      expect(body.installs).toEqual({ total: 2, ios: 1, android: 1 });
      expect(body.activeUsers).toBe(2);
      expect(body.visits).toBe(2);
      expect(body.conversion).toBe(50);
      expect(body.daily).toHaveLength(7);
      expect(body.daily[6]).toEqual({ key: today(), value: 2 });
      expect(body.funnel.map((step: { count: number }) => step.count)).toEqual([2, 2, 1, 1, 1]);
      expect(body.topRoutes[0]).toEqual({ label: 'ينبع ← مكة المكرمة', searches: 2, views: 1, bookings: 1, conversion: 50 });
    });

    it('only offers the periods on the page', async () => {
      await http().get(`${API}/reports/app?days=3`).set(admin.auth).expect(400);
    });

    it('keeps no customer identity on an event', async () => {
      const row = await prisma.appEvent.findFirstOrThrow();
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'day', 'destination', 'deviceId', 'id', 'origin', 'platform', 'type']);
    });
  });
});

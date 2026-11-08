import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { BookingCancellationService } from '../src/common/services/booking-cancellation.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { ManifestsService } from '../src/modules/manifests/manifests.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

let keyCounter = 0;
const key = () => `collect-key-${++keyCounter}`;
const DAY = 24 * 60 * 60 * 1000;

describe('Remaining balances and collection', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let adminUser: { id: string; phone: string };
  let collector: { auth: Record<string, string> };
  let collectorUser: { id: string };
  let branchId: string;
  let otherBranchId: string;
  let tripId: string;

  const http = () => app.getHttpServer();
  const list = async (query = '', auth = admin.auth) => (await request(http()).get(`${API}/collections${query}`).set(auth).expect(200)).body;
  const collect = (bookingId: string, body: object, auth = admin.auth) =>
    request(http()).post(`${API}/collections/bookings/${bookingId}`).set(auth).send({ method: 'NETWORK', amount: 10, idempotencyKey: key(), ...body });
  const openDrawer = (id = branchId, openingBalance = 100) => request(http()).post(`${API}/cash/branches/${id}/sessions`).set(admin.auth).send({ openingBalance }).expect(201);
  const drawer = async (id = branchId) => (await request(http()).get(`${API}/cash/branches/${id}/overview`).set(admin.auth).expect(200)).body.lines;
  const makeTrip = async (daysAhead = 2) => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const departureTime = new Date(Date.now() + daysAhead * DAY);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime, arrivalTime: new Date(departureTime.getTime() + 3600000) } });
    return trip.id as string;
  };
  const makeBooking = (options: { due?: number; total?: number; wallet?: number; status?: string; branch?: string | null; trip?: string; bookingStatus?: any } = {}) =>
    prisma.booking.create({
      data: {
        bookingReference: `DR-${key()}`,
        userId: adminUser.id,
        tripId: options.trip ?? tripId,
        branchId: options.branch === undefined ? branchId : options.branch,
        source: 'BRANCH',
        status: options.bookingStatus ?? 'CONFIRMED',
        totalPrice: options.total ?? options.due ?? 100,
        passengers: { create: [{ fullName: 'ناصر الحربي', phone: '+966544102231', seatNumber: '4' }] },
        payment: { create: { amount: options.due ?? 100, walletAmount: options.wallet ?? 0, status: options.status ?? 'PENDING' } },
      },
    });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-collect-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    adminUser = (await createStaff(prisma, 'ADMIN')) as any;
    admin = await loginStaff(app, adminUser.phone);
    branchId = (await prisma.branch.create({ data: { name: 'فرع الحدائق' } })).id;
    otherBranchId = (await prisma.branch.create({ data: { name: 'فرع العليا' } })).id;
    await prisma.rank.upsert({
      where: { id: 'test-collect-staff' },
      create: { id: 'test-collect-staff', name: 'test-collect-staff', role: 'STAFF', jobId: 'job-office', permissions: ['collections.view', 'collections.collect'] },
      update: {},
    });
    collectorUser = await createStaff(prisma, 'STAFF', nextPhone(), 'test-collect-staff');
    await prisma.user.update({ where: { id: collectorUser.id }, data: { branchId } });
    collector = await loginStaff(app, (collectorUser as any).phone);
    tripId = await makeTrip();
  });

  describe('access', () => {
    it('refuses anonymous callers, customers and staff without the permission', async () => {
      const customer = await loginPassenger(app);
      const plain = await createStaff(prisma, 'DRIVER');
      const driver = await loginStaff(app, plain.phone);
      const booking = await makeBooking();
      await request(http()).get(`${API}/collections`).expect(401);
      for (const who of [customer, driver]) {
        await request(http()).get(`${API}/collections`).set(who.auth).expect(403);
        await collect(booking.id, {}, who.auth).expect(403);
      }
    });

    it('confines an employee to their own branch for reading and collecting', async () => {
      const mine = await makeBooking();
      const theirs = await makeBooking({ branch: otherBranchId });
      const online = await makeBooking({ branch: null });

      const seen = await list('', collector.auth);
      expect(seen.items.map((row: { id: string }) => row.id)).toEqual([mine.id]);
      await request(http()).get(`${API}/collections?branchId=${otherBranchId}`).set(collector.auth).expect(403);
      await collect(theirs.id, {}, collector.auth).expect(403);
      await collect(online.id, {}, collector.auth).expect(403);
      await request(http()).patch(`${API}/collections/bookings/${theirs.id}/note`).set(collector.auth).send({ note: 'x' }).expect(403);
      await collect(mine.id, {}, collector.auth).expect(201);
    });

    it('cannot put cash in the drawer of another branch', async () => {
      await openDrawer(otherBranchId);
      const booking = await makeBooking();
      await collect(booking.id, { method: 'CASH', branchId: otherBranchId }, collector.auth).expect(403);
      expect((await drawer(otherBranchId)).receipts).toBe(0);
    });

    it('reads a real all-branch list only for all-branch holders, and filters by branch', async () => {
      await makeBooking();
      await makeBooking({ branch: otherBranchId });
      expect((await list()).items).toHaveLength(2);
      expect((await list(`?branchId=${otherBranchId}`)).items).toHaveLength(1);
    });
  });

  describe('collecting', () => {
    it('takes part payments across methods until the booking is paid', async () => {
      await openDrawer();
      const booking = await makeBooking({ due: 100 });
      await collect(booking.id, { method: 'CASH', amount: 40, branchId }).expect(201);
      let row = (await list()).items[0];
      expect(row).toMatchObject({ paid: 40, remaining: 60, hasPaidAnything: true });

      await collect(booking.id, { method: 'TRANSFER', amount: 60, reference: 'TR-77' }).expect(201);
      expect((await list()).items).toHaveLength(0);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(payment).toMatchObject({ status: 'COMPLETED', method: 'mixed' });
      await collect(booking.id, {}).expect(409);
      row = undefined;
    });

    it('puts only cash in the drawer', async () => {
      await openDrawer();
      const booking = await makeBooking({ due: 100 });
      await collect(booking.id, { method: 'NETWORK', amount: 30 }).expect(201);
      expect((await drawer()).expected).toBe(100);
      await collect(booking.id, { method: 'CASH', amount: 30, branchId }).expect(201);
      expect(await drawer()).toMatchObject({ receipts: 30, expected: 130 });
    });

    it('needs an open drawer for cash, and rolls everything back without one', async () => {
      const booking = await makeBooking();
      const refused = await collect(booking.id, { method: 'CASH', branchId }).expect(409);
      expect(refused.body.message).toContain('الصندوق');
      expect(await prisma.bookingCollection.count()).toBe(0);
      await prisma.cashSession.create({ data: { branchId, businessDate: new Date('2026-01-01T00:00:00Z'), openingBalance: 0, openedById: adminUser.id } });
      await collect(booking.id, { method: 'CASH', branchId }).expect(409);
      expect(await prisma.bookingCollection.count()).toBe(0);
    });

    it('refuses more than is owed, and racing requests cannot exceed it', async () => {
      const booking = await makeBooking({ due: 100 });
      const refused = await collect(booking.id, { amount: 100.01 }).expect(400);
      expect(refused.body.message).toContain('100');
      const results = await Promise.all(Array.from({ length: 5 }, () => collect(booking.id, { amount: 40 })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
      expect((await list()).items[0].remaining).toBe(20);
    });

    it('records a repeated submit of the same form once', async () => {
      await openDrawer();
      const booking = await makeBooking();
      const idempotencyKey = key();
      const body = { method: 'CASH', amount: 25, branchId, idempotencyKey };
      const first = await collect(booking.id, body).expect(201);
      const second = await collect(booking.id, body).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect((await drawer()).receipts).toBe(25);
    });

    it('refuses paid, cancelled and under-review bookings', async () => {
      const paid = await makeBooking({ status: 'SIMULATED' });
      const cancelled = await makeBooking({ bookingStatus: 'CANCELLED' });
      const review = await makeBooking({ bookingStatus: 'PENDING_CANCELLATION_REVIEW' });
      await collect(paid.id, {}).expect(409);
      await collect(cancelled.id, {}).expect(409);
      await collect(review.id, {}).expect(409);
      await collect('missing', {}).expect(404);
    });

    it('validates the form server-side', async () => {
      const booking = await makeBooking();
      await collect(booking.id, { method: 'CHEQUE' }).expect(400);
      await collect(booking.id, { amount: 0 }).expect(400);
      await collect(booking.id, { amount: -5 }).expect(400);
      await collect(booking.id, { amount: 1.234 }).expect(400);
      await collect(booking.id, { method: 'CASH' }).expect(400);
      await collect(booking.id, { method: 'TRANSFER' }).expect(400);
      await collect(booking.id, { status: 'COMPLETED' }).expect(400);
    });

    it('tells the customer, writes the booking history and the audit log', async () => {
      const booking = await makeBooking();
      await collect(booking.id, { amount: 30 }).expect(201);
      const message = await prisma.notification.findFirstOrThrow({ where: { userId: adminUser.id, event: 'PAYMENT_COLLECTED' } });
      expect(message.body).toContain('30 ر.س');
      expect(message.body).toContain('70 ر.س');
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: booking.id, action: 'PAYMENT_COLLECTED' } });
      expect(event.actorId).toBe(adminUser.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await prisma.auditLog.count({ where: { entity: 'Collections' } })).toBe(1);
    });

    it('rejects editing or deleting a collection at the database', async () => {
      const booking = await makeBooking();
      await collect(booking.id, { amount: 30 }).expect(201);
      await expect(prisma.bookingCollection.updateMany({ data: { amount: 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.bookingCollection.deleteMany()).rejects.toThrow(/append-only/);
    });

    it('saves a follow-up note without a payment, and clears it', async () => {
      const booking = await makeBooking();
      const save = (note: string) => request(http()).patch(`${API}/collections/bookings/${booking.id}/note`).set(admin.auth).send({ note }).expect(200);
      await save(' اتفق يدفع عند الصعود ');
      expect((await list()).items[0].followUpNote).toBe('اتفق يدفع عند الصعود');
      await save('');
      expect((await list()).items[0].followUpNote).toBeNull();
    });
  });

  describe('figures', () => {
    it('reproduces the 95.8% in the design', async () => {
      await makeBooking({ total: 8940, due: 8940, status: 'SIMULATED' });
      await makeBooking({ total: 390, due: 390 });
      expect((await list()).summary).toMatchObject({ remaining: 390, count: 1, collected: 8940, rate: 95.8 });
    });

    it('counts wallet money as paid, and tells unpaid from partly paid', async () => {
      const withWallet = await makeBooking({ total: 100, due: 60, wallet: 40 });
      const untouched = await makeBooking({ total: 50, due: 50 });
      const { items } = await list();
      expect(items.find((row: { id: string }) => row.id === withWallet.id)).toMatchObject({ price: 100, paid: 40, remaining: 60, hasPaidAnything: true });
      expect(items.find((row: { id: string }) => row.id === untouched.id)).toMatchObject({ paid: 0, remaining: 50, hasPaidAnything: false });
    });

    it('scopes to the period, sorts by departure, and points at the nearest trip', async () => {
      const later = await makeTrip(5);
      const beyond = await makeTrip(20);
      const past = await makeTrip(-3);
      const a = await makeBooking({ trip: later, due: 10 });
      const b = await makeBooking({ due: 20 });
      const c = await makeBooking({ due: 5 });
      await makeBooking({ trip: beyond, due: 40 });
      await makeBooking({ trip: past, due: 80 });

      const week = await list();
      expect(week.items.map((row: { id: string }) => row.id)).toEqual([b.id, c.id, a.id]);
      expect(week.summary.nearest).toMatchObject({ remaining: 25 });
      expect(week.summary.overdueCount).toBe(1);
      expect((await list('?period=overdue')).summary.remaining).toBe(80);
      expect((await list('?period=all')).items).toHaveLength(5);
      await request(http()).get(`${API}/collections?period=forever`).set(admin.auth).expect(400);
    });

    it('leaves cancelled bookings out of every figure', async () => {
      await makeBooking({ bookingStatus: 'CANCELLED', due: 500 });
      expect((await list()).summary).toMatchObject({ remaining: 0, count: 0, collected: 0, rate: null, nearest: null });
    });
  });

  describe('what partial payment must not break', () => {
    it('refunds on cancellation only what was really received', async () => {
      const cancellation = app.get(BookingCancellationService);
      const booking = await makeBooking({ due: 100, wallet: 20, total: 120 });
      await collect(booking.id, { amount: 30 }).expect(201);
      await expect(prisma.$transaction((tx) => cancellation.cancel(tx, booking.id, { refundAmount: 51 }))).rejects.toThrow(/50/);
      const cancelled = await prisma.$transaction((tx) => cancellation.cancel(tx, booking.id));
      expect(Number(cancelled.refundAmount)).toBe(50);
    });

    it('refunds nothing for a booking nobody paid', async () => {
      const cancellation = app.get(BookingCancellationService);
      const booking = await makeBooking({ due: 100 });
      const cancelled = await prisma.$transaction((tx) => cancellation.cancel(tx, booking.id));
      expect(Number(cancelled.refundAmount)).toBe(0);
    });

    it('splits the trip inventory by how the money really came in', async () => {
      await openDrawer();
      const manifests = app.get(ManifestsService);
      const booking = await makeBooking({ due: 100 });
      await makeBooking({ due: 70 });
      await collect(booking.id, { method: 'CASH', amount: 40, branchId }).expect(201);
      await collect(booking.id, { method: 'TRANSFER', amount: 30, reference: 'TR-1' }).expect(201);
      const { totals, rows } = await manifests.getInventory(tripId);
      expect(totals).toMatchObject({ cash: 40, transfer: 30, network: 0, income: 70 });
      expect((rows as any[]).find((row) => row.cash === 40)).toMatchObject({ transfer: 30, isPaid: false });
    });

    it('keeps retained money honest after a cash refund', async () => {
      await openDrawer();
      const manifests = app.get(ManifestsService);
      const cancellation = app.get(BookingCancellationService);
      const booking = await makeBooking({ due: 100 });
      await collect(booking.id, { method: 'CASH', amount: 100, branchId }).expect(201);
      await prisma.$transaction((tx) => cancellation.cancel(tx, booking.id, { refundAmount: 0 }));
      expect((await manifests.getInventory(tripId)).totals.retained).toBe(100);
    });

    it('does not count unpaid money as collected on the dashboard', async () => {
      const booking = await makeBooking({ due: 100 });
      await makeBooking({ due: 60, status: 'COMPLETED' });
      await collect(booking.id, { amount: 25 }).expect(201);
      const overview = (await request(http()).get(`${API}/dashboard/stats`).set(admin.auth).expect(200)).body;
      expect(overview.revenue.collected).toBe(85);
    });

    it('adds the weekly trend up to the collected figure, each amount in the week it arrived', async () => {
      const days = (count: number) => new Date(Date.now() - count * 24 * 60 * 60 * 1000);
      const trend = async (weeks = 26) => (await request(http()).get(`${API}/dashboard/trend`).query({ weeks }).set(admin.auth).expect(200)).body.weeks;
      const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + row[key], 0);
      const baseline = await trend();
      const collectedBefore = (await request(http()).get(`${API}/dashboard/stats`).set(admin.auth).expect(200)).body.revenue;

      // Created long ago, half collected this week: only the collection falls in this week.
      const partial = await makeBooking({ due: 100 });
      await prisma.booking.update({ where: { id: partial.id }, data: { createdAt: days(40) } });
      await prisma.payment.update({ where: { bookingId: partial.id }, data: { createdAt: days(40) } });
      await collect(partial.id, { amount: 30 }).expect(201);

      const before = baseline[baseline.length - 1];
      const after = await trend();
      expect(after[after.length - 1].revenue).toBeCloseTo(before.revenue + 30, 2);
      expect(sum(after, 'revenue')).toBeCloseTo(sum(baseline, 'revenue') + 30, 2);

      // Finished paying now: what was owed all along joins the week each part arrived.
      await collect(partial.id, { amount: 70 }).expect(201);
      const paid = await trend();
      expect(paid[paid.length - 1].revenue).toBeCloseTo(before.revenue + 100, 2);

      // A simulated payment is not money, and a cancelled booking no longer counts.
      await makeBooking({ due: 40, status: 'SIMULATED' });
      const cancelled = await makeBooking({ due: 55, status: 'COMPLETED' });
      await prisma.booking.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
      const last = await trend();
      expect(last[last.length - 1].revenue).toBeCloseTo(paid[paid.length - 1].revenue, 2);

      // Every week starts on a Sunday and the list ends with the current one.
      expect(last).toHaveLength(26);
      for (const week of last) expect(new Date(week.start).getUTCDay()).toBe(0);
      const stats = (await request(http()).get(`${API}/dashboard/stats`).set(admin.auth).expect(200)).body.revenue;
      expect(stats.collected - stats.simulated).toBeCloseTo(collectedBefore.collected - collectedBefore.simulated + 100, 2);
      expect(sum(last, 'revenue')).toBeCloseTo(sum(baseline, 'revenue') + 100, 2);
    });

    it('refuses a range the chart does not offer, and anyone without the dashboard permission', async () => {
      await request(http()).get(`${API}/dashboard/trend`).query({ weeks: 5000 }).set(admin.auth).expect(400);
      await request(http()).get(`${API}/dashboard/trend`).expect(401);
      await request(http()).get(`${API}/dashboard/trend`).set(collector.auth).expect(403);
    });
  });
});

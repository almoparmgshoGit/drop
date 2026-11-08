import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { openBoarding, API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Trips, bookings & tickets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) => {
    const res = await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201);
    return res.body;
  };
  const book = (user: any, body: any, key?: string) => {
    const req = request(http()).post(`${API}/bookings`).set(user.auth);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ paymentMethod: 'mada', ...body });
  };
  const legsFor = (trip: any, seats: string[]) => [{ tripId: trip.id, seats }];
  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ fullName: `مسافر ${i + 1}` }));
  const setWallet = (userId: string, balance: number) =>
    prisma.user.update({ where: { id: userId }, data: { walletBalance: balance } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    const staff = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, staff.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('booking flow', () => {
    it('books several passengers including single digit seats and issues one ticket each', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      const res = await book(user, { legs: legsFor(trip, ['1', '9', '10']), passengers: people(3) }).expect(201);

      const [booking] = res.body.bookings;
      expect(booking.passengers).toHaveLength(3);
      expect(booking.passengers.every((p: any) => p.ticket?.signedToken)).toBe(true);
      expect(Number(booking.totalPrice)).toBe(540);

      const refreshed = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(refreshed.body.availableSeats).toBe(46);
    });

    it('exposes every seat of a large bus', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      const map = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(user.auth).expect(200);
      expect(map.body.seats).toHaveLength(49);
      await book(user, { legs: legsFor(trip, ['49']), passengers: people(1) }).expect(201);
    });

    it('rejects double booking of the same seat', async () => {
      const trip = await createTrip();
      await book(await loginPassenger(app), { legs: legsFor(trip, ['5']), passengers: people(1) }).expect(201);
      await book(await loginPassenger(app), { legs: legsFor(trip, ['5']), passengers: people(1) }).expect(409);
    });

    it('sells a contested seat exactly once under concurrency', async () => {
      const trip = await createTrip();
      const users = await Promise.all(Array.from({ length: 6 }, () => loginPassenger(app)));
      const results = await Promise.all(users.map((u) => book(u, { legs: legsFor(trip, ['7']), passengers: people(1) })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const count = await prisma.booking.count({ where: { tripId: trip.id } });
      expect(count).toBe(1);
    });

    it('rejects draft, past and cancelled trips', async () => {
      const user = await loginPassenger(app);
      const draft = await createTrip({ tripStatus: 'DRAFT' });
      await book(user, { legs: legsFor(draft, ['1']), passengers: people(1) }).expect(400);

      const past = await createTrip();
      await prisma.trip.update({ where: { id: past.id }, data: { departureTime: new Date(Date.now() - 1000) } });
      await book(user, { legs: legsFor(past, ['1']), passengers: people(1) }).expect(400);

      const cancelled = await createTrip();
      await request(http()).post(`${API}/trips/${cancelled.id}/cancel`).set(admin.auth).send({}).expect(201);
      await book(user, { legs: legsFor(cancelled, ['1']), passengers: people(1) }).expect(400);
    });

    it('enforces the per-booking seat limit, passenger count and seat existence', async () => {
      const trip = await createTrip({ maxSeatsPerBooking: 2 });
      const user = await loginPassenger(app);
      await book(user, { legs: legsFor(trip, ['1', '2', '3']), passengers: people(3) }).expect(400);
      await book(user, { legs: legsFor(trip, ['1', '2']), passengers: people(1) }).expect(400);
      await book(user, { legs: legsFor(trip, ['1', '1']), passengers: people(2) }).expect(400);
      await book(user, { legs: legsFor(trip, ['500']), passengers: people(1) }).expect(409);
    });

    it('enforces the singles seating section on the server', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      await book(user, { legs: legsFor(trip, ['3']), passengers: people(1), category: 'SINGLES' }).expect(400);
      await book(user, { legs: legsFor(trip, ['26']), passengers: people(1), category: 'SINGLES' }).expect(201);
      await book(user, { legs: legsFor(trip, ['3']), passengers: people(1), category: 'FAMILY' }).expect(201);
    });

    it('stores the chosen boarding point and rejects one from another trip', async () => {
      const trip = await createTrip();
      const other = await createTrip();
      const user = await loginPassenger(app);
      const [point] = trip.boardingPoints;
      const res = await book(user, {
        legs: [{ tripId: trip.id, seats: ['1'], boardingPointId: point.id }],
        passengers: [{ fullName: 'مسافر', phone: '0551234567' }],
      }).expect(201);
      expect(res.body.bookings[0].boardingPointName).toBe(point.name);
      expect(res.body.bookings[0].passengers[0].phone).toBe('+966551234567');

      await book(user, {
        legs: [{ tripId: other.id, seats: ['1'], boardingPointId: point.id }],
        passengers: people(1),
      }).expect(400);
    });

    it('returns the same booking for a retried idempotency key, scoped per user', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      const other = await loginPassenger(app);
      const body = { legs: legsFor(trip, ['1']), passengers: people(1) };

      const first = await book(user, body, 'retry-key').expect(201);
      const retry = await book(user, body, 'retry-key').expect(201);
      expect(retry.body.bookings[0].id).toBe(first.body.bookings[0].id);

      const stranger = await book(other, { legs: legsFor(trip, ['2']), passengers: people(1) }, 'retry-key').expect(201);
      expect(stranger.body.bookings[0].id).not.toBe(first.body.bookings[0].id);
      expect(stranger.body.bookings[0].userId).toBe(other.user.id);
    });

    it('books a round trip as two linked bookings', async () => {
      const outbound = await createTrip({ price: 100 });
      const inbound = await createTrip({ price: 80, origin: 'مكة المكرمة', destination: 'ينبع' });
      const user = await loginPassenger(app);
      const res = await book(user, {
        legs: [
          { tripId: outbound.id, seats: ['1', '2'] },
          { tripId: inbound.id, seats: ['3', '4'] },
        ],
        passengers: people(2),
      }).expect(201);
      expect(res.body.bookings).toHaveLength(2);
      expect(res.body.bookings[0].groupReference).toBe(res.body.bookings[1].groupReference);
      const totals = res.body.bookings.map((b: any) => Number(b.totalPrice)).sort();
      expect(totals).toEqual([160, 200]);
    });
  });

  describe('seat holds', () => {
    it('blocks other users from a held seat until it expires', async () => {
      const trip = await createTrip();
      const holder = await loginPassenger(app);
      const other = await loginPassenger(app);

      await request(http()).post(`${API}/bookings/holds`).set(holder.auth).send({ tripId: trip.id, seats: ['4'] }).expect(201);
      await request(http()).post(`${API}/bookings/holds`).set(other.auth).send({ tripId: trip.id, seats: ['4'] }).expect(409);
      await book(other, { legs: legsFor(trip, ['4']), passengers: people(1) }).expect(409);

      const holderMap = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(holder.auth).expect(200);
      const otherMap = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(other.auth).expect(200);
      expect(holderMap.body.seats.find((s: any) => s.seatNumber === '4').status).toBe('mine');
      expect(otherMap.body.seats.find((s: any) => s.seatNumber === '4').status).toBe('held');

      await prisma.seat.updateMany({ where: { tripId: trip.id, seatNumber: '4' }, data: { heldUntil: new Date(Date.now() - 1000) } });
      await book(other, { legs: legsFor(trip, ['4']), passengers: people(1) }).expect(201);
    });

    it('lets the holder complete the booking and release on demand', async () => {
      const trip = await createTrip();
      const holder = await loginPassenger(app);
      await request(http()).post(`${API}/bookings/holds`).set(holder.auth).send({ tripId: trip.id, seats: ['6'] }).expect(201);
      await request(http()).delete(`${API}/bookings/holds`).set(holder.auth).send({ tripId: trip.id }).expect(200);
      const map = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(holder.auth).expect(200);
      expect(map.body.seats.find((s: any) => s.seatNumber === '6').status).toBe('available');
    });

    it('rolls back every seat when one of a group is unavailable', async () => {
      const trip = await createTrip();
      const first = await loginPassenger(app);
      const second = await loginPassenger(app);
      await request(http()).post(`${API}/bookings/holds`).set(first.auth).send({ tripId: trip.id, seats: ['2'] }).expect(201);
      await request(http()).post(`${API}/bookings/holds`).set(second.auth).send({ tripId: trip.id, seats: ['1', '2'] }).expect(409);
      const map = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(first.auth).expect(200);
      expect(map.body.seats.find((s: any) => s.seatNumber === '1').status).toBe('available');
    });
  });

  describe('pricing', () => {
    it('ignores any price sent by the client', async () => {
      const trip = await createTrip({ price: 180 });
      const user = await loginPassenger(app);
      await book(user, { legs: legsFor(trip, ['1']), passengers: people(1), totalPrice: 1 }).expect(400);
      const res = await book(user, { legs: legsFor(trip, ['2']), passengers: people(1) }).expect(201);
      expect(Number(res.body.bookings[0].totalPrice)).toBe(180);
    });

    it('uses the package price when the trip belongs to one', async () => {
      const pkg = await request(http()).post(`${API}/packages`).set(admin.auth).send({ name: 'باقة', price: 720, status: 'PUBLISHED' }).expect(201);
      const trip = await createTrip({ price: 100, packageId: pkg.body.id });
      const user = await loginPassenger(app);
      const quote = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['1']) }).expect(201);
      expect(quote.body.total).toBe(720);
      const details = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(details.body.pricePerSeat).toBe(720);
    });

    it('debits the wallet for real, so it cannot be spent twice', async () => {
      const trip = await createTrip({ price: 180 });
      const user = await loginPassenger(app);
      await setWallet(user.user.id, 120);

      const quote = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['1']), useWallet: true }).expect(201);
      expect(quote.body).toMatchObject({ total: 180, walletUsed: 120, payable: 60 });

      await book(user, { legs: legsFor(trip, ['1']), passengers: people(1), useWallet: true }).expect(201);
      const second = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['2']), useWallet: true }).expect(201);
      expect(second.body).toMatchObject({ walletUsed: 0, payable: 180 });

      const history = await request(http()).get(`${API}/users/profile/wallet-transactions`).set(user.auth).expect(200);
      expect(history.body).toHaveLength(1);
      expect(Number(history.body[0].amount)).toBe(-120);
      expect(Number(history.body[0].balanceAfter)).toBe(0);
    });

    it('does not allow concurrent spending of the same wallet balance', async () => {
      const tripA = await createTrip({ price: 100 });
      const tripB = await createTrip({ price: 100 });
      const user = await loginPassenger(app);
      await setWallet(user.user.id, 100);
      await Promise.all([
        book(user, { legs: legsFor(tripA, ['1']), passengers: people(1), useWallet: true }),
        book(user, { legs: legsFor(tripB, ['1']), passengers: people(1), useWallet: true }),
      ]);
      const fresh = await prisma.user.findUnique({ where: { id: user.user.id } });
      expect(Number(fresh.walletBalance)).toBe(0);
      const spent = await prisma.payment.aggregate({ where: { booking: { userId: user.user.id } }, _sum: { walletAmount: true } });
      expect(Number(spent._sum.walletAmount)).toBe(100);
    });

    it('validates coupons on the server and enforces usage limits', async () => {
      await request(http()).post(`${API}/coupons`).set(admin.auth).send({ code: 'madinah10', type: 'FIXED_PER_SEAT', value: 10, maxUses: 1 }).expect(201);
      const trip = await createTrip({ price: 180 });
      const user = await loginPassenger(app);

      await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['1']), couponCode: 'NOPE' }).expect(400);
      const quote = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['1', '2']), couponCode: 'MADINAH10' }).expect(201);
      expect(quote.body).toMatchObject({ couponDiscount: 20, total: 340 });

      const res = await book(user, { legs: legsFor(trip, ['1', '2']), passengers: people(2), couponCode: 'madinah10' }).expect(201);
      expect(Number(res.body.bookings[0].discountAmount)).toBe(20);
      await book(user, { legs: legsFor(trip, ['3']), passengers: people(1), couponCode: 'MADINAH10' }).expect(400);
    });

    it('caps a coupon at the price and splits amounts across a round trip without losing a halala', async () => {
      await request(http()).post(`${API}/coupons`).set(admin.auth).send({ code: 'THIRD', type: 'PERCENT', value: 33.33 }).expect(201);
      await request(http()).post(`${API}/coupons`).set(admin.auth).send({ code: 'HUGE', type: 'FIXED_PER_SEAT', value: 99999 }).expect(201);
      const a = await createTrip({ price: 100.01 });
      const b = await createTrip({ price: 33.33 });
      const user = await loginPassenger(app);

      const huge = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(a, ['1']), couponCode: 'HUGE' }).expect(201);
      expect(huge.body.total).toBe(0);

      const res = await book(user, {
        legs: [{ tripId: a.id, seats: ['1'] }, { tripId: b.id, seats: ['1'] }],
        passengers: people(1),
        couponCode: 'THIRD',
      }).expect(201);
      const total = res.body.bookings.reduce((sum: number, x: any) => sum + Number(x.totalPrice) + Number(x.discountAmount), 0);
      expect(total).toBeCloseTo(133.34, 2);
    });

    it('calculates VAT as included in the price', async () => {
      const trip = await createTrip({ price: 115 });
      const user = await loginPassenger(app);
      const quote = await request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: legsFor(trip, ['1']) }).expect(201);
      expect(quote.body).toMatchObject({ total: 115, vatIncluded: 15, vatRate: 15 });
    });

    it('rejects trips without a real price instead of inventing one', async () => {
      const { price, ...withoutPrice } = tripPayload();
      await request(http()).post(`${API}/trips`).set(admin.auth).send(withoutPrice).expect(400);
      await request(http()).post(`${API}/trips`).set(admin.auth).send({ ...withoutPrice, price: 0 }).expect(400);
    });
  });

  describe('cancellation & refunds', () => {
    const bookOne = async (price = 180) => {
      const trip = await createTrip({ price });
      const user = await loginPassenger(app);
      const res = await book(user, { legs: legsFor(trip, ['8']), passengers: people(1) }).expect(201);
      return { trip, user, booking: res.body.bookings[0] };
    };

    it('runs request, approval, seat release and wallet refund end to end', async () => {
      const { trip, user, booking } = await bookOne();
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({ reason: 'ظرف طارئ' }).expect(201);

      const pending = await request(http()).get(`${API}/bookings/admin/all?status=PENDING_CANCELLATION_REVIEW`).set(admin.auth).expect(200);
      expect(pending.body.items.some((b: any) => b.id === booking.id)).toBe(true);

      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: true }).expect(201);

      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(Number(profile.body.walletBalance)).toBe(180);
      const map = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(user.auth).expect(200);
      expect(map.body.seats.find((s: any) => s.seatNumber === '8').status).toBe('available');
      expect(map.body.availableSeats).toBe(49);

      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({}).expect(400);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: true }).expect(409);
    });

    it('supports partial refunds and caps them at the amount paid', async () => {
      const { user, booking } = await bookOne(100);
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({}).expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: true, refundAmount: 500 }).expect(400);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: true, refundAmount: 40 }).expect(201);
      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(Number(profile.body.walletBalance)).toBe(40);
    });

    it('restores the booking when the request is rejected', async () => {
      const { user, booking } = await bookOne();
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({}).expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: false, note: 'مرفوض' }).expect(201);
      const fresh = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(fresh.body.status).toBe('CONFIRMED');
    });

    it('stops customers from cancelling other people\'s bookings', async () => {
      const { booking } = await bookOne();
      const stranger = await loginPassenger(app);
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(stranger.auth).send({}).expect(404);
    });

    it('refunds every booking when a trip is cancelled', async () => {
      const trip = await createTrip({ price: 90 });
      const a = await loginPassenger(app);
      const b = await loginPassenger(app);
      await book(a, { legs: legsFor(trip, ['1']), passengers: people(1) }).expect(201);
      await book(b, { legs: legsFor(trip, ['2']), passengers: people(1) }).expect(201);

      const res = await request(http()).post(`${API}/trips/${trip.id}/cancel`).set(admin.auth).send({}).expect(201);
      expect(res.body.cancelledBookings).toBe(2);
      const fresh = await prisma.user.findUnique({ where: { id: a.user.id } });
      expect(Number(fresh.walletBalance)).toBe(90);
    });
  });

  describe('privacy', () => {
    it('never leaks staff phones or password hashes from public trip endpoints', async () => {
      const supervisor = await createStaff(prisma, 'STAFF');
      const driver = await createStaff(prisma, 'DRIVER');
      const trip = await createTrip({ supervisorIds: [supervisor.id], driverIds: [driver.id] });

      const search = await request(http()).get(`${API}/trips/search`).expect(200);
      const details = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      for (const body of [search.body, details.body]) {
        const json = JSON.stringify(body);
        expect(json).not.toContain('passwordHash');
        expect(json).not.toContain(driver.phone);
        expect(json).not.toContain(supervisor.phone);
      }
    });

    it('hides drafts and departed trips from the public, ignoring a status override', async () => {
      const draft = await createTrip({ tripStatus: 'DRAFT' });
      await request(http()).get(`${API}/trips/${draft.id}`).expect(404);
      const res = await request(http()).get(`${API}/trips/search`).query({ status: 'DRAFT' });
      expect(res.status).toBe(400);
      const search = await request(http()).get(`${API}/trips/search`).expect(200);
      expect(search.body.some((t: any) => t.id === draft.id)).toBe(false);
    });

    it('keeps bookings and tickets private to their owner', async () => {
      const trip = await createTrip();
      const owner = await loginPassenger(app);
      const stranger = await loginPassenger(app);
      const res = await book(owner, { legs: legsFor(trip, ['1']), passengers: people(1) }).expect(201);
      const id = res.body.bookings[0].id;

      await request(http()).get(`${API}/bookings/${id}`).set(stranger.auth).expect(403);
      await request(http()).get(`${API}/tickets/booking/${id}`).set(stranger.auth).expect(403);
      await request(http()).get(`${API}/tickets/booking/${id}`).set(owner.auth).expect(200);

      const adminView = await request(http()).get(`${API}/bookings/${id}`).set(admin.auth).expect(200);
      expect(JSON.stringify(adminView.body)).not.toContain('passwordHash');
    });
  });

  describe('search dates', () => {
    it('groups trips by the calendar day in Riyadh', async () => {
      const lateNight = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
      lateNight.setUTCHours(22, 0, 0, 0); // 01:00 the next day in Riyadh
      const trip = await createTrip({ departureTime: lateNight.toISOString(), arrivalTime: new Date(lateNight.getTime() + 3600000).toISOString(), origin: 'جازان', destination: 'تبوك' });

      const riyadh = new Date(lateNight.getTime() + 3 * 60 * 60 * 1000);
      const dayStr = `${riyadh.getUTCFullYear()}-${riyadh.getUTCMonth() + 1}-${riyadh.getUTCDate()}`;
      const hit = await request(http()).get(`${API}/trips/search`).query({ origin: 'جازان', date: dayStr }).expect(200);
      expect(hit.body.map((t: any) => t.id)).toContain(trip.id);

      const utcDay = `${lateNight.getUTCFullYear()}-${lateNight.getUTCMonth() + 1}-${lateNight.getUTCDate()}`;
      const miss = await request(http()).get(`${API}/trips/search`).query({ origin: 'جازان', date: utcDay }).expect(200);
      expect(miss.body.map((t: any) => t.id)).not.toContain(trip.id);
    });

    it('rejects malformed dates', async () => {
      await request(http()).get(`${API}/trips/search`).query({ date: '2026-13-45' }).expect(400);
    });
  });

  describe('trip administration', () => {
    it('prevents assigning a bus or crew member to overlapping trips', async () => {
      const bus = await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'AAA-1', model: 'Visero' }).expect(201);
      const driver = await createStaff(prisma, 'DRIVER');
      const base = tripPayload({ busId: bus.body.id, driverIds: [driver.id] });
      const created = await request(http()).post(`${API}/trips`).set(admin.auth).send(base).expect(201);
      expect(created.body.totalSeats).toBe(49);

      const clashBus = tripPayload({ departureTime: base.departureTime, arrivalTime: base.arrivalTime, busId: bus.body.id });
      await request(http()).post(`${API}/trips`).set(admin.auth).send(clashBus).expect(409);
      const clashDriver = tripPayload({ departureTime: base.departureTime, arrivalTime: base.arrivalTime, driverIds: [driver.id] });
      await request(http()).post(`${API}/trips`).set(admin.auth).send(clashDriver).expect(409);
    });

    it('refuses buses under maintenance and crew without a staff role', async () => {
      const bus = await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'BBB-2', model: 'Visero', status: 'MAINTENANCE' }).expect(201);
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ busId: bus.body.id })).expect(409);
      const passenger = await loginPassenger(app);
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ driverIds: [passenger.user.id] })).expect(400);
    });

    it('validates input instead of failing with a server error', async () => {
      await request(http()).post(`${API}/trips`).set(admin.auth).send({ tripCode: 'X1' }).expect(400);
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ departureTime: 'not-a-date' })).expect(400);
      await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'CCC-3' }).expect(400);
      await request(http()).put(`${API}/buses/nope`).set(admin.auth).send({ trips: { deleteMany: {} } }).expect(400);
      const past = new Date(Date.now() - 86400000).toISOString();
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ departureTime: past, arrivalTime: new Date().toISOString() })).expect(400);
    });
  });

  describe('boarding', () => {
    const scenario = async () => {
      const crew = await createStaff(prisma, 'DRIVER');
      const trip = await createTrip({ driverIds: [crew.id] });
      const user = await loginPassenger(app);
      const res = await book(user, { legs: legsFor(trip, ['1', '2']), passengers: people(2) }).expect(201);
      const session = await loginStaff(app, crew.phone);
      await openBoarding(prisma, trip.id);
      return { trip, session, booking: res.body.bookings[0], user };
    };
    const verify = (session: any, signedToken: string, tripId: string) =>
      request(http()).post(`${API}/tickets/verify`).set(session.auth).send({ signedToken, tripId });

    it('boards each passenger once and completes the booking after the last one', async () => {
      const { trip, session, booking, user } = await scenario();
      const [first, second] = booking.passengers.map((p: any) => p.ticket.signedToken);

      const ok = await verify(session, first, trip.id).expect(201);
      expect(ok.body.result).toBe('BOARDED');
      expect(ok.body.ticket.passengerName).toBe('مسافر 1');

      const again = await verify(session, first, trip.id).expect(201);
      expect(again.body.result).toBe('ALREADY_USED');

      const partial = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(partial.body.status).toBe('CONFIRMED');

      await verify(session, second, trip.id).expect(201);
      const complete = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(complete.body.status).toBe('BOARDED');
    });

    it('stays valid for trips booked far in advance', async () => {
      const crew = await createStaff(prisma, 'DRIVER');
      const far = Date.now() + 60 * 24 * 60 * 60 * 1000;
      const trip = await createTrip({
        driverIds: [crew.id],
        departureTime: new Date(far).toISOString(),
        arrivalTime: new Date(far + 3600000).toISOString(),
      });
      const user = await loginPassenger(app);
      const res = await book(user, { legs: legsFor(trip, ['1']), passengers: people(1) }).expect(201);
      const session = await loginStaff(app, crew.phone);
      await openBoarding(prisma, trip.id);
      const result = await verify(session, res.body.bookings[0].passengers[0].ticket.signedToken, trip.id).expect(201);
      expect(result.body.result).toBe('BOARDED');
    });

    it('flags tickets for another trip, forged tokens and cancelled bookings', async () => {
      const { trip, session, booking, user } = await scenario();
      const crewTrip = await prisma.tripDriver.findFirst({ where: { tripId: trip.id } });
      const secondTrip = await createTrip({ driverIds: [crewTrip.userId] });
      const token = booking.passengers[0].ticket.signedToken;

      const wrong = await verify(session, token, secondTrip.id).expect(201);
      expect(wrong.body.result).toBe('WRONG_TRIP');

      const [prefix, body] = token.split('.');
      const forged = await verify(session, `${prefix}.${body}.AAAA`, trip.id).expect(201);
      expect(forged.body.result).toBe('INVALID');
      const garbage = await verify(session, 'not-a-token', trip.id).expect(201);
      expect(garbage.body.result).toBe('INVALID');

      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({}).expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: true }).expect(201);
      const cancelled = await verify(session, token, trip.id).expect(201);
      expect(cancelled.body.result).toBe('CANCELLED');
    });

    it('limits scanning and manifests to crew assigned to the trip', async () => {
      const { trip, booking } = await scenario();
      const outsider = await createStaff(prisma, 'DRIVER');
      const session = await loginStaff(app, outsider.phone);
      await verify(session, booking.passengers[0].ticket.signedToken, trip.id).expect(403);
      await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(403);
    });

    it('shows the manifest and supports manual boarding', async () => {
      const { trip, session, booking } = await scenario();
      const manifest = await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(200);
      expect(manifest.body).toMatchObject({ total: 2, boarded: 0 });

      const ticketNumber = booking.passengers[0].ticket.ticketNumber;
      const boarded = await request(http()).post(`${API}/tickets/${ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
      expect(boarded.body.result).toBe('BOARDED');
      const after = await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(200);
      expect(after.body.boarded).toBe(1);

      const assigned = await request(http()).get(`${API}/tickets/my-trips`).set(session.auth).expect(200);
      expect(assigned.body.map((t: any) => t.id)).toContain(trip.id);
    });
  });

  describe('dashboard', () => {
    it('reports live numbers', async () => {
      const stats = await request(http()).get(`${API}/dashboard/stats`).set(admin.auth).expect(200);
      expect(stats.body.bookings.total).toBe(await prisma.booking.count());
      expect(stats.body.registeredUsers.total).toBe(await prisma.user.count({ where: { role: 'PASSENGER' } }));
      expect(stats.body.bookingTypes.reduce((sum: number, row: any) => sum + row.count, 0)).toBeGreaterThan(0);
    });
  });
});

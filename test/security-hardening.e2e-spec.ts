import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Security hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let rankCounter = 0;

  const rankedStaff = async (permissions: string[]) => {
    const job = await prisma.jobType.findFirstOrThrow();
    const rank = await prisma.rank.create({ data: { id: `test-sec-${++rankCounter}`, name: `رتبة اختبار ${rankCounter}`, role: 'STAFF', jobId: job.id, permissions } });
    const user = await createStaff(prisma, 'STAFF', undefined, rank.id);
    return { user, ...(await loginStaff(app, user.phone)) };
  };
  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const bookReq = (user: any, tripId: string, seats = ['5'], extra = {}) =>
    request(http()).post(`${API}/bookings`).set(user.auth).send({ paymentMethod: 'mada', legs: [{ tripId, seats }], passengers: seats.map((seat) => ({ fullName: `مسافر ${seat}` })), ...extra });
  const book = async (user: any, tripId: string, seats = ['5']) => (await bookReq(user, tripId, seats).expect(201)).body.bookings[0];
  const saveRules = (cancellationRules: object[]) => request(http()).put(`${API}/settings`).set(admin.auth).send({ cancellationRules }).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-sec-' } } });
    await app.close();
  });

  describe('phone code guessing', () => {
    it('keeps counting wrong codes across new codes, then refuses even the right one', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ otpMaxFailuresPerDay: 5, otpResendCooldownSeconds: 10 }).expect(200);
      const phone = '+966512345601';
      const redis = (app as any).get(require('../src/common/services/redis.service').RedisService);
      const send = async () => {
        await redis.del(`otp_cooldown:${phone}`);
        return (await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(201)).body.devCode;
      };
      const wrong = (code: string) => (code === '1000' ? '1001' : '1000');
      await redis.del(`otp_failures:${phone}`);

      const first = await send();
      for (let attempt = 0; attempt < 3; attempt++) await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: wrong(first) }).expect(400);
      const second = await send();
      for (let attempt = 0; attempt < 2; attempt++) await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: wrong(second) }).expect(400);
      const third = await send();
      await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: third }).expect(429);
      await redis.del(`otp_failures:${phone}`);
    });
  });

  describe('staff sign-in', () => {
    it('does not let failures from one address lock the employee out of another', async () => {
      const staff = await createStaff(prisma, 'STAFF');
      for (let attempt = 0; attempt < 5; attempt++) {
        await request(http()).post(`${API}/auth/login`).send({ phone: staff.phone, password: 'not-the-right-one' }).expect(401);
      }
      await request(http()).post(`${API}/auth/login`).send({ phone: staff.phone, password: 'correct-horse-battery' }).expect(429);
      const redis = (app as any).get(require('../src/common/services/redis.service').RedisService);
      expect(Number(await redis.get(`login_failures_total:${staff.id}`))).toBe(5);
      // Another address starts with its own count, which clearing this one's stands in for: the account-wide total alone does not lock yet.
      for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await redis.del(`login_failures:${staff.id}:${ip}`);
      await request(http()).post(`${API}/auth/login`).send({ phone: staff.phone, password: 'correct-horse-battery' }).expect(201);
    });
  });

  describe('session refresh', () => {
    it('lets only one of two simultaneous uses of a token win, and ends the session', async () => {
      const user = await loginPassenger(app);
      const results = await Promise.all([1, 2].map(() => request(http()).post(`${API}/auth/refresh`).send({ refreshToken: user.refreshToken })));
      expect(results.map((res) => res.status).sort()).toEqual([201, 403]);
      const winner = results.find((res) => res.status === 201)!;
      await request(http()).post(`${API}/auth/refresh`).send({ refreshToken: winner.body.refreshToken }).expect(403);
    });
  });

  describe('wallet and points', () => {
    it('stops an employee crediting themselves unless the rank allows it', async () => {
      const staff = await rankedStaff(['wallet.adjust']);
      const url = `${API}/users/${staff.user.id}/wallet`;
      await request(http()).put(url).set(staff.auth).send({ amount: 100, description: 'لنفسي' }).expect(403);
      await request(http()).put(`${url}/reset`).set(admin.auth).expect(200);

      const allowed = await rankedStaff(['wallet.adjust', 'wallet.adjust_self']);
      await request(http()).put(`${API}/users/${allowed.user.id}/wallet`).set(allowed.auth).send({ amount: 100, description: 'مسموح' }).expect(200);
    });

    it('holds an employee to the daily limit across customers, including under simultaneous requests', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ walletAdjustDailyLimit: 100 }).expect(200);
      const staff = await rankedStaff(['wallet.adjust']);
      const customer = await loginPassenger(app);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(http()).put(`${API}/users/${customer.user.id}/wallet`).set(staff.auth).send({ amount: 40, description: 'دفعة' })),
      );
      expect(results.filter((res) => res.status === 200)).toHaveLength(2);
      expect(results.filter((res) => res.status === 403)).toHaveLength(2);

      const unlimited = await rankedStaff(['wallet.adjust', 'wallet.adjust_unlimited']);
      await request(http()).put(`${API}/users/${customer.user.id}/wallet`).set(unlimited.auth).send({ amount: 5000, description: 'تعويض' }).expect(200);
    });

    it('applies the same rules to points', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ loyaltyAdjustDailyLimit: 100 }).expect(200);
      const staff = await rankedStaff(['loyalty.adjust']);
      const customer = await loginPassenger(app);
      const url = (id: string) => `${API}/loyalty/customers/${id}/adjust`;
      await request(http()).post(url(staff.user.id)).set(staff.auth).send({ points: 10, reason: 'لنفسي' }).expect(403);
      await request(http()).post(url(customer.user.id)).set(staff.auth).send({ points: 80, reason: 'تعويض' }).expect(201);
      await request(http()).post(url(customer.user.id)).set(staff.auth).send({ points: -30, reason: 'تصحيح' }).expect(403);
    });
  });

  describe('refunds', () => {
    it('holds a cancellation to the policy unless the rank may go above it', async () => {
      await saveRules([{ minDays: 0, percent: 50 }]);
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const staff = await rankedStaff(['bookings.cancel']);

      const first = await book(customer, trip.id, ['5']);
      await request(http()).post(`${API}/bookings/${first.id}/admin-cancel`).set(staff.auth).send({ note: 'قرار', refundAmount: 180 }).expect(403);
      await request(http()).post(`${API}/bookings/${first.id}/admin-cancel`).set(staff.auth).send({ note: 'قرار' }).expect(201);
      expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: customer.user.id } })).walletBalance)).toBe(90);

      const second = await book(customer, trip.id, ['6']);
      const senior = await rankedStaff(['bookings.cancel', 'refunds.override_policy']);
      await request(http()).post(`${API}/bookings/${second.id}/admin-cancel`).set(senior.auth).send({ note: 'قرار', refundAmount: 180 }).expect(201);
    });

    it('gives nothing by default once the trip has left', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 3_600_000), arrivalTime: new Date(Date.now() + 3_600_000) } });
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'لم يحضر' }).expect(201);
      expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: customer.user.id } })).walletBalance)).toBe(0);
    });

    it('with no policy saved, leaves the refund to those who can approve refunds', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      const staff = await rankedStaff(['bookings.cancel']);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(staff.auth).send({ note: 'قرار' }).expect(403);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(staff.auth).send({ note: 'قرار', refundAmount: 0 }).expect(201);
    });
  });

  describe('data exposure', () => {
    it('keeps staff-only booking fields away from the customer', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      await prisma.payment.update({ where: { bookingId: booking.id }, data: { followUpNote: 'يرفض الدفع', gatewayReference: 'GW-1' } });
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'سبب داخلي' }).expect(201);

      for (const body of [
        (await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200)).body,
        (await request(http()).get(`${API}/bookings`).set(customer.auth).expect(200)).body[0],
      ]) {
        expect(JSON.stringify(body)).not.toContain('يرفض الدفع');
        expect(JSON.stringify(body)).not.toContain('GW-1');
        expect(JSON.stringify(body)).not.toContain('سبب داخلي');
        expect(body.cancelReviewedById).toBeUndefined();
      }
    });

    it('shows the customer the note written for them when a request is rejected', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(customer.auth).send({}).expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(admin.auth).send({ approve: false, note: 'انتهت المدة' }).expect(201);
      expect((await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200)).body.cancelReviewNote).toBe('انتهت المدة');
    });

    it('never gives staff a boarding token or the trip costs through a customer profile', async () => {
      const trip = await createTrip({ busRentalPrice: 7777 });
      const customer = await loginPassenger(app);
      await book(customer, trip.id);
      const staff = await rankedStaff(['customers.view']);
      const res = await request(http()).get(`${API}/users/${customer.user.id}`).set(staff.auth).expect(200);
      expect(res.body.bookings[0].trip.origin).toBe(trip.origin);
      expect(res.body.bookings[0].tickets[0].ticketNumber).toBeTruthy();
      expect(res.body.bookings[0].tickets[0].signedToken).toBeUndefined();
      expect(res.body.bookings[0].trip.busRentalPrice).toBeUndefined();
    });

    it('shows trip rent only to those who manage trips or see rates', async () => {
      const trip = await createTrip({ busRentalPrice: 7777 });
      const rentOf = async (auth: any) => (await request(http()).get(`${API}/trips/admin/all`).set(auth).expect(200)).body.find((row: any) => row.id === trip.id).busRentalPrice;
      expect(await rentOf((await rankedStaff(['loyalty.view'])).auth)).toBeUndefined();
      expect(Number(await rentOf((await rankedStaff(['buses.rates', 'trips.view'])).auth))).toBe(7777);
      expect(Number(await rentOf((await rankedStaff(['trips.manage'])).auth))).toBe(7777);
    });
  });

  describe('selling seats', () => {
    it('does not let one customer spend a per-customer coupon twice at once', async () => {
      await prisma.coupon.create({ data: { code: 'ONCE', type: 'FIXED_PER_SEAT', value: 10, isActive: true, perUserLimit: 1 } as any });
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const results = await Promise.all(['5', '6', '7'].map((seat) => bookReq(customer, trip.id, [seat], { couponCode: 'ONCE' })));
      expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    });

    it('never confirms a booking racing with the trip being cancelled', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const [booking] = await Promise.all([bookReq(customer, trip.id), request(http()).post(`${API}/trips/${trip.id}/cancel`).set(admin.auth).send({ reason: 'تعطل' })]);
      if (booking.status === 201) {
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.body.bookings[0].id } })).status).toBe('CANCELLED');
      }
      expect(await prisma.booking.count({ where: { tripId: trip.id, status: 'CONFIRMED' } })).toBe(0);
    });

    it('keeps a seat from being sold on both a round trip and its reverse', async () => {
      const departure = Date.now() + 5 * 86_400_000;
      const trip = await createTrip({
        direction: 'ROUND_TRIP',
        maxSeatsPerBooking: 4,
        reverseEnabled: true,
        reverseOpenPercent: 2,
        reverseDepartureAt: new Date(departure + 8 * 3_600_000).toISOString(),
        reversePrice: 90,
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 3_600_000).toISOString(),
      });
      const customer = await loginPassenger(app);
      await book(customer, trip.id, ['1']);
      const reverse = (await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send({ boardingPointName: 'مكة' }).expect(201)).body;
      expect(reverse.availableSeats).toBe(48);

      const outbound = await book(customer, trip.id, ['2']);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).availableSeats).toBe(47);
      await bookReq(customer, reverse.id, ['2']).expect(409);

      const onReverse = await book(customer, reverse.id, ['3']);
      await bookReq(customer, trip.id, ['3']).expect(409);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).availableSeats).toBe(46);

      await request(http()).post(`${API}/bookings/${outbound.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).availableSeats).toBe(47);
      await book(customer, reverse.id, ['2']);

      await request(http()).post(`${API}/bookings/${onReverse.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
      expect(await prisma.seat.findFirstOrThrow({ where: { tripId: trip.id, seatNumber: '3' } })).toMatchObject({ isBooked: false });
    });

    it('splits the wallet so no leg of a round trip is charged below zero', async () => {
      const [outbound, back] = [await createTrip({ price: 33.33 }), await createTrip({ price: 66.67 })];
      const customer = await loginPassenger(app);
      await request(http()).put(`${API}/users/${customer.user.id}/wallet`).set(admin.auth).send({ amount: 1000, description: 'رصيد' }).expect(200);
      const res = await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ useWallet: true, legs: [{ tripId: outbound.id, seats: ['5'] }, { tripId: back.id, seats: ['5'] }], passengers: [{ fullName: 'مسافر واحد' }] })
        .expect(201);
      for (const booking of res.body.bookings) expect(Number(booking.payment.amount)).toBe(0);
    });
  });

  describe('boarding', () => {
    it('refuses a booking that has not been paid', async () => {
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      const crew = await createStaff(prisma, 'STAFF');
      await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: crew.id, isPrimary: true } });
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 7_200_000), crewOpensBeforeMinutes: 1440, boardingOpensBeforeMinutes: 1440 } });
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING' } });
      const session = await loginStaff(app, crew.phone);
      const res = await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
      expect(res.body.result).toBe('NOT_PAID');
    });
  });

  describe('cash refunds', () => {
    it('keeps another branch out of moving a cash refund to the wallet', async () => {
      const branch = await prisma.branch.create({ data: { name: 'فرع أ' } as any });
      const trip = await createTrip();
      const customer = await loginPassenger(app);
      const booking = await book(customer, trip.id);
      const refund = await prisma.paymentTransaction.create({ data: { type: 'REFUND', status: 'PENDING', bookingId: booking.id, amount: 10, method: 'cash', branchId: branch.id } as any });
      const outsider = await rankedStaff(['refunds.execute']);
      await request(http()).post(`${API}/cancellations/refunds/${refund.id}/move-to-wallet`).set(outsider.auth).send({ reason: 'تجربة' }).expect(403);
    });
  });
});

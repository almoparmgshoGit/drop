import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { openBoarding, API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Loyalty program (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let staff: any;

  const setProgram = (changes: object) => request(http()).put(`${API}/loyalty/program`).set(admin.auth).send(changes).expect(200);
  const summary = async (user: any) => (await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200)).body;
  const createTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const quote = (user: any, trip: any, seats: string[], extra = {}) =>
    request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: [{ tripId: trip.id, seats }], ...extra });
  const bookRaw = (user: any, trip: any, seats: string[], extra = {}) =>
    request(http())
      .post(`${API}/bookings`)
      .set(user.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })), ...extra });
  const book = async (user: any, trip: any, seats = ['5'], extra = {}) => (await bookRaw(user, trip, seats, extra).expect(201)).body.bookings[0];
  const givePoints = (user: any, points: number) =>
    prisma.user.update({ where: { phone: user.phone }, data: { loyaltyPoints: points, loyaltyActivityAt: new Date() } });
  const balance = async (user: any) => (await prisma.user.findUniqueOrThrow({ where: { phone: user.phone } })).loyaltyPoints;

  const completeTrip = async (trip: any, booking: any) => {
    const crew = await createStaff(prisma, 'STAFF');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: crew.id } });
    const session = await loginStaff(app, crew.phone);
    await openBoarding(prisma, trip.id);
    for (const passenger of booking.passengers) {
      await request(http()).post(`${API}/tickets/${passenger.ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
    }
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 7_200_000), arrivalTime: new Date(Date.now() - 3_600_000) } });
    await app.get(TripsService).completeFinishedTrips();
  };

  const rule = (body: object) => request(http()).post(`${API}/loyalty/rules`).set(admin.auth).send(body);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('administration', () => {
    it('lets only admins change anything, and hides the program from public settings', async () => {
      const user = await loginPassenger(app);
      for (const session of [user, staff]) {
        await request(http()).put(`${API}/loyalty/program`).set(session.auth).send({ pointsPerRiyal: 100 }).expect(403);
        await request(http()).post(`${API}/loyalty/rules`).set(session.auth).send({ name: 'ضعف', type: 'MULTIPLIER', value: 2 }).expect(403);
        await request(http()).post(`${API}/loyalty/vouchers`).set(session.auth).send({ name: 'قسيمة', pointsCost: 1, value: 1000 }).expect(403);
      }
      await request(http()).get(`${API}/loyalty/program`).set(user.auth).expect(403);
      await request(http()).get(`${API}/loyalty/program`).set(staff.auth).expect(200);
      await request(http()).get(`${API}/loyalty/report`).set(staff.auth).expect(403);

      await setProgram({ pointsPerRiyal: 3 });
      const settings = await request(http()).get(`${API}/settings`).expect(200);
      expect(JSON.stringify(settings.body)).not.toContain('pointsPerRiyal');
    });

    it('rejects settings and rules that make no sense', async () => {
      await request(http()).put(`${API}/loyalty/program`).set(admin.auth).send({ maxRedeemPercent: 150 }).expect(400);
      await request(http()).put(`${API}/loyalty/program`).set(admin.auth).send({ redeemPoints: 500, minRedeemPoints: 100 }).expect(400);
      await request(http()).put(`${API}/loyalty/program`).set(admin.auth).send({ tiers: { silverTrips: 20, goldTrips: 5 } }).expect(400);
      await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 0.5 }).expect(400);
      await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 2, startsAt: '2030-02-01', endsAt: '2030-01-01' }).expect(400);
      await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 2, weekdays: [9] }).expect(400);
    });

    it('adjusts by hand with a reason and never below zero', async () => {
      const user = await loginPassenger(app);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { phone: user.phone } });
      const url = `${API}/loyalty/customers/${id}/adjust`;
      await request(http()).post(url).set(staff.auth).send({ points: 100, reason: 'تعويض' }).expect(403);
      await request(http()).post(url).set(admin.auth).send({ points: 100 }).expect(400);
      await request(http()).post(url).set(admin.auth).send({ points: 100, reason: 'تعويض عن تأخير' }).expect(201);
      expect(await balance(user)).toBe(100);
      await request(http()).post(url).set(admin.auth).send({ points: -500, reason: 'تصحيح' }).expect(409);
      expect(await balance(user)).toBe(100);

      const ledger = await request(http()).get(`${API}/loyalty/customers/${id}/transactions`).set(staff.auth).expect(200);
      expect(ledger.body[0]).toMatchObject({ type: 'ADJUSTED', points: 100, description: 'تعويض عن تأخير', createdByName: 'ADMIN user' });
    });

    it('reports the outstanding liability', async () => {
      const user = await loginPassenger(app);
      await givePoints(user, 1000);
      const report = await request(http()).get(`${API}/loyalty/report`).set(admin.auth).expect(200);
      expect(report.body.outstandingPoints).toBe(1000);
      expect(report.body.outstandingValue).toBe(50);
    });
  });

  describe('redeeming at checkout', () => {
    it('prices the discount on the server and charges the points once', async () => {
      const trip = await createTrip({ price: 200 });
      const user = await loginPassenger(app);
      await givePoints(user, 1000);

      const q = await quote(user, trip, ['5'], { pointsToRedeem: 200 }).expect(201);
      expect(q.body.loyalty).toMatchObject({ pointsUsed: 200, discount: 10, balance: 1000, maxPoints: 1000 });
      expect(q.body.total).toBe(190);
      expect(await balance(user)).toBe(1000);

      const booking = await book(user, trip, ['5'], { pointsToRedeem: 200 });
      expect(Number(booking.totalPrice)).toBe(190);
      // 200 spent once; the 190 actually paid earns points of its own at payment.
      const earned = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { bookingId: booking.id, type: 'EARNED' } });
      expect(earned.points).toBeGreaterThan(0);
      expect(await balance(user)).toBe(800 + earned.points);
      expect(await prisma.loyaltyTransaction.count({ where: { bookingId: booking.id, type: 'REDEEMED' } })).toBe(1);
    });

    it('enforces balance, step, minimum and the percentage cap', async () => {
      const trip = await createTrip({ price: 100 });
      const user = await loginPassenger(app);
      await givePoints(user, 5000);
      await quote(user, trip, ['5'], { pointsToRedeem: 150 }).expect(400);
      await quote(user, trip, ['5'], { pointsToRedeem: 50 }).expect(400);
      await quote(user, trip, ['5'], { pointsToRedeem: 9000 }).expect(400);
      // 50% of 100 is 50 SAR, which is 1000 points at 100 points = 5 SAR.
      await quote(user, trip, ['5'], { pointsToRedeem: 1100 }).expect(400);
      const q = await quote(user, trip, ['5'], { pointsToRedeem: 1000 }).expect(201);
      expect(q.body.total).toBe(50);
      expect(q.body.loyalty.maxPoints).toBe(1000);
      await quote(user, trip, ['5'], { pointsToRedeem: -100 }).expect(400);
    });

    it('cannot spend the same points twice under simultaneous bookings', async () => {
      const trip = await createTrip({ price: 200 });
      const user = await loginPassenger(app);
      await givePoints(user, 200);
      const results = await Promise.all([bookRaw(user, trip, ['1'], { pointsToRedeem: 200 }), bookRaw(user, trip, ['2'], { pointsToRedeem: 200 })]);
      // A customer's bookings now run one at a time, so the second is refused when priced rather than when spending.
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      // The 200 points went once; what is left is only what the one paid booking earned.
      const earned = await prisma.loyaltyTransaction.aggregate({ where: { user: { phone: user.phone }, type: 'EARNED' }, _sum: { points: true } });
      expect(await balance(user)).toBe(earned._sum.points ?? 0);
      expect(await prisma.booking.count({ where: { tripId: trip.id } })).toBe(1);
    });

    it('splits points across a round trip without losing any', async () => {
      const out = await createTrip({ price: 100 });
      const back = await createTrip({ price: 300, origin: 'مكة المكرمة', destination: 'ينبع' });
      const user = await loginPassenger(app);
      await givePoints(user, 400);
      const res = await request(http())
        .post(`${API}/bookings`)
        .set(user.auth)
        .send({ paymentMethod: 'mada', pointsToRedeem: 400, legs: [{ tripId: out.id, seats: ['1'] }, { tripId: back.id, seats: ['1'] }], passengers: [{ fullName: 'مسافر' }] })
        .expect(201);
      const stored = await prisma.booking.findMany({ where: { groupReference: res.body.groupReference } });
      expect(stored.reduce((sum, b) => sum + b.pointsRedeemed, 0)).toBe(400);
      expect(stored.reduce((sum, b) => sum + Number(b.pointsDiscount), 0)).toBe(20);
    });

    it('returns the points on cancellation, once', async () => {
      const trip = await createTrip({ price: 200 });
      const user = await loginPassenger(app);
      await givePoints(user, 200);
      const booking = await book(user, trip, ['5'], { pointsToRedeem: 200 });
      const results = await Promise.all(
        Array.from({ length: 3 }, () => request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      // The 200 redeemed come back and the 190 earned at payment go, each once.
      expect(await balance(user)).toBe(200);
    });

    it('withdraws the points a cancelled booking earned, never below zero', async () => {
      const trip = await createTrip({ price: 100 });
      const user = await loginPassenger(app);
      const booking = await book(user, trip);
      expect(await balance(user)).toBe(100);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      expect(await balance(user)).toBe(0);

      // Points already spent elsewhere cannot be taken back: the withdrawal stops at the balance and says so.
      const other = await book(user, trip, ['6']);
      await givePoints(user, 30);
      await request(http()).post(`${API}/bookings/${other.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      expect(await balance(user)).toBe(0);
      const history = await summary(user);
      expect(history.transactions[0]).toMatchObject({ type: 'REFUNDED', points: -30 });
      expect(history.transactions[0].description).toContain('30 من 100');
    });

    it('is switched off with the program', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      await givePoints(user, 1000);
      await setProgram({ enabled: false });
      await quote(user, trip, ['5'], { pointsToRedeem: 100 }).expect(400);
      const q = await quote(user, trip, ['5']).expect(201);
      expect(q.body.loyalty.maxPoints).toBe(0);
      expect(q.body.loyalty.willEarn).toBe(0);
    });
  });

  describe('earning rules', () => {
    const paidPoints = async (overrides: object, seats = ['5']) => {
      const trip = await createTrip({ price: 100, ...overrides });
      const user = await loginPassenger(app);
      const booking = await book(user, trip, seats);
      await completeTrip(trip, booking);
      return { points: await balance(user), booking, user, trip };
    };

    it('earns on the amount actually paid, not on the discount', async () => {
      const trip = await createTrip({ price: 200 });
      const user = await loginPassenger(app);
      await givePoints(user, 200);
      const booking = await book(user, trip, ['5'], { pointsToRedeem: 200 });
      await completeTrip(trip, booking);
      expect(await balance(user)).toBe(190);
    });

    it('applies a weekday multiplier only on matching trips', async () => {
      const departure = new Date(Date.now() + 10 * 86_400_000);
      const weekday = new Date(departure.getTime() + 3 * 3_600_000).getUTCDay();
      const dates = { departureTime: departure.toISOString(), arrivalTime: new Date(departure.getTime() + 18_000_000).toISOString() };
      await rule({ name: 'ضعف منتصف الأسبوع', type: 'MULTIPLIER', value: 2, weekdays: [weekday] }).expect(201);
      expect((await paidPoints(dates)).points).toBe(200);
    });

    it('skips a multiplier on other weekdays and outside its dates', async () => {
      const departure = new Date(Date.now() + 10 * 86_400_000);
      const weekday = new Date(departure.getTime() + 3 * 3_600_000).getUTCDay();
      const dates = { departureTime: departure.toISOString(), arrivalTime: new Date(departure.getTime() + 18_000_000).toISOString() };
      await rule({ name: 'يوم آخر', type: 'MULTIPLIER', value: 2, weekdays: [(weekday + 1) % 7] }).expect(201);
      await rule({ name: 'منتهية', type: 'MULTIPLIER', value: 5, endsAt: '2020-01-01' }).expect(201);
      expect((await paidPoints(dates)).points).toBe(100);
    });

    it('does not stack multipliers, but adds early-booking percent and group bonus', async () => {
      await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 2 }).expect(201);
      await rule({ name: 'ثلاثة أضعاف', type: 'MULTIPLIER', value: 3 }).expect(201);
      await rule({ name: 'حجز مبكر', type: 'BONUS_PERCENT', value: 10, minDaysBefore: 2 }).expect(201);
      await rule({ name: 'مجموعة', type: 'BONUS_POINTS', value: 100, minSeats: 4 }).expect(201);
      // 100 SAR × 3 × 1.1; the group bonus needs four seats.
      expect((await paidPoints({})).points).toBe(330);
    });

    it('gives the group bonus from the seat count', async () => {
      await rule({ name: 'مجموعة', type: 'BONUS_POINTS', value: 100, minSeats: 2 }).expect(201);
      expect((await paidPoints({}, ['1', '2'])).points).toBe(300);
    });

    it('keeps the terms a booking was made under, even if the rule changes later', async () => {
      const created = await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 2 }).expect(201);
      const trip = await createTrip({ price: 100 });
      const user = await loginPassenger(app);
      const booking = await book(user, trip);
      await request(http()).delete(`${API}/loyalty/rules/${created.body.id}`).set(admin.auth).expect(200);
      await setProgram({ pointsPerRiyal: 0.5 });
      await completeTrip(trip, booking);
      expect(await balance(user)).toBe(200);
    });

    it('previews exactly what the booking will earn, credited at payment and not again after the trip', async () => {
      await rule({ name: 'ضعف', type: 'MULTIPLIER', value: 2 }).expect(201);
      const trip = await createTrip({ price: 150 });
      const user = await loginPassenger(app);
      const q = await quote(user, trip, ['5']).expect(201);
      const booking = await book(user, trip);
      expect(await balance(user)).toBe(q.body.loyalty.willEarn);
      await completeTrip(trip, booking);
      await app.get(TripsService).completeFinishedTrips();
      expect(await balance(user)).toBe(q.body.loyalty.willEarn);
      expect((await summary(user)).transactions.filter((tx: any) => tx.type === 'EARNED')).toHaveLength(1);
    });
  });

  describe('expiry', () => {
    it('expires points after the inactivity period only', async () => {
      const stale = await loginPassenger(app);
      const fresh = await loginPassenger(app);
      await prisma.user.update({ where: { phone: stale.phone }, data: { loyaltyPoints: 500, loyaltyActivityAt: new Date('2020-01-01') } });
      await givePoints(fresh, 500);
      await app.get(TripsService).completeFinishedTrips();
      expect(await balance(stale)).toBe(0);
      expect(await balance(fresh)).toBe(500);
      const history = await summary(stale);
      expect(history.transactions[0]).toMatchObject({ type: 'EXPIRED', points: -500 });
      expect((await summary(fresh)).expiresAt).toBeTruthy();
    });

    it('never expires when the admin sets it to zero', async () => {
      await setProgram({ expiryMonths: 0 });
      const user = await loginPassenger(app);
      await prisma.user.update({ where: { phone: user.phone }, data: { loyaltyPoints: 500, loyaltyActivityAt: new Date('2020-01-01') } });
      await app.get(TripsService).completeFinishedTrips();
      expect(await balance(user)).toBe(500);
      expect((await summary(user)).expiresAt).toBeNull();
    });
  });

  describe('referrals', () => {
    it('stays off until the admin enables it', async () => {
      const user = await loginPassenger(app);
      expect((await summary(user)).referral).toBeNull();
      await request(http()).post(`${API}/users/profile/loyalty/referral`).set(user.auth).send({ code: 'DHABCDEF' }).expect(409);
    });

    it('rewards both sides only after the friend completes a trip, and only once', async () => {
      await setProgram({ referral: { enabled: true, rewardType: 'POINTS', referrerPoints: 200, refereePoints: 150 } });
      const inviter = await loginPassenger(app);
      const friend = await loginPassenger(app);
      const { code } = (await summary(inviter)).referral;
      await request(http()).post(`${API}/users/profile/loyalty/referral`).set(friend.auth).send({ code: code.toLowerCase() }).expect(201);
      expect(await balance(inviter)).toBe(0);

      const first = await createTrip({ price: 100 });
      const booking = await book(friend, first);
      // The booking's own points come with the payment; the invite rewards wait for the trip.
      expect(await balance(friend)).toBe(100);
      expect(await balance(inviter)).toBe(0);
      await completeTrip(first, booking);
      expect(await balance(inviter)).toBe(200);
      expect(await balance(friend)).toBe(100 + 150);

      const second = await createTrip({ price: 100 });
      await completeTrip(second, await book(friend, second));
      expect(await balance(inviter)).toBe(200);
    });

    it('pays invites in coupons without the points programme: the friend at once, the inviter after the friend completes a trip', async () => {
      await setProgram({ enabled: false, referral: { enabled: true, rewardType: 'COUPON', referrerCouponValue: 30, refereeCouponValue: 20, couponValidDays: 10, maxPerUser: 1 } });
      const inviter = await loginPassenger(app);
      const friend = await loginPassenger(app);
      const { code, rewardType } = (await summary(inviter)).referral;
      expect(rewardType).toBe('COUPON');
      const applied = await request(http()).post(`${API}/users/profile/loyalty/referral`).set(friend.auth).send({ code }).expect(201);
      expect(applied.body.coupon).toMatchObject({ value: 20 });
      expect((await summary(friend)).myVouchers).toEqual([expect.objectContaining({ code: applied.body.coupon.code, value: 20, isUsed: false })]);
      expect((await summary(inviter)).myVouchers).toHaveLength(0);

      const first = await createTrip({ price: 100 });
      await completeTrip(first, await book(friend, first));
      expect((await summary(inviter)).myVouchers).toEqual([expect.objectContaining({ value: 30, isUsed: false })]);
      expect((await summary(friend)).myVouchers).toHaveLength(1);
      expect(await balance(inviter)).toBe(0);

      // A second trip by the same friend, and a second friend past the cap, earn nothing more.
      const second = await createTrip({ price: 100 });
      await completeTrip(second, await book(friend, second));
      const other = await loginPassenger(app);
      await request(http()).post(`${API}/users/profile/loyalty/referral`).set(other.auth).send({ code }).expect(201);
      const third = await createTrip({ price: 100 });
      await completeTrip(third, await book(other, third));
      expect((await summary(inviter)).myVouchers).toHaveLength(1);
    });

    it('rejects own code, unknown code, a second code and existing customers', async () => {
      await setProgram({ referral: { enabled: true } });
      const inviter = await loginPassenger(app);
      const { code } = (await summary(inviter)).referral;
      const url = `${API}/users/profile/loyalty/referral`;
      await request(http()).post(url).set(inviter.auth).send({ code }).expect(400);
      await request(http()).post(url).set(inviter.auth).send({ code: 'DHNOPE00' }).expect(400);

      const friend = await loginPassenger(app);
      await request(http()).post(url).set(friend.auth).send({ code }).expect(201);
      await request(http()).post(url).set(friend.auth).send({ code }).expect(409);

      const veteran = await loginPassenger(app);
      await book(veteran, await createTrip());
      await request(http()).post(url).set(veteran.auth).send({ code }).expect(409);
    });

    it('stops rewarding the inviter at the admin cap', async () => {
      await setProgram({ pointsPerRiyal: 0.01, referral: { enabled: true, rewardType: 'POINTS', referrerPoints: 200, refereePoints: 0, maxPerUser: 1 } });
      const inviter = await loginPassenger(app);
      const { code } = (await summary(inviter)).referral;
      for (let i = 0; i < 2; i++) {
        const friend = await loginPassenger(app);
        await request(http()).post(`${API}/users/profile/loyalty/referral`).set(friend.auth).send({ code }).expect(201);
        const trip = await createTrip();
        await completeTrip(trip, await book(friend, trip));
      }
      expect(await balance(inviter)).toBe(200);
    });
  });

  describe('tiers and challenge', () => {
    it('raises the earning rate once the customer reaches a tier', async () => {
      await setProgram({ tiers: { enabled: true, silverTrips: 1, silverMultiplier: 2, goldTrips: 5 } });
      const user = await loginPassenger(app);
      expect((await summary(user)).tier).toMatchObject({ key: 'BRONZE', nextName: 'فضي', tripsToNext: 1 });

      const first = await createTrip({ price: 100 });
      await completeTrip(first, await book(user, first));
      expect(await balance(user)).toBe(100);
      expect((await summary(user)).tier.key).toBe('SILVER');

      const second = await createTrip({ price: 100 });
      await completeTrip(second, await book(user, second));
      expect(await balance(user)).toBe(300);
    });

    it('pays the challenge bonus once a year at the target', async () => {
      await setProgram({ challenge: { enabled: true, trips: 2, points: 500 } });
      const user = await loginPassenger(app);
      for (let i = 0; i < 3; i++) {
        const trip = await createTrip({ price: 100 });
        await completeTrip(trip, await book(user, trip));
      }
      expect(await balance(user)).toBe(300 + 500);
      expect((await summary(user)).challenge).toMatchObject({ target: 2, done: 3 });
    });
  });

  describe('top-up vouchers', () => {
    const createVoucher = async (body = {}) =>
      (await request(http()).post(`${API}/loyalty/vouchers`).set(admin.auth).send({ name: 'شحن 100', pointsCost: 500, price: 95, value: 100, bonusPoints: 50, ...body }).expect(201)).body;
    const purchase = (user: any, id: string, body: object) => request(http()).post(`${API}/vouchers/${id}/purchase`).set(user.auth).send(body);
    const redeemCode = (user: any, code: string) => request(http()).post(`${API}/vouchers/redeem`).set(user.auth).send({ code });
    const walletOf = async (user: any) => {
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.user.id }, select: { walletBalance: true, walletTransportBalance: true } });
      return { total: Number(row.walletBalance), transport: Number(row.walletTransportBalance) };
    };

    it('sells cards for points, each with its own code, redeemable once by whoever has it', async () => {
      const voucher = await createVoucher();
      const buyer = await loginPassenger(app);
      await givePoints(buyer, 1200);
      const { body } = await purchase(buyer, voucher.id, { quantity: 2, method: 'POINTS' }).expect(201);
      expect(await balance(buyer)).toBe(200);
      expect(body.cards).toHaveLength(2);
      expect(body.cards[0].code).not.toBe(body.cards[1].code);
      expect(body.cards[0].qr).toMatch(/^DUROB-TOPUP:/);

      // A friend scans the QR: they get the balance and the bonus points, the buyer gets nothing more.
      const friend = await loginPassenger(app);
      const redeemed = await redeemCode(friend, body.cards[0].qr).expect(201);
      expect(redeemed.body).toMatchObject({ value: 100, bonusPoints: 50 });
      expect(await walletOf(friend)).toEqual({ total: 100, transport: 0 });
      expect(await balance(friend)).toBe(50);
      await redeemCode(buyer, body.cards[0].code).expect(409);

      // Typed by hand without dashes works too.
      await redeemCode(buyer, body.cards[1].code.replace(/-/g, '').toLowerCase()).expect(201);
      const mine = (await request(http()).get(`${API}/vouchers/mine`).set(buyer.auth).expect(200)).body;
      expect(mine.map((c: any) => c.status).sort()).toEqual(['REDEEMED', 'REDEEMED']);
    });

    it('sells for money in simulated mode and adds transport-only balance when the voucher says so', async () => {
      const voucher = await createVoucher({ pointsCost: null, creditTransportOnly: true });
      const user = await loginPassenger(app);
      const { body } = await purchase(user, voucher.id, { quantity: 1, method: 'MONEY', paymentMethod: 'mada' }).expect(201);
      expect(body.amount).toBe(95);
      await purchase(user, voucher.id, { quantity: 1, method: 'POINTS' }).expect(400);
      await redeemCode(user, body.cards[0].code).expect(201);
      expect(await walletOf(user)).toEqual({ total: 100, transport: 100 });
    });

    it('keeps to the stock and the most per order', async () => {
      const voucher = await createVoucher({ stockTotal: 3, maxPerPurchase: 2 });
      const user = await loginPassenger(app);
      await purchase(user, voucher.id, { quantity: 3, method: 'MONEY' }).expect(400);
      await purchase(user, voucher.id, { quantity: 2, method: 'MONEY' }).expect(201);
      await purchase(user, voucher.id, { quantity: 2, method: 'MONEY' }).expect(409);
      await purchase(user, voucher.id, { quantity: 1, method: 'MONEY' }).expect(201);
      const list = (await request(http()).get(`${API}/loyalty/vouchers`).set(admin.auth).expect(200)).body;
      expect(list[0]).toMatchObject({ soldCount: 3, remaining: 0 });
      await request(http()).patch(`${API}/loyalty/vouchers/${voucher.id}`).set(admin.auth).send({ stockTotal: 2 }).expect(400);
    });

    it('refuses expired or unknown codes and hides inactive vouchers', async () => {
      const voucher = await createVoucher();
      const user = await loginPassenger(app);
      const { body } = await purchase(user, voucher.id, { quantity: 1, method: 'MONEY' }).expect(201);
      await prisma.voucherCard.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await redeemCode(user, body.cards[0].code).expect(409);
      await redeemCode(user, 'AAAA-BBBB-CCCC-DDDD').expect(404);

      await request(http()).patch(`${API}/loyalty/vouchers/${voucher.id}`).set(admin.auth).send({ isActive: false }).expect(200);
      expect((await request(http()).get(`${API}/vouchers/catalog`).set(user.auth).expect(200)).body).toEqual([]);
      await purchase(user, voucher.id, { quantity: 1, method: 'MONEY' }).expect(404);
    });

    it('needs a price and something to give', async () => {
      await request(http()).post(`${API}/loyalty/vouchers`).set(admin.auth).send({ name: 'بلا سعر', value: 10 }).expect(400);
      await request(http()).post(`${API}/loyalty/vouchers`).set(admin.auth).send({ name: 'فارغة', price: 10, value: 0 }).expect(400);
    });
  });
});

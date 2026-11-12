import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { openBoarding, API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Customer screens data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  const book = async (trip: any, seats = ['5'], user?: any) => {
    const session = user ?? (await loginPassenger(app));
    const res = await request(http())
      .post(`${API}/bookings`)
      .set(session.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })) })
      .expect(201);
    return { user: session, booking: res.body.bookings[0] };
  };

  const crewFor = async (trip: any) => {
    const staff = await createStaff(prisma, 'STAFF');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    return { staff, session: await loginStaff(app, staff.phone) };
  };

  const startSoon = (tripId: string) =>
    prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() - 3_600_000), arrivalTime: new Date(Date.now() + 3_600_000) } });

  const complete = (tripId: string) =>
    prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() - 7_200_000), arrivalTime: new Date(Date.now() - 3_600_000) } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('live tracking', () => {
    it('reports no position until the crew broadcasts, and never invents one', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const res = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(res.body.stage).toBe('NOT_STARTED');
      expect(res.body.location).toBeNull();
      expect(res.body.scheduleProgress).toBe(0);
    });

    it('takes positions only from crew assigned to the trip, inside the trip window', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const { session } = await crewFor(trip);
      const stranger = await loginStaff(app, (await createStaff(prisma, 'DRIVER')).phone);
      const url = `${API}/tracking/trips/${trip.id}/location`;
      const point = { lat: 24.08, lng: 38.06, speed: 20 };

      await request(http()).post(url).set(session.auth).send(point).expect(409);
      await startSoon(trip.id);
      await request(http()).post(url).set(user.auth).send(point).expect(403);
      await request(http()).post(url).set(stranger.auth).send(point).expect(403);
      await request(http()).post(url).set(session.auth).send({ lat: 500, lng: 38 }).expect(400);
      await request(http()).post(url).set(session.auth).send({ ...point, recordedAt: '2000-01-01' }).expect(400);
      await request(http()).post(url).set(session.auth).send(point).expect(201);

      const res = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(res.body.stage).toBe('IN_PROGRESS');
      expect(res.body.location).toMatchObject({ lat: 24.08, lng: 38.06, isLive: true });
      expect(res.body.scheduleProgress).toBeGreaterThan(40);
      expect(res.body.scheduleProgress).toBeLessThan(60);

      await request(http()).post(`${API}/tracking/trips/${trip.id}/stop`).set(session.auth).expect(201);
      const stopped = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(stopped.body.location).toBeNull();
    });

    it('marks an old position as no longer live', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const old = { lat: 1, lng: 2, reportedById: 'x', recordedAt: new Date(Date.now() - 600_000) };
      await prisma.tripLocation.upsert({ where: { tripId: trip.id }, create: { tripId: trip.id, ...old }, update: old });
      const res = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(res.body.location.isLive).toBe(false);
    });

    it('shows a trip only to its booking owner, and not after cancellation', async () => {
      const trip = await createTrip();
      const { booking } = await book(trip);
      const other = await loginPassenger(app);
      await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(other.auth).expect(404);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(admin.auth).expect(409);
    });

    it('gives the supervisor phone only close to departure', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const { staff } = await crewFor(trip);
      const far = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(far.body.supervisor.name).toBe(staff.name);
      expect(far.body.supervisor.phone).toBeNull();
      await startSoon(trip.id);
      const near = await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(near.body.supervisor.phone).toBe(staff.phone);
    });
  });

  describe('my trip now page', () => {
    const track = async (user: any, bookingId: string) => (await request(http()).get(`${API}/tracking/bookings/${bookingId}`).set(user.auth).expect(200)).body;
    const listed = async (user: any, bookingId: string) => (await request(http()).get(`${API}/bookings`).set(user.auth).expect(200)).body.find((b: any) => b.id === bookingId);
    const setStatus = (session: any, tripId: string, status: string, boardingPointId?: string) =>
      request(http()).post(`${API}/tickets/trips/${tripId}/status`).set(session.auth).send({ status, boardingPointId }).expect(201);

    it('opens on the trip day only, by the server clock', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const before = await track(user, booking.id);
      expect(before.tripDay.isOpen).toBe(false);
      expect(new Date(before.tripDay.opensAt).getTime()).toBeLessThanOrEqual(new Date(trip.departureTime).getTime());
      expect((await listed(user, booking.id)).tripDayOpen).toBe(false);

      await startSoon(trip.id);
      expect((await track(user, booking.id)).tripDay.isOpen).toBe(true);
      expect((await listed(user, booking.id)).tripDayOpen).toBe(true);
      expect((await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200)).body.tripDayOpen).toBe(true);

      const lastWeek = (days: number) => new Date(Date.now() - days * 86_400_000);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: lastWeek(7), arrivalTime: lastWeek(6) } });
      expect((await track(user, booking.id)).tripDay.isOpen).toBe(false);
    });

    it('never counts a passenger as boarded because time passed, only a scan does', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const expectNotBoarded = async () => {
        const row = await listed(user, booking.id);
        expect(row.status).toBe('CONFIRMED');
        expect(row.passengers[0].ticket.isBoarded).toBe(false);
        expect(row.passengers[0].ticket.boardedAt).toBeNull();
        expect((await track(user, booking.id)).isAllBoarded).toBe(false);
      };

      await startSoon(trip.id);
      await expectNotBoarded();

      await complete(trip.id);
      await app.get(TripsService).completeFinishedTrips();
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).tripStatus).toBe('COMPLETED');
      await expectNotBoarded();
      expect(await prisma.bookingEvent.count({ where: { bookingId: booking.id, action: 'BOARDED' } })).toBe(0);
    });

    it('stays open for a delayed bus until the tracking limit, and closes for a cancelled trip', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: hoursAgo(50), arrivalTime: hoursAgo(49), liveStatus: 'ON_ROAD' } });
      expect((await track(user, booking.id)).tripDay.isOpen).toBe(false);

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: hoursAgo(26), arrivalTime: hoursAgo(1) } });
      expect((await track(user, booking.id)).tripDay.isOpen).toBe(true);

      await prisma.trip.update({ where: { id: trip.id }, data: { tripStatus: 'CANCELLED' } });
      expect((await track(user, booking.id)).tripDay.isOpen).toBe(false);
    });

    it('lays the route out in travel order and follows the crew along it', async () => {
      const trip = await createTrip({
        boardingPoints: [
          { name: 'نقطة ثانية', time: '08:00', address: 'ع' },
          { name: 'نقطة أولى', time: '07:00', address: 'ع' },
        ],
        itineraryStops: [{ time: '09:00', title: 'ميقات الجحفة', desc: 'إحرام', kind: 'MIQAT' }],
      });
      // 07:30 in Riyadh, so a point at 07:00 is gathered at before departure and still comes first.
      const riyadhMorning = new Date(Date.now() + 86_400_000);
      riyadhMorning.setUTCHours(4, 30, 0, 0);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: riyadhMorning, arrivalTime: new Date(riyadhMorning.getTime() + 5 * 3_600_000), crewOpensBeforeMinutes: 7 * 24 * 60 } });
      const fresh = (await request(http()).get(`${API}/trips/${trip.id}`).expect(200)).body;
      const second = fresh.boardingPoints.find((point: any) => point.name === 'نقطة ثانية');

      const session = await loginPassenger(app);
      const res = await request(http())
        .post(`${API}/bookings`)
        .set(session.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['12', '3'], boardingPointId: second.id }], passengers: [{ fullName: 'مسافر أول' }, { fullName: 'مسافر ثان' }] })
        .expect(201);
      const bookingId = res.body.bookings[0].id;
      const { session: crew } = await crewFor(trip);

      const start = await track(session, bookingId);
      expect(start.seats).toEqual(['3', '12']);
      expect(start.isAllBoarded).toBe(false);
      expect(start.route.map((leg: any) => leg.name)).toEqual(['نقطة أولى', 'نقطة ثانية', 'ميقات الجحفة', 'مكة المكرمة']);
      expect(start.route[1].isMine).toBe(true);
      expect(start.route.some((leg: any) => leg.isPassed || leg.isCurrent)).toBe(false);

      await setStatus(crew, trip.id, 'AT_POINT', second.id);
      const atMine = await track(session, bookingId);
      expect(atMine.route.map((leg: any) => [leg.isPassed, leg.isCurrent])).toEqual([[true, false], [false, true], [false, false], [false, false]]);
      expect(atMine.notices[0].message).toBe('وصلت الحافلة إلى نقطة ثانية');
      expect(JSON.stringify(atMine.notices)).not.toContain('STAFF user');

      await setStatus(crew, trip.id, 'ON_ROAD');
      const onRoad = await track(session, bookingId);
      expect(onRoad.route[1]).toMatchObject({ isPassed: true, isCurrent: false });
      expect(onRoad.route[2].isPassed).toBe(false);
      expect(onRoad.notices.map((notice: any) => notice.message)).toEqual(['الحافلة في الطريق', 'وصلت الحافلة إلى نقطة ثانية']);

      await setStatus(crew, trip.id, 'ARRIVED');
      const arrived = await track(session, bookingId);
      expect(arrived.route.slice(0, -1).every((leg: any) => leg.isPassed)).toBe(true);
      expect(arrived.route.at(-1)).toMatchObject({ kind: 'DESTINATION', isCurrent: true });
    });
  });

  describe('used ticket', () => {
    it('names the crew member who boarded the passenger, for that ticket only', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip, ['5', '6']);
      const { staff, session } = await crewFor(trip);
      await openBoarding(prisma, trip.id);
      await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);

      const res = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      const boarded = res.body.passengers.find((p: any) => p.id === booking.passengers[0].id);
      const waiting = res.body.passengers.find((p: any) => p.id === booking.passengers[1].id);
      expect(boarded.ticket.isBoarded).toBe(true);
      expect(boarded.ticket.boardedAt).toBeTruthy();
      expect(boarded.boardedByName).toBe(staff.name);
      expect(waiting.boardedByName).toBeNull();
    });
  });

  describe('loyalty points', () => {
    it('starts at zero with an empty history', async () => {
      const user = await loginPassenger(app);
      const res = await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200);
      expect(res.body.points).toBe(0);
      expect(res.body.transactions).toEqual([]);
      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(profile.body.loyaltyPoints).toBe(0);
    });

    it('awards once when the booking is paid, and not again when the trip completes', async () => {
      const trip = await createTrip({ price: 100 });
      const { user, booking } = await book(trip, ['5', '6']);
      const paid = await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200);
      expect(paid.body.points).toBe(Math.floor(Number(booking.totalPrice)));

      const { session } = await crewFor(trip);
      await openBoarding(prisma, trip.id);
      await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
      await complete(trip.id);

      const trips = app.get(TripsService);
      await trips.completeFinishedTrips();
      await trips.completeFinishedTrips();

      const res = await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200);
      expect(res.body.points).toBe(Math.floor(Number(booking.totalPrice)));
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].type).toBe('EARNED');
      expect(res.body.transactions[0].booking.bookingReference).toBe(booking.bookingReference);
      expect(res.body.transactions[0].balanceAfter).toBe(res.body.points);
    });

    it('takes the points back when the booking is cancelled', async () => {
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      await app.get(TripsService).completeFinishedTrips();
      const res = await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200);
      expect(res.body.points).toBe(0);
      expect(res.body.transactions.map((tx: any) => tx.type)).toEqual(['REFUNDED', 'EARNED']);
    });

    it('cannot be credited by the customer through the profile', async () => {
      const user = await loginPassenger(app);
      await request(http()).put(`${API}/users/profile`).set(user.auth).send({ name: 'اسم', loyaltyPoints: 99999 }).expect(400);
    });

    it('follows the rate in settings, where zero switches earning off', async () => {
      await request(http()).put(`${API}/loyalty/program`).set(admin.auth).send({ pointsPerRiyal: 0 }).expect(200);
      const trip = await createTrip();
      const { user, booking } = await book(trip);
      const { session } = await crewFor(trip);
      await openBoarding(prisma, trip.id);
      await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
      await complete(trip.id);
      await app.get(TripsService).completeFinishedTrips();
      const res = await request(http()).get(`${API}/users/profile/loyalty`).set(user.auth).expect(200);
      expect(res.body.points).toBe(0);
      await request(http()).put(`${API}/loyalty/program`).set(admin.auth).send({ pointsPerRiyal: 1 }).expect(200);
    });
  });

  describe('wallet details', () => {
    it('links a movement to its booking and trip, with the real balance', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      await prisma.user.update({ where: { phone: user.phone }, data: { walletBalance: 1000 } });
      const { booking } = await book(trip, ['5'], user);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);

      const history = await request(http()).get(`${API}/users/profile/wallet-transactions`).set(user.auth).expect(200);
      const refund = history.body.find((t: any) => t.type === 'REFUND');
      expect(refund.bookingReference).toBe(booking.bookingReference);
      expect(refund.trip.origin).toBe(trip.origin);
      expect(refund.balanceAfter).toBeDefined();
    });

    it('opens a movement only for its owner', async () => {
      const trip = await createTrip();
      const user = await loginPassenger(app);
      await prisma.user.update({ where: { phone: user.phone }, data: { walletBalance: 1000 } });
      const { booking } = await book(trip, ['5'], user);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      const [movement] = (await request(http()).get(`${API}/users/profile/wallet-transactions`).set(user.auth).expect(200)).body;

      await request(http()).get(`${API}/users/profile/wallet-transactions/${movement.id}`).set(user.auth).expect(200);
      const other = await loginPassenger(app);
      await request(http()).get(`${API}/users/profile/wallet-transactions/${movement.id}`).set(other.auth).expect(404);
    });
  });
});

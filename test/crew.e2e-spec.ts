import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Supervisor app (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  /** A trip with one two-seat booking, and a supervisor assigned to it. */
  const scenario = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const passenger = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(passenger.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '2'] }], passengers: [{ fullName: 'مسافر أول' }, { fullName: 'مسافر ثان' }] })
        .expect(201)
    ).body.bookings[0];
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    return { trip, passenger, booking, staff, session: await loginStaff(app, staff.phone) };
  };

  /** Departs in three days, with the default opening times: not yet open to its crew. */
  const moveFar = (tripId: string, data: Record<string, number> = {}) =>
    prisma.trip.update({
      where: { id: tripId },
      data: { departureTime: new Date(Date.now() + 72 * 3_600_000), arrivalTime: new Date(Date.now() + 77 * 3_600_000), crewOpensBeforeMinutes: 1440, boardingOpensBeforeMinutes: 120, boardingClosesAfterMinutes: 60, ...data },
    });

  const loginStaffOf = (user: { phone: string }) => loginStaff(app, user.phone);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts real passengers and boardings on the assigned trips', async () => {
    const { trip, booking, session } = await scenario();
    await openBoarding(prisma, trip.id);
    const ticketNumber = booking.passengers[0].ticket.ticketNumber;
    await request(http()).post(`${API}/tickets/${ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);

    const trips = await request(http()).get(`${API}/tickets/my-trips`).set(session.auth).expect(200);
    expect(trips.body).toHaveLength(1);
    expect(trips.body[0]).toMatchObject({ id: trip.id, passengerCount: 2, boardedCount: 1 });
  });

  it('tells who already boarded a used ticket, and the booking type', async () => {
    const { trip, booking, staff, session } = await scenario();
    await openBoarding(prisma, trip.id);
    const { ticketNumber, signedToken } = booking.passengers[0].ticket;
    await request(http()).post(`${API}/tickets/${ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);

    const again = await request(http()).post(`${API}/tickets/verify`).set(session.auth).send({ signedToken, tripId: trip.id }).expect(201);
    expect(again.body.result).toBe('ALREADY_USED');
    expect(again.body.ticket).toMatchObject({ boardedBy: staff.name, bookingType: 'TRANSPORT_ONLY' });
  });

  describe('passenger notices', () => {
    it('reaches the passenger through the booking updates', async () => {
      const { trip, passenger, booking, session } = await scenario();
      const sent = await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(session.auth).send({ message: '  تأخر الانطلاق 30 دقيقة  ' }).expect(201);
      expect(sent.body).toEqual({ bookings: 1 });

      const seen = await request(http()).get(`${API}/bookings/${booking.id}`).set(passenger.auth).expect(200);
      expect(seen.body.updates.map((u: any) => u.message)).toContain('تأخر الانطلاق 30 دقيقة');
    });

    it('skips cancelled bookings', async () => {
      const { trip, booking, session } = await scenario();
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
      const sent = await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(session.auth).send({ message: 'تنبيه' }).expect(201);
      expect(sent.body).toEqual({ bookings: 0 });
    });

    it('rejects an empty message, a finished trip, and crew of other trips', async () => {
      const { trip, session } = await scenario();
      const url = `${API}/tickets/trips/${trip.id}/notices`;
      await request(http()).post(url).set(session.auth).send({ message: '   ' }).expect(400);

      const outsider = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await request(http()).post(url).set(outsider.auth).send({ message: 'تنبيه' }).expect(403);

      await prisma.trip.update({ where: { id: trip.id }, data: { tripStatus: 'COMPLETED' } });
      await request(http()).post(url).set(session.auth).send({ message: 'تنبيه' }).expect(409);
    });

    it('belongs to supervisors: the seeded driver rank does not hold it', async () => {
      const ranks = await prisma.rank.findMany({ where: { id: { in: ['rank-driver', 'rank-supervisor'] } } });
      expect(ranks.find((rank) => rank.id === 'rank-supervisor').permissions).toContain('crew.notify');
      expect(ranks.find((rank) => rank.id === 'rank-driver').permissions).not.toContain('crew.notify');
    });

    it('refuses a driver of the trip, even one whose rank holds the permission', async () => {
      const { trip } = await scenario();
      const url = `${API}/tickets/trips/${trip.id}/notices`;

      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id } });
      const driverSession = await loginStaffOf(driver);
      await request(http()).post(url).set(driverSession.auth).send({ message: 'تنبيه' }).expect(403);

      const wideRank = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: wideRank.id } });
      const wideRankSession = await loginStaffOf(wideRank);
      await request(http()).post(url).set(wideRankSession.auth).send({ message: 'تنبيه' }).expect(403);
    });

    it('caps the notices per trip, across its supervisors', async () => {
      const { trip, session } = await scenario();
      const url = `${API}/tickets/trips/${trip.id}/notices`;
      for (let sent = 0; sent < 5; sent++) {
        await request(http()).post(url).set(session.auth).send({ message: `تنبيه ${sent}` }).expect(201);
      }
      await request(http()).post(url).set(session.auth).send({ message: 'تنبيه زائد' }).expect(429);

      const second = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: second.id } });
      const secondSession = await loginStaffOf(second);
      await request(http()).post(url).set(secondSession.auth).send({ message: 'تنبيه زائد' }).expect(429);
    });
  });

  describe('boarding window', () => {
    const board = (session: any, booking: any, tripId: string) =>
      request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId }).expect(201);
    const verify = (session: any, booking: any, tripId: string) =>
      request(http()).post(`${API}/tickets/verify`).set(session.auth).send({ signedToken: booking.passengers[0].ticket.signedToken, tripId }).expect(201);
    const departIn = (tripId: string, minutes: number, data: Record<string, number>) =>
      prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() + minutes * 60_000), arrivalTime: new Date(Date.now() + (minutes + 300) * 60_000), ...data } });

    it('follows the opening set on the trip', async () => {
      const { trip, booking, session } = await scenario();
      await departIn(trip.id, 60, { crewOpensBeforeMinutes: 1440, boardingOpensBeforeMinutes: 30 });
      expect((await board(session, booking, trip.id)).body.result).toBe('OUTSIDE_WINDOW');
      const scanned = await verify(session, booking, trip.id);
      expect(scanned.body.result).toBe('OUTSIDE_WINDOW');
      expect(scanned.body.ticket.boardingOpensAt).toBeTruthy();
      expect((await prisma.ticket.findFirstOrThrow({ where: { bookingId: booking.id } })).isBoarded).toBe(false);

      await departIn(trip.id, 20, { crewOpensBeforeMinutes: 1440, boardingOpensBeforeMinutes: 30 });
      expect((await board(session, booking, trip.id)).body.result).toBe('BOARDED');
    });

    it('follows the closing set on the trip', async () => {
      const { trip, booking, session } = await scenario();
      await departIn(trip.id, -90, { boardingClosesAfterMinutes: 60 });
      expect((await board(session, booking, trip.id)).body.result).toBe('OUTSIDE_WINDOW');

      await departIn(trip.id, -30, { boardingClosesAfterMinutes: 60 });
      expect((await board(session, booking, trip.id)).body.result).toBe('BOARDED');
    });

    it('still reports a used ticket once the window has closed', async () => {
      const { trip, booking, session } = await scenario();
      await board(session, booking, trip.id);
      await departIn(trip.id, -600, { boardingClosesAfterMinutes: 60 });
      expect((await verify(session, booking, trip.id)).body.result).toBe('ALREADY_USED');
    });
  });

  describe('before the trip opens to its crew', () => {
    it('shows the trip, its driver and supervisors, but no passenger', async () => {
      const { trip, staff, session } = await scenario();
      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id, isPrimary: true } });
      await moveFar(trip.id);

      const listed = await request(http()).get(`${API}/tickets/my-trips`).set(session.auth).expect(200);
      expect(listed.body[0].id).toBe(trip.id);
      expect(listed.body[0].access).toMatchObject({ isTripOpen: false, isBoardingOpen: false });

      const details = await request(http()).get(`${API}/tickets/trips/${trip.id}/details`).set(session.auth).expect(200);
      expect(details.body.access.isTripOpen).toBe(false);
      expect(details.body.tripCode).toBe(trip.tripCode);
      expect(details.body.boardingPoints[0].name).toBe('فرع ينبع');
      expect(details.body.drivers).toEqual([{ id: driver.id, name: driver.name, isPrimary: true }]);
      expect(details.body.supervisors.map((s: any) => s.id)).toEqual([staff.id]);
      expect(details.body.passengerCount).toBe(2);

      const json = JSON.stringify(details.body);
      expect(json).not.toContain('مسافر أول');
      expect(json).not.toContain(driver.phone);
    });

    it('refuses every action until the opening time', async () => {
      const { trip, booking, session } = await scenario();
      await moveFar(trip.id);

      await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(409);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(session.auth).send({ message: 'تنبيه' }).expect(409);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/reports`).set(session.auth).send({ type: 'OTHER', details: 'x' }).expect(409);
      await request(http()).post(`${API}/tracking/trips/${trip.id}/location`).set(session.auth).send({ lat: 21, lng: 39 }).expect(409);
      const boarded = await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: trip.id }).expect(201);
      expect(boarded.body.result).toBe('OUTSIDE_WINDOW');
    });

    it('opens according to the time set on the trip', async () => {
      const { trip, session } = await scenario();
      await moveFar(trip.id, { crewOpensBeforeMinutes: 4 * 1440 });
      await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(200);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(session.auth).send({ message: 'تنبيه' }).expect(201);
    });

    it('keeps the details closed to crew of other trips', async () => {
      const { trip } = await scenario();
      const outsider = await loginStaffOf(await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor'));
      await request(http()).get(`${API}/tickets/trips/${trip.id}/details`).set(outsider.auth).expect(403);
    });
  });

  describe('trip opening settings', () => {
    const create = (overrides: Record<string, unknown>) => request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides));

    it('saves the times from the trip form and keeps them from customers', async () => {
      const res = await create({ crewOpensBeforeMinutes: 2880, boardingOpensBeforeMinutes: 90, boardingClosesAfterMinutes: 15 }).expect(201);
      expect(res.body).toMatchObject({ crewOpensBeforeMinutes: 2880, boardingOpensBeforeMinutes: 90, boardingClosesAfterMinutes: 15 });

      const updated = await request(http()).put(`${API}/trips/${res.body.id}`).set(admin.auth).send({ boardingClosesAfterMinutes: 45 }).expect(200);
      expect(updated.body).toMatchObject({ crewOpensBeforeMinutes: 2880, boardingClosesAfterMinutes: 45 });

      const publicTrip = await request(http()).get(`${API}/trips/${res.body.id}`).expect(200);
      expect(publicTrip.body.crewOpensBeforeMinutes).toBeUndefined();
      expect(publicTrip.body.boardingOpenAnnouncedAt).toBeUndefined();
    });

    it('refuses boarding that opens before the trip does, or never opens at all', async () => {
      await create({ crewOpensBeforeMinutes: 60, boardingOpensBeforeMinutes: 120 }).expect(400);
      await create({ boardingOpensBeforeMinutes: 0, boardingClosesAfterMinutes: 0 }).expect(400);
      await create({ boardingOpensBeforeMinutes: 1441 }).expect(400);
      await create({ crewOpensBeforeMinutes: -1 }).expect(400);
    });
  });

  describe('crew notifications', () => {
    const sweep = () => app.get(TripsService).announceCrewWindows();
    const count = (userId: string, event: string, tripId: string) => prisma.notification.count({ where: { userId, event, tripId } });

    it('tells supervisor and driver once when the trip and its boarding open and close', async () => {
      const { trip, staff } = await scenario();
      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id, isPrimary: true } });
      await prisma.trip.update({ where: { id: trip.id }, data: { crewOpenAnnouncedAt: null, boardingOpenAnnouncedAt: null, boardingCloseAnnouncedAt: null } });

      await moveFar(trip.id);
      await sweep();
      expect(await count(staff.id, 'CREW_TRIP_OPENED', trip.id)).toBe(0);

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 300 * 60_000), arrivalTime: new Date(Date.now() + 600 * 60_000) } });
      await sweep();
      await sweep();
      for (const member of [staff, driver]) {
        expect(await count(member.id, 'CREW_TRIP_OPENED', trip.id)).toBe(1);
        expect(await count(member.id, 'CREW_BOARDING_OPENED', trip.id)).toBe(0);
      }

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 60 * 60_000) } });
      await sweep();
      expect(await count(driver.id, 'CREW_BOARDING_OPENED', trip.id)).toBe(1);

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 90 * 60_000) } });
      await sweep();
      await sweep();
      expect(await count(driver.id, 'CREW_BOARDING_CLOSED', trip.id)).toBe(1);
      expect(await count(staff.id, 'CREW_BOARDING_CLOSED', trip.id)).toBe(1);
    });

    it('announces again after the departure moves', async () => {
      const { trip, staff } = await scenario();
      await prisma.trip.update({ where: { id: trip.id }, data: { crewOpenAnnouncedAt: null } });
      await sweep();
      expect(await count(staff.id, 'CREW_TRIP_OPENED', trip.id)).toBe(1);

      const later = Date.now() + 22 * 3_600_000;
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ departureTime: new Date(later).toISOString(), arrivalTime: new Date(later + 3_600_000).toISOString() }).expect(200);
      await sweep();
      expect(await count(staff.id, 'CREW_TRIP_OPENED', trip.id)).toBe(2);
    });

    it('does not announce a draft, and stays silent about opening once boarding has closed', async () => {
      const { trip, staff } = await scenario();
      await prisma.trip.update({ where: { id: trip.id }, data: { tripStatus: 'DRAFT', crewOpenAnnouncedAt: null } });
      await sweep();
      expect(await count(staff.id, 'CREW_TRIP_OPENED', trip.id)).toBe(0);

      await prisma.trip.update({
        where: { id: trip.id },
        data: { tripStatus: 'PUBLISHED', departureTime: new Date(Date.now() - 180 * 60_000), arrivalTime: new Date(Date.now() + 120 * 60_000), boardingClosesAfterMinutes: 60, crewOpenAnnouncedAt: null, boardingOpenAnnouncedAt: null, boardingCloseAnnouncedAt: null },
      });
      await sweep();
      expect(await count(staff.id, 'CREW_TRIP_OPENED', trip.id)).toBe(0);
      expect(await count(staff.id, 'CREW_BOARDING_OPENED', trip.id)).toBe(0);
      expect(await count(staff.id, 'CREW_BOARDING_CLOSED', trip.id)).toBe(1);
    });

    it('tells the rest of the crew about a passenger notice and a report, not the sender', async () => {
      const { trip, staff, session } = await scenario();
      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id } });

      await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(session.auth).send({ message: 'تأخر الانطلاق' }).expect(201);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/reports`).set(session.auth).send({ type: 'DELAY', details: 'زحام' }).expect(201);

      const received = await prisma.notification.findMany({ where: { userId: driver.id, tripId: trip.id, event: { in: ['CREW_PASSENGERS_NOTIFIED', 'CREW_COLLEAGUE_REPORT'] } } });
      expect(received.map((n) => n.event).sort()).toEqual(['CREW_COLLEAGUE_REPORT', 'CREW_PASSENGERS_NOTIFIED']);
      expect(received.find((n) => n.event === 'CREW_PASSENGERS_NOTIFIED').body).toContain('تأخر الانطلاق');
      expect(await count(staff.id, 'CREW_PASSENGERS_NOTIFIED', trip.id)).toBe(0);
      expect(await count(staff.id, 'CREW_COLLEAGUE_REPORT', trip.id)).toBe(0);
    });

    it('reaches the driver through the same inbox the app reads', async () => {
      const { trip } = await scenario();
      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id } });
      await prisma.trip.update({ where: { id: trip.id }, data: { crewOpenAnnouncedAt: null } });
      await sweep();

      const session = await loginStaffOf(driver);
      const inbox = await request(http()).get(`${API}/notifications/mine`).set(session.auth).expect(200);
      expect(inbox.body.items.find((n: any) => n.event === 'CREW_TRIP_OPENED').tripId).toBe(trip.id);
    });
  });

  describe('manifest after the trip', () => {
    const endTrip = (tripId: string, hoursAgo: number) =>
      prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() - (hoursAgo + 5) * 3_600_000), arrivalTime: new Date(Date.now() - hoursAgo * 3_600_000) } });

    it('stays open for a day, then keeps only the totals for the crew', async () => {
      const { trip, session } = await scenario();
      const url = `${API}/tickets/manifest/${trip.id}`;

      await endTrip(trip.id, 23);
      const fresh = await request(http()).get(url).set(session.auth).expect(200);
      expect(fresh.body.passengersHidden).toBe(false);
      expect(fresh.body.passengers).toHaveLength(2);

      await endTrip(trip.id, 25);
      const old = await request(http()).get(url).set(session.auth).expect(200);
      expect(old.body).toMatchObject({ passengersHidden: true, passengers: [], total: 2, boarded: 0 });
      expect(JSON.stringify(old.body)).not.toContain('مسافر أول');
    });

    it('stays open for admins, who already bypass the assignment', async () => {
      const { trip } = await scenario();
      await endTrip(trip.id, 25);
      const res = await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(admin.auth).expect(200);
      expect(res.body.passengers).toHaveLength(2);
    });
  });

  describe('incident reports', () => {
    it('records who reported and lists it for the office', async () => {
      const { trip, staff, session } = await scenario();
      await request(http()).post(`${API}/tickets/trips/${trip.id}/reports`).set(session.auth).send({ type: 'BREAKDOWN', details: 'عطل في التكييف' }).expect(201);

      const reports = await request(http()).get(`${API}/tickets/reports`).set(admin.auth).expect(200);
      expect(reports.body[0]).toMatchObject({ type: 'BREAKDOWN', details: 'عطل في التكييف', createdById: staff.id, createdByName: staff.name });
      expect(reports.body[0].trip.tripCode).toBe(trip.tripCode);
      await request(http()).get(`${API}/tickets/reports`).set(session.auth).expect(403);
    });

    it('rejects an unknown type, empty details, and crew of other trips', async () => {
      const { trip, session } = await scenario();
      const url = `${API}/tickets/trips/${trip.id}/reports`;
      await request(http()).post(url).set(session.auth).send({ type: 'NOPE', details: 'x' }).expect(400);
      await request(http()).post(url).set(session.auth).send({ type: 'OTHER', details: ' ' }).expect(400);

      const outsider = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await request(http()).post(url).set(outsider.auth).send({ type: 'OTHER', details: 'x' }).expect(403);
    });
  });
});

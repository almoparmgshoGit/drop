import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { BookingCancellationService } from '../src/common/services/booking-cancellation.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Reverse trips (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  let scheduleOffset = 0;
  /** Each trip gets its own days so buses and crew never clash between tests. */
  const times = () => {
    scheduleOffset += 1;
    const departure = Date.now() + (5 + scheduleOffset) * DAY;
    return { departure, departureTime: new Date(departure).toISOString(), arrivalTime: new Date(departure + 5 * HOUR).toISOString() };
  };

  /**
   * Most cases here open the way back by hand, at a chosen moment, to see what that moment leaves on sale. So the trip is
   * published first and its way back switched on afterwards, which skips the automatic opening publishing does; that is
   * covered with createPublished.
   */
  const createOutbound = async (direction: 'ONE_WAY' | 'ROUND_TRIP', overrides: Record<string, unknown> = {}) => {
    const { departure, departureTime, arrivalTime } = times();
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({
      direction,
      departureTime,
      arrivalTime,
      estimatedArrivalAt: arrivalTime,
      maxSeatsPerBooking: 6,
      ...overrides,
    })).expect(201)).body;
    const reverse = { reverseEnabled: true, reverseOpenPercent: 1, reverseDepartureAt: new Date(departure + 8 * HOUR), reversePrice: 90 };
    await prisma.trip.update({ where: { id: trip.id }, data: reverse });
    return { ...trip, ...reverse, departure };
  };

  /** A trip published with its way back on, as the office creates one: the way back opens with it. */
  const createPublished = async (direction: 'ONE_WAY' | 'ROUND_TRIP', overrides: Record<string, unknown> = {}) => {
    const { departure, departureTime, arrivalTime } = times();
    return (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({
      direction,
      departureTime,
      arrivalTime,
      estimatedArrivalAt: arrivalTime,
      reverseEnabled: true,
      reverseDepartureAt: new Date(departure + 8 * HOUR).toISOString(),
      ...overrides,
    })).expect(201)).body;
  };

  const book = async (tripId: string, seats: string[], customer?: any) => {
    const user = customer ?? await loginPassenger(app);
    const res = await request(http()).post(`${API}/bookings`).set(user.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId, seats }], passengers: seats.map((seat) => ({ fullName: `راكب ${seat}` })) })
      .expect(201);
    return { user, booking: res.body.bookings[0] };
  };

  const openReverse = async (tripId: string, body: Record<string, unknown> = {}) =>
    (await request(http()).post(`${API}/trips/${tripId}/open-reverse`).set(admin.auth).send({ boardingPointName: 'فندق العزيزية', ...body }).expect(201)).body;

  const edit = (id: string, body: Record<string, unknown>) => request(http()).put(`${API}/trips/${id}`).set(admin.auth).send(body);
  const reverseRow = async (tripId: string) =>
    (await request(http()).get(`${API}/trips/admin/reverse?range=month`).set(admin.auth).expect(200)).body.find((row: any) => row.id === tripId);

  const opensBoardingNow = (tripId: string) =>
    prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() + 20 * HOUR), arrivalTime: new Date(Date.now() + 25 * HOUR), crewOpensBeforeMinutes: 1440, boardingOpensBeforeMinutes: 1440 } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a round trip passenger riding back', () => {
    const riding = async () => {
      const trip = await createOutbound('ROUND_TRIP');
      const { user, booking } = await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      await prisma.tripSupervisor.create({ data: { tripId: reverse.id, userId: supervisor.id, isPrimary: true } });
      return { trip, reverse, user, booking, session: await loginStaff(app, supervisor.phone) };
    };

    it('is on the reverse sheet and boards with the outbound ticket, once', async () => {
      const { reverse, booking, user, session } = await riding();
      await opensBoardingNow(reverse.id);

      const crewSheet = (await request(http()).get(`${API}/tickets/manifest/${reverse.id}`).set(session.auth).expect(200)).body;
      expect(crewSheet.total).toBe(2);
      expect(crewSheet.boarded).toBe(0);
      expect(crewSheet.passengers.every((p: any) => p.isReturning)).toBe(true);

      const officeSheet = (await request(http()).get(`${API}/manifests/${reverse.id}`).set(admin.auth).expect(200)).body;
      expect(officeSheet.passengers.map((p: any) => p.seatNumber)).toEqual(['1', '2']);
      // Seats 1 and 2 were sold before it opened, so they are shown from the riders, not from the reverse's own seats.
      expect(officeSheet.seats.find((s: any) => s.seatNumber === '1')).toMatchObject({ status: 'booked', passengerName: 'راكب 1' });
      expect(officeSheet.housing.persons).toBe(officeSheet.housing.hasHousing ? officeSheet.passengers.length : 0);

      const { ticket } = booking.passengers[0];
      const boarded = await request(http()).post(`${API}/tickets/verify`).set(session.auth).send({ signedToken: (await prisma.ticket.findUniqueOrThrow({ where: { ticketNumber: ticket.ticketNumber } })).signedToken, tripId: reverse.id }).expect(201);
      expect(boarded.body.result).toBe('BOARDED');
      expect(boarded.body.ticket).toMatchObject({ isReturning: true, boardingPointName: 'فندق العزيزية', trip: { id: reverse.id } });

      const stored = await prisma.ticket.findUniqueOrThrow({ where: { ticketNumber: ticket.ticketNumber } });
      expect(stored.isBoarded).toBe(false);
      expect(stored.returnBoardedAt).not.toBeNull();
      // The outbound's boarding state and booking status are not this ride's to change.
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');

      const again = await request(http()).post(`${API}/tickets/${ticket.ticketNumber}/board`).set(session.auth).send({ tripId: reverse.id }).expect(201);
      expect(again.body.result).toBe('ALREADY_USED');

      const after = (await request(http()).get(`${API}/tickets/manifest/${reverse.id}`).set(session.auth).expect(200)).body;
      expect(after.boarded).toBe(1);

      const seen = (await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200)).body;
      expect(seen.returnRide).toMatchObject({ tripCode: reverse.tripCode, boardingPointName: 'فندق العزيزية' });
      expect(seen.updates.some((update: any) => update.type === 'RETURN_BOARDED')).toBe(true);
    });

    it('lets the office record and undo the return, leaving the outbound alone', async () => {
      const { booking } = await riding();
      const passenger = booking.passengers[0];
      const url = `${API}/bookings/admin/${booking.id}/passengers/${passenger.id}`;
      const updatedAt = async () => (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).updatedAt;
      await request(http()).post(`${url}/board`).set(admin.auth).send({ reason: 'تسجيل يدوي', returning: true, expectedUpdatedAt: await updatedAt() }).expect(201);
      expect(await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } })).toMatchObject({ isBoarded: false });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } })).returnBoardedAt).not.toBeNull();
      await request(http()).post(`${url}/unboard`).set(admin.auth).send({ reason: 'خطأ في التسجيل', returning: true, expectedUpdatedAt: await updatedAt() }).expect(201);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } })).returnBoardedAt).toBeNull();
    });

    it('still refuses a ticket from an unrelated trip, a one-way trip and a cancelled booking', async () => {
      const { reverse, booking, session } = await riding();
      await opensBoardingNow(reverse.id);
      const other = await book((await createOutbound('ROUND_TRIP')).id, ['1']);
      const stranger = await request(http()).post(`${API}/tickets/${other.booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: reverse.id }).expect(201);
      expect(stranger.body.result).toBe('WRONG_TRIP');

      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
      const cancelled = await request(http()).post(`${API}/tickets/${booking.passengers[0].ticket.ticketNumber}/board`).set(session.auth).send({ tripId: reverse.id }).expect(201);
      expect(cancelled.body.result).toBe('WRONG_TRIP');

      const oneWay = await createOutbound('ONE_WAY');
      const goOnly = await book(oneWay.id, ['1', '2']);
      const oneWayReverse = await openReverse(oneWay.id);
      await opensBoardingNow(oneWayReverse.id);
      const refused = await request(http()).post(`${API}/tickets/${goOnly.booking.passengers[0].ticket.ticketNumber}/board`).set(admin.auth).send({ tripId: oneWayReverse.id }).expect(201);
      expect(refused.body.result).toBe('WRONG_TRIP');
    });

    it('is told about the way back in its own words', async () => {
      const { reverse, user, session } = await riding();
      await opensBoardingNow(reverse.id);
      const point = (await prisma.boardingPoint.findFirstOrThrow({ where: { tripId: reverse.id } })).id;
      await request(http()).post(`${API}/tickets/trips/${reverse.id}/status`).set(session.auth).send({ status: 'AT_POINT', boardingPointId: point });
      const notified = await prisma.notification.findFirst({ where: { userId: user.user.id, event: 'BUS_AT_YOUR_POINT' } });
      expect(notified?.body).toContain('فندق العزيزية');
    });

    it('moves its seat back on sale when a sold-before seat is cancelled', async () => {
      const { reverse, booking } = await riding();
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).totalSeats).toBe(47);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
      const after = await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } });
      expect(after).toMatchObject({ totalSeats: 49, availableSeats: 49 });
      await book(reverse.id, ['1']);
    });
  });

  describe('changing the outbound after the reverse opened', () => {
    it('moves the reverse by the same amount and tells its customers', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);
      const { user } = await book(reverse.id, ['1']);

      const later = new Date(trip.departure + 2 * HOUR).toISOString();
      await edit(trip.id, { departureTime: later }).expect(200);
      const moved = await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } });
      expect(moved.departureTime.getTime()).toBe(new Date(reverse.departureTime).getTime() + 2 * HOUR);
      expect(moved.arrivalTime.getTime()).toBe(new Date(reverse.arrivalTime).getTime() + 2 * HOUR);
      expect(await prisma.notification.count({ where: { userId: user.user.id, event: 'TRIP_TIME_CHANGED' } })).toBe(1);
    });

    it('refuses a reverse leaving before the outbound arrives, both ways round', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);
      await edit(reverse.id, { departureTime: new Date(trip.departure + 3 * HOUR).toISOString() }).expect(400);
      const late = new Date(trip.departure + 9 * HOUR).toISOString();
      await edit(trip.id, { arrivalTime: late, estimatedArrivalAt: late }).expect(400);

      const unopened = times();
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({
        direction: 'ONE_WAY',
        departureTime: unopened.departureTime,
        arrivalTime: unopened.arrivalTime,
        reverseEnabled: true,
        reverseDepartureAt: new Date(unopened.departure + 2 * HOUR).toISOString(),
        reversePrice: 90,
      })).expect(400);
    });

    it('takes the bus along, and the crew unless the reverse has its own', async () => {
      const [first, second] = await Promise.all([
        request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `ر ${Date.now()}`, model: 'مرسيدس' }),
        request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `س ${Date.now()}`, model: 'مان' }),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      const trip = await createOutbound('ONE_WAY', { busId: first.body.id });
      await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);

      await edit(reverse.id, { busId: second.body.id }).expect(409);

      const driver = await createStaff(prisma, 'DRIVER');
      await edit(trip.id, { busId: second.body.id, driverIds: [driver.id] }).expect(200);
      const followed = await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id }, include: { drivers: true } });
      expect(followed).toMatchObject({ busId: second.body.id, availableSeats: 49 });
      expect(followed.drivers.map((d) => d.userId)).toEqual([driver.id]);

      // Someone picked another driver for the way back: changing the outbound's must not undo that.
      const own = await createStaff(prisma, 'DRIVER');
      const newest = await createStaff(prisma, 'DRIVER');
      await edit(reverse.id, { driverIds: [own.id] }).expect(200);
      await edit(trip.id, { driverIds: [newest.id] }).expect(200);
      const kept = await prisma.tripDriver.findMany({ where: { tripId: reverse.id } });
      expect(kept.map((d) => d.userId)).toEqual([own.id]);
    });

    it('lets a bus be replaced once the outbound has left, for that way only', async () => {
      const replacement = (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `ت ${Date.now()}`, model: 'مان' }).expect(201)).body;
      const trip = await createOutbound('ROUND_TRIP');
      await book(trip.id, ['5', '6']);
      const reverse = await openReverse(trip.id);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - HOUR), arrivalTime: new Date(Date.now() + 30 * DAY), estimatedArrivalAt: new Date(Date.now() + HOUR) } });

      // A departed outbound can still be edited; publishing into the past is what stays refused.
      await edit(trip.id, { price: 111 }).expect(200);

      await edit(reverse.id, { busId: replacement.id }).expect(200);
      expect(await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).toMatchObject({ busId: replacement.id, totalSeats: 47, availableSeats: 47 });
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).busId).toBeNull();
    });
  });

  describe('cancelling and opening again', () => {
    it('protects riders from a silent cancellation, tells them when it goes ahead, and can reopen', async () => {
      const trip = await createOutbound('ROUND_TRIP');
      const { user } = await book(trip.id, ['1']);
      const reverse = await openReverse(trip.id);
      await book(reverse.id, ['2']);

      await request(http()).post(`${API}/trips/${reverse.id}/cancel`).set(admin.auth).send({}).expect(409);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).tripStatus).toBe('PUBLISHED');
      await request(http()).delete(`${API}/trips/${reverse.id}`).set(admin.auth).expect(409);

      await request(http()).post(`${API}/trips/${reverse.id}/cancel`).set(admin.auth).send({ acknowledgeReturning: true }).expect(201);
      expect(await prisma.notification.count({ where: { userId: user.user.id, event: 'RETURN_RIDE_CANCELLED' } })).toBe(1);

      const row = await reverseRow(trip.id);
      expect(row).toMatchObject({ status: 'READY', wasCancelled: true, reverse: null });

      // Its seats start over from the outbound: seat 1 is still sold there, and seat 2 was freed with the cancelled booking.
      const reopened = await openReverse(trip.id, { boardingPointName: 'نقطة جديدة' });
      expect(reopened.id).toBe(reverse.id);
      expect(reopened).toMatchObject({ tripStatus: 'PUBLISHED', availableSeats: 48 });
      expect(reopened.boardingPoints.map((p: any) => p.name)).toEqual(['نقطة جديدة']);
      const { booking } = await book(reverse.id, ['2']);
      expect(booking.status).toBe('CONFIRMED');
      expect(await prisma.seat.findFirstOrThrow({ where: { tripId: trip.id, seatNumber: '2' } })).toMatchObject({ isBooked: true });
    });

    it('corrects a wrong direction through a cancellation', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);
      await edit(trip.id, { direction: 'ROUND_TRIP' }).expect(409);

      await request(http()).post(`${API}/trips/${reverse.id}/cancel`).set(admin.auth).send({}).expect(201);
      await edit(trip.id, { direction: 'ROUND_TRIP' }).expect(200);
      const reopened = await openReverse(trip.id);
      expect(reopened.availableSeats).toBe(47);
    });

    it('refuses to open with no channel, and shows closed channels as a pause', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send({ boardingPointName: 'نقطة', channelApp: false, channelBranch: false }).expect(400);
      const reverse = await openReverse(trip.id);
      await edit(reverse.id, { channelApp: false, channelBranch: false }).expect(200);
      expect((await reverseRow(trip.id)).status).toBe('PAUSED');
    });
  });

  describe('opening', () => {
    it('opens as soon as the outbound is published, however far ahead and however empty', async () => {
      const departure = Date.now() + 120 * DAY;
      const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({
        direction: 'ROUND_TRIP',
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 5 * HOUR).toISOString(),
        estimatedArrivalAt: new Date(departure + 5 * HOUR).toISOString(),
        reverseEnabled: true,
        reverseOpenPercent: 80,
        reverseDepartureAt: new Date(departure + 8 * HOUR).toISOString(),
        reversePrice: 90,
      })).expect(201)).body;

      const all = (await request(http()).get(`${API}/trips/admin/reverse`).set(admin.auth).expect(200)).body;
      // Published means both ways are on sale: the way back opened with it, whatever its percent.
      expect(all.find((row: any) => row.id === trip.id)).toMatchObject({ status: 'OPEN', reachedPercent: false });
      const month = (await request(http()).get(`${API}/trips/admin/reverse?range=month`).set(admin.auth).expect(200)).body;
      expect(month.some((row: any) => row.id === trip.id)).toBe(false);

      const reverse = await prisma.trip.findFirstOrThrow({ where: { reverseOfTripId: trip.id } });
      expect(reverse.totalSeats).toBe(trip.totalSeats);
      // A seat the outbound sells afterwards is kept for its passenger on the way back.
      await book(trip.id, ['1']);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).availableSeats).toBe(trip.totalSeats - 1);
    });
  });

  describe('route and gathering points', () => {
    it('opens with its own gathering points and route, offers the outbound route reversed, and edits them later', async () => {
      const trip = await createOutbound('ONE_WAY', {
        itineraryStops: [{ title: 'الطائف', time: '10:00', kind: 'STOP' }, { title: 'ميقات السيل', time: '11:00', kind: 'MIQAT' }],
      });
      await book(trip.id, ['1']);
      const before = await reverseRow(trip.id);
      expect(before.outboundStops.map((stop: any) => stop.title)).toEqual(['الطائف', 'ميقات السيل']);

      await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send({}).expect(400);
      await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth)
        .send({ boardingPoints: [{ name: 'فندق العزيزية', time: '' }] }).expect(400);

      const reverse = await openReverse(trip.id, {
        boardingPointName: undefined,
        boardingPoints: [{ name: 'فندق العزيزية', time: '20:00', address: 'شارع الحج' }, { name: 'محطة الحرم', time: '20:30' }],
        itineraryStops: [{ title: 'الطائف', time: '22:00', kind: 'REST' }],
      });
      expect(reverse.boardingPoints.map((point: any) => point.name).sort()).toEqual(['فندق العزيزية', 'محطة الحرم']);
      expect(reverse.itineraryStops).toEqual([expect.objectContaining({ title: 'الطائف', time: '22:00', kind: 'REST' })]);

      const row = await reverseRow(trip.id);
      expect(row.reverse.boardingPoints).toHaveLength(2);
      expect(row.reverse.itineraryStops.map((stop: any) => stop.title)).toEqual(['الطائف']);

      await edit(reverse.id, { boardingPoints: [{ name: 'محطة الحرم', time: '21:00' }], itineraryStops: [] }).expect(200);
      const after = await reverseRow(trip.id);
      expect(after.reverse.boardingPoints.map((point: any) => point.name)).toEqual(['محطة الحرم']);
      expect(after.reverse.itineraryStops).toEqual([]);
    });

    it('still opens with a single point name', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1']);
      const reverse = await openReverse(trip.id);
      expect(reverse.boardingPoints).toEqual([expect.objectContaining({ name: 'فندق العزيزية' })]);
    });
  });

  describe('the reverse screen', () => {
    it('counts real bookings, not seats closed by the link', async () => {
      const trip = await createOutbound('ROUND_TRIP');
      await book(trip.id, ['1']);
      const reverse = await openReverse(trip.id);
      await book(trip.id, ['2']);
      await book(reverse.id, ['3']);
      await edit(reverse.id, { price: 200 }).expect(200);

      const row = await reverseRow(trip.id);
      expect(row.reverse.bookedSeats).toBe(1);
      expect(row.reverse.bookedRevenue).toBe(90);
      expect(row.reverse.availableSeats).toBe(46);
      expect(row.bookedSeats).toBe(2);
      expect(row.returningSeats).toBe(2);
    });

    it('keeps a reverse in view after its outbound leaves', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      await openReverse(trip.id);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - HOUR), arrivalTime: new Date(Date.now() - 1000), estimatedArrivalAt: null, tripStatus: 'COMPLETED' } });
      expect(await reverseRow(trip.id)).toMatchObject({ status: 'OPEN', hasDeparted: true });

      // One that was never opened can still be, since the bus is there and the way back is ahead.
      const late = await createOutbound('ONE_WAY');
      await book(late.id, ['1', '2']);
      await prisma.trip.update({ where: { id: late.id }, data: { departureTime: new Date(Date.now() - 2 * HOUR), arrivalTime: new Date(Date.now() - HOUR), estimatedArrivalAt: null, tripStatus: 'COMPLETED' } });
      expect(await reverseRow(late.id)).toMatchObject({ status: 'READY', hasDeparted: true });
      await openReverse(late.id);
    });

    it('opens the way back by itself when the way there is published, under the same number', async () => {
      // A road no earlier case used, so no return on it exists yet.
      const trip = await createPublished('ONE_WAY', { destination: 'الطائف' });
      const saved = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { reverseTrip: { include: { boardingPoints: true } } } });
      expect(saved.tripCode).toMatch(/^D\d{3}-\d{2}\/\d{4}$/);
      expect(saved.reverseTrip).toMatchObject({ tripStatus: 'PUBLISHED', codeNumber: saved.codeNumber, codePeriod: saved.codePeriod });
      // No price of its own: coming back only costs the ticket's base price.
      expect(Number(saved.reverseTrip!.price)).toBe(Number(saved.price));
      expect(saved.reverseTrip!.tripCode).toBe(saved.tripCode.replace(/^D/, 'R'));
      // With no earlier return on this road, passengers gather at the destination.
      expect(saved.reverseTrip!.boardingPoints.map((point) => point.name)).toEqual([saved.destination]);

      // The next return on the road reuses that one's gathering points.
      await prisma.boardingPoint.updateMany({ where: { tripId: saved.reverseTrip!.id }, data: { name: 'فندق العزيزية' } });
      const next = await createPublished('ONE_WAY', { destination: 'الطائف' });
      const nextReverse = await prisma.trip.findFirstOrThrow({ where: { reverseOfTripId: next.id }, include: { boardingPoints: true } });
      expect(nextReverse.boardingPoints.map((point) => point.name)).toEqual(['فندق العزيزية']);
    });

    it('tells those who manage trips once when the way back cannot open, and opens it once it can', async () => {
      const trip = await createPublished('ONE_WAY', { tripStatus: 'DRAFT' });
      // Both sale channels closed: the way back has nowhere to be sold.
      await edit(trip.id, { channelApp: false, channelBranch: false, tripStatus: 'PUBLISHED' }).expect(200);
      const sweep = () => app.get(TripsService).openPendingReverses();
      const told = () => prisma.notification.count({ where: { tripId: trip.id, event: 'REVERSE_TRIP_READY', userId: admin.user.id } });
      await sweep();
      expect(await told()).toBe(1);
      expect(await prisma.trip.count({ where: { reverseOfTripId: trip.id } })).toBe(0);

      await edit(trip.id, { channelApp: true }).expect(200);
      expect(await prisma.trip.count({ where: { reverseOfTripId: trip.id, tripStatus: 'PUBLISHED' } })).toBe(1);
      expect(await told()).toBe(1);
    });
  });

  describe('a DR journey account', () => {
    it('adds up the way there and the way back in one account, and shows each leg', async () => {
      const trip = await createOutbound('ONE_WAY');
      await book(trip.id, ['1', '2']);
      const reverse = await openReverse(trip.id);
      await book(reverse.id, ['7']);

      const list = (await request(http()).get(`${API}/trip-accounts?view=trip&q=${encodeURIComponent(reverse.tripCode)}`).set(admin.auth).expect(200)).body;
      // One row for the journey, found by either leg's code; the way back has no row of its own.
      expect(list.items.map((item: any) => item.id)).toEqual([trip.id]);
      const [row] = list.items;
      expect(row.journeyCode).toBe(reverse.tripCode.replace(/^R/, 'DR'));
      expect(row.legs.map((leg: any) => leg.id)).toEqual([trip.id, reverse.id]);
      expect(row.tickets).toBe(2 * 180 + 90);
      expect(row.passengers).toBe(3);

      // Either leg opens the same journey account; the figures below it stay the leg's own.
      const detail = (await request(http()).get(`${API}/trip-accounts/${reverse.id}`).set(admin.auth).expect(200)).body;
      expect(detail.journey.figures.tickets).toBe(450);
      expect(detail.figures.tickets).toBe(90);

      const profits = (await request(http()).get(`${API}/trip-accounts/current-profits`).set(admin.auth).expect(200)).body;
      expect(profits[trip.id]).toMatchObject({ isJourney: true, journeyCode: row.journeyCode });
      expect(profits[reverse.id]).toMatchObject({ partOfTripId: trip.id });
    });
  });

  describe('a DR journey carrying more than the bus holds', () => {
    it('frees the way-back seat of a round-trip passenger who comes back on another date, and takes it back if that leg is cancelled', async () => {
      const trip = await createOutbound('ROUND_TRIP');
      const reverse = await openReverse(trip.id);
      const { departureTime, arrivalTime } = times();
      const later = (await request(http()).post(`${API}/trips`).set(admin.auth)
        .send(tripPayload({ origin: 'مكة المكرمة', destination: 'ينبع', departureTime, arrivalTime })).expect(201)).body;
      const seatOnReverse = () => prisma.seat.findFirstOrThrow({ where: { tripId: reverse.id, seatNumber: '5' } });

      const customer = await loginPassenger(app);
      const journey = (await request(http()).post(`${API}/bookings`).set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['5'] }, { tripId: later.id, seats: ['5'] }], passengers: [{ fullName: 'راكب يعود لاحقًا' }] })
        .expect(201)).body;
      // Coming home on the later trip, so seat 5 on this journey's way back can be sold to someone else.
      expect(await seatOnReverse()).toMatchObject({ isBooked: false });

      const returnLeg = journey.bookings.find((booking: any) => booking.tripId === later.id);
      await prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, returnLeg.id, { refundAmount: 0 }));
      // With that leg gone, the passenger rides back on the journey's own way back again.
      expect(await seatOnReverse()).toMatchObject({ isBooked: true });
    });
  });

  describe('holds across the two directions', () => {
    it('blocks the other direction while a seat is held, and lets go together', async () => {
      const trip = await createOutbound('ROUND_TRIP');
      await book(trip.id, ['1']);
      const reverse = await openReverse(trip.id);
      const [first, second] = [await loginPassenger(app), await loginPassenger(app)];
      const hold = (user: any, tripId: string, seats: string[]) => request(http()).post(`${API}/bookings/holds`).set(user.auth).send({ tripId, seats });

      await hold(first, trip.id, ['3']).expect(201);
      await hold(second, reverse.id, ['3']).expect(409);
      const map = (await request(http()).get(`${API}/bookings/seat-map/${reverse.id}`).set(second.auth).expect(200)).body;
      expect(map.seats.find((seat: any) => seat.seatNumber === '3').status).toBe('held');

      // Picking another seat frees the first one on both directions.
      await hold(first, trip.id, ['4']).expect(201);
      await hold(second, reverse.id, ['3']).expect(201);

      // The first customer still books their own held seat.
      await book(trip.id, ['4'], first);
      await hold(second, reverse.id, ['4']).expect(409);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Booking administration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let staff: any;

  const createTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  // One traveller sits with the singles (26–49); two or more book as a family outside that range.
  const bookOne = async (overrides = {}, seats = ['30']) => {
    const trip = await createTrip(overrides);
    const user = await loginPassenger(app);
    const res = await request(http())
      .post(`${API}/bookings`)
      .set(user.auth)
      .send({
        paymentMethod: 'mada',
        category: seats.length === 1 ? 'SINGLES' : 'FAMILY',
        legs: [{ tripId: trip.id, seats }],
        passengers: seats.map((_, i) => ({ fullName: `مسافر ${i + 1}` })),
      })
      .expect(201);
    return { trip, user, booking: res.body.bookings[0] };
  };

  const details = async (id: string, session = admin) =>
    (await request(http()).get(`${API}/bookings/admin/${id}`).set(session.auth).expect(200)).body;

  const seatFree = async (tripId: string, seatNumber: string) =>
    !(await prisma.seat.findFirstOrThrow({ where: { tripId, seatNumber } })).isBooked;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('access control', () => {
    it('keeps customers and drivers out of every admin endpoint', async () => {
      const { user, booking } = await bookOne();
      const driver = await loginStaff(app, (await createStaff(prisma, 'DRIVER')).phone);
      const passenger = booking.passengers[0];
      for (const session of [user, driver]) {
        await request(http()).get(`${API}/bookings/admin/all`).set(session.auth).expect(403);
        await request(http()).get(`${API}/bookings/admin/search?q=abc`).set(session.auth).expect(403);
        await request(http()).get(`${API}/bookings/admin/${booking.id}`).set(session.auth).expect(403);
        await request(http())
          .patch(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}`)
          .set(session.auth)
          .send({ fullName: 'اختراق', reason: 'محاولة', expectedUpdatedAt: booking.updatedAt })
          .expect(403);
      }
      await request(http()).get(`${API}/bookings/admin/all`).expect(401);
    });

    it('reserves money and cancellation decisions for admins', async () => {
      const { user, booking } = await bookOne();
      await request(http()).get(`${API}/bookings/admin/export`).set(staff.auth).expect(403);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(staff.auth).send({ note: 'سبب' }).expect(403);

      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(user.auth).send({}).expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(staff.auth).send({ approve: true }).expect(403);
      await request(http()).post(`${API}/bookings/${booking.id}/cancellation/review`).set(staff.auth).send({ approve: false, note: 'مرفوض' }).expect(201);

      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(Number(profile.body.walletBalance)).toBe(0);
    });

    it('never returns signed ticket tokens from panel endpoints', async () => {
      const { booking } = await bookOne();
      const list = await request(http()).get(`${API}/bookings/admin/all`).set(admin.auth).expect(200);
      const detail = await request(http()).get(`${API}/bookings/admin/${booking.id}`).set(admin.auth).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('signedToken');
      expect(JSON.stringify(detail.body)).not.toContain('signedToken');
    });

    it('hides internal notes and history from the customer', async () => {
      const { user, booking } = await bookOne();
      await request(http()).post(`${API}/bookings/admin/${booking.id}/notes`).set(staff.auth).send({ text: 'ملاحظة سرية' }).expect(201);
      const own = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(JSON.stringify(own.body)).not.toContain('ملاحظة سرية');
    });
  });

  describe('passenger edits', () => {
    it('updates the passenger and records who changed what and why', async () => {
      const { booking } = await bookOne();
      const passenger = booking.passengers[0];
      const res = await request(http())
        .patch(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}`)
        .set(staff.auth)
        .send({ fullName: '  عبدالله العتيبي  ', phone: '0551234567', reason: 'خطأ إملائي', expectedUpdatedAt: booking.updatedAt })
        .expect(200);

      expect(res.body.passengers[0].fullName).toBe('عبدالله العتيبي');
      expect(res.body.passengers[0].phone).toBe('+966551234567');
      const event = res.body.events.find((e: any) => e.action === 'PASSENGER_UPDATED');
      expect(event.reason).toBe('خطأ إملائي');
      expect(event.actorRole).toBe('STAFF');
      expect(event.before.fullName).toBe('مسافر 1');
      expect(event.after.fullName).toBe('عبدالله العتيبي');
    });

    it('requires a real reason and rejects unknown fields', async () => {
      const { booking } = await bookOne();
      const url = `${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}`;
      await request(http()).patch(url).set(admin.auth).send({ fullName: 'اسم جديد', expectedUpdatedAt: booking.updatedAt }).expect(400);
      await request(http()).patch(url).set(admin.auth).send({ fullName: 'اسم جديد', reason: '    ', expectedUpdatedAt: booking.updatedAt }).expect(400);
      await request(http()).patch(url).set(admin.auth).send({ fullName: 'اسم جديد', reason: 'سبب كاف', expectedUpdatedAt: booking.updatedAt, seatNumber: '9' }).expect(400);
      await request(http()).patch(url).set(admin.auth).send({ reason: 'سبب كاف', expectedUpdatedAt: booking.updatedAt }).expect(400);
    });

    it('rejects a passenger id taken from another booking', async () => {
      const first = await bookOne();
      const second = await bookOne();
      await request(http())
        .patch(`${API}/bookings/admin/${first.booking.id}/passengers/${second.booking.passengers[0].id}`)
        .set(admin.auth)
        .send({ fullName: 'تلاعب', reason: 'محاولة تلاعب', expectedUpdatedAt: first.booking.updatedAt })
        .expect(404);
      const untouched = await prisma.bookingPassenger.findUniqueOrThrow({ where: { id: second.booking.passengers[0].id } });
      expect(untouched.fullName).toBe('مسافر 1');
    });

    it('rejects an edit based on an outdated copy of the booking', async () => {
      const { booking } = await bookOne();
      const url = `${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}`;
      await request(http()).patch(url).set(admin.auth).send({ fullName: 'الأول', reason: 'تعديل أول', expectedUpdatedAt: booking.updatedAt }).expect(200);
      await request(http()).patch(url).set(staff.auth).send({ fullName: 'الثاني', reason: 'تعديل ثان', expectedUpdatedAt: booking.updatedAt }).expect(409);
      expect((await details(booking.id)).passengers[0].fullName).toBe('الأول');
    });
  });

  describe('seat changes', () => {
    it('moves the seat, keeps the count and retires the old ticket', async () => {
      const { trip, booking } = await bookOne();
      const passenger = booking.passengers[0];
      const oldToken = passenger.ticket.signedToken;
      const res = await request(http())
        .post(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}/seat`)
        .set(staff.auth)
        .send({ seatNumber: '32', reason: 'طلب العميل', expectedUpdatedAt: booking.updatedAt })
        .expect(201);

      expect(res.body.passengers[0].seatNumber).toBe('32');
      expect(await seatFree(trip.id, '30')).toBe(true);
      expect(await seatFree(trip.id, '32')).toBe(false);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).availableSeats).toBe(48);
      expect(res.body.passengers[0].ticket.ticketNumber).not.toBe(passenger.ticket.ticketNumber);

      const verify = await request(http()).post(`${API}/tickets/verify`).set(admin.auth).send({ signedToken: oldToken, tripId: trip.id }).expect(201);
      expect(verify.body.result).toBe('INVALID');
    });

    it('refuses taken, missing, held and rule-breaking seats', async () => {
      const { trip, booking } = await bookOne({}, ['5', '6']);
      const url = `${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}/seat`;
      const body = { reason: 'طلب العميل', expectedUpdatedAt: booking.updatedAt };
      await request(http()).post(url).set(admin.auth).send({ ...body, seatNumber: '6' }).expect(409);
      await request(http()).post(url).set(admin.auth).send({ ...body, seatNumber: '5' }).expect(400);
      await request(http()).post(url).set(admin.auth).send({ ...body, seatNumber: '999' }).expect(409);
      await request(http()).post(url).set(admin.auth).send({ ...body, seatNumber: 'abc' }).expect(400);

      await prisma.seat.update({
        where: { tripId_seatNumber: { tripId: trip.id, seatNumber: '20' } },
        data: { heldByUserId: booking.userId, heldUntil: new Date(Date.now() + 60_000) },
      });
      await request(http()).post(url).set(admin.auth).send({ ...body, seatNumber: '20' }).expect(409);
      expect(await seatFree(trip.id, '5')).toBe(false);
    });

    it('gives one free seat to exactly one of two simultaneous requests', async () => {
      const first = await bookOne({}, ['5', '6']);
      const body = { seatNumber: '12', reason: 'نفس المقعد', expectedUpdatedAt: first.booking.updatedAt };
      const results = await Promise.all(
        first.booking.passengers.map((p: any) =>
          request(http()).post(`${API}/bookings/admin/${first.booking.id}/passengers/${p.id}/seat`).set(admin.auth).send(body),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const seats = (await details(first.booking.id)).passengers.map((p: any) => p.seatNumber);
      expect(seats.filter((s: string) => s === '12')).toHaveLength(1);
    });

    it('refuses once the passenger boarded or the trip left', async () => {
      const { trip, booking } = await bookOne({}, ['5', '6']);
      const [boardedPassenger, otherPassenger] = booking.passengers;
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000) } });
      const after = await request(http())
        .post(`${API}/bookings/admin/${booking.id}/passengers/${boardedPassenger.id}/board`)
        .set(staff.auth)
        .send({ reason: 'لا يوجد ماسح', expectedUpdatedAt: booking.updatedAt })
        .expect(201);
      await request(http())
        .post(`${API}/bookings/admin/${booking.id}/passengers/${boardedPassenger.id}/seat`)
        .set(admin.auth)
        .send({ seatNumber: '9', reason: 'طلب', expectedUpdatedAt: after.body.updatedAt })
        .expect(409);

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 3_600_000) } });
      await request(http())
        .post(`${API}/bookings/admin/${booking.id}/passengers/${otherPassenger.id}/seat`)
        .set(admin.auth)
        .send({ seatNumber: '9', reason: 'طلب', expectedUpdatedAt: after.body.updatedAt })
        .expect(409);
    });
  });

  describe('boarding point', () => {
    it('only accepts points of the same trip', async () => {
      const { trip, booking } = await bookOne({
        boardingPoints: [
          { name: 'الفرع', time: '05:15', address: 'أ' },
          { name: 'المحطة', time: '05:45', address: 'ب' },
        ],
      });
      const other = await createTrip();
      const url = `${API}/bookings/admin/${booking.id}/boarding-point`;
      const body = { reason: 'طلب العميل', expectedUpdatedAt: booking.updatedAt };
      await request(http()).post(url).set(staff.auth).send({ ...body, boardingPointId: other.boardingPoints[0].id }).expect(400);

      const target = trip.boardingPoints.find((p: any) => p.name === 'المحطة');
      const res = await request(http()).post(url).set(staff.auth).send({ ...body, boardingPointId: target.id }).expect(201);
      expect(res.body.boardingPointName).toBe('المحطة');
      expect(res.body.boardingPointTime).toBe('05:45');
    });
  });

  describe('boarding overrides', () => {
    it('blocks early boarding and lets only admins undo a boarding', async () => {
      const { trip, booking } = await bookOne();
      const passenger = booking.passengers[0];
      const base = `${API}/bookings/admin/${booking.id}/passengers/${passenger.id}`;
      await request(http()).post(`${base}/board`).set(admin.auth).send({ reason: 'مبكر جدا', expectedUpdatedAt: booking.updatedAt }).expect(409);

      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000) } });
      const boarded = await request(http()).post(`${base}/board`).set(staff.auth).send({ reason: 'الماسح معطل', expectedUpdatedAt: booking.updatedAt }).expect(201);
      expect(boarded.body.status).toBe('BOARDED');

      const body = { reason: 'سجل بالخطأ', expectedUpdatedAt: boarded.body.updatedAt };
      await request(http()).post(`${base}/unboard`).set(staff.auth).send(body).expect(403);
      const undone = await request(http()).post(`${base}/unboard`).set(admin.auth).send(body).expect(201);
      expect(undone.body.status).toBe('CONFIRMED');
      expect(undone.body.passengers[0].ticket.isBoarded).toBe(false);
      expect(undone.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['BOARDED', 'UNBOARDED']));
    });
  });

  describe('cancellation', () => {
    it('requires a reason and refunds only once under simultaneous requests', async () => {
      const { trip, user, booking } = await bookOne();
      const url = `${API}/bookings/${booking.id}/admin-cancel`;
      await request(http()).post(url).set(admin.auth).send({}).expect(400);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => request(http()).post(url).set(admin.auth).send({ note: 'قرار إداري' })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);

      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(Number(profile.body.walletBalance)).toBe(180);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).availableSeats).toBe(49);
      const events = (await details(booking.id)).events.filter((e: any) => e.action === 'CANCELLED');
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('قرار إداري');
    });

    it('refunds to the original payment method as a pending refund, once', async () => {
      const { user, booking } = await bookOne();
      const url = `${API}/bookings/${booking.id}/admin-cancel`;
      await request(http()).post(url).set(admin.auth).send({ note: 'قرار إداري', refundMethod: 'CARD' }).expect(400);

      const results = await Promise.all(
        Array.from({ length: 3 }, () => request(http()).post(url).set(admin.auth).send({ note: 'قرار إداري', refundMethod: 'ORIGINAL' })),
      );
      const done = results.filter((r) => r.status === 201);
      expect(done).toHaveLength(1);
      expect(Number(done[0].body.refundAmount)).toBe(0);

      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(Number(profile.body.walletBalance)).toBe(0);
      const refunds = await prisma.paymentTransaction.findMany({ where: { bookingId: booking.id, type: 'REFUND' } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ status: 'PENDING', destination: 'ORIGINAL', method: 'mada' });
      expect(Number(refunds[0].amount)).toBe(180);
    });

    it('refuses to cancel a booking with some passengers already boarded', async () => {
      const { trip, booking } = await bookOne({}, ['5', '6']);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000) } });
      await request(http())
        .post(`${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}/board`)
        .set(staff.auth)
        .send({ reason: 'الماسح معطل', expectedUpdatedAt: booking.updatedAt })
        .expect(201);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'محاولة' }).expect(400);
    });

    it('blocks every edit after cancellation', async () => {
      const { booking } = await bookOne();
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      const { updatedAt } = await details(booking.id);
      await request(http())
        .patch(`${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}`)
        .set(admin.auth)
        .send({ fullName: 'بعد الإلغاء', reason: 'محاولة', expectedUpdatedAt: updatedAt })
        .expect(409);
    });
  });

  describe('history integrity', () => {
    it('cannot be rewritten or removed, even from inside the application', async () => {
      const { booking } = await bookOne();
      await request(http()).post(`${API}/bookings/admin/${booking.id}/notes`).set(staff.auth).send({ text: 'أصلية' }).expect(201);
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: booking.id } });
      await expect(prisma.bookingEvent.update({ where: { id: event.id }, data: { reason: 'مزورة' } })).rejects.toThrow();
      await expect(prisma.bookingEvent.delete({ where: { id: event.id } })).rejects.toThrow();
      await expect(prisma.booking.delete({ where: { id: booking.id } })).rejects.toThrow();
      expect((await prisma.bookingEvent.findUniqueOrThrow({ where: { id: event.id } })).reason).toBe('أصلية');
    });

    it('rolls back the change when its history cannot be written', async () => {
      const { booking } = await bookOne();
      const passenger = booking.passengers[0];
      await prisma.$executeRawUnsafe(`ALTER TABLE "BookingEvent" ADD CONSTRAINT "tmp_block" CHECK ("action" <> 'PASSENGER_UPDATED') NOT VALID`);
      try {
        await request(http())
          .patch(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}`)
          .set(admin.auth)
          .send({ fullName: 'لن يحفظ', reason: 'اختبار الرجوع', expectedUpdatedAt: booking.updatedAt })
          .expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "BookingEvent" DROP CONSTRAINT "tmp_block"`);
      }
      expect((await prisma.bookingPassenger.findUniqueOrThrow({ where: { id: passenger.id } })).fullName).toBe('مسافر 1');
    });
  });

  describe('trip setup used by bookings', () => {
    it('keeps visit steps in the order they were entered', async () => {
      const titles = ['جبل أحد', 'مسجد قباء', 'المساجد السبعة', 'أبار علي'];
      const trip = await createTrip({ bookingType: 'WITH_VISITS', visits: titles.map((title) => ({ title })) });
      const fresh = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(fresh.body.visits.map((v: any) => v.title)).toEqual(titles);
    });

    it('sells a one-way trip\'s seats again on its reverse, even when the outbound is full', async () => {
      const departure = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const times = {
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 5 * 3_600_000).toISOString(),
      };
      const trip = await createTrip({
        ...times,
        direction: 'ONE_WAY',
        maxSeatsPerBooking: 4,
        reverseEnabled: true,
        reverseOpenPercent: 5,
        reverseDepartureAt: new Date(departure + 8 * 3_600_000).toISOString(),
        reversePrice: 90,
      });
      const later = await createTrip({
        direction: 'ONE_WAY',
        departureTime: new Date(departure + 2 * 86_400_000).toISOString(),
        arrivalTime: new Date(departure + 2 * 86_400_000 + 5 * 3_600_000).toISOString(),
      });
      const user = await loginPassenger(app);
      // A traveller alone sits with the singles (26–49); a family books outside that range.
      const bookTrip = (legs: { tripId: string; seats: string[] }[], names: string[]) =>
        request(http()).post(`${API}/bookings`).set(user.auth)
          .send({ paymentMethod: 'mada', category: names.length === 1 ? 'SINGLES' : 'FAMILY', legs, passengers: names.map((fullName) => ({ fullName })) })
          .expect(201);

      // Three seats go one way; the fourth has its return on another trip, so it is not counted as going only.
      await bookTrip([{ tripId: trip.id, seats: ['1', '2', '3'] }], ['راكب أول', 'راكب ثان', 'راكب ثالث']);
      await bookTrip([{ tripId: trip.id, seats: ['26'] }, { tripId: later.id, seats: ['26'] }], ['راكب رابع']);

      // Publishing the trip opened its way back, which sells the whole bus again.
      const reverse = await prisma.trip.findFirstOrThrow({ where: { reverseOfTripId: trip.id } });
      expect(reverse.availableSeats).toBe(49);
      // A family of two on the way back, on the seat a go-only passenger holds outbound.
      await bookTrip([{ tripId: reverse.id, seats: ['1', '2'] }], ['راكب عكسي', 'مرافق عكسي']);

      const outboundSeats = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(outboundSeats.availableSeats).toBe(45);

      const manifest = (await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200)).body;
      expect(manifest.reverse).toMatchObject({ goOnlySeats: 3, isOpen: true, bookedSeats: 2, availableSeats: 47 });
      expect(manifest.passengers.filter((p: any) => p.goOnly).map((p: any) => p.seatNumber)).toEqual(['1', '2', '3']);

      const list = (await request(http()).get(`${API}/bookings/admin/all?tripId=${trip.id}`).set(admin.auth).expect(200)).body;
      expect(list.reverse.goOnlySeats).toBe(3);
      expect(list.items.filter((b: any) => b.goOnly)).toHaveLength(1);

      // Cancelling an outbound booking must leave the reverse passenger on seat 1.
      const first = manifest.passengers.find((p: any) => p.seatNumber === '1');
      await request(http()).post(`${API}/bookings/${first.bookingId}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
      expect(await prisma.seat.findFirstOrThrow({ where: { tripId: reverse.id, seatNumber: '1' } })).toMatchObject({ isBooked: true });
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).availableSeats).toBe(47);

      // The rule depends on the direction, so it cannot change under sales already made.
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ direction: 'ROUND_TRIP' }).expect(409);
    });

    it('opens the reverse trip once, on the free seats', async () => {
      const departure = Date.now() + 5 * 24 * 60 * 60 * 1000;
      const trip = await createTrip({
        direction: 'ROUND_TRIP',
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 5 * 3_600_000).toISOString(),
      });
      // Switched on after publishing, so publishing does not open it by itself and the office opens it by hand here.
      await prisma.trip.update({ where: { id: trip.id }, data: { reverseEnabled: true, reverseOpenPercent: 10, reverseDepartureAt: new Date(departure + 8 * 3_600_000), reversePrice: 90 } });
      const open = (body = { boardingPointName: 'فندق العزيزية', channelApp: true }) =>
        request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send(body);

      const user = await loginPassenger(app);
      const seats = ['1', '2', '3', '4', '5'];
      await request(http())
        .post(`${API}/bookings`)
        .set(user.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats }], passengers: seats.map((_, i) => ({ fullName: `مسافر ${i + 1}` })) })
        .expect(201);

      await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(staff.auth).send({ boardingPointName: 'نقطة' }).expect(403);
      const results = await Promise.all([open(), open()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

      const reverse = results.find((r) => r.status === 201)!.body;
      expect(reverse.origin).toBe(trip.destination);
      expect(reverse.availableSeats).toBe(44);
      const map = await request(http()).get(`${API}/bookings/seat-map/${reverse.id}`).set(user.auth).expect(200);
      expect(map.body.seats.map((s: any) => s.seatNumber)).toEqual(Array.from({ length: 44 }, (_, idx) => String(idx + 6)));

      // Editing the reverse trip must not renumber or delete its seats.
      await request(http()).put(`${API}/trips/${reverse.id}`).set(admin.auth).send({ price: 95 }).expect(200);
      expect(await prisma.seat.count({ where: { tripId: reverse.id } })).toBe(44);

      // Hidden from the app channel: not searchable and not bookable.
      await request(http()).put(`${API}/trips/${reverse.id}`).set(admin.auth).send({ channelApp: false }).expect(200);
      await request(http()).get(`${API}/trips/${reverse.id}`).expect(404);
      await request(http()).get(`${API}/bookings/seat-map/${reverse.id}`).set(user.auth).expect(404);

      // Cancelling the outbound takes the reverse trip with it.
      await request(http()).post(`${API}/trips/${trip.id}/cancel`).set(admin.auth).send({ reason: 'تعطل' }).expect(201);
      expect((await prisma.trip.findUniqueOrThrow({ where: { id: reverse.id } })).tripStatus).toBe('CANCELLED');
    });
  });

  describe('trip manifests', () => {
    const manifest = async (tripId: string, session = staff) =>
      (await request(http()).get(`${API}/manifests/${tripId}`).set(session.auth).expect(200)).body;

    it('lists boarded state and seats, without ticket tokens, for panel roles only', async () => {
      const { trip, user, booking } = await bookOne({}, ['5', '6']);
      await request(http()).get(`${API}/manifests/${trip.id}`).set(user.auth).expect(403);
      await request(http()).get(`${API}/manifests/${trip.id}`).expect(401);

      const body = await manifest(trip.id);
      expect(body.passengers.map((p: any) => p.seatNumber)).toEqual(['5', '6']);
      expect(body.summary).toMatchObject({ total: 2, boarded: 0, available: 47 });
      expect(body.seats.find((s: any) => s.seatNumber === '5').passengerName).toBe('مسافر 1');
      expect(JSON.stringify(body)).not.toContain('signedToken');
      expect(body.passengers[0].bookingId).toBe(booking.id);
    });

    it('drops cancelled bookings and frees their seats on the sheet', async () => {
      const { trip, booking } = await bookOne();
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      const body = await manifest(trip.id);
      expect(body.passengers).toHaveLength(0);
      expect(body.seats.find((s: any) => s.seatNumber === '30').status).toBe('available');
    });

    it('saves national id and notes on the passenger and shows them on the sheet', async () => {
      const { trip, booking } = await bookOne();
      const url = `${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}`;
      await request(http()).patch(url).set(staff.auth).send({ nationalId: '<script>', reason: 'تصحيح', expectedUpdatedAt: booking.updatedAt }).expect(400);
      await request(http()).patch(url).set(staff.auth).send({ nationalId: 'A45159509', notes: 'عودة من مكة', reason: 'تصحيح', expectedUpdatedAt: booking.updatedAt }).expect(200);
      const [row] = (await manifest(trip.id)).passengers;
      expect(row.nationalId).toBe('A45159509');
      expect(row.notes).toBe('عودة من مكة');
      const found = await request(http()).get(`${API}/bookings/admin/search?q=A45159509`).set(staff.auth).expect(200);
      expect(found.body.items).toHaveLength(1);
    });

    it('keeps the inventory for admins and reconciles every riyal', async () => {
      const { trip, user, booking } = await bookOne({ price: 100 }, ['5', '6', '7']);
      await request(http()).get(`${API}/manifests/${trip.id}/inventory`).set(staff.auth).expect(403);

      await prisma.user.update({ where: { id: booking.userId }, data: { walletBalance: 50 } });
      const second = await request(http())
        .post(`${API}/bookings`)
        .set(user.auth)
        .send({ paymentMethod: 'card', useWallet: true, category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['31'] }], passengers: [{ fullName: 'مسافر 4' }] })
        .expect(201);
      const third = await request(http())
        .post(`${API}/bookings`)
        .set(user.auth)
        .send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['32'] }], passengers: [{ fullName: 'مسافر 5' }] })
        .expect(201);
      await request(http()).post(`${API}/bookings/${third.body.bookings[0].id}/admin-cancel`).set(admin.auth).send({ refundAmount: 30, note: 'رسوم إلغاء' }).expect(201);

      const inv = (await request(http()).get(`${API}/manifests/${trip.id}/inventory`).set(admin.auth).expect(200)).body;
      expect(inv.totals.passengers).toBe(4);
      expect(inv.totals.wallet).toBe(50);
      expect(inv.totals.network).toBe(Number(booking.totalPrice) + Number(second.body.bookings[0].totalPrice) - 50);
      expect(inv.totals.retained).toBe(Number(third.body.bookings[0].totalPrice) - 30);
      expect(inv.totals.income).toBe(inv.totals.network + inv.totals.wallet + inv.totals.retained);
      expect(inv.rows.reduce((sum: number, r: any) => sum + r.price, 0)).toBe(Number(booking.totalPrice) + Number(second.body.bookings[0].totalPrice));
      expect(inv.places[0].place).toBe('التطبيق');
      expect(inv.totals.net).toBe(inv.totals.income);
    });
  });

  describe('search and export', () => {
    it('finds a passenger and reports the amount per seat', async () => {
      const { trip, booking } = await bookOne({}, ['5', '6']);
      const res = await request(http()).get(`${API}/bookings/admin/search?q=${encodeURIComponent(trip.tripCode)}`).set(staff.auth).expect(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].bookingId).toBe(booking.id);
      expect(res.body.items[0].tripCode).toBe(trip.tripCode);
      expect(res.body.items[0].price + res.body.items[1].price).toBe(Number(booking.totalPrice));
      await request(http()).get(`${API}/bookings/admin/search?q=R`).set(staff.auth).expect(400);
    });

    it('filters by boarding, payment and month', async () => {
      const { trip, booking } = await bookOne();
      const list = (qs: string) => request(http()).get(`${API}/bookings/admin/all?tripId=${trip.id}&${qs}`).set(staff.auth).expect(200);
      expect((await list('boarding=WAITING')).body.total).toBe(1);
      expect((await list('boarding=BOARDED')).body.total).toBe(0);
      expect((await list('payment=PAID')).body.total).toBe(1);
      expect((await list('payment=PENDING')).body.total).toBe(0);
      expect((await list('month=2001-01')).body.total).toBe(0);
      await request(http()).get(`${API}/bookings/admin/all?payment=HACK`).set(staff.auth).expect(400);
      expect(booking.id).toBeDefined();
    });

    it('neutralizes spreadsheet formulas in the export and audits it', async () => {
      const { user, trip } = await bookOne();
      await prisma.user.update({ where: { id: user.user?.id ?? (await prisma.user.findUniqueOrThrow({ where: { phone: user.phone } })).id }, data: { name: '=HYPERLINK("http://evil")' } });
      const res = await request(http()).get(`${API}/bookings/admin/export?tripId=${trip.id}`).set(admin.auth).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(await prisma.auditLog.count({ where: { action: 'GET /bookings/admin/export' } })).toBeGreaterThan(0);
    });
  });
});

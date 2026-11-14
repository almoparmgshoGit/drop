import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

// The smallest valid PNG: the signature is what the upload checks.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe('Customer photos, complaints and roommates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const book = async (trip: any, seats: string[], user?: any, roomChoice?: string) => {
    const session = user ?? (await loginPassenger(app));
    const res = await request(http())
      .post(`${API}/bookings`)
      .set(session.auth)
      .send({ paymentMethod: 'mada', ...(seats.length === 1 ? { category: 'SINGLES' } : {}), legs: [{ tripId: trip.id, seats, ...(roomChoice && { roomChoice }) }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })) })
      .expect(201);
    return { user: session, booking: res.body.bookings[0] };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('photo', () => {
    it('lets the customer set, read and remove their own photo, and refuses what is not an image', async () => {
      const user = await loginPassenger(app);
      await request(http()).get(`${API}/users/profile/photo`).set(user.auth).expect(404);
      await request(http()).put(`${API}/users/profile/photo`).set(user.auth).attach('photo', Buffer.from('<svg/>'), 'x.png').expect(400);

      const set = await request(http()).put(`${API}/users/profile/photo`).set(user.auth).attach('photo', PNG, 'me.png').expect(200);
      expect(set.body.photoUpdatedAt).toBeTruthy();
      const profile = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(profile.body.photoUpdatedAt).toBe(set.body.photoUpdatedAt);
      const photo = await request(http()).get(`${API}/users/profile/photo`).set(user.auth).expect(200);
      expect(photo.headers['content-type']).toContain('image/png');

      await request(http()).get(`${API}/users/${profile.body.id}/photo`).set(admin.auth).expect(200);
      await request(http()).get(`${API}/users/${profile.body.id}/photo`).set(user.auth).expect(403);

      await request(http()).delete(`${API}/users/profile/photo`).set(user.auth).expect(200);
      await request(http()).get(`${API}/users/profile/photo`).set(user.auth).expect(404);
    });

    it('lets staff set a customer photo but leaves an employee photo to HR', async () => {
      const user = await loginPassenger(app);
      const { body: me } = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      await request(http()).put(`${API}/users/${me.id}/photo`).set(admin.auth).attach('photo', PNG, 'c.png').expect(200);
      const employee = await createStaff(prisma, 'STAFF');
      await request(http()).put(`${API}/users/${employee.id}/photo`).set(admin.auth).attach('photo', PNG, 'e.png').expect(403);
    });
  });

  describe('complaints', () => {
    it('takes a complaint about the app, tells staff, and lets staff answer it', async () => {
      const user = await loginPassenger(app);
      await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'APP', details: 'x' }).expect(400);
      const { body } = await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'APP', details: 'التطبيق يتوقف عند الدفع' }).expect(201);
      expect(body.reference).toMatch(/^C-\d+$/);

      await request(http()).get(`${API}/complaints`).set(user.auth).expect(403);
      const list = await request(http()).get(`${API}/complaints`).set(admin.auth).query({ status: 'OPEN', search: body.reference }).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.openByCategory.APP).toBeGreaterThanOrEqual(1);

      await request(http()).post(`${API}/complaints/${body.id}/resolve`).set(admin.auth).send({ resolution: 'أصلحنا المشكلة في التحديث الأخير' }).expect(201);
      await request(http()).post(`${API}/complaints/${body.id}/resolve`).set(admin.auth).send({ resolution: 'مرة أخرى' }).expect(409);

      const mine = await request(http()).get(`${API}/complaints/mine`).set(user.auth).expect(200);
      expect(mine.body.complaints[0]).toMatchObject({ status: 'RESOLVED', resolution: 'أصلحنا المشكلة في التحديث الأخير' });
      expect(mine.body.complaints[0].resolvedByName).toBeUndefined();
      const { body: me } = await request(http()).get(`${API}/users/profile`).set(user.auth).expect(200);
      expect(await prisma.notification.count({ where: { userId: me.id, event: 'CUSTOMER_COMPLAINT_RESOLVED' } })).toBe(1);

      await request(http()).post(`${API}/complaints/${body.id}/reopen`).set(admin.auth).expect(201);
    });

    it('needs the customer\'s own booking for a trip or supervisor complaint, and copies the supervisors', async () => {
      const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      const { user, booking } = await book(trip, ['30']);
      const stranger = await loginPassenger(app);

      await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'TRIP', details: 'تأخر الباص كثيرًا' }).expect(400);
      await request(http()).post(`${API}/complaints`).set(stranger.auth).send({ category: 'TRIP', bookingId: booking.id, details: 'تأخر الباص كثيرًا' }).expect(400);
      // No supervisor on the trip yet, so there is nobody to complain about.
      await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'SUPERVISOR', bookingId: booking.id, details: 'تعامل غير لائق' }).expect(400);

      const supervisor = await createStaff(prisma, 'STAFF');
      await prisma.user.update({ where: { id: supervisor.id }, data: { name: 'سالم المشرف' } });
      await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: supervisor.id, isPrimary: true } });

      const mine = await request(http()).get(`${API}/complaints/mine`).set(user.auth).expect(200);
      expect(mine.body.bookings.find((b: any) => b.id === booking.id).supervisors).toEqual(['سالم المشرف']);

      await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'SUPERVISOR', bookingId: booking.id, details: 'تعامل غير لائق' }).expect(201);
      const saved = await prisma.customerComplaint.findFirstOrThrow({ where: { bookingId: booking.id, category: 'SUPERVISOR' } });
      expect(saved).toMatchObject({ tripCode: trip.tripCode, supervisorNames: 'سالم المشرف' });
    });

    it('caps how many open complaints one customer can have', async () => {
      const user = await loginPassenger(app);
      for (let i = 0; i < 5; i++) await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'OTHER', details: `ملاحظة رقم ${i}` }).expect(201);
      await request(http()).post(`${API}/complaints`).set(user.auth).send({ category: 'OTHER', details: 'ملاحظة زائدة' }).expect(409);
    });
  });

  describe('roommates', () => {
    it('gives each customer in a shared room the names of the others, and nothing else about them', async () => {
      const hotel = (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: 'فندق الشركاء', city: 'مكة', nightlyRate: 50 }).expect(201)).body;
      const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ bookingType: 'WITH_HOTEL', housingPrice: 40 })).expect(201)).body;
      const first = await book(trip, ['27'], undefined, 'SHARED');
      const second = await book(trip, ['28'], undefined, 'SHARED');

      await request(http()).post(`${API}/hotels/assign-booking`).set(admin.auth).send({ bookingId: first.booking.id, hotelId: hotel.id, roomNumber: '301', roomType: 'SHARED' }).expect(201);
      await request(http()).post(`${API}/hotels/assign-booking`).set(admin.auth).send({ bookingId: second.booking.id, hotelId: hotel.id, roomNumber: '301', roomType: 'SHARED' }).expect(201);

      const seenByFirst = await request(http()).get(`${API}/bookings/${first.booking.id}`).set(first.user.auth).expect(200);
      expect(seenByFirst.body.passengers[0].roommates).toEqual(['مسافر 28']);
      expect(JSON.stringify(seenByFirst.body)).not.toContain(second.booking.passengers[0].id);
      const seenBySecond = await request(http()).get(`${API}/bookings/${second.booking.id}`).set(second.user.auth).expect(200);
      expect(seenBySecond.body.passengers[0].roommates).toEqual(['مسافر 27']);

      // Both bookings hear who joined: the one already there and the one moving in.
      const told = await prisma.notification.findMany({ where: { event: 'ROOMMATES_UPDATED', bookingId: { in: [first.booking.id, second.booking.id] } } });
      expect(told.map((n) => n.bookingId).sort()).toEqual([first.booking.id, second.booking.id].sort());
      expect(told.find((n) => n.bookingId === first.booking.id)!.body).toContain('مسافر 28');
    });
  });
});

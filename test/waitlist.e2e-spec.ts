import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { WaitlistService } from '../src/common/services/waitlist.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Waiting list (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const book = (user: any, tripId: string, seats: string[]) =>
    request(http())
      .post(`${API}/bookings`)
      .set(user.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId, seats }], passengers: seats.map((_, i) => ({ fullName: `مسافر ${i + 1}` })) });
  /** Every seat but the ones given is sold, as if other customers had bought them. */
  const fillExcept = async (tripId: string, keep: string[]) => {
    await prisma.seat.updateMany({ where: { tripId, seatNumber: { notIn: keep } }, data: { isBooked: true } });
    const free = await prisma.seat.count({ where: { tripId, isBooked: false } });
    await prisma.trip.update({ where: { id: tripId }, data: { availableSeats: free } });
  };
  const join = (user: any, tripId: string, seats: number) => request(http()).post(`${API}/waitlist`).set(user.auth).send({ tripId, seats });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    waitlist = app.get(WaitlistService);
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses the waiting list while seats are free', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    await join(user, trip.id, 2).expect(400);
  });

  it('queues customers in order and offers a cancelled seat to the first who fits', async () => {
    const trip = await createTrip();
    const holder = await loginPassenger(app);
    const booked = (await book(holder, trip.id, ['1']).expect(201)).body.bookings[0];
    await fillExcept(trip.id, []);

    const big = await loginPassenger(app);
    const small = await loginPassenger(app);
    const bigEntry = (await join(big, trip.id, 2).expect(201)).body;
    const smallEntry = (await join(small, trip.id, 1).expect(201)).body;
    expect(bigEntry).toMatchObject({ status: 'WAITING', queuePlace: 1 });
    expect(smallEntry).toMatchObject({ status: 'WAITING', queuePlace: 2 });
    await join(small, trip.id, 1).expect(409);

    // One seat frees up: the first entry needs two, so the second, who fits, is offered it.
    await request(http()).post(`${API}/bookings/${booked.id}/admin-cancel`).set(admin.auth).send({ note: 'إلغاء للاختبار' }).expect(201);
    const offered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: smallEntry.id } });
    expect(offered).toMatchObject({ status: 'OFFERED', heldSeats: ['1'] });
    expect(offered.expiresAt!.getTime() - offered.offeredAt!.getTime()).toBe(30 * 60_000);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: bigEntry.id } })).status).toBe('WAITING');
    const seat = await prisma.seat.findFirstOrThrow({ where: { tripId: trip.id, seatNumber: '1' } });
    expect(seat.heldByUserId).toBe(small.user.id);
    expect(await prisma.notification.count({ where: { event: 'WAITLIST_OFFERED', tripId: trip.id } })).toBe(1);

    // Nobody else can take the held seat; the offered customer books it and leaves the queue.
    await book(await loginPassenger(app), trip.id, ['1']).expect(409);
    await book(small, trip.id, ['1']).expect(201);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: smallEntry.id } })).status).toBe('BOOKED');

    const mine = await request(http()).get(`${API}/waitlist/mine`).set(big.auth).expect(200);
    expect(mine.body).toEqual([expect.objectContaining({ id: bigEntry.id, status: 'WAITING', queuePlace: 1 })]);
  });

  it('passes an unbooked offer to the next in line when its window ends', async () => {
    const trip = await createTrip();
    await fillExcept(trip.id, []);
    const first = await loginPassenger(app);
    const second = await loginPassenger(app);
    const a = (await join(first, trip.id, 1).expect(201)).body;
    const b = (await join(second, trip.id, 1).expect(201)).body;

    // A seat frees without a cancellation (say, a bigger bus): the sweep offers it.
    await prisma.seat.updateMany({ where: { tripId: trip.id, seatNumber: '7' }, data: { isBooked: false } });
    await waitlist.sweep();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('OFFERED');

    // The window ran out: the entry and the seat it held both end at the same moment.
    const past = new Date(Date.now() - 1000);
    await prisma.waitlistEntry.update({ where: { id: a.id }, data: { expiresAt: past } });
    await prisma.seat.updateMany({ where: { tripId: trip.id, seatNumber: '7' }, data: { heldUntil: past } });
    await waitlist.sweep();
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('EXPIRED');
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('OFFERED');
    expect(await prisma.notification.count({ where: { event: 'WAITLIST_EXPIRED', tripId: trip.id } })).toBe(1);
  });

  it('lets the customer leave and staff offer or remove entries', async () => {
    const trip = await createTrip();
    await fillExcept(trip.id, []);
    const customer = await loginPassenger(app);
    const other = await loginPassenger(app);
    const mine = (await join(customer, trip.id, 1).expect(201)).body;
    const theirs = (await join(other, trip.id, 1).expect(201)).body;

    await request(http()).delete(`${API}/waitlist/${theirs.id}`).set(customer.auth).expect(404);
    await request(http()).delete(`${API}/waitlist/${mine.id}`).set(customer.auth).expect(200);
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('CANCELLED');

    await request(http()).get(`${API}/waitlist/admin/trip/${trip.id}`).set(customer.auth).expect(403);
    // No free seat yet: offering by hand is refused.
    await request(http()).post(`${API}/waitlist/admin/${theirs.id}/offer`).set(admin.auth).expect(400);
    await prisma.seat.updateMany({ where: { tripId: trip.id, seatNumber: '3' }, data: { isBooked: false } });
    const offered = await request(http()).post(`${API}/waitlist/admin/${theirs.id}/offer`).set(admin.auth).expect(201);
    expect(offered.body).toMatchObject({ status: 'OFFERED', heldSeats: ['3'] });

    const list = await request(http()).get(`${API}/waitlist/admin/trip/${trip.id}`).set(admin.auth).expect(200);
    expect(list.body.map((row: any) => row.status)).toEqual(['OFFERED', 'CANCELLED']);

    await request(http()).delete(`${API}/waitlist/admin/${theirs.id}`).set(admin.auth).expect(200);
    const seat = await prisma.seat.findFirstOrThrow({ where: { tripId: trip.id, seatNumber: '3' } });
    expect(seat.heldByUserId).toBeNull();
  });

  it('honours the offer window setting and the switch', async () => {
    await request(http()).put(`${API}/settings`).set(admin.auth).send({ waitlistOfferMinutes: 45 }).expect(200);
    const trip = await createTrip();
    await fillExcept(trip.id, ['9']);
    // Seat 9 is held by someone else for now, so the trip is full to anyone asking.
    const holder = await loginPassenger(app);
    await request(http()).post(`${API}/bookings/holds`).set(holder.auth).send({ tripId: trip.id, seats: ['9'] }).expect(201);
    const customer = await loginPassenger(app);
    const entry = (await join(customer, trip.id, 1).expect(201)).body;
    await request(http()).delete(`${API}/bookings/holds`).set(holder.auth).send({ tripId: trip.id }).expect(200);
    await waitlist.sweep();
    const offered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(offered.expiresAt!.getTime() - offered.offeredAt!.getTime()).toBe(45 * 60_000);

    await request(http()).put(`${API}/settings`).set(admin.auth).send({ waitlistEnabled: false }).expect(200);
    await join(await loginPassenger(app), trip.id, 1).expect(400);
    await request(http()).put(`${API}/settings`).set(admin.auth).send({ waitlistEnabled: true, waitlistOfferMinutes: 30 }).expect(200);
  });
});

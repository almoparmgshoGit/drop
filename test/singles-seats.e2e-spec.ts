import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Singles seats set on the bus (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let plate = 0;

  const createBus = async (from: number, to: number) =>
    (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `ع ز ${++plate}`, model: 'VIP', singlesFromSeat: from, singlesToSeat: to }).expect(201)).body;
  const createTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const bookReq = (user: any, tripId: string, seat: string, category = 'SINGLES') =>
    request(http()).post(`${API}/bookings`).set(user.auth)
      .send({ paymentMethod: 'mada', category, legs: [{ tripId, seats: [seat] }], passengers: [{ fullName: 'راكب' }] });
  const seatMap = async (user: any, tripId: string) => (await request(http()).get(`${API}/bookings/seat-map/${tripId}`).set(user.auth).expect(200)).body;
  const assign = (tripId: string, busId: string) => request(http()).put(`${API}/trips/${tripId}`).set(admin.auth).send({ busId });
  const settings = (body: object) => request(http()).put(`${API}/settings`).set(admin.auth).send(body);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('checks the range against the fixed plan when a bus is saved', async () => {
    const bus = await createBus(25, 44);
    expect(bus).toMatchObject({ singlesFromSeat: 25, singlesToSeat: 44 });
    const send = (body: object) => request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `ع ز ${++plate}`, model: 'VIP', ...body });
    await send({ singlesFromSeat: 30, singlesToSeat: 20 }).expect(400);
    await send({ singlesFromSeat: 0, singlesToSeat: 20 }).expect(400);
    await send({ singlesFromSeat: 25, singlesToSeat: 50 }).expect(400);
    await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ singlesFromSeat: 45 }).expect(400);
  });

  it('holds singles inside both ends of the range, and leaves families free', async () => {
    const bus = await createBus(25, 44);
    const trip = await createTrip({ busId: bus.id });
    const user = await loginPassenger(app);
    await bookReq(user, trip.id, '24').expect(400);
    await bookReq(user, trip.id, '45').expect(400);
    await bookReq(user, trip.id, '25').expect(201);
    await bookReq(user, trip.id, '44').expect(201);
    await bookReq(user, trip.id, '1', 'FAMILY').expect(201);
    await bookReq(user, trip.id, '49', 'FAMILY').expect(201);
    expect(await seatMap(user, trip.id)).toMatchObject({ singlesFromSeat: 25, singlesToSeat: 44 });

    await request(http()).post(`${API}/bookings/holds`).set(user.auth).send({ tripId: trip.id, seats: ['46'], category: 'SINGLES' }).expect(400);
  });

  it('follows the settings until a bus is assigned, then the bus', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    expect(await seatMap(user, trip.id)).toMatchObject({ singlesFromSeat: 26, singlesToSeat: 49 });
    await bookReq(user, trip.id, '30').expect(201);

    const bus = await createBus(25, 44);
    await assign(trip.id, bus.id).expect(200);
    expect(await seatMap(user, trip.id)).toMatchObject({ singlesFromSeat: 25, singlesToSeat: 44 });
    await bookReq(user, trip.id, '25').expect(201);
    await bookReq(user, trip.id, '49').expect(400);
  });

  it('refuses a bus that leaves a singles passenger outside its range, until they are moved', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    const booking = (await bookReq(user, trip.id, '48').expect(201)).body.bookings[0];

    const bus = await createBus(25, 44);
    const refused = await assign(trip.id, bus.id).expect(409);
    expect(refused.body.message).toContain('48');
    expect(refused.body.message).toContain(trip.tripCode);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).busId).toBeNull();

    const passenger = booking.passengers[0];
    await request(http()).post(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}/seat`).set(admin.auth)
      .send({ seatNumber: '30', reason: 'نقل لنطاق الباص', expectedUpdatedAt: (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).updatedAt })
      .expect((res) => expect(res.status).toBeLessThan(300));
    await assign(trip.id, bus.id).expect(200);
  });

  it('ignores families when a bus or range changes', async () => {
    const trip = await createTrip();
    await bookReq(await loginPassenger(app), trip.id, '2', 'FAMILY').expect(201);
    await assign(trip.id, (await createBus(25, 44)).id).expect(200);
  });

  it('refuses editing a bus range under a singles passenger on its open trips', async () => {
    const bus = await createBus(25, 44);
    const trip = await createTrip({ busId: bus.id });
    await bookReq(await loginPassenger(app), trip.id, '40').expect(201);
    await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ singlesToSeat: 35 }).expect(409);
    await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ singlesToSeat: 42 }).expect(200);
  });

  it('checks the settings range too, against trips with no bus yet', async () => {
    await settings({ defaultSinglesFromSeat: 40, defaultSinglesToSeat: 30 }).expect(400);
    await settings({ defaultSinglesToSeat: 50 }).expect(400);

    const trip = await createTrip();
    const booking = (await bookReq(await loginPassenger(app), trip.id, '27').expect(201)).body.bookings[0];
    await settings({ defaultSinglesFromSeat: 28 }).expect(409);
    await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار' }).expect(201);
    await settings({ defaultSinglesFromSeat: 28 }).expect((res) => expect(res.status).toBeLessThan(300));

    // A later bus-less trip reads the saved settings.
    const user = await loginPassenger(app);
    expect(await seatMap(user, (await createTrip()).id)).toMatchObject({ singlesFromSeat: 28, singlesToSeat: 49 });
    await settings({ defaultSinglesFromSeat: 26 }).expect((res) => expect(res.status).toBeLessThan(300));
  });

  it('checks the reverse as well when the outbound takes a new bus', async () => {
    const departure = Date.now() + 90 * 86_400_000;
    const trip = await createTrip({
      departureTime: new Date(departure).toISOString(),
      arrivalTime: new Date(departure + 5 * 3_600_000).toISOString(),
      direction: 'ONE_WAY',
      reverseEnabled: true,
      reverseOpenPercent: 1,
      reverseDepartureAt: new Date(departure + 8 * 3_600_000).toISOString(),
      reversePrice: 90,
    });
    await bookReq(await loginPassenger(app), trip.id, '30').expect(201);
    const reverse = (await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send({ boardingPointName: 'مكة' }).expect(201)).body;
    await bookReq(await loginPassenger(app), reverse.id, '48').expect(201);

    await assign(trip.id, (await createBus(25, 44)).id).expect(409);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).busId).toBeNull();
  });
});

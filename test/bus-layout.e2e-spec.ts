import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { BUS_SEAT_COUNT, BUS_SEAT_LAYOUT, BUS_SEAT_NUMBERS } from '../src/common/utils/bus-layout.util';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Fixed bus plan (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('matches the plan the client supplied', () => {
    expect(BUS_SEAT_COUNT).toBe(49);
    expect(BUS_SEAT_NUMBERS).toEqual(Array.from({ length: 49 }, (_, idx) => String(idx + 1)));
    expect(BUS_SEAT_LAYOUT).toHaveLength(13);
    expect(BUS_SEAT_LAYOUT[0]).toEqual(['1', '2', null, '3', '4']);
    // The gap beside the middle door, on the same side as seats 1 and 2.
    expect(BUS_SEAT_LAYOUT[4]).toEqual(['17', '18', null, '19', '20']);
    expect(BUS_SEAT_LAYOUT[5]).toEqual([null, null, null, '21', '22']);
    expect(BUS_SEAT_LAYOUT[6]).toEqual([null, null, null, '23', '24']);
    expect(BUS_SEAT_LAYOUT[7]).toEqual(['25', '26', null, '27', '28']);
    // Only the back row fills the aisle.
    expect(BUS_SEAT_LAYOUT[12]).toEqual(['45', '46', '47', '48', '49']);
  });

  it('gives every trip the whole bus and takes no seat count from anyone', async () => {
    const bus = (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'خ ط 1', model: 'VIP' }).expect(201)).body;
    expect(bus.totalSeats).toBeUndefined();
    const trip = await createTrip({ busId: bus.id });
    expect(trip.totalSeats).toBe(49);
    expect(await prisma.seat.count({ where: { tripId: trip.id } })).toBe(49);

    await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ totalSeats: 20 })).expect(400);
    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ totalSeats: 20 }).expect(400);
    await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'خ ط 2', model: 'VIP', totalSeats: 49 }).expect(400);
  });

  it('refuses a seat that is not on the plan', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    await request(http()).post(`${API}/bookings`).set(user.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '50'] }], passengers: [{ fullName: 'راكب' }, { fullName: 'مرافق' }] })
      .expect(409);
  });

  it('sends the same plan to the app, the branch counter, the seat change screen and the manifest', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    const booked = await request(http()).post(`${API}/bookings`).set(user.auth)
      .send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['30'] }], passengers: [{ fullName: 'راكب' }] })
      .expect(201);

    const plan = JSON.parse(JSON.stringify(BUS_SEAT_LAYOUT));
    const app_ = (await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(user.auth).expect(200)).body;
    expect(app_.layout).toEqual(plan);
    expect(app_).toMatchObject({ singlesFromSeat: 26, singlesToSeat: 49 });
    expect(app_.seats.find((seat: any) => seat.seatNumber === '30').status).toBe('booked');
    expect((await request(http()).get(`${API}/branch-bookings/trips/${trip.id}/seats`).set(admin.auth).expect(200)).body.layout).toEqual(plan);
    expect((await request(http()).get(`${API}/bookings/admin/${booked.body.bookings[0].id}/seat-map`).set(admin.auth).expect(200)).body.layout).toEqual(plan);
    expect((await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200)).body.layout).toEqual(plan);
  });

  it('keeps the singles section on a reverse that sells only part of the bus', async () => {
    const departure = Date.now() + 40 * 86_400_000;
    const trip = await createTrip({
      direction: 'ROUND_TRIP',
      departureTime: new Date(departure).toISOString(),
      arrivalTime: new Date(departure + 5 * 3_600_000).toISOString(),
    });
    // Switched on after publishing, so the way back is opened by hand below, after the outbound sold these seats.
    await prisma.trip.update({ where: { id: trip.id }, data: { reverseEnabled: true, reverseOpenPercent: 1, reverseDepartureAt: new Date(departure + 8 * 3_600_000), reversePrice: 90 } });
    const user = await loginPassenger(app);
    const seats = Array.from({ length: 5 }, (_, idx) => String(idx + 26));
    await request(http()).post(`${API}/bookings`).set(user.auth)
      .send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: trip.id, seats }], passengers: seats.map((seat) => ({ fullName: `راكب ${seat}` })) })
      .expect(201);
    const reverse = (await request(http()).post(`${API}/trips/${trip.id}/open-reverse`).set(admin.auth).send({ boardingPointName: 'مكة' }).expect(201)).body;

    const map = (await request(http()).get(`${API}/bookings/seat-map/${reverse.id}`).set(user.auth).expect(200)).body;
    expect(map).toMatchObject({ singlesFromSeat: 26, singlesToSeat: 49 });
    expect(map.seats.map((seat: any) => seat.seatNumber)).not.toContain('26');
    const other = await loginPassenger(app);
    await request(http()).post(`${API}/bookings`).set(other.auth)
      .send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: reverse.id, seats: ['1'] }], passengers: [{ fullName: 'راكب' }] })
      .expect(400);
  });
});

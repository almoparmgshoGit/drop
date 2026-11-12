import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Package group prices and crew on the same day', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let customer: { auth: Record<string, string> };
  const http = () => app.getHttpServer();

  const sameTime = () => {
    const departure = new Date(Date.now() + 20 * 86_400_000);
    return { departureTime: departure.toISOString(), arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString() };
  };
  const createTrip = (overrides: Record<string, unknown>) => request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides));
  const createPackage = (body: Record<string, unknown>) =>
    request(http()).post(`${API}/packages`).set(admin.auth).send({ name: 'باقة العائلة', status: 'PUBLISHED', ...body });
  const quote = (tripId: string, seats: string[]) => request(http()).post(`${API}/bookings/quote`).set(customer.auth).send({ legs: [{ tripId, seats }] });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    customer = await loginPassenger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('crew', () => {
    it('lets one supervisor look after two trips at the same time', async () => {
      const supervisor = await createStaff(prisma, 'STAFF');
      const when = sameTime();
      await createTrip({ ...when, supervisorIds: [supervisor.id] }).expect(201);
      await createTrip({ ...when, supervisorIds: [supervisor.id] }).expect(201);
    });

    it('lets one trip have several supervisors', async () => {
      const [first, second, third] = await Promise.all([createStaff(prisma, 'STAFF'), createStaff(prisma, 'STAFF'), createStaff(prisma, 'STAFF')]);
      const res = await createTrip({ ...sameTime(), supervisorIds: [first.id, second.id, third.id] }).expect(201);
      expect(res.body.supervisors).toHaveLength(3);
    });

    it('still keeps a driver to one trip at a time', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const when = sameTime();
      await createTrip({ ...when, driverIds: [driver.id] }).expect(201);
      await createTrip({ ...when, driverIds: [driver.id] }).expect(409);
    });

    it('does not make someone a supervisor while they drive another trip at that time', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const when = sameTime();
      await createTrip({ ...when, driverIds: [driver.id] }).expect(201);
      const res = await createTrip({ ...when, supervisorIds: [driver.id] });
      // Either the rank cannot supervise or the clash refuses it; never two trips at once.
      expect([400, 409]).toContain(res.status);
    });
  });

  describe('package prices', () => {
    it('fills the group totals from the one-person price when they are left out', async () => {
      const res = await createPackage({ price: 1000 }).expect(201);
      expect(res.body).toMatchObject({ price: '1000', price2: '2000', price3: '3000', price4: '4000' });
    });

    it('refuses a bigger group paying less than a smaller one', async () => {
      await createPackage({ price: 1000, price2: 1800, price3: 1700, price4: 3000 }).expect(400);
    });

    it('charges the total for the group size and takes at most four people', async () => {
      const pkg = (await createPackage({ price: 1500, price2: 2600, price3: 3600, price4: 4400 }).expect(201)).body;
      const trip = (await createTrip({ packageId: pkg.id, maxSeatsPerBooking: 6 }).expect(201)).body;

      expect((await quote(trip.id, ['1']).expect(201)).body.legs[0]).toMatchObject({ seatsSubtotal: 1500, isPackage: true });
      expect((await quote(trip.id, ['1', '2', '3']).expect(201)).body.legs[0].seatsSubtotal).toBe(3600);
      expect((await quote(trip.id, ['1', '2', '3', '4']).expect(201)).body.subtotal).toBe(4400);
      await quote(trip.id, ['1', '2', '3', '4', '5']).expect(400);

      const listed = (await request(http()).get(`${API}/packages/${pkg.id}`).expect(200)).body;
      expect(listed.priceTiers).toEqual([
        { persons: 1, total: 1500 },
        { persons: 2, total: 2600 },
        { persons: 3, total: 3600 },
        { persons: 4, total: 4400 },
      ]);

      const seatMap = (await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(customer.auth).expect(200)).body;
      expect(seatMap.maxSeatsPerBooking).toBe(4);
      expect(seatMap.packagePriceTiers).toHaveLength(4);
    });
  });
});

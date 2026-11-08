import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const dateOf = (when: Date) => new Date(when.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('Packages shown to customers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };

  const http = () => app.getHttpServer();
  const search = async (query: Record<string, string> = {}) => (await request(http()).get(`${API}/packages`).query(query).expect(200)).body;
  const makePackage = async (overrides: object = {}) =>
    (await request(http()).post(`${API}/packages`).set(admin.auth).send({ name: 'باقة العمرة', price: 720, status: 'PUBLISHED', ...overrides }).expect(201)).body;
  const makeTrip = async (packageId: string | undefined, daysAhead: number, overrides: object = {}) => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ packageId, origin: 'الرياض', destination: 'مكة المكرمة', ...overrides })).expect(201)).body;
    const departureTime = new Date(Date.now() + daysAhead * DAY);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime, arrivalTime: new Date(departureTime.getTime() + 5 * 3_600_000) } });
    return { id: trip.id as string, date: dateOf(departureTime), departureTime };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.trip.deleteMany();
    await prisma.package.deleteMany();
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  it('hides a package with no trip assigned', async () => {
    await makePackage();
    expect(await search()).toEqual([]);
  });

  it('hides a package whose only trip the customer cannot book', async () => {
    const draft = await makePackage({ name: 'مسودة' });
    await makeTrip(draft.id, 5, { tripStatus: 'DRAFT' });
    const branchOnly = await makePackage({ name: 'فروع فقط' });
    await makeTrip(branchOnly.id, 5, { channelApp: false });
    const departed = await makePackage({ name: 'انتهت رحلته' });
    await makeTrip(departed.id, -1);
    expect(await search()).toEqual([]);
  });

  it('hides an unpublished package even with a trip', async () => {
    const pkg = await makePackage({ status: 'DRAFT' });
    await makeTrip(pkg.id, 5);
    expect(await search()).toEqual([]);
  });

  it('shows a package only when one of its trips matches the route and day searched', async () => {
    const pkg = await makePackage();
    const trip = await makeTrip(pkg.id, 5);
    const route = { origin: 'الرياض', destination: 'مكة المكرمة' };

    const found = await search({ ...route, date: trip.date });
    expect(found.map((row: any) => row.id)).toEqual([pkg.id]);

    expect(await search({ ...route, date: dateOf(new Date(trip.departureTime.getTime() + DAY)) })).toEqual([]);
    expect(await search({ origin: 'جدة', destination: 'مكة المكرمة', date: trip.date })).toEqual([]);
    expect(await search({ origin: 'الرياض', destination: 'المدينة المنورة', date: trip.date })).toEqual([]);
  });

  it('lists only the trips that match, not the package’s other trips', async () => {
    const pkg = await makePackage();
    const wanted = await makeTrip(pkg.id, 5);
    await makeTrip(pkg.id, 9);
    await makeTrip(pkg.id, 5, { origin: 'جدة' });

    const [found] = await search({ origin: 'الرياض', destination: 'مكة المكرمة', date: wanted.date });
    expect(found.trips.map((trip: any) => trip.id)).toEqual([wanted.id]);
  });

  it('leaves out packages that do not match while keeping those that do', async () => {
    const riyadh = await makePackage({ name: 'من الرياض' });
    const trip = await makeTrip(riyadh.id, 5);
    const jeddah = await makePackage({ name: 'من جدة' });
    await makeTrip(jeddah.id, 5, { origin: 'جدة' });
    const empty = await makePackage({ name: 'بلا رحلة' });

    const found = await search({ origin: 'الرياض', destination: 'مكة المكرمة', date: trip.date });
    expect(found.map((row: any) => row.id)).toEqual([riyadh.id]);
    expect(found.map((row: any) => row.id)).not.toContain(empty.id);
  });

  it('does not hide or show packages because of a trip without a package', async () => {
    const trip = await makeTrip(undefined, 5);
    expect(await search({ origin: 'الرياض', destination: 'مكة المكرمة', date: trip.date })).toEqual([]);
  });

  it('prices the trip at the package price and keeps costs out of the public response', async () => {
    const pkg = await makePackage({ price: 720 });
    const trip = await makeTrip(pkg.id, 5, { price: 100 });
    await prisma.trip.update({ where: { id: trip.id }, data: { busRentalPrice: 3000, housingPrice: 40 } });

    const [found] = await search({ date: trip.date });
    expect(found.trips[0].pricePerSeat).toBe(720);
    for (const field of ['busRentalPrice', 'housingPrice', 'reversePrice', 'channelBranch']) expect(found.trips[0]).not.toHaveProperty(field);

    const byId = await request(http()).get(`${API}/packages/${pkg.id}`).expect(200);
    expect(byId.body.trips[0]).not.toHaveProperty('busRentalPrice');
  });

  it('does not open a package with no bookable trip by its id', async () => {
    const pkg = await makePackage();
    await request(http()).get(`${API}/packages/${pkg.id}`).expect(404);
  });

  it('rejects a malformed date', async () => {
    await request(http()).get(`${API}/packages`).query({ date: 'tomorrow' }).expect(400);
  });

  describe('next available day', () => {
    const next = async (query: Record<string, string>) => (await request(http()).get(`${API}/packages/next-available`).query(query).expect(200)).body.departureTime;
    const route = { origin: 'الرياض', destination: 'مكة المكرمة' };

    it('finds the next package trip on the route after the chosen day', async () => {
      const pkg = await makePackage();
      const soon = await makeTrip(pkg.id, 5);
      const later = await makeTrip(pkg.id, 9);

      expect(new Date(await next({ ...route })).getTime()).toBe(soon.departureTime.getTime());
      expect(new Date(await next({ ...route, after: soon.date })).getTime()).toBe(later.departureTime.getTime());
    });

    it('ignores trips with no package, an unpublished package, another route, or no seats', async () => {
      await makeTrip(undefined, 3);
      const draft = await makePackage({ status: 'DRAFT' });
      await makeTrip(draft.id, 4);
      const pkg = await makePackage();
      await makeTrip(pkg.id, 5, { origin: 'جدة' });
      const full = await makeTrip(pkg.id, 6);
      await prisma.trip.update({ where: { id: full.id }, data: { availableSeats: 0 } });

      expect(await next(route)).toBeNull();
    });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { riyadhDate } from '../src/common/utils/time.util';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Operations board and availability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let plateCounter = 0;

  const createTrip = async (overrides: Record<string, unknown> = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const createBus = async () =>
    (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `OPS-${++plateCounter}`, model: 'Visero' }).expect(201)).body;
  const availability = (query: Record<string, string>) => request(http()).get(`${API}/trips/admin/availability`).set(admin.auth).query(query);
  const board = (query: Record<string, string>) => request(http()).get(`${API}/trips/admin/board`).set(admin.auth).query(query);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('availability', () => {
    it('lists the bus and crew another trip holds at that time, by the save-time rules', async () => {
      const bus = await createBus();
      const driver = await createStaff(prisma, 'DRIVER');
      const supervisor = await createStaff(prisma, 'STAFF');
      const base = tripPayload({ busId: bus.id, driverIds: [driver.id], supervisorIds: [supervisor.id] });
      const held = (await request(http()).post(`${API}/trips`).set(admin.auth).send(base).expect(201)).body;

      const res = await availability({ start: base.departureTime as string, end: base.arrivalTime as string }).expect(200);
      expect(res.body.buses).toEqual([expect.objectContaining({ busId: bus.id, trip: expect.objectContaining({ id: held.id, tripCode: held.tripCode }) })]);
      expect(res.body.drivers.map((row: any) => row.userId)).toContain(driver.id);
      expect(res.body.supervisors.map((row: any) => row.userId)).toContain(supervisor.id);

      // What the endpoint reports busy is what saving refuses.
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ departureTime: base.departureTime, arrivalTime: base.arrivalTime, busId: bus.id })).expect(409);
      // A supervisor may look after two trips at once, so supervising elsewhere does not block supervising this one.
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ departureTime: base.departureTime, arrivalTime: base.arrivalTime, supervisorIds: [supervisor.id] })).expect(201);
    });

    it('leaves out the trip being edited and times that do not overlap', async () => {
      const bus = await createBus();
      const trip = await createTrip({ busId: bus.id });
      const own = await availability({ start: trip.departureTime, end: trip.arrivalTime, excludeTripId: trip.id }).expect(200);
      expect(own.body.buses.map((row: any) => row.busId)).not.toContain(bus.id);

      const later = new Date(new Date(trip.arrivalTime).getTime() + 60_000);
      const after = await availability({ start: later.toISOString(), end: new Date(later.getTime() + 3_600_000).toISOString() }).expect(200);
      expect(after.body.buses.map((row: any) => row.busId)).not.toContain(bus.id);
    });

    it('lists crew on approved leave on the days of the window', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const type = await prisma.leaveType.upsert({ where: { code: 'OPS_TEST' }, update: {}, create: { code: 'OPS_TEST', name: 'إجازة اختبار لوحة التشغيل', kind: 'OTHER' } });
      const start = new Date(Date.now() + 40 * 86_400_000);
      const day = riyadhDate(start);
      await prisma.leaveRequest.create({
        data: { userId: driver.id, typeId: type.id, startDate: new Date(`${day}T00:00:00.000Z`), endDate: new Date(`${day}T00:00:00.000Z`), days: 1, status: 'APPROVED', createdById: driver.id },
      });
      const res = await availability({ start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }).expect(200);
      expect(res.body.leaves).toEqual([expect.objectContaining({ userId: driver.id, startDate: day, endDate: day })]);
    });

    it('refuses a window that ends before it starts', async () => {
      const now = Date.now();
      await availability({ start: new Date(now + 3_600_000).toISOString(), end: new Date(now).toISOString() }).expect(400);
      await availability({ start: 'nope', end: new Date(now).toISOString() }).expect(400);
    });
  });

  describe('board', () => {
    it('groups the days trips per bus and driver and flags overlapping pairs', async () => {
      const bus = await createBus();
      const driver = await createStaff(prisma, 'DRIVER');
      const first = await createTrip({ busId: bus.id, driverIds: [driver.id] });
      // Saving refuses the clash, so it is made the way an old record or a direct change would leave it.
      const second = await createTrip({ departureTime: first.departureTime, arrivalTime: first.arrivalTime });
      await prisma.trip.update({ where: { id: second.id }, data: { busId: bus.id, drivers: { create: { userId: driver.id, isPrimary: true } } } });
      const loose = await createTrip({ departureTime: first.departureTime, arrivalTime: first.arrivalTime });

      const day = riyadhDate(new Date(first.departureTime));
      const res = await board({ from: day, to: day }).expect(200);
      const ids = res.body.trips.map((trip: any) => trip.id);
      expect(ids).toEqual(expect.arrayContaining([first.id, second.id, loose.id]));

      const busRow = res.body.buses.find((row: any) => row.id === bus.id);
      expect(busRow.tripIds).toEqual(expect.arrayContaining([first.id, second.id]));
      const driverRow = res.body.drivers.find((row: any) => row.id === driver.id);
      expect(driverRow.tripIds).toEqual(expect.arrayContaining([first.id, second.id]));

      const kinds = res.body.conflicts.filter((c: any) => c.trips.some((t: any) => t.id === first.id)).map((c: any) => c.kind);
      expect(kinds).toEqual(expect.arrayContaining(['BUS', 'DRIVER']));
      expect(res.body.trips.find((trip: any) => trip.id === first.id).conflictIndexes.length).toBeGreaterThan(0);
      expect(res.body.trips.find((trip: any) => trip.id === loose.id).conflictIndexes).toEqual([]);

      expect(res.body.unassigned.noBus).toContain(loose.id);
      expect(res.body.unassigned.noDriver).toContain(loose.id);
      expect(res.body.unassigned.noBus).not.toContain(first.id);
    });

    it('does not flag a cancelled trip', async () => {
      const bus = await createBus();
      const first = await createTrip({ busId: bus.id });
      const second = await createTrip({ departureTime: first.departureTime, arrivalTime: first.arrivalTime });
      await prisma.trip.update({ where: { id: second.id }, data: { busId: bus.id, tripStatus: 'CANCELLED' } });
      const day = riyadhDate(new Date(first.departureTime));
      const res = await board({ from: day }).expect(200);
      expect(res.body.trips.map((trip: any) => trip.id)).not.toContain(second.id);
      expect(res.body.conflicts.filter((c: any) => c.kind === 'BUS' && c.resourceId === bus.id)).toEqual([]);
    });

    it('refuses bad or too long ranges, and is closed to customers', async () => {
      await board({ from: '2026-13-01' }).expect(400);
      await board({ from: '2026-01-10', to: '2026-01-01' }).expect(400);
      await board({ from: '2026-01-01', to: '2026-03-01' }).expect(400);
      await request(http()).get(`${API}/trips/admin/board`).expect(401);
    });
  });
});

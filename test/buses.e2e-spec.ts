import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, STAFF_PASSWORD, tripPayload, validIqama } from './helpers';

describe('Buses, drivers and office statements (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let staff: any;
  let counter = 0;

  const createOffice = async (extra = {}) =>
    (
      await request(http())
        .post(`${API}/bus-offices`)
        .set(admin.auth)
        .send({
          name: `مكتب ${++counter}`,
          contractNumber: 'BC-2026-07',
          phone: '555302742',
          rates: [{ origin: 'ينبع', destination: 'مكة المكرمة', price: 1800 }, { origin: 'ينبع', destination: 'المدينة المنورة', price: 1500 }],
          ...extra,
        })
        .expect(201)
    ).body;

  const createBus = async (officeId?: string | null, extra = {}) =>
    (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `ا ب ${++counter}`, model: 'فيزيرو VIP', officeId, ...extra }).expect(201)).body;

  const createTrip = async (bus: any, extra = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ busId: bus.id, ...extra })).expect(201)).body;

  const driverBody = (extra = {}) => ({
    name: 'دلاور كريم',
    phone: `05${String(10000000 + ++counter)}`,
    password: STAFF_PASSWORD,
    iqamaNumber: validIqama(counter + 777),
    nationality: 'باكستاني',
    gender: 'MALE',
    birthDate: '1988-02-10',
    idIssueDate: '2024-01-15',
    idExpiryDate: '2030-06-30',
    licenseExpiry: '2028-03-31',
    ...extra,
  });

  const createDriver = async (extra = {}) => {
    const body = driverBody(extra);
    const { id } = (await request(http()).post(`${API}/drivers`).set(admin.auth).send(body).expect(201)).body;
    return { id, ...body };
  };

  const monthOf = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600000).toISOString().slice(0, 7);

  const statementOf = async (office: any, month: string, session = admin) =>
    (await request(http()).get(`${API}/bus-offices/${office.id}/statement?month=${month}`).set(session.auth).expect(200)).body;

  const setCost = (trip: any, body: object, session = admin) => request(http()).patch(`${API}/bus-offices/trips/${trip.id}/cost`).set(session.auth).send(body);

  const pay = (office: any, month: string, amount: number) =>
    request(http()).post(`${API}/bus-offices/${office.id}/payments`).set(admin.auth).send({ month, amount, method: 'TRANSFER', paidAt: `${month}-15` });

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

  describe('access', () => {
    it('keeps customers out and contract terms away from ranks without buses.rates', async () => {
      const office = await createOffice();
      const user = await loginPassenger(app);
      await request(http()).get(`${API}/drivers`).set(user.auth).expect(403);
      await request(http()).get(`${API}/bus-offices`).expect(401);

      const seenByStaff = await request(http()).get(`${API}/bus-offices`).set(staff.auth).expect(200);
      const listed = seenByStaff.body.find((o: any) => o.id === office.id);
      expect(listed.name).toBe(office.name);
      expect(listed.rates).toBeUndefined();
      expect(listed.contractNumber).toBeUndefined();

      await request(http()).get(`${API}/bus-offices/${office.id}/statement`).set(staff.auth).expect(403);
      await request(http()).post(`${API}/bus-offices`).set(staff.auth).send({ name: 'تجربة' }).expect(403);
      await request(http()).post(`${API}/drivers`).set(staff.auth).send(driverBody()).expect(403);
      await request(http()).post(`${API}/buses`).set(staff.auth).send({ plateNumber: 'س س 1', model: 'كينج لونج' }).expect(403);
    });

    it('gives the accountant rank the statement after the migration', async () => {
      const rank = await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-accountant' } });
      expect(rank.permissions).toEqual(expect.arrayContaining(['buses.view', 'buses.rates', 'buses.accounts']));
      const operations = await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-operations' } });
      expect(operations.permissions).toEqual(expect.arrayContaining(['buses.rates', 'buses.accounts']));
      const bookings = await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-bookings' } });
      expect(bookings.permissions).not.toContain('buses.rates');
    });

    it('keeps trip costs out of the customer-facing trip response', async () => {
      const bus = await createBus((await createOffice()).id);
      const trip = await createTrip(bus);
      await setCost(trip, { driverExpense: 100 }).expect(200);
      const seen = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(seen.body.busRentalPrice).toBeUndefined();
      expect(seen.body.busCost).toBeUndefined();
      expect(seen.body.bus.officeId).toBeUndefined();
    });
  });

  describe('bus registry', () => {
    it('reports the running trip and the ones still to come', async () => {
      const bus = await createBus();
      const upcoming = await createTrip(bus);
      const running = await createTrip(bus);
      await prisma.trip.update({ where: { id: running.id }, data: { departureTime: new Date(Date.now() - 3600000), arrivalTime: new Date(Date.now() + 3600000) } });

      const res = await request(http()).get(`${API}/buses`).set(staff.auth).expect(200);
      const listed = res.body.find((b: any) => b.id === bus.id);
      expect(listed.currentTrip).toBe(running.tripCode);
      expect(listed.upcomingTrips).toEqual([upcoming.tripCode]);
      expect(listed.tripCount).toBe(2);
    });

    it('takes the company from the office and follows its renames', async () => {
      const office = await createOffice();
      const bus = await createBus(office.id, { company: 'نص حر' });
      expect(bus.company).toBe(office.name);
      await request(http()).patch(`${API}/bus-offices/${office.id}`).set(admin.auth).send({ name: `${office.name} الجديد` }).expect(200);
      const saved = await prisma.bus.findUniqueOrThrow({ where: { id: bus.id } });
      expect(saved.company).toBe(`${office.name} الجديد`);
    });

    it('refuses moving a bus with trips to another office, but allows first linking it', async () => {
      const [first, second] = [await createOffice(), await createOffice()];
      const bus = await createBus();
      await createTrip(bus);
      await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ officeId: first.id }).expect(200);
      await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ officeId: second.id }).expect(409);
      await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ officeId: null }).expect(409);
    });

    it('refuses linking a bus to a stopped office', async () => {
      const office = await createOffice();
      await request(http()).patch(`${API}/bus-offices/${office.id}`).set(admin.auth).send({ isActive: false }).expect(200);
      await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `و و ${++counter}`, model: 'هايجر', officeId: office.id }).expect(409);
    });
  });

  describe('drivers', () => {
    it('creates a working app login and shows the iqama in the crew list', async () => {
      const driver = await createDriver();
      const session = await request(http()).post(`${API}/auth/login`).send({ phone: driver.phone, password: driver.password }).expect(201);
      expect(session.body.user.permissions).toContain('crew.trips');

      const crew = await request(http()).get(`${API}/users/crew`).set(admin.auth).expect(200);
      expect(crew.body.drivers.find((d: any) => d.id === driver.id).driverProfile.iqamaNumber).toBe(driver.iqamaNumber);

      const listed = await request(http()).get(`${API}/drivers`).set(staff.auth).expect(200);
      const row = listed.body.find((d: any) => d.id === driver.id);
      expect(row.nationality).toBe('باكستان');
      expect(row.passwordHash).toBeUndefined();
    });

    it('validates the iqama, and refuses a duplicate iqama or phone', async () => {
      const driver = await createDriver();
      await request(http()).post(`${API}/drivers`).set(admin.auth).send(driverBody({ iqamaNumber: '123' })).expect(400);
      await request(http()).post(`${API}/drivers`).set(admin.auth).send(driverBody({ iqamaNumber: driver.iqamaNumber })).expect(409);
      await request(http()).post(`${API}/drivers`).set(admin.auth).send(driverBody({ phone: driver.phone })).expect(409);
      await request(http()).post(`${API}/drivers`).set(admin.auth).send(driverBody({ licenseExpiry: '2028-02-31' })).expect(400);
    });

    it('fills in a profile for a driver who had none', async () => {
      const existing = await createStaff(prisma, 'DRIVER');
      await request(http()).patch(`${API}/drivers/${existing.id}`).set(admin.auth).send({ iqamaNumber: validIqama(4242), nationality: 'هندي', licenseExpiry: '2027-11-30' }).expect(200);
      const profile = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: existing.id } });
      expect(profile.iqamaNumber).toBe('2111111111');
    });

    it('will not edit someone who is not a driver through this screen', async () => {
      await request(http()).patch(`${API}/drivers/${(await createStaff(prisma, 'ADMIN')).id}`).set(admin.auth).send({ password: 'new-password-123' }).expect(404);
    });

    it('stops a limited manager taking over a driver account beyond their own access', async () => {
      const rank = await prisma.rank.create({ data: { name: `مدير باصات ${Date.now()}`, role: 'STAFF', jobId: 'job-office', permissions: ['buses.view', 'buses.manage'] } });
      const manager = await createStaff(prisma, 'STAFF', nextPhone(), rank.id);
      const session = await loginStaff(app, manager.phone);
      const driver = await createDriver();
      await request(http()).patch(`${API}/drivers/${driver.id}`).set(session.auth).send({ password: 'new-password-123' }).expect(403);
      await request(http()).post(`${API}/drivers`).set(session.auth).send(driverBody()).expect(403);
    });

    it('stops a driver: no new trips, no login, and refused while assigned', async () => {
      const driver = await createDriver();
      const bus = await createBus();
      const trip = await createTrip(bus, { driverIds: [driver.id] });

      await request(http()).patch(`${API}/drivers/${driver.id}`).set(admin.auth).send({ isActive: false }).expect(409);
      await prisma.tripDriver.deleteMany({ where: { tripId: trip.id } });
      await request(http()).patch(`${API}/drivers/${driver.id}`).set(admin.auth).send({ isActive: false }).expect(200);

      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ driverIds: [driver.id] })).expect(400);
      await request(http()).post(`${API}/auth/login`).send({ phone: driver.phone, password: driver.password }).expect(403);
      const crew = await request(http()).get(`${API}/users/crew`).set(admin.auth).expect(200);
      expect(crew.body.drivers.some((d: any) => d.id === driver.id)).toBe(false);

      await request(http()).patch(`${API}/drivers/${driver.id}`).set(admin.auth).send({ isActive: true }).expect(200);
      await request(http()).post(`${API}/auth/login`).send({ phone: driver.phone, password: driver.password }).expect(201);
    });

    it('ends older sessions when the password is reset', async () => {
      const driver = await createDriver();
      const session = await request(http()).post(`${API}/auth/login`).send({ phone: driver.phone, password: driver.password }).expect(201);
      await request(http()).patch(`${API}/drivers/${driver.id}`).set(admin.auth).send({ password: 'another-password-1' }).expect(200);
      await request(http()).post(`${API}/auth/refresh`).send({ refreshToken: session.body.refreshToken }).expect(403);
      await request(http()).post(`${API}/auth/login`).send({ phone: driver.phone, password: 'another-password-1' }).expect(201);
    });
  });

  describe('bus services', () => {
    const createService = async (name: string) =>
      (await request(http()).post(`${API}/services`).set(admin.auth).send({ name: `${name} ${++counter}` }).expect(201)).body;

    const tripServices = async (tripId: string) => {
      const rows = await prisma.tripService.findMany({ where: { tripId } });
      return rows.map((row) => row.serviceId).sort();
    };

    it('lets a bus manager add to the shared list, and nobody without the permission', async () => {
      const rank = await prisma.rank.create({ data: { name: `باصات فقط ${Date.now()}`, role: 'STAFF', jobId: 'job-office', permissions: ['buses.view', 'buses.manage'] } });
      const manager = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), rank.id)).phone);
      await request(http()).post(`${API}/services`).set(manager.auth).send({ name: `شاحن ${++counter}` }).expect(201);
      await request(http()).post(`${API}/services`).set(staff.auth).send({ name: 'ممنوع' }).expect(403);
    });

    it('adds them to a trip automatically and shows them to passengers with the bus', async () => {
      const [charger, water, meals] = [await createService('شاحن'), await createService('ماء'), await createService('وجبات')];
      const bus = await createBus(null, { serviceIds: [charger.id, water.id] });
      expect(bus.services.map((s: any) => s.id).sort()).toEqual([charger.id, water.id].sort());

      const trip = await createTrip(bus, { serviceIds: [meals.id] });
      expect(await tripServices(trip.id)).toEqual([charger.id, water.id, meals.id].sort());

      const seen = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(seen.body.services).toHaveLength(3);
      expect(seen.body.bus.services.map((row: any) => row.service.name).sort()).toEqual([charger.name, water.name].sort());
      expect(seen.body.bus.plateNumber).toBeUndefined();
    });

    it('swaps them when the bus changes, keeping what was picked by hand', async () => {
      const [charger, water, meals] = [await createService('شاحن'), await createService('ماء'), await createService('وجبات')];
      const first = await createBus(null, { serviceIds: [charger.id] });
      const second = await createBus(null, { serviceIds: [water.id] });
      const trip = await createTrip(first, { serviceIds: [meals.id] });

      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ busId: second.id }).expect(200);
      expect(await tripServices(trip.id)).toEqual([water.id, meals.id].sort());

      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ busId: '' }).expect(200);
      expect(await tripServices(trip.id)).toEqual([meals.id]);
    });

    it('does not let a trip edit remove what the bus provides, nor drop a hand-picked service it also provides', async () => {
      const [charger, meals] = [await createService('شاحن'), await createService('وجبات')];
      const bus = await createBus(null, { serviceIds: [charger.id] });
      const trip = await createTrip(bus, { serviceIds: [meals.id] });
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ serviceIds: [] }).expect(200);
      expect(await tripServices(trip.id)).toEqual([charger.id]);

      const picked = await createTrip(bus, { serviceIds: [charger.id] });
      const otherBus = await createBus();
      await request(http()).put(`${API}/trips/${picked.id}`).set(admin.auth).send({ busId: otherBus.id }).expect(200);
      expect(await tripServices(picked.id)).toEqual([charger.id]);
    });

    it('updates open trips when the bus changes, and leaves finished trips as they were', async () => {
      const [charger, water] = [await createService('شاحن'), await createService('ماء')];
      const bus = await createBus(null, { serviceIds: [charger.id] });
      const open = await createTrip(bus);
      const finished = await createTrip(bus);
      await prisma.trip.update({ where: { id: finished.id }, data: { tripStatus: 'COMPLETED' } });

      await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ serviceIds: [water.id] }).expect(200);
      expect(await tripServices(open.id)).toEqual([water.id]);
      expect(await tripServices(finished.id)).toEqual([charger.id]);
    });

    it('keeps the services when other bus fields are saved, and refuses unknown ones', async () => {
      const charger = await createService('شاحن');
      const bus = await createBus(null, { serviceIds: [charger.id] });
      const saved = await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ color: 'أزرق' }).expect(200);
      expect(saved.body.services.map((s: any) => s.id)).toEqual([charger.id]);
      await request(http()).put(`${API}/buses/${bus.id}`).set(admin.auth).send({ serviceIds: ['nope'] }).expect(400);
    });

    it('gives a reverse trip what the bus provides', async () => {
      const charger = await createService('شاحن');
      const bus = await createBus(null, { serviceIds: [charger.id] });
      const outbound = await createTrip(bus, {
        reverseEnabled: true,
        reverseOpenPercent: 50,
        reverseDepartureAt: new Date(Date.now() + 3000 * 24 * 3600000).toISOString(),
        reversePrice: 100,
      });
      // Skips filling half the seats, which is not what this test is about.
      await prisma.trip.update({ where: { id: outbound.id }, data: { reverseOpenPercent: 0 } });
      const reverse = await request(http()).post(`${API}/trips/${outbound.id}/open-reverse`).set(admin.auth).send({ boardingPointName: 'مكة' }).expect(201);
      expect(reverse.body.services.map((s: any) => s.serviceId)).toEqual([charger.id]);
    });
  });

  describe('contract rates', () => {
    it('applies the rate to new trips only when no price was entered', async () => {
      const bus = await createBus((await createOffice()).id);
      const priced = await createTrip(bus);
      expect(Number(priced.busRentalPrice)).toBe(1800);
      const manual = await createTrip(bus, { busRentalPrice: 999 });
      expect(Number(manual.busRentalPrice)).toBe(999);
      const noRate = await createTrip(bus, { destination: 'جدة' });
      expect(noRate.busRentalPrice).toBeNull();
    });

    it('applies the rate when a bus is first chosen on an existing trip, never over a set price', async () => {
      const bus = await createBus((await createOffice()).id);
      const empty = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      const updated = await request(http()).put(`${API}/trips/${empty.id}`).set(admin.auth).send({ busId: bus.id }).expect(200);
      expect(Number(updated.body.busRentalPrice)).toBe(1800);

      const set = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ busRentalPrice: 500 })).expect(201)).body;
      const kept = await request(http()).put(`${API}/trips/${set.id}`).set(admin.auth).send({ busId: bus.id }).expect(200);
      expect(Number(kept.body.busRentalPrice)).toBe(500);
    });

    it('refuses the same route twice in a rate table and leaves old trips alone when rates change', async () => {
      const office = await createOffice();
      const route = { origin: 'ينبع', destination: 'جدة', price: 900 };
      await request(http()).patch(`${API}/bus-offices/${office.id}`).set(admin.auth).send({ rates: [route, route] }).expect(400);

      const trip = await createTrip(await createBus(office.id));
      await request(http()).patch(`${API}/bus-offices/${office.id}`).set(admin.auth).send({ rates: [{ origin: 'ينبع', destination: 'مكة المكرمة', price: 2500 }] }).expect(200);
      const saved = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(Number(saved.busRentalPrice)).toBe(1800);
    });
  });

  describe('statement', () => {
    it('owes the rent minus expenses, as in the design', async () => {
      const office = await createOffice();
      const bus = await createBus(office.id);
      const driver = await createDriver();
      const first = await createTrip(bus, { driverIds: [driver.id] });
      const second = await createTrip(bus, { destination: 'المدينة المنورة' });
      await prisma.trip.update({ where: { id: second.id }, data: { departureTime: first.departureTime, arrivalTime: first.arrivalTime } });
      await setCost(first, { driverExpense: 100 }).expect(200);
      await setCost(second, { driverExpense: 100, delegationExpense: 450 }).expect(200);

      const statement = await statementOf(office, monthOf(first.departureTime));
      const row = statement.rows.find((r: any) => r.tripCode === second.tripCode);
      expect(row).toMatchObject({ rental: 1500, driverExpense: 100, delegationExpense: 450, expenses: 550, due: 950 });
      expect(statement.summary).toMatchObject({ trips: 2, rental: 3300, expenses: 650, due: 2650, paid: 0, remaining: 2650, missingRental: [] });
      expect(statement.buses[0].driver.name).toBe(driver.name);
    });

    it('leaves out cancelled and draft trips and other offices, and flags a trip with no price', async () => {
      const office = await createOffice();
      const bus = await createBus(office.id);
      const noPrice = await createTrip(bus, { destination: 'جدة' });
      const draft = await createTrip(bus, { tripStatus: 'DRAFT' });
      const cancelled = await createTrip(bus);
      await prisma.trip.update({ where: { id: cancelled.id }, data: { tripStatus: 'CANCELLED' } });
      const other = await createTrip(await createBus((await createOffice()).id));
      await prisma.trip.updateMany({ where: { id: { in: [draft.id, cancelled.id, other.id] } }, data: { departureTime: noPrice.departureTime } });

      const statement = await statementOf(office, monthOf(noPrice.departureTime));
      expect(statement.rows.map((r: any) => r.tripCode)).toEqual([noPrice.tripCode]);
      expect(statement.summary.missingRental).toEqual([noPrice.tripCode]);
    });

    it('counts a trip in the Riyadh month it departs', async () => {
      const office = await createOffice();
      const trip = await createTrip(await createBus(office.id));
      // 22:30 UTC on 30 Sep is already 1 Oct in Riyadh.
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date('2031-09-30T22:30:00.000Z'), arrivalTime: new Date('2031-10-01T05:00:00.000Z') } });
      expect((await statementOf(office, '2031-09')).rows).toHaveLength(0);
      expect((await statementOf(office, '2031-10')).rows).toHaveLength(1);
    });

    it('keeps exact totals across many fractional amounts', async () => {
      const office = await createOffice();
      const bus = await createBus(office.id);
      const trips = [await createTrip(bus, { busRentalPrice: 0.1 }), await createTrip(bus, { busRentalPrice: 0.2 })];
      const when = new Date(trips[0].departureTime);
      await prisma.trip.update({ where: { id: trips[1].id }, data: { departureTime: when } });
      const statement = await statementOf(office, monthOf(trips[0].departureTime));
      expect(statement.summary.rental).toBe(0.3);
    });

    it('refuses costs on a cancelled trip or a company-owned bus, and from ranks without buses.accounts', async () => {
      const own = await createTrip(await createBus());
      await setCost(own, { driverExpense: 1 }).expect(409);
      const cancelled = await createTrip(await createBus((await createOffice()).id));
      await prisma.trip.update({ where: { id: cancelled.id }, data: { tripStatus: 'CANCELLED' } });
      await setCost(cancelled, { driverExpense: 1 }).expect(409);
      await setCost(own, { driverExpense: -5 }).expect(400);
      await setCost(own, { driverExpense: 1 }, staff).expect(403);
    });

    it('leaves the trip inventory net unchanged by expenses, since they come out of the rent', async () => {
      const trip = await createTrip(await createBus((await createOffice()).id));
      const before = await request(http()).get(`${API}/manifests/${trip.id}/inventory`).set(admin.auth).expect(200);
      await setCost(trip, { driverExpense: 300, delegationExpense: 200 }).expect(200);
      const after = await request(http()).get(`${API}/manifests/${trip.id}/inventory`).set(admin.auth).expect(200);
      expect(after.body.totals.net).toBe(before.body.totals.net);
      expect(after.body.totals.busRental).toBe(1800);
    });
  });

  describe('payments', () => {
    const settledOffice = async () => {
      const office = await createOffice();
      const trip = await createTrip(await createBus(office.id));
      return { office, trip, month: monthOf(trip.departureTime) };
    };

    it('reduces the balance, refuses overpaying, and restores it when voided', async () => {
      const { office, month } = await settledOffice();
      const { body: payment } = await pay(office, month, 1000).expect(201);
      expect((await statementOf(office, month)).summary).toMatchObject({ paid: 1000, remaining: 800 });

      await pay(office, month, 800.01).expect(409);
      await pay(office, month, 800).expect(201);
      expect((await statementOf(office, month)).summary.remaining).toBe(0);

      await request(http()).post(`${API}/bus-offices/payments/${payment.id}/void`).set(admin.auth).send({ reason: 'ab' }).expect(400);
      await request(http()).post(`${API}/bus-offices/payments/${payment.id}/void`).set(admin.auth).send({ reason: 'تحويل مرتجع' }).expect(201);
      await request(http()).post(`${API}/bus-offices/payments/${payment.id}/void`).set(admin.auth).send({ reason: 'تحويل مرتجع' }).expect(409);

      const statement = await statementOf(office, month);
      expect(statement.summary).toMatchObject({ paid: 800, remaining: 1000 });
      expect(statement.payments.find((p: any) => p.id === payment.id).voidReason).toBe('تحويل مرتجع');
    });

    it('never overpays under simultaneous requests', async () => {
      const { office, month } = await settledOffice();
      const results = await Promise.all([pay(office, month, 1800), pay(office, month, 1800)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await statementOf(office, month)).summary.paid).toBe(1800);
    });

    it('shows a negative balance when expenses are added after settling', async () => {
      const { office, trip, month } = await settledOffice();
      await pay(office, month, 1800).expect(201);
      await setCost(trip, { driverExpense: 100 }).expect(200);
      expect((await statementOf(office, month)).summary.remaining).toBe(-100);
    });

    it('rejects impossible dates, unknown methods and non-positive amounts', async () => {
      const { office, month } = await settledOffice();
      const send = (body: object) => request(http()).post(`${API}/bus-offices/${office.id}/payments`).set(admin.auth).send({ month, amount: 10, method: 'CASH', paidAt: `${month}-01`, ...body });
      await send({ paidAt: '2030-02-31' }).expect(400);
      await send({ method: 'BITCOIN' }).expect(400);
      await send({ amount: 0 }).expect(400);
      await send({ month: '2030-13' }).expect(400);
    });
  });

  describe('manifest', () => {
    it('gives the crew phones and the driver iqama', async () => {
      const driver = await createDriver();
      const trip = await createTrip(await createBus(), { driverIds: [driver.id] });
      const res = await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200);
      expect(res.body.trip.driver.iqamaNumber).toBe(driver.iqamaNumber);
      expect(res.body.trip.crew[0]).toMatchObject({ name: driver.name, label: 'السائق الأول' });
    });
  });
});

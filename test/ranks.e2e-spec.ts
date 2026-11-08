import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, STAFF_PASSWORD, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload, officialDetails, validIqama } from './helpers';

describe('Ranks and permissions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;
  let rankCounter = 0;

  const http = () => app.getHttpServer();

  const makeRank = (permissions: string[], jobId = 'job-office') =>
    prisma.rank.create({ data: { name: `rank ${Date.now()} ${++rankCounter}`, role: jobId === 'job-driver' ? 'DRIVER' : 'STAFF', jobId, permissions } });

  const uniqueName = (label: string) => `${label} ${Date.now()} ${++rankCounter}`;

  const employeeWith = async (permissions: string[]) => {
    const rank = await makeRank(permissions);
    const user = await createStaff(prisma, 'STAFF', nextPhone(), rank.id);
    return { user, rank, ...(await loginStaff(app, user.phone)) };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('what the migration sets up', () => {
    it('gives existing staff exactly the access they had', async () => {
      const staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
      await request(http()).get(`${API}/dashboard/stats`).set(staff.auth).expect(200);
      await request(http()).get(`${API}/users`).set(staff.auth).expect(200);
      await request(http()).get(`${API}/tickets/my-trips`).set(staff.auth).expect(200);
      await request(http()).get(`${API}/coupons`).set(staff.auth).expect(403);
      await request(http()).put(`${API}/settings`).set(staff.auth).send({}).expect(403);
      await request(http()).post(`${API}/trips`).set(staff.auth).send({}).expect(403);
    });

    it('keeps a supervisor rank out of everything but their assigned trips', async () => {
      const user = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-supervisor');
      const supervisor = await loginStaff(app, user.phone);
      await request(http()).get(`${API}/tickets/my-trips`).set(supervisor.auth).expect(200);
      for (const path of ['/users', `/users/${user.id}`, '/bookings/admin/all', '/trips/admin/all', '/dashboard/stats', '/buses']) {
        await request(http()).get(`${API}${path}`).set(supervisor.auth).expect(403);
      }
    });

    it('holds nothing for a staff account without a rank', async () => {
      const user = await prisma.user.create({ data: { phone: nextPhone(), role: 'STAFF', name: 'x', passwordHash: (await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).passwordHash } });
      const session = await loginStaff(app, user.phone);
      expect(session.user.permissions).toEqual([]);
      await request(http()).get(`${API}/tickets/my-trips`).set(session.auth).expect(403);
    });
  });

  describe('sessions', () => {
    it('reports the rank and permissions at login', async () => {
      const { rank, user } = await employeeWith(['bookings.view']);
      const login = await request(http()).post(`${API}/auth/login`).send({ phone: user.phone, password: STAFF_PASSWORD }).expect(201);
      expect(login.body.user.rank).toEqual({ id: rank.id, name: rank.name });
      expect(login.body.user.permissions).toEqual(['bookings.view']);
    });

    it('gives admins every permission and passengers none', async () => {
      const me = await request(http()).get(`${API}/auth/me`).set(admin.auth).expect(200);
      expect(me.body.permissions).toContain('employees.manage');
      const passenger = await loginPassenger(app);
      const passengerMe = await request(http()).get(`${API}/auth/me`).set(passenger.auth).expect(200);
      expect(passengerMe.body.permissions).toEqual([]);
    });

    it('applies an edited rank to tokens that are already issued', async () => {
      const { auth, rank } = await employeeWith(['buses.view']);
      await request(http()).get(`${API}/buses`).set(auth).expect(200);
      await request(http()).put(`${API}/ranks/${rank.id}`).set(admin.auth).send({ permissions: ['trips.view'] }).expect(200);
      await request(http()).get(`${API}/buses`).set(auth).expect(403);
      await request(http()).get(`${API}/trips/admin/all`).set(auth).expect(200);
    });
  });

  describe('granular permissions', () => {
    it('separates viewing from managing', async () => {
      const { auth } = await employeeWith(['buses.view']);
      await request(http()).get(`${API}/buses`).set(auth).expect(200);
      await request(http()).post(`${API}/buses`).set(auth).send({ plateNumber: 'X', model: 'Y' }).expect(403);
    });

    it('lets customer access and employee access see only their own side', async () => {
      const customerClerk = await employeeWith(['customers.view']);
      const hr = await employeeWith(['employees.view']);
      const passenger = await loginPassenger(app);

      await request(http()).get(`${API}/users/${passenger.user.id}`).set(customerClerk.auth).expect(200);
      await request(http()).get(`${API}/users/${hr.user.id}`).set(customerClerk.auth).expect(403);
      await request(http()).get(`${API}/users/employees`).set(customerClerk.auth).expect(403);

      await request(http()).get(`${API}/users/${hr.user.id}`).set(hr.auth).expect(200);
      await request(http()).get(`${API}/users/${passenger.user.id}`).set(hr.auth).expect(403);
      await request(http()).get(`${API}/users`).set(hr.auth).expect(403);
    });

    it('lists only customers in the customers list and only staff in the employees list', async () => {
      await loginPassenger(app);
      const customers = await request(http()).get(`${API}/users`).set(admin.auth).expect(200);
      expect(customers.body.items.every((u: any) => u.role === 'PASSENGER')).toBe(true);
      const employees = await request(http()).get(`${API}/users/employees`).set(admin.auth).expect(200);
      expect(employees.body.items.length).toBeGreaterThan(0);
      expect(employees.body.items.every((u: any) => u.role !== 'PASSENGER')).toBe(true);
      expect(JSON.stringify(employees.body)).not.toContain('passwordHash');
    });

    it('offers trip managers the crew without opening customer data', async () => {
      const { auth } = await employeeWith(['trips.manage']);
      const driver = await createStaff(prisma, 'DRIVER');
      const supervisor = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-supervisor');
      const bookingClerk = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-bookings');

      const crew = await request(http()).get(`${API}/users/crew`).set(auth).expect(200);
      expect(crew.body.drivers.map((u: any) => u.id)).toContain(driver.id);
      const supervisorIds = crew.body.supervisors.map((u: any) => u.id);
      expect(supervisorIds).toContain(supervisor.id);
      expect(supervisorIds).not.toContain(bookingClerk.id);
      await request(http()).get(`${API}/users`).set(auth).expect(403);
      await request(http()).post(`${API}/trips`).set(auth).send(tripPayload({ tripCode: `RANK${Date.now()}` })).expect(201);
    });

    it('hides hotel contract rates without the cost permission', async () => {
      await prisma.hotel.create({ data: { name: `فندق ${Date.now()}`, city: 'مكة', nightlyRate: 300 } as any });
      const clerk = await employeeWith(['hotels.view']);
      const finance = await employeeWith(['hotels.view', 'hotels.rates']);
      const hidden = await request(http()).get(`${API}/hotels`).set(clerk.auth).expect(200);
      expect(hidden.body[0].nightlyRate).toBeUndefined();
      const shown = await request(http()).get(`${API}/hotels`).set(finance.auth).expect(200);
      expect(shown.body[0].nightlyRate).toBeDefined();
    });

    it('only opens the crew tools a rank grants', async () => {
      const { auth } = await employeeWith(['crew.trips']);
      await request(http()).get(`${API}/tickets/my-trips`).set(auth).expect(200);
      await request(http()).get(`${API}/tickets/manifest/x`).set(auth).expect(403);
      await request(http()).post(`${API}/tickets/verify`).set(auth).send({ signedToken: 'x', tripId: 'x' }).expect(403);
      await request(http()).post(`${API}/tracking/trips/x/stop`).set(auth).send({}).expect(403);
    });
  });

  describe('hiring', () => {
    const employee = (rankId: string) => ({ name: 'موظف جديد', phone: nextPhone(), rankId, password: 'a-long-enough-password', ...officialDetails() });

    it('gives a new employee the access of their rank', async () => {
      const created = await request(http()).post(`${API}/users`).set(admin.auth).send(employee('rank-driver')).expect(201);
      expect(created.body.role).toBe('DRIVER');
      expect(created.body.rank.id).toBe('rank-driver');
      const session = await request(http()).post(`${API}/auth/login`).send({ phone: created.body.phone, password: 'a-long-enough-password' }).expect(201);
      expect(session.body.user.permissions).toContain('crew.board');
    });

    it('rejects a missing or unknown rank', async () => {
      const { rankId, ...withoutRank } = employee('x');
      await request(http()).post(`${API}/users`).set(admin.auth).send(withoutRank).expect(400);
      await request(http()).post(`${API}/users`).set(admin.auth).send(employee('no-such-rank')).expect(400);
    });

    it('refuses employee management without the permission', async () => {
      const { auth } = await employeeWith(['employees.view']);
      await request(http()).post(`${API}/users`).set(auth).send(employee('rank-driver')).expect(403);
      await request(http()).post(`${API}/ranks`).set(auth).send({ name: 'x y', jobId: 'job-office', permissions: [] }).expect(403);
    });
  });

  describe('nobody can exceed their own access', () => {
    let manager: any;

    beforeAll(async () => {
      manager = await employeeWith(['employees.view', 'employees.manage', 'customers.view', 'customers.manage']);
    });

    const hire = (rankId: string) =>
      request(http()).post(`${API}/users`).set(manager.auth).send({ name: 'موظف', phone: nextPhone(), rankId, password: 'a-long-enough-password', ...officialDetails() });

    it('refuses granting a rank beyond the manager', async () => {
      await hire('rank-admin').expect(403);
      await hire('rank-accountant').expect(403);
      const smaller = await makeRank(['customers.view']);
      await hire(smaller.id).expect(201);
    });

    it('refuses creating or widening a rank beyond the manager', async () => {
      await request(http()).post(`${API}/ranks`).set(manager.auth).send({ name: 'واسعة', jobId: 'job-office', permissions: ['wallet.adjust'] }).expect(403);
      const own = await request(http()).post(`${API}/ranks`).set(manager.auth).send({ name: `ضيقة ${Date.now()}`, jobId: 'job-office', permissions: ['customers.view'] }).expect(201);
      await request(http()).put(`${API}/ranks/${own.body.id}`).set(manager.auth).send({ permissions: ['wallet.adjust'] }).expect(403);
    });

    it('refuses editing a rank that already exceeds the manager', async () => {
      await request(http()).put(`${API}/ranks/rank-accountant`).set(manager.auth).send({ permissions: [] }).expect(403);
      await request(http()).delete(`${API}/ranks/rank-accountant`).set(manager.auth).expect(403);
    });

    it('refuses taking over a more powerful account', async () => {
      const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
      const accountant = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-accountant');
      for (const target of [adminUser, accountant]) {
        await request(http()).put(`${API}/users/${target.id}`).set(manager.auth).send({ password: 'attacker-controlled-pw' }).expect(403);
        await request(http()).delete(`${API}/users/${target.id}`).set(manager.auth).expect(403);
      }
    });

    it('refuses changing your own rank', async () => {
      const wider = await makeRank(['customers.view']);
      await request(http()).put(`${API}/users/${manager.user.id}`).set(manager.auth).send({ rankId: wider.id }).expect(400);
    });

    it('does not let customer access turn a customer into a staff login', async () => {
      const { auth } = await employeeWith(['customers.manage']);
      const passenger = await loginPassenger(app);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(auth).send({ name: 'اسم صحيح' }).expect(200);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(auth).send({ password: 'attacker-controlled-pw' }).expect(403);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(auth).send({ rankId: 'rank-driver' }).expect(403);
    });
  });

  describe('email accounts', () => {
    const newEmployee = (email: string) => ({ name: 'موظف بريد', phone: nextPhone(), email, rankId: 'rank-driver', password: 'a-long-enough-password', ...officialDetails() });
    const uniqueEmail = () => `staff${Date.now()}${++rankCounter}@example.com`;

    it('signs an employee in with email or phone, ignoring email case', async () => {
      const email = uniqueEmail();
      const created = await request(http()).post(`${API}/users`).set(admin.auth).send(newEmployee(email.toUpperCase())).expect(201);
      expect(created.body.email).toBe(email);
      for (const identifier of [email, email.toUpperCase(), created.body.phone]) {
        const login = await request(http()).post(`${API}/auth/login`).send({ phone: identifier, password: 'a-long-enough-password' }).expect(201);
        expect(login.body.user.email).toBe(email);
      }
    });

    it('rejects a wrong password, an unknown email, a taken email and a malformed one', async () => {
      const email = uniqueEmail();
      await request(http()).post(`${API}/users`).set(admin.auth).send(newEmployee(email)).expect(201);
      await request(http()).post(`${API}/auth/login`).send({ phone: email, password: 'not-the-right-password' }).expect(401);
      await request(http()).post(`${API}/auth/login`).send({ phone: uniqueEmail(), password: 'a-long-enough-password' }).expect(401);
      await request(http()).post(`${API}/users`).set(admin.auth).send(newEmployee(email)).expect(409);
      await request(http()).post(`${API}/users`).set(admin.auth).send(newEmployee('not-an-email')).expect(400);
    });

    it('locks email sign-in after repeated failures', async () => {
      const email = uniqueEmail();
      await request(http()).post(`${API}/users`).set(admin.auth).send(newEmployee(email)).expect(201);
      for (let attempt = 0; attempt < 5; attempt++) {
        await request(http()).post(`${API}/auth/login`).send({ phone: email, password: 'not-the-right-password' }).expect(401);
      }
      await request(http()).post(`${API}/auth/login`).send({ phone: email.toUpperCase(), password: 'a-long-enough-password' }).expect(429);
    });

    it('never lets a customer sign in with a password by setting an email', async () => {
      const email = uniqueEmail();
      const passenger = await loginPassenger(app);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(admin.auth).send({ email }).expect(200);
      await request(http()).post(`${API}/auth/login`).send({ phone: email, password: 'a-long-enough-password' }).expect(401);
    });
  });

  describe('bringing registered people on as crew', () => {
    const CREW = { rankId: 'rank-driver', password: 'a-long-enough-password' };

    it('finds people by name, email and local phone without exposing secrets or admins', async () => {
      const name = uniqueName('عميل بحث');
      const email = `find${Date.now()}${++rankCounter}@example.com`;
      const passenger = await loginPassenger(app);
      await prisma.user.update({ where: { id: passenger.user.id }, data: { name, email } });
      const localPhone = passenger.phone.replace('+966', '0');
      for (const search of [name, email.toUpperCase(), localPhone]) {
        const found = await request(http()).get(`${API}/users/candidates`).query({ search }).set(admin.auth).expect(200);
        expect(found.body.map((u: any) => u.id)).toContain(passenger.user.id);
        expect(JSON.stringify(found.body)).not.toContain('passwordHash');
      }
      const adminName = (await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).name as string;
      const admins = await request(http()).get(`${API}/users/candidates`).query({ search: adminName }).set(admin.auth).expect(200);
      expect(admins.body.every((u: any) => u.role !== 'ADMIN')).toBe(true);
      await request(http()).get(`${API}/users/candidates`).query({ search: 'x' }).set(admin.auth).expect(400);
    });

    it('promotes a customer into the trip crew, keeps their bookings and moves them to password sign-in', async () => {
      const passenger = await loginPassenger(app);
      const email = `promote${Date.now()}${++rankCounter}@example.com`;
      const promoted = await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(admin.auth).send({ ...CREW, email, ...officialDetails() }).expect(201);
      expect(promoted.body.role).toBe('DRIVER');
      expect(promoted.body.rank.id).toBe('rank-driver');

      const crew = await request(http()).get(`${API}/users/crew`).set(admin.auth).expect(200);
      expect(crew.body.drivers.map((u: any) => u.id)).toContain(passenger.user.id);
      await request(http()).post(`${API}/auth/refresh`).send({ refreshToken: passenger.refreshToken }).expect(403);
      await request(http()).post(`${API}/auth/login`).send({ phone: email, password: CREW.password }).expect(201);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: passenger.user.id } })).role).not.toBe('PASSENGER');
    });

    it('saves driver details for the driver registry and refuses bad ones', async () => {
      const iqama = validIqama(Date.now() % 100_000_000);
      const details = { iqamaNumber: iqama, nationality: 'مصري', gender: 'MALE', birthDate: '1988-02-10', idIssueDate: '2024-01-15', idExpiryDate: '2030-06-30', licenseExpiry: '2030-01-31' };
      const created = await request(http()).post(`${API}/users`).set(admin.auth).send({ name: 'سائق كامل', phone: nextPhone(), ...CREW, ...details }).expect(201);
      expect(created.body.driverProfile.iqamaNumber).toBe(iqama);
      const stored = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: created.body.id } });
      expect(stored.nationality).toBe('مصري');

      const passenger = await loginPassenger(app);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(admin.auth).send({ ...CREW, ...details, iqamaNumber: '123' }).expect(400);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(admin.auth).send({ ...CREW, ...details, iqamaNumber: validIqama(99), licenseExpiry: '2030-02-31' }).expect(400);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(admin.auth).send({ ...CREW, ...details }).expect(409);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: passenger.user.id } })).role).toBe('PASSENGER');
    });

    it('does not bring back a stopped driver through this route', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.user.update({ where: { id: driver.id }, data: { driverProfile: { create: { isActive: false } } } });
      await request(http()).post(`${API}/users/${driver.id}/promote`).set(admin.auth).send({ rankId: 'rank-driver' }).expect(409);
    });

    it('needs a password for an account without one, but keeps an existing one', async () => {
      const passenger = await loginPassenger(app);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(admin.auth).send({ rankId: 'rank-driver' }).expect(400);
      const employee = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-bookings');
      const moved = await request(http()).post(`${API}/users/${employee.id}/promote`).set(admin.auth).send({ rankId: 'rank-supervisor' }).expect(201);
      expect(moved.body.rank.id).toBe('rank-supervisor');
      await request(http()).post(`${API}/auth/login`).send({ phone: employee.phone, password: STAFF_PASSWORD }).expect(201);
    });

    it('requires employee management, and stays within the manager own access', async () => {
      const passenger = await loginPassenger(app);
      const tripsOnly = await employeeWith(['trips.manage']);
      await request(http()).get(`${API}/users/candidates`).query({ search: 'عميل' }).set(tripsOnly.auth).expect(403);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(tripsOnly.auth).send(CREW).expect(403);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(passenger.auth).send(CREW).expect(403);

      const manager = await employeeWith(['employees.manage']);
      await request(http()).get(`${API}/ranks`).set(manager.auth).expect(200);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(manager.auth).send(CREW).expect(403);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(manager.auth).send({ ...CREW, rankId: 'rank-admin' }).expect(403);
      const own = await makeRank(['employees.manage']);
      await request(http()).post(`${API}/users/${passenger.user.id}/promote`).set(manager.auth).send({ ...CREW, rankId: own.id }).expect(201);

      const accountant = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-accountant');
      await request(http()).post(`${API}/users/${accountant.id}/promote`).set(manager.auth).send({ rankId: own.id }).expect(403);
    });

    it('refuses changing yourself or a general manager', async () => {
      const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
      await request(http()).post(`${API}/users/${adminUser.id}/promote`).set(admin.auth).send(CREW).expect(400);
      const manager = await employeeWith(['employees.manage', 'crew.trips', 'crew.manifest', 'crew.board', 'crew.track']);
      await request(http()).post(`${API}/users/${manager.user.id}/promote`).set(manager.auth).send(CREW).expect(400);
      await request(http()).post(`${API}/users/${adminUser.id}/promote`).set(manager.auth).send(CREW).expect(400);
    });
  });

  describe('custom job types', () => {
    const createJob = (body: Record<string, unknown>) => request(http()).post(`${API}/job-types`).set(admin.auth).send(body);

    it('lets the manager add, rename and remove a job', async () => {
      const job = await createJob({ name: uniqueName('مرشد ديني'), description: 'يرافق المعتمرين' }).expect(201);
      expect(job.body.tripRole).toBe('NONE');
      const renamed = await request(http()).put(`${API}/job-types/${job.body.id}`).set(admin.auth).send({ name: uniqueName('مرشد') }).expect(200);
      expect(renamed.body.name).toContain('مرشد');
      const list = await request(http()).get(`${API}/job-types`).set(admin.auth).expect(200);
      expect(list.body.map((j: any) => j.id)).toContain(job.body.id);
      await request(http()).delete(`${API}/job-types/${job.body.id}`).set(admin.auth).expect(200);
    });

    it('hires into a new job through a rank of that job', async () => {
      const job = await createJob({ name: uniqueName('محصل') }).expect(201);
      const rank = await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: uniqueName('محصل أول'), jobId: job.body.id, permissions: ['bookings.view'] }).expect(201);
      const hired = await request(http()).post(`${API}/users`).set(admin.auth).send({ name: 'موظف', phone: nextPhone(), rankId: rank.body.id, password: 'a-long-enough-password', ...officialDetails() }).expect(201);
      expect(hired.body.role).toBe('STAFF');
      expect(hired.body.rank.job.id).toBe(job.body.id);
      const filtered = await request(http()).get(`${API}/users/employees?jobId=${job.body.id}`).set(admin.auth).expect(200);
      expect(filtered.body.items.map((u: any) => u.id)).toEqual([hired.body.id]);
    });

    it('offers a custom job for trips according to its trip role', async () => {
      const relief = await createJob({ name: uniqueName('سائق احتياطي'), tripRole: 'DRIVER' }).expect(201);
      const rank = await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: uniqueName('احتياطي'), jobId: relief.body.id, permissions: ['crew.trips', 'crew.track'] }).expect(201);
      expect(rank.body.role).toBe('DRIVER');
      const noApp = await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: uniqueName('بلا تطبيق'), jobId: relief.body.id, permissions: [] }).expect(201);
      const driver = await createStaff(prisma, 'DRIVER', nextPhone(), rank.body.id);
      const hidden = await createStaff(prisma, 'DRIVER', nextPhone(), noApp.body.id);
      const crew = await request(http()).get(`${API}/users/crew`).set(admin.auth).expect(200);
      const driverIds = crew.body.drivers.map((u: any) => u.id);
      expect(driverIds).toContain(driver.id);
      expect(driverIds).not.toContain(hidden.id);
    });

    it('moves everyone with a rank to the account type of its new job', async () => {
      const rank = await makeRank(['crew.trips']);
      const user = await createStaff(prisma, 'STAFF', nextPhone(), rank.id);
      const moved = await request(http()).put(`${API}/ranks/${rank.id}`).set(admin.auth).send({ jobId: 'job-driver' }).expect(200);
      expect(moved.body.role).toBe('DRIVER');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('DRIVER');
    });

    it('protects jobs that ranks depend on', async () => {
      const job = await createJob({ name: uniqueName('وظيفة') }).expect(201);
      await prisma.rank.create({ data: { name: uniqueName('رتبة'), role: 'STAFF', jobId: job.body.id } });
      await request(http()).delete(`${API}/job-types/${job.body.id}`).set(admin.auth).expect(409);
      await request(http()).put(`${API}/job-types/${job.body.id}`).set(admin.auth).send({ tripRole: 'DRIVER' }).expect(409);
      await request(http()).put(`${API}/job-types/${job.body.id}`).set(admin.auth).send({ description: 'وصف' }).expect(200);
    });

    it('protects the top management job and rejects bad input', async () => {
      await request(http()).put(`${API}/job-types/job-admin`).set(admin.auth).send({ name: 'اسم آخر' }).expect(400);
      await request(http()).delete(`${API}/job-types/job-admin`).set(admin.auth).expect(400);
      await createJob({ name: uniqueName('دور خطأ'), tripRole: 'CAPTAIN' }).expect(400);
      await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: 'بلا وظيفة', permissions: [] }).expect(400);
      await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: 'وظيفة خطأ', jobId: 'no-such-job', permissions: [] }).expect(400);
    });

    it('requires employee management to change jobs', async () => {
      const { auth } = await employeeWith(['employees.view']);
      await request(http()).get(`${API}/job-types`).set(auth).expect(200);
      await request(http()).post(`${API}/job-types`).set(auth).send({ name: 'ممنوعة' }).expect(403);
      await request(http()).put(`${API}/job-types/job-office`).set(auth).send({ name: 'ممنوعة' }).expect(403);
      await request(http()).delete(`${API}/job-types/job-office`).set(auth).expect(403);
      const outsider = await employeeWith(['trips.view']);
      await request(http()).get(`${API}/job-types`).set(outsider.auth).expect(403);
    });
  });

  describe('managing ranks', () => {
    it('protects the general manager rank', async () => {
      await request(http()).put(`${API}/ranks/rank-admin`).set(admin.auth).send({ permissions: [] }).expect(400);
      await request(http()).delete(`${API}/ranks/rank-admin`).set(admin.auth).expect(400);
    });

    it('rejects unknown permissions and an admin job type', async () => {
      await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: 'س ص', jobId: 'job-office', permissions: ['root.everything'] }).expect(400);
      await request(http()).post(`${API}/ranks`).set(admin.auth).send({ name: 'س ص', jobId: 'job-admin', permissions: [] }).expect(400);
    });

    it('refuses deleting a rank that employees still hold, then allows it', async () => {
      const rank = await makeRank(['trips.view']);
      const user = await createStaff(prisma, 'STAFF', nextPhone(), rank.id);
      await request(http()).delete(`${API}/ranks/${rank.id}`).set(admin.auth).expect(409);
      await request(http()).put(`${API}/users/${user.id}`).set(admin.auth).send({ rankId: 'rank-supervisor' }).expect(200);
      await request(http()).delete(`${API}/ranks/${rank.id}`).set(admin.auth).expect(200);
    });

    it('signs an employee out and updates their job when the rank changes', async () => {
      const user = await createStaff(prisma, 'STAFF');
      const session = await loginStaff(app, user.phone);
      const updated = await request(http()).put(`${API}/users/${user.id}`).set(admin.auth).send({ rankId: 'rank-driver' }).expect(200);
      expect(updated.body.role).toBe('DRIVER');
      await request(http()).post(`${API}/auth/refresh`).send({ refreshToken: session.refreshToken }).expect(403);
    });

    it('turns an employee back into a customer with a null rank', async () => {
      const user = await createStaff(prisma, 'DRIVER');
      const updated = await request(http()).put(`${API}/users/${user.id}`).set(admin.auth).send({ rankId: null }).expect(200);
      expect(updated.body.role).toBe('PASSENGER');
      expect(updated.body.rank).toBeNull();
    });

    it('lists every permission grouped for the panel', async () => {
      const groups = await request(http()).get(`${API}/ranks/permissions`).set(admin.auth).expect(200);
      expect(groups.body.flatMap((g: any) => g.items.map((i: any) => i.key))).toContain('bookings.view');
      const ranks = await request(http()).get(`${API}/ranks`).set(admin.auth).expect(200);
      expect(ranks.body.find((r: any) => r.id === 'rank-admin')._count.users).toBeGreaterThan(0);
    });
  });
});

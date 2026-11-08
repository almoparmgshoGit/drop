import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, STAFF_PASSWORD, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase } from './helpers';

describe('Authentication & authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('backdoors stay closed', () => {
    it('rejects the former demo admin token', async () => {
      await request(http()).get(`${API}/users`).set('Authorization', 'Bearer demo_admin_token').expect(401);
    });

    it('rejects the former master OTP codes', async () => {
      const phone = nextPhone();
      await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(201);
      for (const code of ['1234', '0000']) {
        const res = await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code });
        // The real code is random, so skip the 1-in-9000 chance it equals a former master code.
        expect([400, 201]).toContain(res.status);
        if (res.status === 201) return;
      }
      expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
    });

    it('rejects the former master admin password', async () => {
      const admin = await createStaff(prisma, 'ADMIN');
      await request(http()).post(`${API}/auth/login`).send({ phone: admin.phone, password: 'AdminPassword123!' }).expect(401);
    });

    it('never creates an admin from a login attempt with an unknown phone', async () => {
      const phone = nextPhone();
      await request(http()).post(`${API}/auth/login`).send({ phone, password: 'whatever-password' }).expect(401);
      expect(await prisma.user.findUnique({ where: { phone } })).toBeNull();
    });
  });

  describe('OTP', () => {
    it('gives new users an empty wallet', async () => {
      const passenger = await loginPassenger(app);
      expect(Number(passenger.user.walletBalance)).toBe(0);
    });

    it('treats every spelling of a number as the same account', async () => {
      const first = await loginPassenger(app, '+966511111111');
      const again = await loginPassenger(app, '٠٥٢٢٢٢٢٢٢٢');
      expect(again.user.phone).toBe('+966522222222');
      await prisma.user.deleteMany({ where: { phone: '+966511111111' } });
      expect(first.user.phone).toBe('+966511111111');
    });

    it('rejects invalid phone numbers', async () => {
      await request(http()).post(`${API}/auth/send-otp`).send({ phone: '12345' }).expect(400);
    });

    it('burns the code after too many wrong attempts', async () => {
      const phone = nextPhone();
      const sent = await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(201);
      const wrong = sent.body.devCode === '1111' ? '2222' : '1111';
      for (let i = 0; i < 5; i++) {
        await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: wrong }).expect(400);
      }
      await request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: sent.body.devCode }).expect(429);
    });

    it('does not let staff in with a phone code alone', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const sent = await request(http()).post(`${API}/auth/send-otp`).send({ phone: driver.phone }).expect(201);
      await request(http()).post(`${API}/auth/verify-otp`).send({ phone: driver.phone, code: sent.body.devCode }).expect(403);
    });

    it('enforces a resend cooldown', async () => {
      const phone = nextPhone();
      await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(201);
      await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(429);
    });
  });

  describe('staff login', () => {
    it('locks after repeated wrong passwords', async () => {
      const admin = await createStaff(prisma, 'ADMIN');
      for (let i = 0; i < 5; i++) {
        await request(http()).post(`${API}/auth/login`).send({ phone: admin.phone, password: 'wrong-password' }).expect(401);
      }
      await request(http()).post(`${API}/auth/login`).send({ phone: admin.phone, password: STAFF_PASSWORD }).expect(429);
    });
  });

  describe('sessions', () => {
    it('revokes the access token on logout', async () => {
      const passenger = await loginPassenger(app);
      await request(http()).get(`${API}/users/profile`).set(passenger.auth).expect(200);
      await request(http()).post(`${API}/auth/logout`).set(passenger.auth).send({ refreshToken: passenger.refreshToken }).expect(201);
      await request(http()).get(`${API}/users/profile`).set(passenger.auth).expect(401);
      await request(http()).post(`${API}/auth/refresh`).send({ refreshToken: passenger.refreshToken }).expect(403);
    });

    it('applies a role change to tokens that are already issued', async () => {
      const admin = await createStaff(prisma, 'ADMIN');
      const session = await loginStaff(app, admin.phone);
      await request(http()).get(`${API}/users`).set(session.auth).expect(200);
      await prisma.user.update({ where: { id: admin.id }, data: { role: 'PASSENGER' } });
      await request(http()).get(`${API}/users`).set(session.auth).expect(403);
    });

    it('rejects tokens of deleted users', async () => {
      const passenger = await loginPassenger(app);
      await prisma.user.delete({ where: { id: passenger.user.id } });
      await request(http()).get(`${API}/users/profile`).set(passenger.auth).expect(401);
    });
  });

  describe('passengers cannot reach admin operations', () => {
    let passenger: any;

    beforeAll(async () => {
      passenger = await loginPassenger(app);
    });

    const adminRoutes: [string, string, any][] = ([

      ['get', '/users'],
      ['get', '/users/x'],
      ['post', '/users', { name: 'hacker', phone: '0512345678', rankId: 'rank-admin', password: 'long-enough-password' }],
      ['put', '/users/x', { rankId: 'rank-admin' }],
      ['put', '/users/x/wallet', { amount: 1000, description: 'free money' }],
      ['put', '/users/x/wallet/reset'],
      ['delete', '/users/x'],
      ['get', '/trips/admin/all'],
      ['post', '/trips', {}],
      ['put', '/trips/x', {}],
      ['delete', '/trips/x'],
      ['post', '/trips/x/cancel', {}],
      ['get', '/buses'],
      ['post', '/buses', {}],
      ['put', '/buses/x', {}],
      ['delete', '/buses/x'],
      ['get', '/packages/admin/all'],
      ['post', '/packages', {}],
      ['delete', '/packages/x'],
      ['post', '/services', {}],
      ['get', '/coupons'],
      ['post', '/coupons', {}],
      ['put', '/settings', {}],
      ['get', '/dashboard/stats'],
      ['get', '/dashboard/audit-log'],
      ['get', '/bookings/admin/all'],
      ['post', '/bookings/x/cancellation/review', { approve: true }],
      ['post', '/bookings/x/admin-cancel', {}],
      ['post', '/tickets/verify', { signedToken: 'x', tripId: 'x' }],
      ['get', '/tickets/my-trips'],
      ['get', '/tickets/manifest/x'],
      // Every row needs all three values: jest treats a missing argument as a `done` callback and waits for it.
    ] as [string, string, any?][]).map(([method, path, body]) => [method, path, body ?? {}]);

    it.each(adminRoutes)('%s %s returns 403', async (method, path, body) => {
      await (request(http()) as any)[method](`${API}${path}`).set(passenger.auth).send(body).expect(403);
    });

    it.each(adminRoutes)('%s %s returns 401 without a token', async (method, path, body) => {
      await (request(http()) as any)[method](`${API}${path}`).send(body).expect(401);
    });

    it('never exposes password hashes through the staff users list', async () => {
      const admin = await createStaff(prisma, 'ADMIN');
      const session = await loginStaff(app, admin.phone);
      const list = await request(http()).get(`${API}/users`).set(session.auth).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('passwordHash');
      const details = await request(http()).get(`${API}/users/${admin.id}`).set(session.auth).expect(200);
      expect(details.body.passwordHash).toBeUndefined();
    });
  });

  describe('admin user management', () => {
    let session: any;
    let adminId: string;

    beforeAll(async () => {
      const admin = await createStaff(prisma, 'ADMIN');
      adminId = admin.id;
      session = await loginStaff(app, admin.phone);
    });

    it('rejects an unknown rank', async () => {
      const passenger = await loginPassenger(app);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(session.auth).send({ rankId: 'no-such-rank' }).expect(400);
    });

    it('requires a password before promoting someone to staff', async () => {
      const passenger = await loginPassenger(app);
      await request(http()).put(`${API}/users/${passenger.user.id}`).set(session.auth).send({ rankId: 'rank-staff' }).expect(400);
      await request(http())
        .put(`${API}/users/${passenger.user.id}`)
        .set(session.auth)
        .send({ rankId: 'rank-staff', password: 'a-long-enough-password' })
        .expect(200);
    });

    it('prevents an admin from demoting or deleting themselves', async () => {
      await request(http()).put(`${API}/users/${adminId}`).set(session.auth).send({ rankId: null }).expect(400);
      await request(http()).delete(`${API}/users/${adminId}`).set(session.auth).expect(400);
    });

    it('never lets an admin debit a wallet below zero and records signed amounts', async () => {
      const passenger = await loginPassenger(app);
      const url = `${API}/users/${passenger.user.id}/wallet`;
      await request(http()).put(url).set(session.auth).send({ amount: 100, description: 'تعويض' }).expect(200);
      await request(http()).put(url).set(session.auth).send({ amount: -500, description: 'خصم' }).expect(409);
      await request(http()).put(url).set(session.auth).send({ amount: -40, description: 'خصم' }).expect(200);

      const details = await request(http()).get(`${API}/users/${passenger.user.id}`).set(session.auth).expect(200);
      expect(Number(details.body.walletBalance)).toBe(60);
      expect(details.body.walletTransactions.map((t: any) => Number(t.amount)).sort((a: number, b: number) => a - b)).toEqual([-40, 100]);
      expect(details.body.walletTransactions.every((t: any) => t.createdById === adminId)).toBe(true);
    });

    it('records administrative actions in the audit log without secrets', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const log = await request(http()).get(`${API}/dashboard/audit-log`).set(session.auth).expect(200);
      expect(log.body.length).toBeGreaterThan(0);
      expect(JSON.stringify(log.body)).not.toContain('a-long-enough-password');
    });
  });
});

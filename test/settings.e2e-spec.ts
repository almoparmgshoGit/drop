import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AUDIT_EVENTS, describeAuditAction } from '../src/common/audit-events';
import { IntegrationsService } from '../src/common/services/integrations.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const SECRET = 'sk_live_this_value_must_never_leave_the_server_9876';

describe('Settings control panel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let adminId: string;
  let admin: any;
  let passenger: any;
  const http = () => app.getHttpServer();

  beforeAll(async () => {
    ({ app, prisma, redis } = await createTestApp());
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    adminId = adminUser.id;
    admin = await loginStaff(app, adminUser.phone);
    passenger = await loginPassenger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('every write has a name in the log', () => {
    it('finds a described event for each write route', () => {
      const stack: any[] = app.getHttpAdapter().getInstance()._router.stack;
      const routes = stack.flatMap((layer) => {
        if (!layer.route) return [];
        return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`);
      });
      const writes = routes.filter((route) => /^(POST|PUT|PATCH|DELETE) /.test(route));
      expect(writes.length).toBeGreaterThan(80);
      const missing = writes.filter((route) => !AUDIT_EVENTS[route.replace(`${API}/`, '/')]);
      expect(missing).toEqual([]);
    });

    it('never falls back to the address for a route it does not know', () => {
      const { event } = describeAuditAction(`POST ${API}/brand-new/route`);
      expect(event).not.toContain('/');
    });

    it('shows the event and its record in words, and hides machine traffic', async () => {
      await prisma.auditLog.createMany({
        data: [
          { userId: adminId, action: `PUT ${API}/settings`, entity: 'Settings', details: { maintenanceMode: true, vatRate: 15 } },
          { userId: adminId, action: `POST ${API}/bookings/quote`, entity: 'Bookings' },
          { userId: adminId, action: 'GET /payments/export', entity: 'PaymentTransaction', details: { rows: 7 } },
        ],
      });
      const { body } = await request(http()).get(`${API}/dashboard/audit-log`).set(admin.auth).expect(200);
      const events = body.map((row: any) => row.event);
      expect(events).toEqual(expect.arrayContaining(['تعديل إعدادات النظام', 'تصدير سجل المدفوعات']));
      expect(events).not.toContain('حساب سعر حجز');
      const summary = body.find((row: any) => row.event === 'تعديل إعدادات النظام').summary;
      expect(summary).toContain('وضع الصيانة');
      expect(summary).toContain('نسبة الضريبة');
      expect(JSON.stringify(body.map((row: any) => [row.event, row.section, row.summary, row.target]))).not.toContain('/api');
      expect(body.find((row: any) => row.event === 'تصدير سجل المدفوعات').summary).toBe('عدد السجلات: 7');
    });

    it('filters by section and pages through the rows', async () => {
      const { body } = await request(http()).get(`${API}/dashboard/audit-log`).query({ section: 'المدفوعات والاسترداد' }).set(admin.auth).expect(200);
      expect(body.every((row: any) => row.section === 'المدفوعات والاسترداد')).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      const none = await request(http()).get(`${API}/dashboard/audit-log`).query({ skip: 10000 }).set(admin.auth).expect(200);
      expect(none.body).toEqual([]);
      await request(http()).get(`${API}/dashboard/audit-log`).query({ section: 'nonsense' }).set(admin.auth).expect(400);
    });
  });

  describe('service keys', () => {
    it('keeps them from anyone without the permission', async () => {
      await request(http()).get(`${API}/settings/integrations`).expect(401);
      await request(http()).get(`${API}/settings/integrations`).set(passenger.auth).expect(403);
      await request(http()).put(`${API}/settings/integrations`).set(passenger.auth).send({ values: { paymentSecretKey: 'x' } }).expect(403);
    });

    it('encrypts a secret, shows only its end, and never returns or logs it', async () => {
      const saved = await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { paymentSecretKey: SECRET } }).expect(200);
      expect(JSON.stringify(saved.body)).not.toContain(SECRET);
      const field = saved.body.groups.flatMap((group: any) => group.fields).find((row: any) => row.key === 'paymentSecretKey');
      expect(field).toMatchObject({ configured: true, hint: '9876', unreadable: false });

      const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'integration.paymentSecretKey' } });
      expect(row.value).not.toContain(SECRET);
      expect(await app.get(IntegrationsService).value('paymentSecretKey')).toBe(SECRET);

      for (const path of ['/settings', '/settings/app-config', '/settings/admin', '/settings/panel', '/settings/integrations']) {
        const res = await request(http()).get(`${API}${path}`).set(admin.auth).expect(200);
        expect(JSON.stringify(res.body)).not.toContain(SECRET);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      const logs = await prisma.auditLog.findMany({ where: { action: { contains: 'settings/integrations' } } });
      expect(logs).toHaveLength(1);
      expect(logs[0].details).toEqual({ changed: ['paymentSecretKey'] });
      const log = await request(http()).get(`${API}/dashboard/audit-log`).set(admin.auth).expect(200);
      expect(JSON.stringify(log.body)).not.toContain(SECRET);
      expect(log.body.find((entry: any) => entry.event === 'تعديل مفاتيح الخدمات الخارجية').summary).toBe('المفتاح السري');
    });

    it('removes a key with null', async () => {
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { paymentSecretKey: null } }).expect(200);
      expect(await prisma.setting.count({ where: { key: 'integration.paymentSecretKey' } })).toBe(0);
    });

    it('rejects an unknown key and a map address that would not work', async () => {
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { somethingElse: 'x' } }).expect(400);
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { mapTilesUrl: 'http://tiles.example.com/map.png' } }).expect(400);
    });

    it('hands the map address to the app, because the map reads it', async () => {
      const url = 'https://tiles.example.com/{z}/{x}/{y}.png?key=public';
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { mapTilesUrl: url } }).expect(200);
      const { body } = await request(http()).get(`${API}/settings/app-config`).expect(200);
      expect(body.mapTilesUrl).toBe(url);
    });

    it('builds the Mapbox map from its token and style, for the app and the panel', async () => {
      const save = (values: object) => request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values });
      await save({ mapProvider: 'mapbox' }).expect(400);
      await save({ mapProvider: 'mapbox', mapboxPublicToken: 'sk.secret_token' }).expect(400);
      await save({ mapProvider: 'google' }).expect(400);
      await save({ mapProvider: 'mapbox', mapboxPublicToken: 'pk.public_token', mapboxStyle: 'not a style' }).expect(400);
      await save({ mapProvider: 'mapbox', mapboxPublicToken: 'pk.public_token', mapboxStyle: 'mapbox://styles/durob/custom1' }).expect(200);
      await save({ mapboxPublicToken: null }).expect(400);

      const tiles = 'https://api.mapbox.com/styles/v1/durob/custom1/tiles/256/{z}/{x}/{y}@2x?access_token=pk.public_token';
      const appConfig = await request(http()).get(`${API}/settings/app-config`).expect(200);
      expect(appConfig.body.mapTilesUrl).toBe(tiles);
      expect(appConfig.body.mapAttribution).toContain('Mapbox');
      const panel = await request(http()).get(`${API}/settings/panel`).set(admin.auth).expect(200);
      expect(panel.body.map).toMatchObject({ provider: 'mapbox', tilesUrl: tiles, searchToken: 'pk.public_token' });
    });

    it('goes back to the saved map address when Mapbox is turned off', async () => {
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { mapProvider: '', mapboxPublicToken: null, mapboxStyle: null } }).expect(200);
      const { body } = await request(http()).get(`${API}/settings/app-config`).expect(200);
      expect(body.mapTilesUrl).toBe('https://tiles.example.com/{z}/{x}/{y}.png?key=public');
      expect(body.mapAttribution).toBeNull();
    });
  });

  describe('app and panel settings', () => {
    it('keeps internal limits out of the public endpoints', async () => {
      const [general, appConfig] = await Promise.all([request(http()).get(`${API}/settings`).expect(200), request(http()).get(`${API}/settings/app-config`).expect(200)]);
      for (const body of [general.body, appConfig.body]) {
        for (const key of ['otpMaxAttempts', 'loginMaxFailures', 'panelNotice']) expect(body).not.toHaveProperty(key);
      }
      await request(http()).get(`${API}/settings/admin`).set(passenger.auth).expect(403);
      await request(http()).get(`${API}/settings/panel`).set(passenger.auth).expect(403);
    });

    it('saves only the fields sent and leaves the others', async () => {
      const before = await request(http()).get(`${API}/settings/admin`).set(admin.auth).expect(200);
      expect(before.body.holdMinutes).toBe(10);
      const { body } = await request(http()).put(`${API}/settings`).set(admin.auth).send({ holdMinutes: 15, panelNotice: 'اجتماع الساعة 5' }).expect(200);
      expect(body).toMatchObject({ holdMinutes: 15, panelNotice: 'اجتماع الساعة 5', loginMaxFailures: before.body.loginMaxFailures, systemName: before.body.systemName });
      const panel = await request(http()).get(`${API}/settings/panel`).set(admin.auth).expect(200);
      expect(panel.body.panelNotice).toBe('اجتماع الساعة 5');
    });

    it('refuses values that would lock people out', async () => {
      for (const bad of [{ loginMaxFailures: 0 }, { otpMaxAttempts: 1000 }, { holdMinutes: 0 }, { minAppVersion: 'latest' }, { androidStoreUrl: 'javascript:alert(1)' }, { maintenanceMode: 'yes' }]) {
        await request(http()).put(`${API}/settings`).set(admin.auth).send(bad).expect(400);
      }
    });

    it('stops new customers while registration is off, and lets existing ones in', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ registrationEnabled: false }).expect(200);
      const login = async (phone: string) => {
        await redis.del(`otp_cooldown:${phone}`);
        const otp = await request(http()).post(`${API}/auth/send-otp`).send({ phone }).expect(201);
        return request(http()).post(`${API}/auth/verify-otp`).send({ phone, code: otp.body.devCode });
      };
      expect((await login('+966511112222')).status).toBe(403);
      expect((await login(passenger.phone)).status).toBe(201);
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ registrationEnabled: true }).expect(200);
      expect((await login('+966511112222')).status).toBe(201);
    });

    it('rejects seat holds and bookings during maintenance, whatever the app version does', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ maintenanceMode: true, maintenanceMessage: 'صيانة قصيرة' }).expect(200);
      const appConfig = await request(http()).get(`${API}/settings/app-config`).expect(200);
      expect(appConfig.body).toMatchObject({ maintenanceMode: true, maintenanceMessage: 'صيانة قصيرة' });
      const trip = await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201);
      const hold = () => request(http()).post(`${API}/bookings/holds`).set(passenger.auth).send({ tripId: trip.body.id, seats: ['1'] });
      expect((await hold()).status).toBe(503);
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ maintenanceMode: false, bookingsEnabled: false }).expect(200);
      expect((await hold()).status).toBe(503);
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ bookingsEnabled: true, holdMinutes: 15 }).expect(200);
      const held = await hold();
      expect(held.status).toBe(201);
      const minutes = (new Date(held.body.heldUntil).getTime() - Date.now()) / 60000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
    });

    it('uses the saved defaults for a new trip that names none', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ defaultBoardingOpensBeforeMinutes: 90 }).expect(200);
      const trip = await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201);
      expect(trip.body.boardingOpensBeforeMinutes).toBe(90);
    });
  });
});

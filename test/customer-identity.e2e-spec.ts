import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase } from './helpers';

// Valid check digits: 1000000008 (national ID) and 2000000006 (iqama). 1000000016 is another valid national ID.
const NATIONAL_ID = '1000000008';
const OTHER_NATIONAL_ID = '1000000016';
const IQAMA = '2000000006';

describe('Customer identity and search-only access (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const save = (session: any, body: Record<string, unknown>) => request(http()).put(`${API}/users/profile`).set(session.auth).send({ name: 'عميل الاختبار', ...body });

  async function staffWith(permissions: string[]) {
    const rank = await prisma.rank.create({ data: { name: `rank ${Date.now()} ${Math.random()}`, role: 'STAFF', jobId: 'job-office', permissions } });
    const user = await createStaff(prisma, 'STAFF', undefined, rank.id);
    return loginStaff(app, user.phone);
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the document a customer registers with', () => {
    it('accepts each type in its own format, normalized, and makes a national ID holder Saudi', async () => {
      const customer = await loginPassenger(app);
      const { body } = await save(customer, { idType: 'NATIONAL_ID', idNumber: '١٠٠٠٠٠٠٠٠٨', nationality: 'مصري' }).expect(200);
      expect(body).toMatchObject({ idType: 'NATIONAL_ID', idNumber: NATIONAL_ID, nationality: 'سعودي' });

      const resident = await loginPassenger(app);
      expect((await save(resident, { idType: 'IQAMA', idNumber: IQAMA, nationality: 'مصري' }).expect(200)).body).toMatchObject({ idType: 'IQAMA', nationality: 'مصري' });

      const visitor = await loginPassenger(app);
      expect((await save(visitor, { idType: 'PASSPORT', idNumber: 'a12 345-67' }).expect(200)).body.idNumber).toBe('A1234567');
    });

    it('refuses a number that does not fit the chosen type or fails its check digit', async () => {
      const customer = await loginPassenger(app);
      // Digits only, of a sensible length; the first digit and the length are not fixed.
      await save(customer, { idType: 'NATIONAL_ID', idNumber: '12AB45' }).expect(400);
      await save(customer, { idType: 'IQAMA', idNumber: '123' }).expect(400);
      await save(customer, { idType: 'IQAMA', idNumber: '1'.repeat(21) }).expect(400);
      await save(customer, { idType: 'PASSPORT', idNumber: 'AB1' }).expect(400);
      await save(customer, { idType: 'IQAMA', idNumber: IQAMA, nationality: 'سعودي' }).expect(400);
      await save(customer, { idType: 'DRIVING_LICENSE', idNumber: NATIONAL_ID }).expect(400);
      await save(customer, { idNumber: OTHER_NATIONAL_ID }).expect(400);
    });

    it('keeps one account per document', async () => {
      const second = await loginPassenger(app);
      await save(second, { idType: 'NATIONAL_ID', idNumber: NATIONAL_ID }).expect(409);
    });

    it('lets the customer enter it once, after which only staff can change it', async () => {
      const customer = await loginPassenger(app);
      await save(customer, { idType: 'NATIONAL_ID', idNumber: OTHER_NATIONAL_ID }).expect(200);
      await save(customer, { idType: 'NATIONAL_ID', idNumber: OTHER_NATIONAL_ID }).expect(200);
      await save(customer, { idType: 'PASSPORT', idNumber: 'Z9999999' }).expect(403);
      await save(customer, { idType: null, idNumber: null }).expect(403);

      const { id } = (await request(http()).get(`${API}/users/profile`).set(customer.auth).expect(200)).body;
      const { body } = await request(http()).put(`${API}/users/${id}`).set(admin.auth).send({ idType: 'PASSPORT', idNumber: 'Z9999999' }).expect(200);
      expect(body).toMatchObject({ idType: 'PASSPORT', idNumber: 'Z9999999' });
    });

    it('offers the types to choose from', async () => {
      const customer = await loginPassenger(app);
      const { body } = await request(http()).get(`${API}/users/profile/options`).set(customer.auth).expect(200);
      expect(body.idTypes).toEqual([
        { key: 'NATIONAL_ID', label: 'هوية وطنية' },
        { key: 'IQAMA', label: 'إقامة' },
        { key: 'PASSPORT', label: 'جواز سفر' },
      ]);
    });
  });

  describe('employees who may not browse customers', () => {
    let searchOnly: any;
    let known: { id: string; phone: string };

    beforeAll(async () => {
      searchOnly = await staffWith(['customers.view']);
      const customer = await loginPassenger(app);
      await save(customer, { name: 'خالد عبدالرحمن الزهراني' }).expect(200);
      known = (await request(http()).get(`${API}/users/profile`).set(customer.auth).expect(200)).body;
    });

    it('get no table and no totals', async () => {
      const { body } = await request(http()).get(`${API}/users`).set(searchOnly.auth).expect(200);
      expect(body).toMatchObject({ items: [], restricted: true, summary: null });
      await request(http()).get(`${API}/users/wallets`).set(searchOnly.auth).expect(403);
    });

    it('find a customer only by a whole phone, ID number or a name of two words or more', async () => {
      const find = (search: string) => request(http()).get(`${API}/users`).query({ search }).set(searchOnly.auth);
      expect((await find(`0${known.phone.slice(4)}`).expect(200)).body.items.map((row: any) => row.id)).toEqual([known.id]);
      expect((await find('خالد عبدالرحمن').expect(200)).body.items.map((row: any) => row.id)).toContain(known.id);
      expect((await find(IQAMA).expect(200)).body.items).toHaveLength(1);
      await find('خالد').expect(400);
      await find(known.phone.slice(4, 8)).expect(400);
    });

    it('logs each search and stops at the daily allowance', async () => {
      expect(await prisma.auditLog.count({ where: { action: 'GET /users/lookup', userId: searchOnly.user.id } })).toBeGreaterThan(0);
      await prisma.setting.upsert({ where: { key: 'customerLookupDailyLimit' }, create: { key: 'customerLookupDailyLimit', value: '1' }, update: { value: '1' } });
      const limited = await staffWith(['customers.view']);
      await request(http()).get(`${API}/users`).query({ search: known.phone }).set(limited.auth).expect(200);
      await request(http()).get(`${API}/users`).query({ search: known.phone }).set(limited.auth).expect(429);
      await prisma.setting.delete({ where: { key: 'customerLookupDailyLimit' } });
    });

    it('still browse freely when they hold customers.list', async () => {
      const browser = await staffWith(['customers.view', 'customers.list']);
      const { body } = await request(http()).get(`${API}/users`).set(browser.auth).expect(200);
      expect(body.restricted).toBe(false);
      expect(body.items.length).toBeGreaterThan(1);
      expect(body.summary).not.toBeNull();
    });
  });

  describe('employees who may not browse bookings', () => {
    it('see no bookings until one exact search', async () => {
      const searchOnly = await staffWith(['bookings.view', 'bookings.all_branches']);
      const { body } = await request(http()).get(`${API}/bookings/admin/all`).set(searchOnly.auth).expect(200);
      expect(body).toMatchObject({ items: [], restricted: true });
      await request(http()).get(`${API}/bookings/admin/all`).query({ search: 'DR' }).set(searchOnly.auth).expect(400);
      await request(http()).get(`${API}/bookings/admin/search`).query({ q: '55' }).set(searchOnly.auth).expect(400);
      await request(http()).get(`${API}/bookings/admin/search`).query({ q: 'DRB-NOTHING1' }).set(searchOnly.auth).expect(200);
    });
  });
});

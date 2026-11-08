import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase } from './helpers';

describe('Profile details (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const save = (session: any, body: Record<string, unknown>) => request(http()).put(`${API}/users/profile`).set(session.auth).send({ name: 'عميل الاختبار', ...body });
  const profile = async (session: any) => (await request(http()).get(`${API}/users/profile`).set(session.auth).expect(200)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    const owner = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, owner.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('offers the lists a profile chooses from', async () => {
    const customer = await loginPassenger(app);
    const { body } = await request(http()).get(`${API}/users/profile/options`).set(customer.auth).expect(200);
    expect(body.nationalities).toContain('مصري');
    expect(body.nativeLanguages).toContainEqual({ key: 'ar', label: 'العربية' });
    await request(http()).get(`${API}/users/profile/options`).expect(401);
  });

  it('lets a customer fill in their own details and clear them again', async () => {
    const customer = await loginPassenger(app);
    await save(customer, { email: 'Ahmed@Example.com', nationality: 'مصري', nativeLanguage: 'bn', gender: 'MALE' }).expect(200);
    expect(await profile(customer)).toMatchObject({ email: 'ahmed@example.com', nationality: 'مصري', nativeLanguage: 'bn', gender: 'MALE' });

    await save(customer, { email: null, nationality: null, nativeLanguage: null, gender: null }).expect(200);
    expect(await profile(customer)).toMatchObject({ email: null, nationality: null, nativeLanguage: null, gender: null });
  });

  it('leaves the details alone when an older app sends only the name', async () => {
    const customer = await loginPassenger(app);
    await save(customer, { email: 'older-app@example.com', nativeLanguage: 'ur', gender: 'FEMALE' }).expect(200);
    await save(customer, { name: 'اسم جديد' }).expect(200);
    expect(await profile(customer)).toMatchObject({ name: 'اسم جديد', email: 'older-app@example.com', nativeLanguage: 'ur', gender: 'FEMALE' });
  });

  it('refuses values outside the lists', async () => {
    const customer = await loginPassenger(app);
    await save(customer, { gender: 'OTHER' }).expect(400);
    await save(customer, { nativeLanguage: 'klingon' }).expect(400);
    await save(customer, { email: 'not-an-email' }).expect(400);
    await save(customer, { nationality: 'مصرى' }).expect(400);
  });

  it('refuses an email another account holds, whatever its letter case', async () => {
    const first = await loginPassenger(app);
    const second = await loginPassenger(app);
    await save(first, { email: 'taken@example.com' }).expect(200);
    const res = await save(second, { email: 'TAKEN@example.com' }).expect(409);
    expect(res.body.message).toBe('هذا البريد الإلكتروني مستخدم في حساب آخر');
  });

  it('keeps a nationality typed before the list existed until it is changed', async () => {
    const customer = await loginPassenger(app);
    await prisma.user.update({ where: { id: customer.user.id }, data: { nationality: 'مصرية' } });
    await save(customer, { nationality: 'مصرية', gender: 'FEMALE' }).expect(200);
    expect((await profile(customer)).nationality).toBe('مصرية');
    await save(customer, { nationality: 'سودانية' }).expect(400);
  });

  describe('alert language', () => {
    it('follows a native language alerts are written in', async () => {
      const customer = await loginPassenger(app);
      await save(customer, { nativeLanguage: 'ur' }).expect(200);
      expect((await profile(customer)).messageLanguage).toBe('ur');
    });

    it('stays when no alert is written in the native language', async () => {
      const customer = await loginPassenger(app);
      await save(customer, { nativeLanguage: 'bn' }).expect(200);
      expect((await profile(customer)).messageLanguage).toBe('ar');
    });

    it('keeps what the customer chose afterwards when they save their details again', async () => {
      const customer = await loginPassenger(app);
      await save(customer, { nativeLanguage: 'ur' }).expect(200);
      await request(http()).put(`${API}/users/profile/messaging`).set(customer.auth).send({ messageLanguage: 'en' }).expect(200);
      await save(customer, { nativeLanguage: 'ur', gender: 'MALE' }).expect(200);
      expect((await profile(customer)).messageLanguage).toBe('en');
    });
  });

  it('does not let an employee change their sign-in email from their own profile', async () => {
    const staff = await createStaff(prisma, 'STAFF');
    await prisma.user.update({ where: { id: staff.id }, data: { email: 'staff-login@example.com' } });
    const session = await loginStaff(app, staff.phone);

    await save(session, { email: 'someone-else@example.com' }).expect(403);
    await save(session, { email: 'staff-login@example.com', gender: 'MALE' }).expect(200);
    expect(await profile(session)).toMatchObject({ email: 'staff-login@example.com', gender: 'MALE' });
  });

  describe('staff editing a customer', () => {
    it('saves and shows the details', async () => {
      const customer = await loginPassenger(app);
      await request(http()).put(`${API}/users/${customer.user.id}`).set(admin.auth).send({ nationality: 'هندي', nativeLanguage: 'hi', gender: 'FEMALE' }).expect(200);
      const { body } = await request(http()).get(`${API}/users/${customer.user.id}`).set(admin.auth).expect(200);
      expect(body).toMatchObject({ nationality: 'هندي', nativeLanguage: 'hi', gender: 'FEMALE' });
    });

    it('lets a language staff chose outright win over the native language', async () => {
      const customer = await loginPassenger(app);
      await request(http()).put(`${API}/users/${customer.user.id}`).set(admin.auth).send({ nativeLanguage: 'ur', messageLanguage: 'en' }).expect(200);
      expect((await profile(customer)).messageLanguage).toBe('en');
    });

    it('applies the same lists', async () => {
      const customer = await loginPassenger(app);
      await request(http()).put(`${API}/users/${customer.user.id}`).set(admin.auth).send({ nationality: 'نص حر' }).expect(400);
      await request(http()).put(`${API}/users/${customer.user.id}`).set(admin.auth).send({ gender: 'OTHER' }).expect(400);
    });
  });

  it('reaches the customers audience through the saved nationality', async () => {
    const customer = await loginPassenger(app);
    await save(customer, { nationality: 'نيجيري' }).expect(200);
    const { body } = await request(http()).post(`${API}/notifications/campaigns/audience`).set(admin.auth).send({ filters: { nationalities: ['نيجيري'] } }).expect(200);
    expect(body.count).toBe(1);
  });

  it('filters the customers table by nationality and gender, and counts each nationality', async () => {
    const customer = await loginPassenger(app);
    await save(customer, { nationality: 'موريتاني', gender: 'FEMALE' }).expect(200);
    const list = (query: string) => request(http()).get(`${API}/users?${query}`).set(admin.auth).expect(200);
    const byNationality = (await list(`nationality=${encodeURIComponent('موريتاني')}`)).body;
    expect(byNationality.items.map((row: any) => row.id)).toEqual([customer.user.id]);
    expect(byNationality.items[0]).toMatchObject({ nationality: 'موريتاني', gender: 'FEMALE' });
    expect(byNationality.summary.byNationality).toEqual(expect.arrayContaining([{ nationality: 'موريتاني', count: 1 }]));
    expect((await list(`nationality=${encodeURIComponent('موريتاني')}&gender=MALE`)).body.items).toHaveLength(0);
    await request(http()).get(`${API}/users?gender=OTHER`).set(admin.auth).expect(400);
  });
});

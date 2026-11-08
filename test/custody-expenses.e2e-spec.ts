import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { riyadhDate, riyadhMonth } from '../src/common/utils/time.util';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

let keyCounter = 0;
const key = () => `custody-expense-${++keyCounter}`;
const PDF = Buffer.from('%PDF-1.7 test', 'latin1');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'latin1');
const today = () => riyadhDate(new Date());

describe('Custody expenses from the app', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let supervisor: { auth: Record<string, string> };
  let supervisorId: string;
  let other: { auth: Record<string, string> };
  let otherId: string;
  let branchId: string;
  let tripId: string;

  const http = () => app.getHttpServer();
  const get = (url: string, auth = supervisor.auth) => request(http()).get(`${API}${url}`).set(auth);
  const post = (url: string, body: object, auth = admin.auth) => request(http()).post(`${API}${url}`).set(auth).send(body);
  const issue = async (amount = 500, recipientId = supervisorId, trip: string | null = tripId) =>
    (await post(`/cash/branches/${branchId}/custodies`, { recipientId, amount, purpose: 'مصاريف رحلة', tripId: trip ?? undefined, idempotencyKey: key() }).expect(201)).body.id as string;
  const spend = (custodyId: string, body: Record<string, unknown> = {}, files: { data: Buffer; name: string }[] = [{ data: PNG, name: 'r.png' }], auth = supervisor.auth) => {
    let req = request(http()).post(`${API}/crew/custodies/${custodyId}/expenses`).set(auth);
    const fields = { categoryId: 'acct-fuel', amount: 100, spentOn: today(), hasTaxInvoice: false, supplierName: 'محطة الدريس', idempotencyKey: key(), ...body };
    for (const [name, value] of Object.entries(fields)) if (value !== undefined) req = req.field(name, String(value));
    for (const file of files) req = req.attach('invoices', file.data, file.name);
    return req;
  };
  const settle = (custodyId: string, spent: number, files: { data: Buffer; name: string }[] = []) => {
    let req = request(http()).post(`${API}/cash/custodies/${custodyId}/settle`).set(admin.auth).field('spentAmount', String(spent));
    for (const file of files) req = req.attach('invoices', file.data, file.name);
    return req;
  };
  const detail = async (id: string, auth = supervisor.auth) => (await get(`/crew/custodies/${id}`, auth).expect(200)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-ce-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, adminUser.phone);
    branchId = (await prisma.branch.create({ data: { name: 'فرع الحدائق' } })).id;
    await post(`/cash/branches/${branchId}/sessions`, { openingBalance: 5000 }).expect(201);
    const one = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-supervisor');
    const two = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-supervisor');
    supervisorId = one.id;
    otherId = two.id;
    supervisor = await loginStaff(app, one.phone);
    other = await loginStaff(app, two.phone);
    tripId = (await post('/trips', tripPayload()).expect(201)).body.id;
  });

  describe('access', () => {
    it('gives the supervisor and driver ranks the permission through the migration, and nobody else', async () => {
      for (const id of ['rank-supervisor', 'rank-driver']) expect((await prisma.rank.findUniqueOrThrow({ where: { id } })).permissions).toContain('crew.custody');
      expect((await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-accountant' } })).permissions).not.toContain('crew.custody');
    });

    it('refuses anonymous callers, customers and staff without the permission on every route', async () => {
      const customer = await loginPassenger(app);
      await prisma.rank.create({ data: { id: 'test-ce-none', name: 'test-ce-none', role: 'STAFF', jobId: 'job-office', permissions: ['crew.trips'] } }).catch(() => null);
      const plain = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-ce-none')).phone);
      const routes: [string, string][] = [['get', '/crew/custodies'], ['get', '/crew/custodies/x'], ['post', '/crew/custodies/x/expenses'], ['post', '/crew/custodies/expenses/x/void'], ['get', '/crew/custodies/attachments/x']];
      for (const [method, url] of routes) {
        await (request(http()) as any)[method](`${API}${url}`).expect(401);
        for (const who of [customer, plain]) await (request(http()) as any)[method](`${API}${url}`).set(who.auth).expect(403);
      }
    });

    it('never shows or touches another holder’s custody, even for an admin using these routes', async () => {
      const id = await issue();
      const expense = (await spend(id).expect(201)).body;
      const fileId = expense.attachments[0].id;

      for (const auth of [other.auth, admin.auth]) {
        expect((await get('/crew/custodies', auth).expect(200)).body.items).toHaveLength(0);
        await get(`/crew/custodies/${id}`, auth).expect(404);
        await get(`/crew/custodies/attachments/${fileId}`, auth).expect(404);
        await spend(id, {}, undefined, auth).expect(404);
        await post(`/crew/custodies/expenses/${expense.id}/void`, { reason: 'ليس لي' }, auth).expect(404);
      }
      expect((await detail(id)).custody.spent).toBe(100);
    });

    it('keeps office refusal of an expense to settlers of that branch', async () => {
      const id = await issue();
      const expense = (await spend(id).expect(201)).body;
      await post(`/cash/custody-expenses/${expense.id}/void`, { reason: 'لا صلاحية' }, supervisor.auth).expect(403);
      await prisma.rank.upsert({ where: { id: 'test-ce-settler' }, create: { id: 'test-ce-settler', name: 'test-ce-settler', role: 'STAFF', jobId: 'job-office', permissions: ['custody.settle'] }, update: {} });
      const stranger = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-ce-settler')).phone);
      await post(`/cash/custody-expenses/${expense.id}/void`, { reason: 'فرع آخر' }, stranger.auth).expect(403);
    });
  });

  describe('viewing', () => {
    it('shows open custodies first with what is left, and filters by trip', async () => {
      const closed = await issue(100);
      await settle(closed, 0).expect(201);
      const mine = await issue(500);
      const noTrip = await issue(70, supervisorId, null);
      await spend(mine, { amount: 120.5 }).expect(201);

      const { items, totalRemaining } = (await get('/crew/custodies').expect(200)).body;
      expect(items[items.length - 1].id).toBe(closed);
      expect(items.find((row: any) => row.id === mine)).toMatchObject({ amount: 500, spent: 120.5, remaining: 379.5, expenseCount: 1, status: 'OPEN', code: expect.stringMatching(/^CU-/) });
      expect(totalRemaining).toBe(449.5);
      const forTrip = (await get(`/crew/custodies?tripId=${tripId}`).expect(200)).body.items.map((row: any) => row.id);
      expect(forTrip).toContain(mine);
      expect(forTrip).not.toContain(noTrip);
    });

    it('offers only lines a holder can spend on', async () => {
      const { categories } = await detail(await issue());
      const ids = categories.map((row: { id: string }) => row.id);
      expect(ids).toEqual(expect.arrayContaining(['acct-fuel', 'acct-driver', 'acct-meals']));
      for (const refused of ['acct-bus', 'acct-hotel', 'acct-income']) expect(ids).not.toContain(refused);
    });

    it('lists invoices without their bytes and serves them to their holder', async () => {
      const id = await issue();
      await spend(id, {}, [{ data: PDF, name: 'فاتورة.pdf' }]).expect(201);
      const [file] = (await detail(id)).expenses[0].attachments;
      expect(file).toEqual({ id: file.id, fileName: 'فاتورة.pdf', mimeType: 'application/pdf', size: PDF.length });
      const res = await get(`/crew/custodies/attachments/${file.id}`).expect(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
      expect(Buffer.from(res.body).equals(PDF)).toBe(true);
    });
  });

  describe('recording', () => {
    it('requires every piece of data, on the server', async () => {
      const id = await issue();
      expect((await spend(id, {}, []).expect(400)).body.message).toContain('الفاتورة');
      await spend(id, { supplierName: undefined }).expect(400);
      await spend(id, { supplierName: ' ' }).expect(400);
      await spend(id, { amount: undefined }).expect(400);
      await spend(id, { amount: 0 }).expect(400);
      await spend(id, { amount: -5 }).expect(400);
      await spend(id, { amount: 1.234 }).expect(400);
      await spend(id, { hasTaxInvoice: undefined }).expect(400);
      await spend(id, { hasTaxInvoice: 'maybe' }).expect(400);
      await spend(id, { spentOn: 'أمس' }).expect(400);
      await spend(id, { spentOn: '2026-02-31' }).expect(400);
      await spend(id, { spentOn: '2099-01-01' }).expect(400);
      await spend(id, { categoryId: 'missing' }).expect(400);
      await spend(id, { categoryId: 'acct-bus' }).expect(400);
      await spend(id, { categoryId: 'acct-income' }).expect(400);
      await spend(id, { custodyId: 'x' }).expect(400);
      expect(await prisma.custodyExpense.count()).toBe(0);
    });

    it('refuses a date before the custody was issued', async () => {
      const id = await issue();
      await spend(id, { spentOn: '2020-01-01' }).expect(400);
    });

    it('judges files by their bytes and saves nothing when one is refused', async () => {
      const id = await issue();
      await spend(id, {}, [{ data: HTML, name: 'invoice.png' }]).expect(400);
      await spend(id, {}, [{ data: PNG, name: 'a.png' }, { data: HTML, name: 'b.pdf' }]).expect(400);
      const six = Array.from({ length: 6 }, (_, index) => ({ data: PNG, name: `${index}.png` }));
      expect((await spend(id, {}, six)).status).toBeGreaterThanOrEqual(400);
      expect(await prisma.custodyExpense.count()).toBe(0);
      expect(await prisma.custodyAttachment.count()).toBe(0);
    });

    it('takes VAT out of the amount only with a tax invoice', async () => {
      const id = await issue();
      const taxed = (await spend(id, { amount: 115, hasTaxInvoice: true }).expect(201)).body;
      const plain = (await spend(id, { amount: 50, hasTaxInvoice: false }).expect(201)).body;
      expect(taxed).toMatchObject({ vat: 15, hasTaxInvoice: true });
      expect(plain).toMatchObject({ vat: 0, hasTaxInvoice: false });
    });

    it('cannot spend more than remains, even when requests race', async () => {
      const id = await issue(300);
      expect((await spend(id, { amount: 300.01 }).expect(400)).body.message).toContain('300');
      const results = await Promise.all(Array.from({ length: 5 }, () => spend(id, { amount: 100 })));
      expect(results.filter((res) => res.status === 201)).toHaveLength(3);
      expect(results.filter((res) => res.status === 400)).toHaveLength(2);
      expect((await detail(id)).custody).toMatchObject({ spent: 300, remaining: 0 });
    });

    it('records a retried upload once', async () => {
      const id = await issue();
      const idempotencyKey = key();
      const results = await Promise.all(Array.from({ length: 3 }, () => spend(id, { idempotencyKey })));
      expect(results.every((res) => res.status === 201)).toBe(true);
      expect(new Set(results.map((res) => res.body.id)).size).toBe(1);
      expect(await prisma.custodyAttachment.count()).toBe(1);
      expect((await detail(id)).custody.spent).toBe(100);
    });

    it('does not touch the drawer, which paid when the custody was issued', async () => {
      const id = await issue(500);
      const before = (await request(http()).get(`${API}/cash/branches/${branchId}/overview`).set(admin.auth).expect(200)).body.lines.expected;
      await spend(id, { amount: 200 }).expect(201);
      const after = (await request(http()).get(`${API}/cash/branches/${branchId}/overview`).set(admin.auth).expect(200)).body.lines.expected;
      expect(after).toBe(before);
    });

    it('writes the audit log without the files', async () => {
      await spend(await issue()).expect(201);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'CrewCustody' } });
      expect(JSON.stringify(log.details)).toContain('محطة الدريس');
      expect(JSON.stringify(log.details)).not.toContain('PNG');
    });
  });

  describe('voiding', () => {
    it('gives the money back to the balance and keeps the line and its file in the log', async () => {
      const id = await issue();
      const expense = (await spend(id, { amount: 200 }).expect(201)).body;
      await post(`/crew/custodies/expenses/${expense.id}/void`, { reason: 'x' }, supervisor.auth).expect(400);
      await post(`/crew/custodies/expenses/${expense.id}/void`, { reason: 'مبلغ خاطئ' }, supervisor.auth).expect(201);
      await post(`/crew/custodies/expenses/${expense.id}/void`, { reason: 'مرة ثانية' }, supervisor.auth).expect(409);
      const body = await detail(id);
      expect(body.custody).toMatchObject({ spent: 0, remaining: 500, expenseCount: 0 });
      expect(body.expenses[0]).toMatchObject({ voidReason: 'مبلغ خاطئ' });
      expect(body.expenses[0].attachments).toHaveLength(1);
    });

    it('tells the holder when the office refuses an expense', async () => {
      const id = await issue();
      const expense = (await spend(id, { amount: 80 }).expect(201)).body;
      await post(`/cash/custody-expenses/${expense.id}/void`, { reason: 'الفاتورة غير واضحة' }).expect(201);
      const message = await prisma.notification.findFirstOrThrow({ where: { userId: supervisorId, event: 'CUSTODY_EXPENSE_VOIDED' } });
      expect(message.body).toContain('الفاتورة غير واضحة');
      expect((await detail(id)).custody.spent).toBe(0);
    });
  });

  describe('settlement', () => {
    it('accepts recorded expenses without more files, and returns the rest to the drawer', async () => {
      const id = await issue(500);
      await spend(id, { amount: 300 }).expect(201);
      const settled = (await settle(id, 300).expect(201)).body;
      expect(settled).toMatchObject({ status: 'SETTLED' });
      expect(Number(settled.returnedAmount)).toBe(200);
      expect(settled.expenses).toHaveLength(1);
      expect(settled.attachments).toHaveLength(1);
      expect((await detail(id)).custody).toMatchObject({ status: 'SETTLED', spent: 300, remaining: 0, returned: 200 });
    });

    it('refuses to settle below what is recorded, and asks for an invoice above it', async () => {
      const id = await issue(500);
      await spend(id, { amount: 300 }).expect(201);
      expect((await settle(id, 250).expect(400)).body.message).toContain('300');
      await settle(id, 350).expect(400);
      await settle(id, 350, [{ data: PDF, name: 'extra.pdf' }]).expect(201);
    });

    it('closes the custody to new expenses and voids', async () => {
      const id = await issue(500);
      const expense = (await spend(id, { amount: 100 }).expect(201)).body;
      await settle(id, 100).expect(201);
      await spend(id, { amount: 10 }).expect(409);
      await post(`/crew/custodies/expenses/${expense.id}/void`, { reason: 'متأخر جدًا' }, supervisor.auth).expect(409);
      await post(`/cash/custody-expenses/${expense.id}/void`, { reason: 'متأخر جدًا' }).expect(409);
      expect((await detail(id)).categories).toEqual([]);
    });

    it('cannot lose an expense racing the settlement', async () => {
      const id = await issue(500);
      const [spent, settled] = await Promise.all([spend(id, { amount: 100 }), settle(id, 0)]);
      if (settled.status === 201) expect(spent.status).toBe(409);
      else expect(spent.status).toBe(201);
    });
  });

  describe('reaching the accounts', () => {
    const account = async () => (await request(http()).get(`${API}/trip-accounts/${tripId}`).set(admin.auth).expect(200)).body;
    const tax = async () => (await request(http()).get(`${API}/invoices/tax-report?month=${riyadhMonth(new Date())}`).set(admin.auth).expect(200)).body.totals;

    it('stays out of the trip account and the tax report until settled', async () => {
      const id = await issue(500);
      await spend(id, { amount: 115, hasTaxInvoice: true }).expect(201);
      expect((await account()).figures.expenses).toBe(0);
      expect((await account()).pendingCustody).toBe(115);
      expect((await tax()).inputVat).toBe(0);

      await settle(id, 115).expect(201);
      const after = await account();
      expect(after.figures.other).toBe(115);
      expect(after.pendingCustody).toBe(0);
      expect((await tax()).inputVat).toBe(15);
    });

    it('spreads a settled custody over the columns of its expenses, once', async () => {
      const id = await issue(500);
      await spend(id, { categoryId: 'acct-driver', amount: 100 }).expect(201);
      await spend(id, { categoryId: 'acct-admin', amount: 60 }).expect(201);
      await spend(id, { categoryId: 'acct-fuel', amount: 40 }).expect(201);
      await settle(id, 250, [{ data: PDF, name: 'extra.pdf' }]).expect(201);
      expect((await account()).figures).toMatchObject({ driver: 100, admin: 60, other: 90, expenses: 250 });
    });

    it('leaves voided expenses out of the settled figures and input VAT', async () => {
      const id = await issue(500);
      const wrong = (await spend(id, { amount: 230, hasTaxInvoice: true }).expect(201)).body;
      await spend(id, { amount: 115, hasTaxInvoice: true }).expect(201);
      await post(`/cash/custody-expenses/${wrong.id}/void`, { reason: 'مكررة' }).expect(201);
      await settle(id, 115).expect(201);
      expect((await account()).figures.other).toBe(115);
      expect((await tax()).inputVat).toBe(15);
    });
  });

  it('keeps one holder apart from another', async () => {
    const mine = await issue(100);
    const theirs = await issue(900, otherId);
    await spend(theirs, { amount: 500 }, undefined, other.auth).expect(201);
    expect((await detail(mine)).custody.remaining).toBe(100);
    expect((await get('/crew/custodies').expect(200)).body.totalRemaining).toBe(100);
  });
});

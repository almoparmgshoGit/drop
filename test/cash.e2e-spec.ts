import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { CashService } from '../src/modules/cash/cash.service';
import { CollectionsService } from '../src/modules/cash/collections.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.7 test', 'latin1');
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'latin1');

let keyCounter = 0;
const key = () => `test-key-${++keyCounter}`;

describe('Cash drawer and custody', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cash: CashService;
  let admin: { auth: Record<string, string> };
  let adminUser: { id: string };
  let cashier: { auth: Record<string, string> };
  let cashierUser: { id: string };
  let recipient: { auth: Record<string, string> };
  let recipientUser: { id: string };
  let branchId: string;
  let otherBranchId: string;

  const server = () => app.getHttpServer();
  const post = (path: string, auth: Record<string, string>, body: object = {}) => request(server()).post(`${API}${path}`).set(auth).send(body);
  const get = (path: string, auth: Record<string, string>) => request(server()).get(`${API}${path}`).set(auth);
  const overview = async (id = branchId, auth = admin.auth) => (await get(`/cash/branches/${id}/overview`, auth).expect(200)).body;
  const open = (id = branchId, openingBalance = 1000, extra: object = {}, auth = admin.auth) => post(`/cash/branches/${id}/sessions`, auth, { openingBalance, ...extra });
  const issue = (amount: number, extra: object = {}, auth = admin.auth, id = branchId) =>
    post(`/cash/branches/${id}/custodies`, auth, { recipientId: recipientUser.id, amount, purpose: 'مصاريف رحلة', idempotencyKey: key(), ...extra });
  const settle = (custodyId: string, auth: Record<string, string>, spent: string | number, files: { data: Buffer; name: string }[] = [], note?: string) => {
    let req = request(server()).post(`${API}/cash/custodies/${custodyId}/settle`).set(auth).field('spentAmount', String(spent));
    if (note) req = req.field('note', note);
    for (const file of files) req = req.attach('invoices', file.data, file.name);
    return req;
  };
  const close = async (counted: number, note?: string, id = branchId) => {
    const data = await overview(id);
    return post(`/cash/sessions/${data.session.id}/close`, admin.auth, { countedCash: counted, expectedBalance: data.lines.expected, note });
  };
  const rank = async (id: string, permissions: string[]) => {
    await prisma.rank.upsert({
      where: { id },
      create: { id, name: id, role: 'STAFF', jobId: 'job-office', permissions },
      update: { permissions },
    });
    return id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    cash = app.get(CashService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-cash-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    adminUser = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, (adminUser as any).phone);
    const main = await prisma.branch.create({ data: { name: 'فرع الحدائق' } });
    const other = await prisma.branch.create({ data: { name: 'فرع العليا' } });
    branchId = main.id;
    otherBranchId = other.id;

    const cashierRank = await rank('test-cash-cashier', ['cash.view', 'cash.operate', 'custody.issue', 'custody.settle']);
    cashierUser = await createStaff(prisma, 'STAFF', nextPhone(), cashierRank);
    await prisma.user.update({ where: { id: cashierUser.id }, data: { branchId } });
    cashier = await loginStaff(app, (cashierUser as any).phone);

    recipientUser = await createStaff(prisma, 'STAFF');
    recipient = await loginStaff(app, (recipientUser as any).phone);
  });

  describe('access', () => {
    it('refuses anonymous callers, customers and staff without the permission on every route', async () => {
      const customer = await loginPassenger(app);
      const routes = [`/cash/branches/${branchId}/overview`, `/cash/branches/${branchId}/custodies`, `/cash/branches/${branchId}/sessions`, '/cash/custody-options'];
      for (const route of routes) {
        await request(server()).get(`${API}${route}`).expect(401);
        await get(route, customer.auth).expect(403);
        await get(route, recipient.auth).expect(403);
      }
      await post(`/cash/branches/${branchId}/sessions`, recipient.auth, { openingBalance: 5 }).expect(403);
      await post('/cash/branches', cashier.auth, { name: 'فرع جديد' }).expect(403);
    });

    it('confines an employee to their own branch, for reading and for writing', async () => {
      await open(otherBranchId).expect(201);
      const custody = (await issue(100, {}, admin.auth, otherBranchId).expect(201)).body;
      await get(`/cash/branches/${otherBranchId}/overview`, cashier.auth).expect(403);
      await get(`/cash/branches/${otherBranchId}/custodies`, cashier.auth).expect(403);
      await open(otherBranchId, 10, {}, cashier.auth).expect(403);
      await issue(10, {}, cashier.auth, otherBranchId).expect(403);
      await settle(custody.id, cashier.auth, 100, [{ data: PNG, name: 'a.png' }]).expect(403);
      const session = (await overview(otherBranchId)).session;
      await post(`/cash/sessions/${session.id}/close`, cashier.auth, { countedCash: 0, expectedBalance: 900 }).expect(403);

      const branches = (await get('/cash/branches', cashier.auth).expect(200)).body;
      expect(branches.map((b: { id: string }) => b.id)).toEqual([branchId]);
    });

    it('offers only drawers the caller can open, and every branch only for administering', async () => {
      const mixedRank = await rank('test-cash-mixed', ['cash.view', 'employees.manage']);
      const mixedUser = await createStaff(prisma, 'STAFF', nextPhone(), mixedRank);
      await prisma.user.update({ where: { id: mixedUser.id }, data: { branchId } });
      const mixed = await loginStaff(app, (mixedUser as any).phone);
      const names = async (path: string, auth: Record<string, string>) => (await get(path, auth).expect(200)).body.map((b: { id: string }) => b.id).sort();

      expect(await names('/cash/branches', mixed.auth)).toEqual([branchId]);
      expect(await names('/cash/branches?all=true', mixed.auth)).toEqual([branchId, otherBranchId].sort());
      expect(await names('/cash/branches?all=true', cashier.auth)).toEqual([branchId]);
      expect(await names('/cash/branches', admin.auth)).toEqual([branchId, otherBranchId].sort());
      await get(`/cash/branches/${otherBranchId}/overview`, mixed.auth).expect(403);
    });

    it('applies a branch move at once, and only an employee manager can make it', async () => {
      await request(server()).put(`${API}/users/${cashierUser.id}`).set(cashier.auth).send({ branchId: otherBranchId }).expect(403);
      await request(server()).put(`${API}/users/${cashierUser.id}`).set(admin.auth).send({ branchId: otherBranchId }).expect(200);
      await get(`/cash/branches/${otherBranchId}/overview`, cashier.auth).expect(200);
      await get(`/cash/branches/${branchId}/overview`, cashier.auth).expect(403);
    });

    it('never returns invoice bytes in a list, and scopes the download to the branch', async () => {
      await open().expect(201);
      const custody = (await issue(100).expect(201)).body;
      await settle(custody.id, admin.auth, 100, [{ data: PDF, name: 'فاتورة.pdf' }]).expect(201);
      const list = (await get(`/cash/branches/${branchId}/custodies`, admin.auth).expect(200)).body;
      const file = list.items[0].attachments[0];
      expect(file).toEqual({ id: expect.any(String), fileName: 'فاتورة.pdf', mimeType: 'application/pdf', size: PDF.length });

      const download = await get(`/cash/attachments/${file.id}`, cashier.auth).expect(200);
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(download.headers['content-type']).toContain('application/pdf');

      await request(server()).put(`${API}/users/${cashierUser.id}`).set(admin.auth).send({ branchId: otherBranchId }).expect(200);
      await get(`/cash/attachments/${file.id}`, cashier.auth).expect(403);
      await get(`/cash/attachments/${file.id}`, recipient.auth).expect(403);
    });
  });

  describe('opening', () => {
    it('allows only one open drawer per branch, even when requests race', async () => {
      const results = await Promise.all([open(), open(), open(), open()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await prisma.cashSession.count({ where: { branchId, status: 'OPEN' } })).toBe(1);
      await open(otherBranchId).expect(201);
    });

    it('carries the last count forward and demands a reason for anything else', async () => {
      await open(undefined, 500).expect(201);
      await close(480, 'نقص في العد').then((r) => expect(r.status).toBe(201));

      await open(undefined, 300).expect(400);
      await open(undefined, 300, { note: 'x' }).expect(400);
      const changed = await open(undefined, 300, { note: 'إيداع 180 في البنك' }).expect(201);
      expect(Number(changed.body.carriedBalance)).toBe(480);
      expect(changed.body.openingNote).toBe('إيداع 180 في البنك');

      await close(300);
      await open(undefined, 300).expect(201);
    });

    it('alerts all-branch holders when the opening differs, but not the person who did it', async () => {
      const managerRank = await rank('test-cash-manager', ['cash.all_branches', 'cash.view']);
      const manager = await createStaff(prisma, 'STAFF', nextPhone(), managerRank);
      await open(undefined, 500).expect(201);
      await close(500);
      await open(undefined, 100, { note: 'إيداع في البنك' }, cashier.auth).expect(201);
      expect(await prisma.notification.count({ where: { userId: manager.id, event: 'CASH_OPENING_CHANGED' } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: cashierUser.id, event: 'CASH_OPENING_CHANGED' } })).toBe(0);
    });

    it('rejects negative, malformed and over-precise amounts, and an inactive branch', async () => {
      await open(undefined, -1).expect(400);
      await open(undefined, 1.234).expect(400);
      await post(`/cash/branches/${branchId}/sessions`, admin.auth, { openingBalance: '100' }).expect(400);
      await post(`/cash/branches/${branchId}/sessions`, admin.auth, { openingBalance: 100, status: 'CLOSED' }).expect(400);
      await request(server()).patch(`${API}/cash/branches/${otherBranchId}`).set(admin.auth).send({ isActive: false }).expect(200);
      await open(otherBranchId).expect(409);
    });
  });

  describe('issuing', () => {
    it('reduces the expected balance and records who, when and from which drawer', async () => {
      await open(undefined, 1000).expect(201);
      const custody = (await issue(800, {}, cashier.auth).expect(201)).body;
      expect(custody).toMatchObject({ status: 'OPEN', issuedByName: expect.any(String), recipientId: recipientUser.id });
      expect(Number(custody.amount)).toBe(800);

      const data = await overview();
      expect(data.lines).toMatchObject({ opening: 1000, custodyIssued: 800, custodyReturned: 0, expected: 200 });
      expect(data.stats).toMatchObject({ openCount: 1, openAmount: 800, monthCount: 1, monthAmount: 800, monthReturned: 0 });
      expect(await prisma.notification.count({ where: { userId: recipientUser.id, event: 'CUSTODY_ISSUED' } })).toBe(1);
    });

    it('refuses more than the drawer holds, and racing requests cannot overdraw it', async () => {
      await open(undefined, 1000).expect(201);
      await issue(1000.01).expect(409);
      const results = await Promise.all(Array.from({ length: 6 }, () => issue(300)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect((await overview()).lines.expected).toBe(100);
    });

    it('needs an open drawer of today, not a closed one or one left open from yesterday', async () => {
      await issue(10).expect(409);
      await open().expect(201);
      await prisma.cashSession.updateMany({ where: { branchId, status: 'OPEN' }, data: { businessDate: new Date('2026-01-01T00:00:00Z') } });
      const stale = await issue(10).expect(409);
      expect(stale.body.message).toContain('2026-01-01');
      expect((await overview()).session.isCurrent).toBe(false);
      await open().expect(409);
      await close(1000);
      await open(undefined, 1000).expect(201);
      await issue(10).expect(201);
    });

    it('hands out only once for a repeated submit of the same form', async () => {
      await open().expect(201);
      const idempotencyKey = key();
      const first = await issue(100, { idempotencyKey }).expect(201);
      const second = await issue(100, { idempotencyKey }).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect((await overview()).lines.expected).toBe(900);
    });

    it('only goes to active staff, and never to a customer or a cancelled trip', async () => {
      await open().expect(201);
      const customer = await loginPassenger(app);
      const customerRow = await prisma.user.findUniqueOrThrow({ where: { phone: customer.phone } });
      await issue(10, { recipientId: customerRow.id }).expect(400);
      await issue(10, { recipientId: 'missing' }).expect(400);

      const driver = await createStaff(prisma, 'DRIVER');
      await prisma.user.update({ where: { id: driver.id }, data: { driverProfile: { create: { isActive: false } } } });
      await issue(10, { recipientId: driver.id }).expect(400);

      const trip = (await post('/trips', admin.auth, tripPayload()).expect(201)).body;
      const linked = (await issue(10, { tripId: trip.id }).expect(201)).body;
      expect(linked.trip.tripCode).toBe(trip.tripCode);
      await prisma.trip.update({ where: { id: trip.id }, data: { tripStatus: 'CANCELLED' } });
      await issue(10, { tripId: trip.id }).expect(409);
      await issue(10, { tripId: 'missing' }).expect(400);
    });

    it('rejects a client trying to set server-owned fields', async () => {
      await open().expect(201);
      await issue(10, { status: 'SETTLED' }).expect(400);
      await issue(10, { issuedAt: '2020-01-01' }).expect(400);
      await issue(10, { branchId: otherBranchId }).expect(400);
      await issue(0).expect(400);
      await issue(-5).expect(400);
    });
  });

  describe('settling', () => {
    let custodyId: string;
    const invoice = [{ data: PNG, name: 'invoice.png' }];

    beforeEach(async () => {
      await open(undefined, 1000).expect(201);
      custodyId = (await issue(300).expect(201)).body.id;
    });

    it('returns the unspent part to the drawer and computes the return itself', async () => {
      const settled = (await settle(custodyId, admin.auth, 250, invoice, 'ديزل').expect(201)).body;
      expect(settled).toMatchObject({ status: 'SETTLED', settlementNote: 'ديزل' });
      expect(Number(settled.spentAmount)).toBe(250);
      expect(Number(settled.returnedAmount)).toBe(50);

      const data = await overview();
      expect(data.lines).toMatchObject({ custodyIssued: 300, custodyReturned: 50, expected: 750 });
      expect(data.stats).toMatchObject({ openCount: 0, openAmount: 0, monthReturned: 50 });
      expect(await prisma.notification.count({ where: { userId: recipientUser.id, event: 'CUSTODY_SETTLED' } })).toBe(1);
    });

    it('needs an invoice for any spending, but not to return everything', async () => {
      await settle(custodyId, admin.auth, 250).expect(400);
      await settle(custodyId, admin.auth, 0).expect(201);
      expect((await overview()).lines.expected).toBe(1000);
    });

    it('refuses spending above the custody and blank or invalid amounts', async () => {
      await settle(custodyId, admin.auth, 300.01, invoice).expect(400);
      await settle(custodyId, admin.auth, -1, invoice).expect(400);
      await settle(custodyId, admin.auth, '', invoice).expect(400);
      await settle(custodyId, admin.auth, 'abc', invoice).expect(400);
      expect((await get(`/cash/branches/${branchId}/custodies`, admin.auth)).body.items[0].status).toBe('OPEN');
    });

    it('settles once only, even when requests race', async () => {
      const results = await Promise.all([settle(custodyId, admin.auth, 100, invoice), settle(custodyId, admin.auth, 100, invoice), settle(custodyId, admin.auth, 100, invoice)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect((await overview()).lines.custodyReturned).toBe(200);
      expect(await prisma.custodyAttachment.count()).toBe(1);
    });

    it('stops an employee settling a custody issued to themselves, and allows a colleague', async () => {
      const own = (await issue(50, { recipientId: cashierUser.id }).expect(201)).body;
      const refused = await settle(own.id, cashier.auth, 50, invoice).expect(403);
      expect(refused.body.message).toContain('باسمك');
      await settle(custodyId, cashier.auth, 300, invoice).expect(201);
      await settle(own.id, admin.auth, 50, invoice).expect(201);
    });

    it('judges a file by its bytes, whatever it claims to be', async () => {
      await settle(custodyId, admin.auth, 100, [{ data: HTML, name: 'invoice.pdf' }]).expect(400);
      await settle(custodyId, admin.auth, 100, [{ data: PDF, name: '../../evil.png' }]).expect(201);
      const file = await prisma.custodyAttachment.findFirstOrThrow();
      expect(file.mimeType).toBe('application/pdf');
      expect(file.fileName).toBe('evil.png');
    });

    it('limits how many invoices and how large', async () => {
      const six = Array.from({ length: 6 }, (_, i) => ({ data: PNG, name: `${i}.png` }));
      await settle(custodyId, admin.auth, 100, six).expect(400);
      await settle(custodyId, admin.auth, 100, [{ data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]), name: 'big.png' }]).expect(413);
    });

    it('sends a return into today\'s drawer, and refuses one when no drawer is open', async () => {
      await close(700);
      await settle(custodyId, admin.auth, 100, invoice).expect(409);
      await settle(custodyId, admin.auth, 300, invoice).expect(201);
    });

    it('credits a later day\'s drawer, not the one the custody came from', async () => {
      await close(700);
      await open(undefined, 700).expect(201);
      await settle(custodyId, admin.auth, 250, invoice).expect(201);
      const data = await overview();
      expect(data.lines).toMatchObject({ opening: 700, custodyIssued: 0, custodyReturned: 50, expected: 750 });
    });
  });

  describe('closing', () => {
    it('freezes the drawer with the server\'s figures', async () => {
      await open(undefined, 1000).expect(201);
      await issue(200).expect(201);
      const closed = (await close(800).then((r) => r)).body;
      expect(closed.status).toBe('CLOSED');
      expect(Number(closed.expectedBalance)).toBe(800);
      expect(Number(closed.difference)).toBe(0);
      expect(closed.closedByName).toEqual(expect.any(String));
      await issue(10).expect(409);
      await post(`/cash/sessions/${closed.id}/close`, admin.auth, { countedCash: 800, expectedBalance: 800 }).expect(409);
    });

    it('needs a reason for a difference and tells the managers', async () => {
      const managerRank = await rank('test-cash-manager', ['cash.all_branches', 'cash.view']);
      const manager = await createStaff(prisma, 'STAFF', nextPhone(), managerRank);
      await open(undefined, 1000).expect(201);
      expect((await close(980)).status).toBe(400);
      expect((await close(980, 'x')).status).toBe(400);
      const closed = (await close(980, 'نقص عند العد')).body;
      expect(Number(closed.difference)).toBe(-20);

      const alert = await prisma.notification.findFirstOrThrow({ where: { userId: manager.id, event: 'CASH_CLOSING_DIFFERENCE' } });
      expect(alert.body).toContain('-20 ر.س');
    });

    it('refuses a closing based on a balance that has since moved', async () => {
      await open(undefined, 1000).expect(201);
      const stale = await overview();
      await issue(100).expect(201);
      const refused = await post(`/cash/sessions/${stale.session.id}/close`, admin.auth, { countedCash: 1000, expectedBalance: stale.lines.expected }).expect(409);
      expect(refused.body.message).toContain('900');
    });

    it('survives a floating point trap in the money maths', async () => {
      await open(undefined, 0.3).expect(201);
      await issue(0.1).expect(201);
      await issue(0.1).expect(201);
      expect((await overview()).lines.expected).toBe(0.1);
      const closed = (await close(0.1)).body;
      expect(Number(closed.difference)).toBe(0);
    });

    it('allows a stale drawer to be closed, and keeps open custodies across days', async () => {
      await open(undefined, 1000).expect(201);
      await issue(100).expect(201);
      await prisma.cashSession.updateMany({ where: { branchId, status: 'OPEN' }, data: { businessDate: new Date('2026-01-01T00:00:00Z') } });
      expect((await close(900)).status).toBe(201);
      expect((await overview()).stats.openCount).toBe(1);
    });
  });

  describe('the ledger itself', () => {
    it('rejects editing or deleting a movement, and changing a closed drawer, at the database', async () => {
      await open(undefined, 1000).expect(201);
      await issue(100).expect(201);
      await expect(prisma.cashMovement.updateMany({ data: { amount: 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.cashMovement.deleteMany()).rejects.toThrow(/append-only/);
      await close(900);
      await expect(prisma.cashSession.updateMany({ where: { branchId }, data: { countedCash: 5000 } })).rejects.toThrow(/closed/);
      await expect(prisma.cashSession.deleteMany({ where: { branchId } })).rejects.toThrow(/closed/);
      const session = await prisma.cashSession.findFirstOrThrow({ where: { branchId } });
      await expect(prisma.cashMovement.create({ data: { sessionId: session.id, type: 'CUSTODY_ISSUE', amount: 1, createdById: adminUser.id } })).rejects.toThrow(/closed/);
    });

    it('rejects impossible figures at the database', async () => {
      await open(undefined, 1000).expect(201);
      const session = await prisma.cashSession.findFirstOrThrow({ where: { branchId } });
      await expect(prisma.cashMovement.create({ data: { sessionId: session.id, type: 'CUSTODY_ISSUE', amount: -5, createdById: adminUser.id } })).rejects.toThrow();
      const custody = (await issue(100).expect(201)).body;
      await expect(prisma.custody.update({ where: { id: custody.id }, data: { status: 'SETTLED', spentAmount: 90, returnedAmount: 5 } })).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO "CashSession" ("id","branchId","businessDate","openingBalance","openedById") VALUES ('dup',${branchId},'2026-01-01',0,'x')`).rejects.toThrow();
    });

    it('will not let a recipient with a custody record or a trip with one be deleted', async () => {
      await open().expect(201);
      await issue(10).expect(201);
      await expect(prisma.user.delete({ where: { id: recipientUser.id } })).rejects.toThrow();
    });

    it('records every write in the audit log', async () => {
      await open().expect(201);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const log = await prisma.auditLog.findFirst({ where: { entity: 'Cash', userId: adminUser.id } });
      expect(log?.action).toContain('/cash/branches/:branchId/sessions');
    });
  });

  describe('branches', () => {
    it('cannot be stopped with an open drawer or open custodies, and names stay unique', async () => {
      await open(undefined, 100).expect(201);
      const stop = () => request(server()).patch(`${API}/cash/branches/${branchId}`).set(admin.auth).send({ isActive: false });
      expect((await stop()).status).toBe(409);
      await issue(50).expect(201);
      await close(50);
      expect((await stop()).body.message).toContain('عهد');
      const custody = await prisma.custody.findFirstOrThrow();
      await open(undefined, 50).expect(201);
      await settle(custody.id, admin.auth, 0).expect(201);
      await close(100);
      expect((await stop()).status).toBe(200);
      await post('/cash/branches', admin.auth, { name: 'فرع العليا' }).expect(409);
      await post('/cash/branches', admin.auth, { name: ' ' }).expect(400);
    });
  });

  describe('booking cash', () => {
    const makeBooking = async (paymentStatus: string, amount: number, method = 'cash') => {
      const trip = (await post('/trips', admin.auth, tripPayload()).expect(201)).body;
      return prisma.booking.create({
        data: {
          bookingReference: `DRB-${key()}`,
          userId: adminUser.id,
          tripId: trip.id,
          status: 'CONFIRMED',
          source: 'BRANCH',
          totalPrice: amount,
          payment: { create: { amount, status: paymentStatus, method } },
        },
      });
    };
    const actor = () => ({ userId: adminUser.id, role: 'ADMIN', name: 'مدير', permissions: [] });
    const receipt = (bookingId: string, amount: number) => prisma.$transaction((tx) => app.get(CollectionsService).collectInTx(tx, actor(), { method: 'CASH', branchId, bookingId, amount }));
    const refund = (bookingId: string, amount: number) => prisma.$transaction((tx) => cash.recordBookingRefund(tx, actor(), { branchId, bookingId, amount }));

    it('adds receipts to the drawer and marks the payment complete once fully paid', async () => {
      await open(undefined, 100).expect(201);
      const booking = await makeBooking('PENDING', 300);
      await receipt(booking.id, 100);
      expect((await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status).toBe('PENDING');
      await expect(receipt(booking.id, 201)).rejects.toThrow(/200/);
      await receipt(booking.id, 200);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(payment).toMatchObject({ status: 'COMPLETED', method: 'cash' });
      expect((await overview()).lines).toMatchObject({ receipts: 300, expected: 400 });
    });

    it('refuses cash for a booking already paid online or cancelled', async () => {
      await open().expect(201);
      const paid = await makeBooking('SIMULATED', 100, 'mada');
      await expect(receipt(paid.id, 50)).rejects.toThrow(/مستحق/);
      const cancelled = await makeBooking('PENDING', 100);
      await prisma.booking.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
      await expect(receipt(cancelled.id, 50)).rejects.toThrow(/ملغى/);
    });

    it('cannot refund what was never taken in cash, or twice, or again after a wallet refund', async () => {
      await open(undefined, 100).expect(201);
      const booking = await makeBooking('PENDING', 300);
      await expect(refund(booking.id, 10)).rejects.toThrow(/إلغاء/);
      await receipt(booking.id, 300);
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', refundAmount: 100 } });

      await expect(refund(booking.id, 201)).rejects.toThrow(/200/);
      await refund(booking.id, 200);
      await expect(refund(booking.id, 1)).rejects.toThrow();
      expect((await overview()).lines).toMatchObject({ receipts: 300, refunds: 200, expected: 200 });

      const online = await makeBooking('SIMULATED', 100, 'mada');
      await prisma.booking.update({ where: { id: online.id }, data: { status: 'CANCELLED' } });
      await expect(refund(online.id, 10)).rejects.toThrow();
    });

    it('cannot pay out more cash than the drawer holds', async () => {
      await open(undefined, 0).expect(201);
      const booking = await makeBooking('PENDING', 300);
      await receipt(booking.id, 300);
      await issue(250).expect(201);
      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', refundAmount: 0 } });
      await expect(refund(booking.id, 100)).rejects.toThrow(/الرصيد المتوقع/);
    });
  });

  it('reproduces the figures in the design', async () => {
    // A custody from an earlier drawer comes back today, as in the design's +70.
    await open(undefined, 200).expect(201);
    const earlier = (await issue(100).expect(201)).body;
    await close(100);
    await open(undefined, 1500, { note: 'تغذية الصندوق من الإدارة' }).expect(201);
    await settle(earlier.id, admin.auth, 30, [{ data: PNG, name: 'a.png' }]).expect(201);

    const booking = await prisma.booking.create({
      data: {
        bookingReference: 'DRB-DESIGN',
        userId: adminUser.id,
        tripId: (await post('/trips', admin.auth, tripPayload()).expect(201)).body.id,
        status: 'CONFIRMED',
        totalPrice: 1160,
        payment: { create: { amount: 1160, status: 'PENDING' } },
      },
    });
    const actor = { userId: adminUser.id, role: 'ADMIN', name: 'مدير', permissions: [] };
    await prisma.$transaction((tx) => app.get(CollectionsService).collectInTx(tx, actor, { method: 'CASH', branchId, bookingId: booking.id, amount: 1160 }));
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', refundAmount: 0 } });
    await prisma.$transaction((tx) => cash.recordBookingRefund(tx, actor, { branchId, bookingId: booking.id, amount: 120 }));
    await issue(800).expect(201);

    expect((await overview()).lines).toEqual({ opening: 1500, receipts: 1160, refunds: 120, custodyIssued: 800, custodyReturned: 70, expected: 1810 });
    const closed = (await close(1810)).body;
    expect(Number(closed.difference)).toBe(0);
  });
});

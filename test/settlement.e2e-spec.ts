import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginStaff, nextPhone, resetDatabase } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let keyCounter = 0;
const key = () => `settle-key-${++keyCounter}`;
const thisMonth = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

describe('Monthly settlement: remittances, fixed expenses and the statement', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let manager: { auth: Record<string, string> };
  let managerUser: { id: string };
  let branchId: string;

  const server = () => app.getHttpServer();
  const post = (path: string, auth: Record<string, string>, body: object = {}) => request(server()).post(`${API}${path}`).set(auth).send(body);
  const get = (path: string, auth: Record<string, string>) => request(server()).get(`${API}${path}`).set(auth);
  const overview = async () => (await get(`/cash/branches/${branchId}/overview`, admin.auth).expect(200)).body;
  const open = (openingBalance: number, note?: string) => post(`/cash/branches/${branchId}/sessions`, admin.auth, { openingBalance, ...(note && { note }) });
  const close = async (counted: number, note?: string) => {
    const data = await overview();
    return post(`/cash/sessions/${data.session.id}/close`, admin.auth, { countedCash: counted, expectedBalance: data.lines.expected, note });
  };
  /** A day whose drawer took `amount` in cash: counted above its opening, with the reason written. */
  const dayWith = async (amount: number) => {
    const last = await prisma.cashSession.findFirst({ where: { branchId }, orderBy: { openedAt: 'desc' } });
    const opening = last ? Number(last.countedCash ?? 0) - (await remittedSinceClose(last.closedAt)) : 0;
    await open(opening).expect(201);
    await close(opening + amount, 'مقبوضات اليوم').then((res) => expect(res.status).toBe(201));
  };
  const remittedSinceClose = async (closedAt: Date | null) => {
    if (!closedAt) return 0;
    const rows = await prisma.cashRemittance.findMany({ where: { branchId, createdAt: { gt: closedAt }, status: { not: 'CANCELLED' } }, select: { id: true, amount: true } });
    const moved = await prisma.cashMovement.count({ where: { remittanceId: { in: rows.map((row) => row.id) } } });
    return moved ? 0 : rows.reduce((sum, row) => sum + Number(row.amount), 0);
  };
  const remit = (method: 'CASH_HANDOVER' | 'BANK_DEPOSIT', auth = manager.auth, withReceipt = method === 'BANK_DEPOSIT') => {
    let req = request(server()).post(`${API}/remittances`).set(auth).field('branchId', branchId).field('method', method).field('idempotencyKey', key());
    if (withReceipt) req = req.attach('receipts', PNG, 'deposit.png');
    return req;
  };
  const code = async (id: string) => (await post(`/remittances/${id}/code`, admin.auth).expect(201)).body.devCode as string | undefined;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-settle-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, (adminUser as { phone: string }).phone);
    branchId = (await prisma.branch.create({ data: { name: 'فرع الحدائق' } })).id;
    await prisma.rank.upsert({
      where: { id: 'test-settle-manager' },
      create: { id: 'test-settle-manager', name: 'مدير فرع', role: 'STAFF', jobId: 'job-office', permissions: ['cash.view', 'cash.operate', 'remittances.create'] },
      update: { permissions: ['cash.view', 'cash.operate', 'remittances.create'] },
    });
    managerUser = await createStaff(prisma, 'STAFF', nextPhone(), 'test-settle-manager');
    await prisma.user.update({ where: { id: managerUser.id }, data: { branchId } });
    manager = await loginStaff(app, (managerUser as unknown as { phone: string }).phone);
  });

  describe('remittances', () => {
    it('remits only closed drawers, once each, and the next opening is expected without the cash', async () => {
      await remit('CASH_HANDOVER').expect(409);
      await dayWith(820);
      const made = (await remit('CASH_HANDOVER').expect(201)).body;
      expect(made.amount).toBe(820);
      expect(made.status).toBe('PENDING');
      // The same drawer cannot be remitted twice.
      await remit('CASH_HANDOVER').expect(409);
      // The cash left the safe with no drawer open, so nothing carries over and no reason is needed.
      await open(0).expect(201);
      await open(0).expect(409);
    });

    it('takes earlier cash out of today’s open drawer when one is open, and puts it back when withdrawn', async () => {
      await dayWith(500);
      await open(500).expect(201);
      const made = (await remit('CASH_HANDOVER').expect(201)).body;
      expect((await overview()).lines.expected).toBe(0);
      expect((await overview()).lines.remitted).toBe(500);

      await post(`/remittances/${made.id}/cancel`, manager.auth, { reason: 'خطأ في الإدخال' }).expect(201);
      expect((await overview()).lines.expected).toBe(500);
      // Its drawer is free to remit again.
      expect((await get(`/remittances/unremitted/${branchId}`, manager.auth).expect(200)).body.total).toBe(500);
    });

    it('needs the deposit slip for a bank deposit', async () => {
      await dayWith(300);
      await remit('BANK_DEPOSIT', manager.auth, false).expect(400);
      const made = (await remit('BANK_DEPOSIT').expect(201)).body;
      expect(made.attachments).toHaveLength(1);
    });

    it('lets only the owner confirm, with the WhatsApp code, and records a short amount as a difference on its maker', async () => {
      await dayWith(1500);
      const made = (await remit('CASH_HANDOVER').expect(201)).body;
      await post(`/remittances/${made.id}/confirm`, manager.auth, {}).expect(403);

      const devCode = await code(made.id);
      await post(`/remittances/${made.id}/confirm`, admin.auth, { code: '0000', receivedAmount: 1450 }).expect((res) => expect([400, 409]).toContain(res.status));
      await post(`/remittances/${made.id}/confirm`, admin.auth, { code: devCode, receivedAmount: 1450 }).expect(201);

      const row = await prisma.cashRemittance.findUniqueOrThrow({ where: { id: made.id } });
      expect(row.status).toBe('DIFFERENCE');
      expect(Number(row.difference)).toBe(-50);
      expect(await prisma.notification.count({ where: { userId: managerUser.id, event: 'REMITTANCE_DIFFERENCE' } })).toBe(1);

      // A confirmed remittance cannot be withdrawn, and its explanation clears it.
      await post(`/remittances/${made.id}/cancel`, admin.auth, { reason: 'سحب' }).expect(409);
      await post(`/remittances/${made.id}/justify`, admin.auth, { reason: 'فئة 50 تالفة' }).expect(201);
      expect((await get('/remittances', admin.auth).expect(200)).body.items[0].unexplained).toBe(false);
    });

    it('matches a deposit to the bank statement', async () => {
      await dayWith(600);
      const made = (await remit('BANK_DEPOSIT').expect(201)).body;
      await post(`/remittances/${made.id}/match`, admin.auth, { bankAmount: 600 }).expect(201);
      expect((await prisma.cashRemittance.findUniqueOrThrow({ where: { id: made.id } })).status).toBe('MATCHED');
    });

    it('refuses to change what a remittance declared, at the database', async () => {
      await dayWith(200);
      const made = (await remit('CASH_HANDOVER').expect(201)).body;
      await expect(prisma.cashRemittance.update({ where: { id: made.id }, data: { amount: 1 } })).rejects.toThrow();
      await expect(prisma.cashRemittance.delete({ where: { id: made.id } })).rejects.toThrow();
    });
  });

  describe('fixed expenses', () => {
    const contract = (extra: object = {}) =>
      post('/fixed-expenses', admin.auth, {
        category: 'OFFICE_RENT',
        title: 'إيجار مكتب الحدائق',
        branchId,
        amount: 36000,
        cycle: 'ANNUAL',
        dueDay: 1,
        startDate: `${thisMonth()}-01`,
        ...extra,
      });

    it('posts a yearly rent’s twelfth to its branch every month, once', async () => {
      await contract().expect(201);
      await get('/fixed-expenses', admin.auth).expect(200);
      await get('/fixed-expenses', admin.auth).expect(200);
      const postings = await prisma.fixedExpensePosting.findMany();
      expect(postings).toHaveLength(1);
      expect(postings[0].month).toBe(thisMonth());
      expect(Number(postings[0].amount)).toBe(3000);
      await expect(prisma.fixedExpensePosting.update({ where: { id: postings[0].id }, data: { amount: 1 } })).rejects.toThrow();
    });

    it('pays a due from the drawer with its receipt, and a void puts the cash back by a reversing entry', async () => {
      const rent = (await contract({ cycle: 'MONTHLY', amount: 2500 }).expect(201)).body;
      const pay = (withReceipt = true) => {
        let req = request(server())
          .post(`${API}/fixed-expenses/payments`)
          .set(admin.auth)
          .field('expenseId', rent.id)
          .field('period', thisMonth())
          .field('amount', '2500')
          .field('paidOn', today())
          .field('source', 'BRANCH_CASH')
          .field('branchId', branchId)
          .field('idempotencyKey', key());
        if (withReceipt) req = req.attach('receipts', PNG, 'receipt.png');
        return req;
      };
      await pay(false).expect(400);
      // No drawer open: cash cannot leave one.
      await pay().expect(409);
      await open(3000).expect(201);
      const payment = (await pay().expect(201)).body;
      expect((await overview()).lines.expected).toBe(500);

      const dues = (await get('/fixed-expenses/dues', admin.auth).expect(200)).body.items;
      expect(dues.find((due: { expenseId: string; period: string }) => due.expenseId === rent.id && due.period === thisMonth())).toBeUndefined();

      await post(`/fixed-expenses/payments/${payment.id}/void`, admin.auth, { reason: 'سُجّلت مرتين' }).expect(201);
      expect((await overview()).lines.expected).toBe(3000);
      expect(await prisma.cashMovement.count({ where: { fixedPaymentId: payment.id } })).toBe(2);
      await post(`/fixed-expenses/payments/${payment.id}/void`, admin.auth, { reason: 'مرة أخرى' }).expect(409);
    });
  });

  describe('the monthly settlement', () => {
    it('shows the eight steps, a column for the branch and one for the app, and charges the rent to its branch', async () => {
      await post('/fixed-expenses', admin.auth, { category: 'OFFICE_RENT', title: 'إيجار', branchId, amount: 3000, cycle: 'MONTHLY', dueDay: 1, startDate: `${thisMonth()}-01` }).expect(201);
      const view = (await get(`/settlement/monthly?month=${thisMonth()}`, admin.auth).expect(200)).body;
      expect(view.steps).toHaveLength(8);
      expect(view.state).toBe('OPEN');
      expect(view.statement.columns.map((column: { key: string }) => column.key)).toEqual([branchId, 'APP']);
      const rent = view.statement.rows.find((row: { key: string }) => row.key === 'rent');
      expect(rent.values[branchId]).toBe(-3000);
      expect(view.statement.rows.find((row: { key: string }) => row.key === 'net').total).toBe(-3000);
    });

    it('refuses to approve a month that has not ended, and keeps it from staff without the permission', async () => {
      await post('/settlement/approve', admin.auth, { month: thisMonth() }).expect(409);
      await post('/settlement/approve', manager.auth, { month: thisMonth() }).expect(403);
      await post('/settlement/owner-approve', admin.auth, { month: thisMonth() }).expect(409);
    });

    it('shares head-office costs across the branches by revenue', async () => {
      // A second branch with nothing sold: with no revenue at all, the head office is shared equally.
      const other = (await prisma.branch.create({ data: { name: 'فرع العليا' } })).id;
      await post('/fixed-expenses', admin.auth, { category: 'OTHER', title: 'اشتراك النظام', amount: 1000, cycle: 'MONTHLY', dueDay: 1, startDate: `${thisMonth()}-01` }).expect(201);
      const view = (await get(`/settlement/monthly?month=${thisMonth()}`, admin.auth).expect(200)).body;
      const share = view.statement.rows.find((row: { key: string }) => row.key === 'adminShare');
      expect(share.values[branchId] + share.values[other]).toBe(-1000);
      expect(share.total).toBe(-1000);
    });
  });
});

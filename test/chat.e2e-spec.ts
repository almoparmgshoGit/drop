import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase } from './helpers';

const RANK_ID = 'rank-chat-test';

describe('Chat, presence, blocking and promotional credit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: { auth: Record<string, string> };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma, redis } = await createTestApp());
    await resetDatabase(prisma);
    const owner = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, owner.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  const startThread = async (customer: { auth: Record<string, string> }, body = 'متى موعد الرحلة؟') => {
    const sent = await http().post(`${API}/chat/mine/messages`).set(customer.auth).send({ body, clientId: `c-${Date.now()}-${Math.random()}` }).expect(201);
    const list = await http().get(`${API}/chat/conversations?filter=all`).set(admin.auth).expect(200);
    return { sent: sent.body, list: list.body };
  };

  describe('conversation', () => {
    it('carries a message from the customer to staff and the reply back, with the unread counts on each side', async () => {
      const customer = await loginPassenger(app);
      const { list } = await startThread(customer);
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      expect(row.staffUnread).toBe(1);
      expect(row.lastMessagePreview).toBe('متى موعد الرحلة؟');

      const unread = await http().get(`${API}/chat/unread`).set(admin.auth).expect(200);
      expect(unread.body.unread).toBeGreaterThanOrEqual(1);

      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(admin.auth).send({ body: 'الساعة 9 مساءً' }).expect(201);

      const mine = await http().get(`${API}/chat/mine`).set(customer.auth).expect(200);
      expect(mine.body.messages.map((message: any) => message.sender)).toEqual(['CUSTOMER', 'STAFF']);
      expect(mine.body.conversation.customerUnread).toBe(1);
      // The customer sees that support answered, not which employee or their account.
      expect(mine.body.messages[1].staffId).toBeUndefined();
      expect(mine.body.messages[1].staffName).toBeUndefined();

      const summary = await http().get(`${API}/chat/mine/summary`).set(customer.auth).expect(200);
      expect(summary.body.unread).toBe(1);
      await http().post(`${API}/chat/mine/read`).set(customer.auth).expect(201);
      const after = await http().get(`${API}/chat/mine/summary`).set(customer.auth).expect(200);
      expect(after.body.unread).toBe(0);

      const thread = await http().get(`${API}/chat/conversations/${row.id}`).set(admin.auth).expect(200);
      expect(thread.body.staffUnread).toBe(0);
      expect(thread.body.assignedToId).toBeTruthy();
      expect(thread.body.customer.phone).toBe(customer.phone);
    });

    it('notifies a customer who is away from the chat screen, and not one reading it', async () => {
      const customer = await loginPassenger(app);
      const { list } = await startThread(customer);
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      const count = async () => (await http().get(`${API}/notifications/mine/summary`).set(customer.auth).expect(200)).body.unreadCount;

      await http().post(`${API}/presence`).set(customer.auth).send({ screen: 'Home', platform: 'android' }).expect(201);
      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(admin.auth).send({ body: 'رد أول' }).expect(201);
      expect(await count()).toBe(1);

      await http().post(`${API}/presence`).set(customer.auth).send({ screen: 'Chat', platform: 'android' }).expect(201);
      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(admin.auth).send({ body: 'رد ثانٍ' }).expect(201);
      expect(await count()).toBe(1);
    });

    it('does not post a retried message twice', async () => {
      const customer = await loginPassenger(app);
      const payload = { body: 'رسالة', clientId: 'same-client-id' };
      const first = await http().post(`${API}/chat/mine/messages`).set(customer.auth).send(payload).expect(201);
      const second = await http().post(`${API}/chat/mine/messages`).set(customer.auth).send(payload).expect(201);
      expect(second.body.id).toBe(first.body.id);
      const mine = await http().get(`${API}/chat/mine`).set(customer.auth).expect(200);
      expect(mine.body.messages).toHaveLength(1);
    });

    it('reopens a closed conversation when the customer writes again', async () => {
      const customer = await loginPassenger(app);
      const { list } = await startThread(customer);
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      await http().put(`${API}/chat/conversations/${row.id}`).set(admin.auth).send({ status: 'CLOSED' }).expect(200);
      const closed = await http().get(`${API}/chat/conversations?filter=closed`).set(admin.auth).expect(200);
      expect(closed.body.items.some((item: any) => item.id === row.id)).toBe(true);
      await http().post(`${API}/chat/mine/messages`).set(customer.auth).send({ body: 'سؤال آخر' }).expect(201);
      const thread = await http().get(`${API}/chat/conversations/${row.id}`).set(admin.auth).expect(200);
      expect(thread.body.status).toBe('OPEN');
    });

    it('sends a usable coupon and refuses a stopped one', async () => {
      const customer = await loginPassenger(app);
      const { list } = await startThread(customer);
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      await prisma.coupon.create({ data: { code: 'CHATGOOD', type: 'PERCENT', value: 10 } });
      await prisma.coupon.create({ data: { code: 'CHATOFF', type: 'PERCENT', value: 10, isActive: false } });

      const sent = await http().post(`${API}/chat/conversations/${row.id}/messages`).set(admin.auth).send({ couponCode: 'chatgood' }).expect(201);
      expect(sent.body.couponCode).toBe('CHATGOOD');
      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(admin.auth).send({ couponCode: 'CHATOFF' }).expect(400);

      const offered = await http().get(`${API}/chat/coupons`).set(admin.auth).expect(200);
      expect(offered.body.map((coupon: any) => coupon.code)).toEqual(expect.arrayContaining(['CHATGOOD']));
      expect(offered.body.map((coupon: any) => coupon.code)).not.toContain('CHATOFF');
    });

    it("keeps one customer out of another's thread and out of the staff routes", async () => {
      const customer = await loginPassenger(app);
      const other = await loginPassenger(app);
      const { list } = await startThread(customer, 'سر');
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      await http().get(`${API}/chat/conversations/${row.id}`).set(other.auth).expect(403);
      await http().get(`${API}/chat/conversations`).set(other.auth).expect(403);
      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(other.auth).send({ body: 'x' }).expect(403);
      const mine = await http().get(`${API}/chat/mine`).set(other.auth).expect(200);
      expect(mine.body.conversation).toBeNull();
    });

    it('needs chat.reply to answer: chat.view alone can only read', async () => {
      const job = await prisma.jobType.findFirstOrThrow();
      await prisma.rank.upsert({ where: { id: RANK_ID }, update: {}, create: { id: RANK_ID, name: 'قارئ محادثات', role: 'STAFF', jobId: job.id, permissions: ['chat.view'] } });
      const reader = await createStaff(prisma, 'STAFF', nextPhone(), RANK_ID);
      const session = await loginStaff(app, reader.phone);
      const customer = await loginPassenger(app);
      const { list } = await startThread(customer);
      const row = list.items.find((item: any) => item.customer.phone === customer.phone);
      await http().get(`${API}/chat/conversations/${row.id}`).set(session.auth).expect(200);
      await http().post(`${API}/chat/conversations/${row.id}/messages`).set(session.auth).send({ body: 'x' }).expect(403);
    });
  });

  describe('presence', () => {
    it('lists a customer with the app open and drops them once it goes to the background', async () => {
      const customer = await loginPassenger(app);
      await http().post(`${API}/presence`).set(customer.auth).send({ screen: 'Payment', platform: 'android' }).expect(201);
      const live = await http().get(`${API}/chat/live`).set(admin.auth).expect(200);
      const row = live.body.items.find((item: any) => item.customer.phone === customer.phone);
      expect(row.label).toBe('صفحة الدفع');
      expect(row.isPaying).toBe(true);
      expect(live.body.counts.inPayment).toBeGreaterThanOrEqual(1);

      await http().post(`${API}/presence/leave`).set(customer.auth).expect(201);
      const later = await http().get(`${API}/chat/live`).set(admin.auth).expect(200);
      expect(later.body.items.some((item: any) => item.customer.phone === customer.phone)).toBe(false);
      // Leaving from the payment screen without a booking is what the "left payment" card counts.
      expect(later.body.counts.abandoned).toBeGreaterThanOrEqual(1);
    });

    it('does not count staff accounts as customers in the app', async () => {
      await http().post(`${API}/presence`).set(admin.auth).send({ screen: 'Home', platform: 'android' }).expect(201);
      const rows = await prisma.appPresence.count({ where: { user: { role: { not: 'PASSENGER' } } } });
      expect(rows).toBe(0);
    });
  });

  describe('blocking', () => {
    it('ends the session at once, stops new codes and hides nothing from staff until it is lifted', async () => {
      const customer = await loginPassenger(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone: customer.phone } });

      await http().put(`${API}/users/${user.id}/block`).set(admin.auth).send({ blocked: true }).expect(400);
      await http().put(`${API}/users/${user.id}/block`).set(admin.auth).send({ blocked: true, reason: 'إساءة استخدام' }).expect(200);

      await http().get(`${API}/users/profile`).set(customer.auth).expect(401);
      await http().post(`${API}/auth/refresh`).send({ refreshToken: customer.refreshToken }).expect(401);

      await redis.del(`otp_cooldown:${customer.phone}`);
      const sent = await http().post(`${API}/auth/send-otp`).send({ phone: customer.phone }).expect(201);
      await http().post(`${API}/auth/verify-otp`).send({ phone: customer.phone, code: sent.body.devCode }).expect(403);

      const blocked = await http().get(`${API}/users?status=blocked`).set(admin.auth).expect(200);
      expect(blocked.body.items.some((item: any) => item.id === user.id)).toBe(true);
      expect(blocked.body.summary.blocked).toBeGreaterThanOrEqual(1);

      await http().put(`${API}/users/${user.id}/block`).set(admin.auth).send({ blocked: false }).expect(200);
      await redis.del(`otp_cooldown:${customer.phone}`);
      const again = await http().post(`${API}/auth/send-otp`).send({ phone: customer.phone }).expect(201);
      await http().post(`${API}/auth/verify-otp`).send({ phone: customer.phone, code: again.body.devCode }).expect(201);
    });

    it('does not let staff block themselves', async () => {
      const me = await http().get(`${API}/auth/me`).set(admin.auth).expect(200);
      await http().put(`${API}/users/${me.body.id}/block`).set(admin.auth).send({ blocked: true, reason: 'تجربة' }).expect(400);
    });
  });

  describe('promotional credit', () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

    const creditedCustomer = async (amount: number) => {
      const customer = await loginPassenger(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone: customer.phone } });
      await http().post(`${API}/users/${user.id}/wallet/promo`).set(admin.auth).send({ amount, expiresOn: inDays(30), reason: 'تعويض عن تأخر' }).expect(201);
      return { customer, user };
    };

    it('adds spendable credit and shows it apart from the balance', async () => {
      const { user } = await creditedCustomer(50);
      const wallets = await http().get(`${API}/users/wallets?filter=promo`).set(admin.auth).expect(200);
      const row = wallets.body.items.find((item: any) => item.id === user.id);
      expect(Number(row.walletBalance)).toBe(50);
      expect(row.promo).toBe(50);
      expect(wallets.body.summary.promo).toBeGreaterThanOrEqual(50);
    });

    it('refuses a date in the past', async () => {
      const customer = await loginPassenger(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone: customer.phone } });
      await http().post(`${API}/users/${user.id}/wallet/promo`).set(admin.auth).send({ amount: 10, expiresOn: '2020-01-01', reason: 'تعويض' }).expect(400);
    });

    it('takes back only what is unspent when it expires', async () => {
      const { user } = await creditedCustomer(50);
      // Real money on top, then a spend of 20: promotional credit goes first, leaving 30 of it.
      await http().put(`${API}/users/${user.id}/wallet`).set(admin.auth).send({ amount: 100, description: 'شحن' }).expect(200);
      await http().put(`${API}/users/${user.id}/wallet`).set(admin.auth).send({ amount: -20, description: 'خصم' }).expect(200);
      const credit = await prisma.walletTransaction.findFirstOrThrow({ where: { userId: user.id, type: 'PROMO_CREDIT' } });
      expect(Number(credit.promoRemaining)).toBe(30);

      await prisma.walletTransaction.update({ where: { id: credit.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const { WalletService } = await import('../src/common/services/wallet.service');
      await app.get(WalletService).expirePromos(prisma);
      await app.get(WalletService).expirePromos(prisma);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { walletBalance: true } });
      expect(Number(after.walletBalance)).toBe(100);
      const expiries = await prisma.walletTransaction.count({ where: { userId: user.id, type: 'PROMO_EXPIRED' } });
      expect(expiries).toBe(1);
    });
  });
});

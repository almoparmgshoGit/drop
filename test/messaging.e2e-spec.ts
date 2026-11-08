import { INestApplication } from '@nestjs/common';
import * as crypto from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { IntegrationsService } from '../src/common/services/integrations.service';
import { StationAlertsService } from '../src/common/services/station-alerts.service';
import { CampaignsService } from '../src/modules/messaging/campaigns.service';
import { DeliveryWorkerService } from '../src/modules/messaging/delivery-worker.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

const WEBHOOK = `${API}/webhooks/whatsapp`;
const APP_SECRET = 'test-app-secret-value';
const VERIFY_TOKEN = 'test-verify-token-value';

describe('Messaging (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  const realFetch = global.fetch;

  const createTrip = async (overrides: Record<string, unknown> = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  const book = async (trip: any, passenger: any, seat = '1', extra: Record<string, unknown> = {}) =>
    (
      await request(http())
        .post(`${API}/bookings`)
        .set(passenger.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: [seat] }], passengers: [{ fullName: 'سارة أحمد' }], ...extra })
        .expect(201)
    ).body.bookings[0];

  const sign = (body: string, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  const employee = async (permissions: string[]) => {
    const rank = await prisma.rank.create({ data: { name: `رتبة رسائل ${crypto.randomUUID()}`, role: 'STAFF', jobId: 'job-office', permissions } });
    const user = await createStaff(prisma, 'STAFF', undefined, rank.id);
    return { user, session: await loginStaff(app, user.phone) };
  };

  const approve = async (event: string, language = 'ar', paramOrder: string[] = []) => {
    const custom = await request(http()).put(`${API}/notifications/templates/${event}/channels`).set(admin.auth).send({ whatsapp: true }).expect(200);
    expect(custom.body.success).toBe(true);
    const row = await prisma.notificationTemplate.findUniqueOrThrow({ where: { event } });
    return prisma.whatsAppTemplate.create({ data: { event, language, name: `durob_${event.toLowerCase()}_${language}`, status: 'APPROVED', bodySnapshot: row.body, paramOrder } });
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { name: { startsWith: 'رتبة رسائل' } } });
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    await app.get(IntegrationsService).update({ whatsappPhoneId: '123456', whatsappToken: 'token-value', whatsappBusinessAccountId: '654321', whatsappAppSecret: APP_SECRET, whatsappWebhookVerifyToken: VERIFY_TOKEN });
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('webhook', () => {
    it('confirms only the agreed token, and echoes only digits', async () => {
      const verify = (token: string, challenge: string) => request(http()).get(WEBHOOK).query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': challenge });
      const ok = await verify(VERIFY_TOKEN, '12345').expect(200);
      expect(ok.text).toBe('12345');
      expect(ok.headers['content-type']).toContain('text/plain');
      await verify('wrong', '12345').expect(403);
      await verify(VERIFY_TOKEN, '<script>').expect(403);
    });

    it('refuses an unsigned or wrongly signed body without touching anything', async () => {
      const passenger = await loginPassenger(app);
      const row = await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName: 't', status: 'SENT', providerMessageId: 'wamid.forged' } });
      const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.forged', status: 'read' }] } }] }] });

      await request(http()).post(WEBHOOK).set('Content-Type', 'application/json').send(body).expect(403);
      await request(http()).post(WEBHOOK).set('Content-Type', 'application/json').set('x-hub-signature-256', sign(body, 'other-secret')).send(body).expect(403);
      await request(http()).post(WEBHOOK).set('Content-Type', 'application/json').set('x-hub-signature-256', 'sha256=zz').send(body).expect(403);
      expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT');
    });

    it('applies signed receipts in order only, and a late one cannot walk a message back', async () => {
      const passenger = await loginPassenger(app);
      const row = await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName: 't', status: 'SENT', providerMessageId: 'wamid.order' } });
      const send = (status: string) => {
        const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.order', status }] } }] }] });
        return request(http()).post(WEBHOOK).set('Content-Type', 'application/json').set('x-hub-signature-256', sign(body)).send(body).expect(200);
      };
      await send('read');
      await send('delivered');
      await send('sent');
      expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('READ');
    });

    it("takes Meta's decision on a template", async () => {
      const row = await prisma.whatsAppTemplate.create({ data: { event: 'REFUND_COMPLETED', language: 'ar', name: 'durob_refund_completed_ar', status: 'PENDING', bodySnapshot: 'x', metaId: '999' } });
      const body = JSON.stringify({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 999, reason: 'INVALID_FORMAT' } }] }] });
      await request(http()).post(WEBHOOK).set('Content-Type', 'application/json').set('x-hub-signature-256', sign(body)).send(body).expect(200);
      const saved = await prisma.whatsAppTemplate.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' });
      await prisma.whatsAppTemplate.delete({ where: { id: row.id } });
    });
  });

  describe('whatsapp queue', () => {
    afterEach(async () => {
      await prisma.messageDelivery.deleteMany();
      await prisma.whatsAppTemplate.deleteMany();
      await prisma.notificationTemplate.deleteMany();
    });

    it('queues only for an approved template, and an edit of the text stops it', async () => {
      const passenger = await loginPassenger(app);
      await book(await createTrip(), passenger);
      expect(await prisma.messageDelivery.count({ where: { userId: passenger.user.id } })).toBe(0);

      await approve('BOOKING_CONFIRMED', 'ar', ['bookingReference']);
      const booking = await book(await createTrip(), passenger);
      const [queued] = await prisma.messageDelivery.findMany({ where: { userId: passenger.user.id } });
      expect(queued).toMatchObject({ status: 'PENDING', event: 'BOOKING_CONFIRMED', params: [booking.bookingReference] });

      await request(http()).put(`${API}/notifications/templates/BOOKING_CONFIRMED`).set(admin.auth).send({ title: 'عنوان', body: 'نص جديد لم يعتمد', isActive: true }).expect(200);
      await book(await createTrip(), passenger);
      expect(await prisma.messageDelivery.count({ where: { userId: passenger.user.id } })).toBe(1);
    });

    it('a refused action queues nothing', async () => {
      await approve('BOOKING_CANCELLED');
      const passenger = await loginPassenger(app);
      const booking = await book(await createTrip(), passenger);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'خطأ', refundAmount: 99999 }).expect(400);
      expect(await prisma.messageDelivery.count({ where: { event: 'BOOKING_CANCELLED' } })).toBe(0);
    });

    it('sends through Meta with the token only to its host, and clears the values afterwards', async () => {
      const passenger = await loginPassenger(app);
      const row = await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName: 'durob_x', params: ['قيمة'], nextAttemptAt: new Date(Date.now() - 60_000) } });
      const calls: { url: string; init: RequestInit }[] = [];
      global.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.sent' }] }), { status: 200 });
      }) as typeof fetch;

      await app.get(DeliveryWorkerService).sweepDeliveries();

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/123456/messages');
      expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ to: passenger.phone.replace('+', ''), template: { name: 'durob_x', components: [{ parameters: [{ text: 'قيمة' }] }] } });
      const saved = await prisma.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved).toMatchObject({ status: 'SENT', providerMessageId: 'wamid.sent', params: null });
    });

    it('gives up at once on a number without WhatsApp, and pauses the queue on a bad token', async () => {
      const passenger = await loginPassenger(app);
      const first = await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName: 'a', nextAttemptAt: new Date(Date.now() - 60_000) } });
      global.fetch = (async () => new Response(JSON.stringify({ error: { code: 131026 } }), { status: 400 })) as typeof fetch;
      await app.get(DeliveryWorkerService).sweepDeliveries();
      expect(await prisma.messageDelivery.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'FAILED', errorCode: '131026', errorMessage: 'الرقم غير متاح على واتساب' });

      const ids = await Promise.all(['b', 'c'].map(async (templateName) => (await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName, nextAttemptAt: new Date(Date.now() - 60_000) } })).id));
      let calls = 0;
      global.fetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 });
      }) as typeof fetch;
      await app.get(DeliveryWorkerService).sweepDeliveries();
      expect(calls).toBe(1);
      const rows = await prisma.messageDelivery.findMany({ where: { id: { in: ids } } });
      expect(rows.every((row) => row.status === 'PENDING' && row.attempts === 0 && row.nextAttemptAt.getTime() > Date.now())).toBe(true);
    });

    it('does not send a time-critical message after it expired', async () => {
      const passenger = await loginPassenger(app);
      const row = await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'STATION_APPROACHING', templateName: 'a', expiresAt: new Date(Date.now() - 1000) } });
      global.fetch = (async () => {
        throw new Error('must not send');
      }) as typeof fetch;
      await app.get(DeliveryWorkerService).sweepDeliveries();
      expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('EXPIRED');
    });

    it('masks phones in the log and needs its own permission', async () => {
      const passenger = await loginPassenger(app);
      await prisma.messageDelivery.create({ data: { userId: passenger.user.id, event: 'BOOKING_CONFIRMED', templateName: 'a', nextAttemptAt: new Date(Date.now() - 60_000) } });
      const log = await request(http()).get(`${API}/notifications/deliveries`).set(admin.auth).expect(200);
      expect(JSON.stringify(log.body)).not.toContain(passenger.phone);
      expect(log.body.items[0].phone).toContain('•');
      expect(log.body.items[0].params).toBeUndefined();
      const outsider = await employee(['bookings.view']);
      await request(http()).get(`${API}/notifications/deliveries`).set(outsider.session.auth).expect(403);
      await request(http()).get(`${API}/notifications/deliveries`).set(passenger.auth).expect(403);
    });

    it('never returns a key from the status endpoint', async () => {
      const status = await request(http()).get(`${API}/notifications/whatsapp/status`).set(admin.auth).expect(200);
      const text = JSON.stringify(status.body);
      expect(text).not.toContain('token-value');
      expect(text).not.toContain(APP_SECRET);
      expect(status.body.steps).toMatchObject({ phoneId: true, token: true, appSecret: true });
    });

    it('will not store an address that would receive the token elsewhere', async () => {
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { whatsappApiUrl: 'https://evil.example.com/v1' } }).expect(400);
      await request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values: { whatsappApiUrl: 'https://graph.facebook.com.evil.example/v23.0' } }).expect(400);
    });
  });

  describe('campaigns', () => {
    const url = `${API}/notifications/campaigns`;
    const draft = async (session: any, overrides: object = {}) =>
      (await request(http()).post(url).set(session.auth).send({ title: 'عرض', body: 'نص العرض', filters: {}, sendInApp: true, sendWhatsapp: false, ...overrides }).expect(201)).body;
    const count = async (session: any, filters: object) => (await request(http()).post(`${url}/audience`).set(session.auth).send({ filters }).expect(200)).body;

    it('filters by trip, destination and activity, and leaves out staff', async () => {
      const yanbu = await createTrip({ destination: 'جدة التجريبية' });
      const passenger = await loginPassenger(app);
      await book(yanbu, passenger);
      await loginPassenger(app);

      expect((await count(admin, { tripIds: [yanbu.id] })).count).toBe(1);
      expect((await count(admin, { destinations: ['جدة التجريبية'] })).count).toBe(1);
      expect((await count(admin, { destinations: ['وجهة أخرى'] })).count).toBe(0);
      const everyone = await count(admin, {});
      expect(everyone.count).toBe(await prisma.user.count({ where: { role: 'PASSENGER', marketingOptOutAt: null } }));
      // Conditions on a booking must hold on one booking.
      expect((await count(admin, { tripIds: [yanbu.id], destinations: ['وجهة أخرى'] })).count).toBe(0);
    });

    it('targets by days since the last trip, gender and nationality, and shows the mix', async () => {
      const place = `وجهة آخر رحلة ${crypto.randomUUID().slice(0, 6)}`;
      const DAY = 24 * 60 * 60_000;
      // A trip that departed `days` ago, booked and confirmed by the customer.
      const travelled = async (passenger: any, days: number, seat: string) => {
        const trip = await createTrip({ destination: place });
        const booking = await book(trip, passenger, seat);
        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
        await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - days * DAY) } });
      };
      const old = await loginPassenger(app);
      const recent = await loginPassenger(app);
      const oldWithNext = await loginPassenger(app);
      await travelled(old, 120, '1');
      await travelled(recent, 10, '2');
      await travelled(oldWithNext, 150, '3');
      const next = await createTrip({ destination: `${place} قادمة` });
      await prisma.booking.update({ where: { id: (await book(next, oldWithNext, '4')).id }, data: { status: 'CONFIRMED' } });
      await prisma.user.update({ where: { id: old.user.id }, data: { gender: 'FEMALE', nationality: 'مصري' } });
      await prisma.user.update({ where: { id: oldWithNext.user.id }, data: { gender: 'MALE', nationality: 'يمني' } });

      const ids = (filters: object) => ({ ...filters, destinations: [place] });
      expect((await count(admin, ids({ lastTripMinDays: 90 }))).count).toBe(2);
      expect((await count(admin, ids({ lastTripMinDays: 90, noUpcomingTrip: true }))).count).toBe(1);
      expect((await count(admin, ids({ lastTripMinDays: 5, lastTripMaxDays: 130 }))).count).toBe(2);
      expect((await count(admin, ids({ lastTripMaxDays: 30 }))).count).toBe(1);
      expect((await count(admin, ids({ lastTripMinDays: 90, genders: ['FEMALE'] }))).count).toBe(1);
      expect((await count(admin, ids({ genders: ['MALE'], nationalities: ['يمني'] }))).count).toBe(1);

      const mix = await count(admin, ids({}));
      expect(mix.byGender).toEqual({ MALE: 1, FEMALE: 1, UNKNOWN: 1 });
      expect(mix.byNationality).toEqual(expect.arrayContaining([{ nationality: 'مصري', count: 1 }, { nationality: 'يمني', count: 1 }]));

      await request(http()).post(`${url}/audience`).set(admin.auth).send({ filters: { lastTripMinDays: 100, lastTripMaxDays: 30 } }).expect(400);
      await request(http()).post(`${url}/audience`).set(admin.auth).send({ filters: { genders: ['OTHER'] } }).expect(400);
    });

    it('rejects unknown filters and values', async () => {
      await request(http()).post(`${url}/audience`).set(admin.auth).send({ filters: { role: 'ADMIN' } }).expect(400);
      await request(http()).post(`${url}/audience`).set(admin.auth).send({ filters: { payment: 'x' } }).expect(400);
      await request(http()).post(`${url}/audience`).set(admin.auth).send({ filters: { tripIds: 'all' } }).expect(400);
    });

    it('respects the offers switch for marketing, but not for a message about a booked trip', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      await request(http()).put(`${API}/users/profile/messaging`).set(passenger.auth).send({ acceptsOffers: false, messageLanguage: 'ur' }).expect(200);

      const marketing = await count(admin, { hasWallet: false, destinations: [trip.destination] });
      expect(marketing.isMarketing).toBe(true);
      expect(marketing.optedOut).toBeGreaterThanOrEqual(1);
      expect(await count(admin, { tripIds: [trip.id] })).toMatchObject({ count: 1, optedOut: 0, isMarketing: false });
      await request(http()).put(`${API}/users/profile/messaging`).set(passenger.auth).send({ acceptsOffers: true, messageLanguage: 'ar' }).expect(200);
      await request(http()).put(`${API}/users/profile/messaging`).set(passenger.auth).send({ messageLanguage: 'fr' }).expect(400);
    });

    it('sends once to the confirmed count and refuses a stale one', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      const campaign = await draft(admin, { filters: { tripIds: [trip.id] } });

      const stale = await request(http()).post(`${url}/${campaign.id}/send`).set(admin.auth).send({ confirmCount: 5 }).expect(409);
      expect(stale.body.message).toContain('1');
      await request(http()).post(`${url}/${campaign.id}/send`).set(admin.auth).send({ confirmCount: 1 }).expect(200);
      await request(http()).post(`${url}/${campaign.id}/send`).set(admin.auth).send({ confirmCount: 1 }).expect(409);

      await app.get(CampaignsService).dispatch(campaign.id);
      await app.get(CampaignsService).dispatch(campaign.id);
      const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(saved).toMatchObject({ status: 'SENT', recipients: 1 });
      expect(await prisma.notification.count({ where: { userId: passenger.user.id, event: 'CUSTOMER_CAMPAIGN' } })).toBe(1);
    });

    it("sends each customer their language's wording, and only to the chosen languages", async () => {
      const trip = await createTrip();
      const arabic = await loginPassenger(app);
      const english = await loginPassenger(app);
      await prisma.user.update({ where: { id: english.user.id }, data: { messageLanguage: 'en' } });
      await book(trip, arabic, '1');
      await book(trip, english, '2');
      const content = { ar: { title: 'عرض', body: 'نص العرض' }, en: { title: 'Offer', body: 'Offer text' }, ur: { title: 'آفر', body: 'آفر کا متن' } };
      const filters = { tripIds: [trip.id] };

      // Every language needs its wording when all are chosen.
      await request(http()).post(url).set(admin.auth).send({ content: { ar: content.ar }, filters, sendInApp: true, sendWhatsapp: false }).expect(400);

      const all = (await request(http()).post(url).set(admin.auth).send({ content, filters, sendInApp: true, sendWhatsapp: false }).expect(201)).body;
      expect((await count(admin, filters)).byLanguage).toMatchObject({ ar: 1, en: 1 });
      await request(http()).post(`${url}/${all.id}/send`).set(admin.auth).send({ confirmCount: 2 }).expect(200);
      await app.get(CampaignsService).dispatch(all.id);
      const received = (userId: string) => prisma.notification.findMany({ where: { userId, event: 'CUSTOMER_CAMPAIGN' }, orderBy: { createdAt: 'asc' } });
      expect((await received(arabic.user.id))[0]).toMatchObject({ title: 'عرض', body: 'نص العرض' });
      expect((await received(english.user.id))[0]).toMatchObject({ title: 'Offer', body: 'Offer text' });

      const englishOnly = { ...filters, languages: ['en'] };
      expect((await count(admin, englishOnly)).count).toBe(1);
      const onlyEnglish = (await request(http()).post(url).set(admin.auth).send({ content: { en: content.en }, filters: englishOnly, sendInApp: true, sendWhatsapp: false }).expect(201)).body;
      expect(onlyEnglish.title).toBe('Offer');
      await request(http()).post(`${url}/${onlyEnglish.id}/send`).set(admin.auth).send({ confirmCount: 1 }).expect(200);
      await app.get(CampaignsService).dispatch(onlyEnglish.id);
      expect(await received(arabic.user.id)).toHaveLength(1);
      expect(await received(english.user.id)).toHaveLength(2);
    });

    it('keeps the coupon in the message, and refuses a personal or expired one', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      const coupon = await prisma.coupon.create({ data: { code: `CAMP${Date.now()}`, value: 10 } });
      const campaign = await draft(admin, { filters: { tripIds: [trip.id] }, couponId: coupon.id });
      expect(campaign.isMarketing).toBe(true);
      await request(http()).post(`${url}/${campaign.id}/send`).set(admin.auth).send({ confirmCount: 1 }).expect(200);
      await app.get(CampaignsService).dispatch(campaign.id);
      const [message] = await prisma.notification.findMany({ where: { userId: passenger.user.id, event: 'CUSTOMER_CAMPAIGN' }, orderBy: { createdAt: 'desc' } });
      expect(message.body).toContain(coupon.code);

      const personal = await prisma.coupon.create({ data: { code: `OWN${Date.now()}`, value: 10, ownerUserId: passenger.user.id } });
      const expired = await prisma.coupon.create({ data: { code: `OLD${Date.now()}`, value: 10, validUntil: new Date(Date.now() - 1000) } });
      for (const couponId of [personal.id, expired.id]) {
        await request(http()).post(url).set(admin.auth).send({ title: 'ع', body: 'ن', filters: {}, sendInApp: true, sendWhatsapp: false, couponId }).expect(400);
      }
    });

    it('refuses WhatsApp without an approved template, and a campaign with no channel', async () => {
      const trip = await createTrip();
      await book(trip, await loginPassenger(app));
      const campaign = await draft(admin, { filters: { tripIds: [trip.id] }, sendWhatsapp: true });
      await request(http()).post(`${url}/${campaign.id}/send`).set(admin.auth).send({ confirmCount: 1 }).expect(409);
      await request(http()).post(url).set(admin.auth).send({ title: 'ع', body: 'ن', filters: {}, sendInApp: false, sendWhatsapp: false }).expect(400);
    });

    it('holds staff to the cap unless their rank may go beyond it', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ campaignMaxRecipients: 1 }).expect(200);
      const trip = await createTrip();
      await book(trip, await loginPassenger(app), '1');
      await book(trip, await loginPassenger(app), '2');
      const limited = await employee(['notifications.campaigns']);
      const campaign = await draft(limited.session, { filters: { tripIds: [trip.id] } });
      await request(http()).post(`${url}/${campaign.id}/send`).set(limited.session.auth).send({ confirmCount: 2 }).expect(403);
      const unlimited = await employee(['notifications.campaigns', 'notifications.campaigns_unlimited']);
      await request(http()).post(`${url}/${campaign.id}/send`).set(unlimited.session.auth).send({ confirmCount: 2 }).expect(200);
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ campaignMaxRecipients: 5000 }).expect(200);
    });

    it('stops a scheduled send when the sender lost the permission or the audience ballooned', async () => {
      const trip = await createTrip();
      await book(trip, await loginPassenger(app));
      const sender = await employee(['notifications.campaigns']);
      const campaign = await draft(sender.session, { filters: { tripIds: [trip.id] } });
      await request(http()).post(`${url}/${campaign.id}/send`).set(sender.session.auth).send({ confirmCount: 1, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);

      await prisma.campaign.update({ where: { id: campaign.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      await prisma.user.update({ where: { id: sender.user.id }, data: { revokedPermissions: ['notifications.campaigns'] } });
      await app.get(CampaignsService).dispatch(campaign.id);
      expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'CANCELLED', recipients: 0 });

      const second = await draft(admin, { filters: { tripIds: [trip.id] } });
      await request(http()).post(`${url}/${second.id}/send`).set(admin.auth).send({ confirmCount: 1, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);
      // The whole customer base against an approval of one: more than the small allowance for natural growth.
      for (let index = 0; index < 8; index++) await loginPassenger(app);
      await prisma.campaign.update({ where: { id: second.id }, data: { scheduledAt: new Date(Date.now() - 1000), filters: {}, confirmedCount: 1 } });
      await app.get(CampaignsService).dispatch(second.id);
      const stopped = await prisma.campaign.findUniqueOrThrow({ where: { id: second.id } });
      expect(stopped.status).toBe('CANCELLED');
      expect(stopped.failureReason).toContain('كبر الجمهور');
    });

    it('is closed without the permission, including to holders of the other notification rights', async () => {
      const passenger = await loginPassenger(app);
      const other = await employee(['notifications.manage', 'notifications.send']);
      await request(http()).post(`${url}/audience`).set(passenger.auth).send({ filters: {} }).expect(403);
      await request(http()).post(`${url}/audience`).set(other.session.auth).send({ filters: {} }).expect(403);
      await request(http()).get(`${url}/options`).set(other.session.auth).expect(403);
    });
  });

  describe('station alerts', () => {
    const POINTS = [
      { name: 'فرع ينبع', time: '05:15', address: 'أ', lat: 24.0, lng: 38.0 },
      { name: 'حي الشرم', time: '05:50', address: 'ب', lat: 24.1, lng: 38.1 },
    ];
    const trackedTrip = async () => {
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [supervisor.id], boardingPoints: POINTS });
      const passenger = await loginPassenger(app);
      await book(trip, passenger, '1', { boardingPointId: undefined });
      const point = await prisma.boardingPoint.findFirstOrThrow({ where: { tripId: trip.id, name: 'حي الشرم' } });
      await prisma.booking.updateMany({ where: { tripId: trip.id }, data: { boardingPointId: point.id, boardingPointName: point.name } });
      await openBoarding(prisma, trip.id);
      return { trip, passenger, point, crew: await loginStaff(app, supervisor.phone) };
    };
    const received = (userId: string, event: string) => prisma.notification.count({ where: { userId, event } });
    const service = () => app.get(StationAlertsService);

    afterEach(async () => {
      await prisma.stationAlertRule.deleteMany();
    });

    it('warns once as the bus nears the next point, by straight line when no platform is connected', async () => {
      const { trip, passenger } = await trackedTrip();
      const position = { lat: 24.101, lng: 38.101, reportedById: admin.user.id, recordedAt: new Date() };
      await prisma.tripLocation.upsert({ where: { tripId: trip.id }, create: { tripId: trip.id, ...position }, update: position });
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 5 * 3_600_000) } });
      await service().sweep();
      await service().sweep();
      // The first point has nobody waiting, so the alert concerns the one the customer boards at.
      expect(await received(passenger.user.id, 'STATION_APPROACHING')).toBe(1);
      const [message] = await prisma.notification.findMany({ where: { userId: passenger.user.id, event: 'STATION_APPROACHING' } });
      expect(message.body).toContain('حي الشرم');
      const view = await request(http()).get(`${API}/station-alerts/trips/${trip.id}`).set(admin.auth).expect(200);
      expect(view.body.route.map((leg: any) => leg.name)).toEqual(['فرع ينبع', 'حي الشرم', trip.destination]);
      expect(JSON.stringify(view.body)).not.toContain(passenger.phone);
    });

    it('sends the at-stop alert unless the rule is off for this trip, and records it', async () => {
      const on = await trackedTrip();
      await request(http()).post(`${API}/tickets/trips/${on.trip.id}/status`).set(on.crew.auth).send({ status: 'AT_POINT', boardingPointId: on.point.id }).expect(201);
      expect(await received(on.passenger.user.id, 'BUS_AT_YOUR_POINT')).toBe(1);
      expect(await prisma.stationAlert.count({ where: { tripId: on.trip.id, ruleKey: 'AT_STOP' } })).toBe(1);

      const off = await trackedTrip();
      await request(http()).put(`${API}/station-alerts/trips/${off.trip.id}/rules/AT_STOP`).set(admin.auth).send({ isActive: false }).expect(200);
      await request(http()).post(`${API}/tickets/trips/${off.trip.id}/status`).set(off.crew.auth).send({ status: 'AT_POINT', boardingPointId: off.point.id }).expect(201);
      expect(await received(off.passenger.user.id, 'BUS_AT_YOUR_POINT')).toBe(0);
    });

    it('reminds whoever has not boarded, once, after the stop has lasted long enough', async () => {
      const { trip, passenger, point, crew } = await trackedTrip();
      await request(http()).post(`${API}/tickets/trips/${trip.id}/status`).set(crew.auth).send({ status: 'AT_POINT', boardingPointId: point.id }).expect(201);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 5 * 3_600_000) } });
      await service().sweep();
      expect(await received(passenger.user.id, 'STATION_LATE_REMINDER')).toBe(0);
      await prisma.trip.update({ where: { id: trip.id }, data: { liveStatusAt: new Date(Date.now() - 4 * 60_000) } });
      await service().sweep();
      await service().sweep();
      expect(await received(passenger.user.id, 'STATION_LATE_REMINDER')).toBe(1);
    });

    it('writes to each passenger in their language', async () => {
      const { trip, passenger, point } = await trackedTrip();
      await prisma.user.update({ where: { id: passenger.user.id }, data: { messageLanguage: 'en' } });
      await request(http()).post(`${API}/station-alerts/trips/${trip.id}/send`).set(admin.auth).send({ stopKey: point.name, type: 'DELAY', minutes: 20, channels: ['IN_APP'] }).expect(200);
      const [message] = await prisma.notification.findMany({ where: { userId: passenger.user.id, event: 'STATION_DELAY' } });
      expect(message.title).toBe('The bus is delayed');
      expect(message.body).toContain('20');
    });

    it('checks a manual alert: its input, its channel, its stop, and how often', async () => {
      const { trip, point } = await trackedTrip();
      const send = (body: object) => request(http()).post(`${API}/station-alerts/trips/${trip.id}/send`).set(admin.auth).send({ stopKey: point.name, type: 'ARRIVED', channels: ['IN_APP'], ...body });
      await send({ type: 'DELAY' }).expect(400);
      await send({ type: 'LOCATION_CHANGE' }).expect(400);
      await send({ channels: ['SMS'] }).expect(400);
      await send({ channels: ['WHATSAPP'] }).expect(409);
      await send({ stopKey: 'محطة مجهولة' }).expect(404);
      for (let index = 0; index < 6; index++) await send({}).expect(200);
      await send({}).expect(429);
    });

    it('needs the stations permission to read or send, and manage to change company rules', async () => {
      const { trip, point } = await trackedTrip();
      const outsider = await employee(['bookings.view']);
      await request(http()).get(`${API}/station-alerts/trips/${trip.id}`).set(outsider.session.auth).expect(403);
      await request(http()).post(`${API}/station-alerts/trips/${trip.id}/send`).set(outsider.session.auth).send({ stopKey: point.name, type: 'ARRIVED', channels: ['IN_APP'] }).expect(403);
      const stationsOnly = await employee(['notifications.stations']);
      await request(http()).get(`${API}/station-alerts/trips/${trip.id}`).set(stationsOnly.session.auth).expect(200);
      await request(http()).put(`${API}/station-alerts/rules/MIQAT`).set(stationsOnly.session.auth).send({ isActive: false }).expect(403);
    });
  });

  describe('supervisor templates', () => {
    const setup = async () => {
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [supervisor.id] });
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      await openBoarding(prisma, trip.id);
      return { trip, passenger, crew: await loginStaff(app, supervisor.phone) };
    };
    const url = (tripId: string) => `${API}/tickets/trips/${tripId}/template-notices`;

    afterEach(async () => {
      await prisma.notificationTemplate.deleteMany();
    });

    it('sends the office wording with the typed value, and needs the value', async () => {
      const { trip, passenger, crew } = await setup();
      await request(http()).post(url(trip.id)).set(crew.auth).send({ event: 'CREW_POINT_CHANGE' }).expect(400);
      await request(http()).post(url(trip.id)).set(crew.auth).send({ event: 'CREW_POINT_CHANGE', value: 'البوابة الشرقية' }).expect(201);
      const [message] = await prisma.notification.findMany({ where: { userId: passenger.user.id, event: 'CREW_POINT_CHANGE' } });
      expect(message.body).toContain('البوابة الشرقية');
    });

    it('refuses other events, a stranger, and a template the office closed', async () => {
      const { trip, crew } = await setup();
      await request(http()).post(url(trip.id)).set(crew.auth).send({ event: 'WALLET_CREDITED' }).expect(400);
      const stranger = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await request(http()).post(url(trip.id)).set(stranger.auth).send({ event: 'CREW_DEPARTURE_REMINDER' }).expect(403);

      await request(http()).put(`${API}/notifications/templates/CREW_DEPARTURE_REMINDER/channels`).set(admin.auth).send({ crewCanSend: false }).expect(200);
      await request(http()).post(url(trip.id)).set(crew.auth).send({ event: 'CREW_DEPARTURE_REMINDER' }).expect(403);
      const list = await request(http()).get(`${API}/tickets/trips/${trip.id}/notice-templates`).set(crew.auth).expect(200);
      expect(list.body.map((row: any) => row.event)).not.toContain('CREW_DEPARTURE_REMINDER');
    });
  });
});

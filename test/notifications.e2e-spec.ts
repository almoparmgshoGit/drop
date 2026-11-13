import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let adminUser: any;
  let admin: any;

  const createTrip = async (overrides: Record<string, unknown> = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  const book = async (trip: any, passenger: any, seat = '1') =>
    (
      await request(http())
        .post(`${API}/bookings`)
        .set(passenger.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: [seat] }], passengers: [{ fullName: 'سارة أحمد' }] })
        .expect(201)
    ).body.bookings[0];

  const inbox = async (session: any) => (await request(http()).get(`${API}/notifications/mine`).set(session.auth).expect(200)).body;

  const received = async (session: any, event: string) => (await inbox(session)).items.filter((item: any) => item.event === event);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    adminUser = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, adminUser.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('passenger actions', () => {
    it('tells the customer their booking is confirmed, with the booking values filled in', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      const booking = await book(trip, passenger);

      const [item] = await received(passenger, 'BOOKING_CONFIRMED');
      expect(item.title).toBe('تم تأكيد حجزك');
      expect(item.body).toContain(booking.bookingReference);
      expect(item.body).toContain('ينبع');
      expect(item.body).not.toContain('{{');
      expect(item).toMatchObject({ bookingId: booking.id, tripId: trip.id, readAt: null });
    });

    it('sends one trip-cancelled message per booking, not a booking-cancelled one as well', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      await request(http()).post(`${API}/trips/${trip.id}/cancel`).set(admin.auth).send({ reason: 'ظرف طارئ' }).expect(201);

      const cancelled = await received(passenger, 'TRIP_CANCELLED');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].body).toContain('180 ر.س');
      expect(await received(passenger, 'BOOKING_CANCELLED')).toHaveLength(0);
    });

    it('announces a departure change to passengers and crew, showing the old and new time', async () => {
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [supervisor.id] });
      const passenger = await loginPassenger(app);
      await book(trip, passenger);

      const departure = new Date(new Date(trip.departureTime).getTime() + 60 * 60 * 1000);
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ departureTime: departure.toISOString() }).expect(200);

      const [item] = await received(passenger, 'TRIP_TIME_CHANGED');
      expect(item.body).not.toContain('—');
      const crew = await loginStaff(app, supervisor.phone);
      expect(await received(crew, 'CREW_TRIP_TIME_CHANGED')).toHaveLength(1);
    });

    it('delivers a crew notice through the template', async () => {
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [supervisor.id] });
      const passenger = await loginPassenger(app);
      await book(trip, passenger);
      const crew = await loginStaff(app, supervisor.phone);
      await openBoarding(prisma, trip.id);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(crew.auth).send({ message: 'تأخر الانطلاق' }).expect(201);

      const [item] = await received(passenger, 'CREW_NOTICE');
      expect(item.body).toBe('تأخر الانطلاق');
    });

    it('sends nothing when the action is refused', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      const booking = await book(trip, passenger);
      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'خطأ', refundAmount: 99999 }).expect(400);
      expect(await received(passenger, 'BOOKING_CANCELLED')).toHaveLength(0);
    });
  });

  describe('staff actions', () => {
    it('tells only crew who were just added, and those removed', async () => {
      const stays = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const joins = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const leaves = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [stays.id, leaves.id] });
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ supervisorIds: [stays.id, joins.id] }).expect(200);

      const count = (userId: string, event: string) => prisma.notification.count({ where: { userId, event, tripId: trip.id } });
      expect(await count(stays.id, 'CREW_TRIP_ASSIGNED')).toBe(1);
      expect(await count(joins.id, 'CREW_TRIP_ASSIGNED')).toBe(1);
      expect(await count(leaves.id, 'CREW_TRIP_UNASSIGNED')).toBe(1);
      expect(await count(stays.id, 'CREW_TRIP_UNASSIGNED')).toBe(0);
    });

    it('does not announce a draft trip until it is published', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const trip = await createTrip({ tripStatus: 'DRAFT', driverIds: [driver.id] });
      expect(await prisma.notification.count({ where: { userId: driver.id, tripId: trip.id } })).toBe(0);

      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ tripStatus: 'PUBLISHED' }).expect(200);
      expect(await prisma.notification.count({ where: { userId: driver.id, tripId: trip.id, event: 'CREW_TRIP_ASSIGNED' } })).toBe(1);
    });

    it('reaches staff by permission when a customer asks to cancel', async () => {
      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      const booking = await book(trip, passenger);
      await request(http()).post(`${API}/bookings/${booking.id}/cancel`).set(passenger.auth).send({ reason: 'تغيرت الخطة' }).expect(201);

      const adminItems = await received(admin, 'STAFF_CANCELLATION_REQUEST');
      const forThisBooking = adminItems.find((item: any) => item.bookingId === booking.id);
      expect(forThisBooking.body).toContain('تغيرت الخطة');
      // The customer's own inbox holds the acknowledgement, never the staff message.
      expect(await received(passenger, 'CANCELLATION_REQUESTED')).toHaveLength(1);
      expect(await received(passenger, 'STAFF_CANCELLATION_REQUEST')).toHaveLength(0);
    });

    it('does not notify a driver rank about office events', async () => {
      const driver = await createStaff(prisma, 'DRIVER');
      const trip = await createTrip();
      await book(trip, await loginPassenger(app));
      expect(await prisma.notification.count({ where: { userId: driver.id, event: 'STAFF_NEW_BOOKING' } })).toBe(0);
    });

    it('does not tell the reporter about their own incident report', async () => {
      const supervisor = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      const trip = await createTrip({ supervisorIds: [supervisor.id] });
      const crew = await loginStaff(app, supervisor.phone);
      await openBoarding(prisma, trip.id);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/reports`).set(crew.auth).send({ type: 'BREAKDOWN', details: 'عطل في التكييف' }).expect(201);

      const [item] = (await received(admin, 'STAFF_TRIP_REPORT')).filter((row: any) => row.tripId === trip.id);
      expect(item.title).toBe('بلاغ جديد: عطل في الحافلة');
      expect(item.body).toContain('عطل في التكييف');
      expect(await prisma.notification.count({ where: { userId: supervisor.id, event: 'STAFF_TRIP_REPORT' } })).toBe(0);
    });
  });

  describe('templates', () => {
    const url = (event: string) => `${API}/notifications/templates/${event}`;

    afterEach(async () => {
      await prisma.notificationTemplate.deleteMany();
    });

    it('lists every action with its variables', async () => {
      const list = await request(http()).get(`${API}/notifications/templates`).set(admin.auth).expect(200);
      const confirmed = list.body.find((row: any) => row.event === 'BOOKING_CONFIRMED');
      expect(confirmed).toMatchObject({ audience: 'PASSENGER', isActive: true, isCustomized: false });
      expect(confirmed.variables.map((v: any) => v.key)).toContain('bookingReference');
    });

    it('never lets a customer template name the trip number', async () => {
      await request(http())
        .put(url('BOOKING_CONFIRMED'))
        .set(admin.auth)
        .send({ title: 'أهلًا {{userName}}', body: 'مقعدك {{seats}} في رحلة {{tripCode}}', isActive: true })
        .expect(400);
    });

    it('uses the edited title and body with variables and the recipient name', async () => {
      await request(http())
        .put(url('BOOKING_CONFIRMED'))
        .set(admin.auth)
        .send({ title: 'أهلًا {{userName}}', body: 'مقعدك {{seats}} في رحلة {{destination}}', isActive: true })
        .expect(200);

      const trip = await createTrip();
      const passenger = await loginPassenger(app);
      await prisma.user.update({ where: { id: passenger.user.id }, data: { name: 'خالد' } });
      await book(trip, passenger, '7');

      const [item] = await received(passenger, 'BOOKING_CONFIRMED');
      expect(item.title).toBe('أهلًا خالد');
      expect(item.body).toBe(`مقعدك 7 في رحلة ${trip.destination}`);
    });

    it("sends each customer their language's wording, with the admin's own translation where there is one", async () => {
      await request(http())
        .put(url('BOOKING_CONFIRMED'))
        .set(admin.auth)
        .send({ title: 'أهلًا {{userName}}', body: 'مقعدك {{seats}}', isActive: true, translations: { en: { title: 'Hi {{userName}}', body: 'Your seat {{seats}}' }, ur: { title: '', body: '' } } })
        .expect(200);
      const listed = (await request(http()).get(`${API}/notifications/templates`).set(admin.auth).expect(200)).body.find((row: any) => row.event === 'BOOKING_CONFIRMED');
      expect(listed.translations.en).toEqual({ title: 'Hi {{userName}}', body: 'Your seat {{seats}}' });
      // Urdu left empty keeps the catalog's translation.
      expect(listed.translations.ur).toEqual(listed.defaultTranslations.ur);
      expect(listed.isCustomized).toBe(true);

      const trip = await createTrip();
      const english = await loginPassenger(app);
      const urdu = await loginPassenger(app);
      await prisma.user.update({ where: { id: english.user.id }, data: { name: 'Khalid', messageLanguage: 'en' } });
      await prisma.user.update({ where: { id: urdu.user.id }, data: { messageLanguage: 'ur' } });
      await book(trip, english, '7');
      await book(trip, urdu, '8');

      const [en] = await received(english, 'BOOKING_CONFIRMED');
      expect(en).toMatchObject({ title: 'Hi Khalid', body: 'Your seat 7' });
      const [ur] = await received(urdu, 'BOOKING_CONFIRMED');
      expect(ur.title).not.toContain('أهلًا');
      expect(ur.body).not.toContain('{{');
    });

    it('refuses a half-written or broken translation', async () => {
      const base = { title: 'عنوان', body: 'نص', isActive: true };
      await request(http()).put(url('BOOKING_CONFIRMED')).set(admin.auth).send({ ...base, translations: { en: { title: 'Only a title', body: '' } } }).expect(400);
      await request(http()).put(url('BOOKING_CONFIRMED')).set(admin.auth).send({ ...base, translations: { en: { title: 'T', body: 'ID {{nationalId}}' } } }).expect(400);
    });

    it('sends nothing for an action that was switched off', async () => {
      const base = { title: 'عنوان', body: 'نص' };
      await request(http()).put(url('BOOKING_CONFIRMED')).set(admin.auth).send({ ...base, isActive: false }).expect(200);
      const passenger = await loginPassenger(app);
      await book(await createTrip(), passenger);
      expect(await received(passenger, 'BOOKING_CONFIRMED')).toHaveLength(0);
    });

    it('returns to the original wording on reset, and old messages keep theirs', async () => {
      const passenger = await loginPassenger(app);
      await request(http()).put(url('BOOKING_CONFIRMED')).set(admin.auth).send({ title: 'عنوان مؤقت', body: 'نص', isActive: true }).expect(200);
      await book(await createTrip(), passenger);

      const reset = await request(http()).delete(url('BOOKING_CONFIRMED')).set(admin.auth).expect(200);
      expect(reset.body).toMatchObject({ title: 'تم تأكيد حجزك', isCustomized: false });
      await book(await createTrip(), passenger);

      const titles = (await received(passenger, 'BOOKING_CONFIRMED')).map((item: any) => item.title);
      expect(titles).toEqual(['تم تأكيد حجزك', 'عنوان مؤقت']);
    });

    it('rejects a variable the action does not offer, broken braces, and empty text', async () => {
      const send = (body: object) => request(http()).put(url('BOOKING_CONFIRMED')).set(admin.auth).send({ title: 'عنوان', body: 'نص', isActive: true, ...body });
      const unknown = await send({ body: 'الهوية {{nationalId}}' }).expect(400);
      expect(unknown.body.message).toContain('nationalId');
      await send({ body: 'رقم {{bookingReference' }).expect(400);
      await send({ title: '   ' }).expect(400);
      await request(http()).put(url('NOT_AN_EVENT')).set(admin.auth).send({ title: 'ع', body: 'ن', isActive: true }).expect(404);
    });

    it('is closed to anyone without the permission', async () => {
      const passenger = await loginPassenger(app);
      const staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
      await request(http()).get(`${API}/notifications/templates`).set(passenger.auth).expect(403);
      await request(http()).put(url('BOOKING_CONFIRMED')).set(staff.auth).send({ title: 'ع', body: 'ن', isActive: true }).expect(403);
      await request(http()).post(`${url('BOOKING_CONFIRMED')}/test`).set(staff.auth).send({}).expect(403);
    });

    it('sends a labelled test of the unsaved wording to the sender, with made-up values and no delivery row', async () => {
      await prisma.notification.deleteMany({ where: { userId: adminUser.id } });
      const res = await request(http())
        .post(`${url('BOOKING_CONFIRMED')}/test`)
        .set(admin.auth)
        .send({ language: 'en', title: 'Hi {{userName}}', body: 'Booking {{bookingReference}}' })
        .expect(200);
      expect(res.body).toMatchObject({ language: 'en', title: '[تجريبي] Hi عميل تجريبي', body: 'Booking TEST-0000' });
      expect(res.body.results.find((row: any) => row.channel === 'IN_APP').status).toBe('SENT');
      // WhatsApp is off for this template, so it is reported as skipped, never queued.
      expect(res.body.results.find((row: any) => row.channel === 'WHATSAPP').status).toBe('SKIPPED');
      expect(await prisma.messageDelivery.count({ where: { event: 'BOOKING_CONFIRMED' } })).toBe(0);

      const [item] = await received(admin, 'TEMPLATE_TEST');
      expect(item.title).toBe('[تجريبي] Hi عميل تجريبي');
      // Nothing was saved by the test.
      expect(await prisma.notificationTemplate.count({ where: { event: 'BOOKING_CONFIRMED' } })).toBe(0);
    });

    it('tests the saved wording to a number without an account, and refuses broken text', async () => {
      const res = await request(http()).post(`${url('BOOKING_CONFIRMED')}/test`).set(admin.auth).send({ recipient: 'PHONE', phone: '0599999990' }).expect(200);
      expect(res.body.title).toBe('[تجريبي] تم تأكيد حجزك');
      expect(res.body.results.find((row: any) => row.channel === 'IN_APP').status).toBe('SKIPPED');
      await request(http()).post(`${url('BOOKING_CONFIRMED')}/test`).set(admin.auth).send({ title: 'ع', body: 'الهوية {{nationalId}}' }).expect(400);
      await request(http()).post(`${url('BOOKING_CONFIRMED')}/test`).set(admin.auth).send({ recipient: 'PHONE', phone: '123' }).expect(400);
      await request(http()).post(`${url('NOT_AN_EVENT')}/test`).set(admin.auth).send({}).expect(404);
    });
  });

  describe('staff messages', () => {
    const SECTION = 'الحجوزات';
    let rankCounter = 0;

    /** A signed-in employee whose rank holds exactly these permissions. */
    const employee = async (permissions: string[]) => {
      const rank = await prisma.rank.create({ data: { name: `رتبة ${++rankCounter}`, role: 'STAFF', jobId: 'job-office', permissions } });
      const user = await createStaff(prisma, 'STAFF', undefined, rank.id);
      return { user, session: await loginStaff(app, user.phone) };
    };
    const send = (session: any, body: object) => request(http()).post(`${API}/notifications/staff-messages`).set(session.auth).send({ title: 'اجتماع', body: 'الساعة 5', ...body });
    const messagesOf = (userId: string) => prisma.notification.findMany({ where: { userId, event: 'STAFF_MESSAGE' } });

    it('reaches everyone in the section, signed by the sender, but not other sections or the sender', async () => {
      const sender = await employee(['bookings.view', 'notifications.send']);
      const colleague = await employee(['cancellations.review']);
      const outsider = await employee(['hotels.view']);

      const sent = await send(sender.session, { section: SECTION }).expect(201);
      expect(sent.body.recipients).toBeGreaterThanOrEqual(2);

      const [message] = await messagesOf(colleague.user.id);
      expect(message.title).toBe('اجتماع');
      expect(message.body).toContain('الساعة 5');
      expect(message.body).toContain(sender.user.name);
      expect(message.body).toContain(SECTION);
      expect(await messagesOf(adminUser.id)).toHaveLength(1);
      expect(await messagesOf(outsider.user.id)).toHaveLength(0);
      expect(await messagesOf(sender.user.id)).toHaveLength(0);
    });

    it('reaches only staff of the chosen language, each in their own wording when all are chosen', async () => {
      const sender = await employee(['bookings.view', 'notifications.send']);
      const arabic = await employee(['bookings.view']);
      const english = await employee(['bookings.view']);
      await prisma.user.update({ where: { id: english.user.id }, data: { messageLanguage: 'en' } });
      const content = { ar: { title: 'اجتماع', body: 'الساعة 5' }, en: { title: 'Meeting', body: 'At 5' }, ur: { title: 'میٹنگ', body: '5 بجے' } };
      const ids = [arabic.user.id, english.user.id];

      await send(sender.session, { section: SECTION, userIds: ids, title: undefined, body: undefined, languages: ['en'], content: { en: content.en } }).expect(201);
      expect(await messagesOf(arabic.user.id)).toHaveLength(0);
      const [first] = await messagesOf(english.user.id);
      expect(first.title).toBe('Meeting');

      await send(sender.session, { section: SECTION, userIds: ids, title: undefined, body: undefined, content }).expect(201);
      const [toArabic] = await messagesOf(arabic.user.id);
      expect(toArabic.title).toBe('اجتماع');
      expect(await messagesOf(english.user.id)).toHaveLength(2);

      // Every chosen language needs its wording.
      await send(sender.session, { section: SECTION, title: undefined, body: undefined, content: { ar: content.ar } }).expect(400);
    });

    it('can target one responsible employee', async () => {
      const sender = await employee(['bookings.view', 'notifications.send']);
      const chosen = await employee(['bookings.view']);
      const other = await employee(['bookings.view']);
      const sent = await send(sender.session, { section: SECTION, userIds: [chosen.user.id] }).expect(201);
      expect(sent.body).toEqual({ recipients: 1 });
      expect(await messagesOf(chosen.user.id)).toHaveLength(1);
      expect(await messagesOf(other.user.id)).toHaveLength(0);
    });

    it('refuses a section the sender has no permission in, and members from outside the section', async () => {
      const sender = await employee(['bookings.view', 'notifications.send']);
      const outsider = await employee(['hotels.view']);
      await send(sender.session, { section: 'الفنادق والسكن' }).expect(403);
      await send(sender.session, { section: SECTION, userIds: [outsider.user.id] }).expect(400);
      await send(sender.session, { section: 'قسم غير موجود' }).expect(403);
    });

    it('needs the send permission, and the permission alone opens no section', async () => {
      const withoutRight = await employee(['bookings.view']);
      await send(withoutRight.session, { section: SECTION }).expect(403);
      await request(http()).get(`${API}/notifications/staff-sections`).set(withoutRight.session.auth).expect(403);

      const onlyRight = await employee(['notifications.send']);
      const sections = await request(http()).get(`${API}/notifications/staff-sections`).set(onlyRight.session.auth).expect(200);
      expect(sections.body).toEqual([]);

      const passenger = await loginPassenger(app);
      await send(passenger, { section: SECTION }).expect(403);
    });

    it('lists only the sender sections, without phone numbers', async () => {
      const sender = await employee(['hotels.view', 'notifications.send']);
      const peer = await employee(['hotels.book']);
      const sections = await request(http()).get(`${API}/notifications/staff-sections`).set(sender.session.auth).expect(200);
      expect(sections.body.map((section: any) => section.title)).toEqual(['الفنادق والسكن']);
      const member = sections.body[0].members.find((row: any) => row.id === peer.user.id);
      expect(member).toEqual({ id: peer.user.id, name: peer.user.name, rank: expect.any(String) });
    });

    it('rejects empty text and an empty choice of employees', async () => {
      const sender = await employee(['bookings.view', 'notifications.send']);
      await send(sender.session, { section: SECTION, body: '   ' }).expect(400);
      await send(sender.session, { section: SECTION, userIds: [] }).expect(400);
    });
  });

  describe('inbox', () => {
    // Paid bookings also bring a points notice; with the programme off, each booking brings exactly one notification here.
    beforeAll(() => prisma.setting.upsert({ where: { key: 'loyaltyProgram' }, create: { key: 'loyaltyProgram', value: JSON.stringify({ enabled: false }) }, update: { value: JSON.stringify({ enabled: false }) } }));
    afterAll(() => prisma.setting.deleteMany({ where: { key: 'loyaltyProgram' } }));

    it('counts unread, marks read, and pages with before', async () => {
      const passenger = await loginPassenger(app);
      const first = await book(await createTrip(), passenger);
      await book(await createTrip(), passenger);

      const summary = await request(http()).get(`${API}/notifications/mine/summary`).set(passenger.auth).expect(200);
      expect(summary.body.unreadCount).toBe(2);
      expect(summary.body.latestUnread.bookingId).not.toBe(first.id);

      const page = await request(http()).get(`${API}/notifications/mine?limit=1`).set(passenger.auth).expect(200);
      expect(page.body).toMatchObject({ hasMore: true, unreadCount: 2 });
      const older = await request(http()).get(`${API}/notifications/mine?limit=1&before=${encodeURIComponent(page.body.items[0].createdAt)}`).set(passenger.auth).expect(200);
      expect(older.body.items[0].bookingId).toBe(first.id);
      expect(older.body.hasMore).toBe(false);

      const read = await request(http()).post(`${API}/notifications/mine/${older.body.items[0].id}/read`).set(passenger.auth).expect(201);
      expect(read.body.unreadCount).toBe(1);
      await request(http()).post(`${API}/notifications/mine/read-all`).set(passenger.auth).expect(201);
      expect((await inbox(passenger)).unreadCount).toBe(0);
    });

    it("cannot read or mark another user's notification", async () => {
      const owner = await loginPassenger(app);
      await book(await createTrip(), owner);
      const [item] = (await inbox(owner)).items;

      const stranger = await loginPassenger(app);
      expect((await inbox(stranger)).items).toHaveLength(0);
      await request(http()).post(`${API}/notifications/mine/${item.id}/read`).set(stranger.auth).expect(404);
      expect((await inbox(owner)).unreadCount).toBe(1);
    });

    it('keeps read marks out of the audit log', async () => {
      await request(http()).post(`${API}/notifications/mine/read-all`).set(admin.auth).expect(201);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await prisma.auditLog.count({ where: { action: { contains: 'notifications/mine' } } })).toBe(0);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { diffAuditSnapshots, resolveAuditTarget } from '../src/common/audit-snapshots';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

/** The audit log keeps each important write's values before and after it, and the panel reads them in words. */
describe('Audit log before and after values (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;
  const http = () => app.getHttpServer();

  // The log is written after the response, so each check waits for it.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  const log = async (query: Record<string, string> = {}) =>
    (await request(http()).get(`${API}/dashboard/audit-log`).query(query).set(admin.auth).expect(200)).body as any[];

  const fieldOf = (row: any, field: string) => row.changes?.fields.find((change: any) => change.field === field);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('which record a route is about', () => {
    it('resolves updates by route and leaves creations alone', () => {
      expect(resolveAuditTarget('PUT', `${API}/trips/:id`, { id: 't1' })).toEqual({ type: 'trip', id: 't1' });
      expect(resolveAuditTarget('PATCH', `${API}/bookings/admin/:id/passengers/:passengerId`, { id: 'b1', passengerId: 'p1' })).toEqual({ type: 'booking', id: 'b1' });
      expect(resolveAuditTarget('PUT', `${API}/branches/:id/employees/:userId/access`, { id: 'br', userId: 'u1' })).toEqual({ type: 'user', id: 'u1' });
      expect(resolveAuditTarget('POST', `${API}/collections/bookings/:id`, { id: 'b2' })).toEqual({ type: 'booking', id: 'b2' });
      expect(resolveAuditTarget('PUT', `${API}/settings`, {})).toEqual({ type: 'settings', id: 'settings' });
      expect(resolveAuditTarget('POST', `${API}/trips`, {})).toBeNull();
      expect(resolveAuditTarget('POST', `${API}/coupons`, {})).toBeNull();
      expect(resolveAuditTarget('PUT', `${API}/settings/integrations`, {})).toBeNull();
    });

    it('keeps only what differs, and marks a deletion', () => {
      const before = { label: 'x', values: { a: 1, b: 'same', perms: ['x', 'y'] } };
      expect(diffAuditSnapshots(before, { label: 'x', values: { a: 2, b: 'same', perms: ['y', 'x'] } })).toEqual({ label: 'x', fields: [{ field: 'a', before: 1, after: 2 }] });
      expect(diffAuditSnapshots(before, before)).toBeNull();
      expect(diffAuditSnapshots(before, null)).toMatchObject({ deleted: true });
    });
  });

  it('records a rank permission change before and after, in words', async () => {
    const rank = await prisma.rank.create({ data: { name: `audit rank ${Date.now()}`, role: 'STAFF', jobId: 'job-office', permissions: ['trips.view'] } });
    await request(http()).put(`${API}/ranks/${rank.id}`).set(admin.auth).send({ permissions: ['trips.view', 'bookings.view'] }).expect(200);
    await settle();

    const [row] = await log({ record: rank.id });
    expect(row.recordType).toBe('rank');
    const change = fieldOf(row, 'permissions');
    expect(change.label).toBe('الصلاحيات');
    expect(change.before).toEqual(['عرض الرحلات']);
    expect(change.after).toEqual(expect.arrayContaining(['عرض الرحلات', 'البحث عن حجوزات فرعه وفتحها']));
  });

  it('records a trip price change, found by its trip code', async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ price: 150 })).expect(201)).body;
    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ price: 175 }).expect(200);
    await settle();

    const rows = await log({ record: trip.tripCode, recordType: 'trip' });
    const price = fieldOf(rows[0], 'price');
    expect(price.label).toBe('سعر المقعد');
    expect(Number(price.before)).toBe(150);
    expect(Number(price.after)).toBe(175);
    expect(rows[0].target).toContain(trip.tripCode);
  });

  it('records a passenger edit on the booking, found by its booking number', async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const customer = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['5'] }], passengers: [{ fullName: 'اسم قديم' }] })
        .expect(201)
    ).body.bookings[0];
    await request(http())
      .patch(`${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}`)
      .set(admin.auth)
      .send({ fullName: 'اسم جديد', reason: 'تصحيح', expectedUpdatedAt: booking.updatedAt })
      .expect(200);
    await settle();

    const [row] = await log({ record: booking.bookingReference });
    const name = fieldOf(row, 'passengers.1.fullName');
    expect(name).toMatchObject({ label: 'الراكب 1: الاسم', before: 'اسم قديم', after: 'اسم جديد' });
  });

  it('records an employee access change without exposing secrets', async () => {
    const employee = await createStaff(prisma, 'STAFF', nextPhone());
    await request(http()).put(`${API}/users/${employee.id}/access`).set(admin.auth).send({ rankId: 'rank-accountant', extraPermissions: [], revokedPermissions: [] }).expect((res) => expect([200, 201]).toContain(res.status));
    await settle();

    const stored = await prisma.auditLog.findFirst({ where: { recordId: employee.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(stored?.changes ?? {})).not.toMatch(/passwordHash|\$2[aby]\$/);
    const [row] = await log({ record: employee.phone });
    expect(fieldOf(row, 'rankName')).toMatchObject({ label: 'الرتبة', after: 'محاسب' });
  });

  it('records settings by their Arabic names and a deleted coupon', async () => {
    await request(http()).put(`${API}/settings`).set(admin.auth).send({ vatRate: 7 }).expect(200);
    const coupon = (await request(http()).post(`${API}/coupons`).set(admin.auth).send({ code: `AUD${Date.now() % 100000}`, type: 'PERCENT', value: 10 }).expect(201)).body;
    await request(http()).delete(`${API}/coupons/${coupon.id}`).set(admin.auth).expect((res) => expect([200, 204]).toContain(res.status));
    await settle();

    const [settings] = await log({ recordType: 'settings' });
    expect(fieldOf(settings, 'vatRate')).toMatchObject({ label: 'نسبة الضريبة', after: '7' });

    const [removed] = await log({ record: coupon.id });
    expect(removed.changes.deleted).toBe(true);
    expect(fieldOf(removed, 'code')).toMatchObject({ before: coupon.code, after: null });
  });

  it('still shows rows written before values were compared', async () => {
    await prisma.auditLog.create({ data: { userId: (await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id, action: `PUT ${API}/coupons/:id`, entity: 'Coupons', details: { value: 5 } } });
    const rows = await log();
    expect(rows.some((row) => row.event === 'تعديل كوبون' && row.changes === null)).toBe(true);
    await request(http()).get(`${API}/dashboard/audit-log`).query({ recordType: 'nonsense' }).set(admin.auth).expect(400);
    const types = (await request(http()).get(`${API}/dashboard/audit-log/record-types`).set(admin.auth).expect(200)).body;
    expect(types).toEqual(expect.arrayContaining([{ key: 'booking', label: 'الحجوزات' }]));
  });
});

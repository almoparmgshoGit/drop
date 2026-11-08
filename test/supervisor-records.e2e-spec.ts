import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Supervisor records: assignment history and custody (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let supervisorId: string;
  let tripId: string;
  let branchId: string;
  const http = () => request(app.getHttpServer());
  const key = () => `${Date.now()}-${Math.random()}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    await prisma.user.update({ where: { id: adminUser.id }, data: { name: 'مدير التشغيل' } });
    admin = await loginStaff(app, adminUser.phone);
    supervisorId = (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).id;
    tripId = (await http().post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body.id;
    branchId = (await http().post(`${API}/cash/branches`).set(admin.auth).send({ name: 'فرع السجل' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('records who assigned and who removed the supervisor, and why', async () => {
    await http().post(`${API}/supervisors/${supervisorId}/trips/${tripId}`).set(admin.auth).expect(201);
    await http().delete(`${API}/supervisors/${supervisorId}/trips/${tripId}`).set(admin.auth).expect(200);
    const { body } = await http().get(`${API}/supervisors/${supervisorId}/history`).set(admin.auth).expect(200);
    expect(body.log.map((row) => row.action)).toEqual(['UNASSIGNED', 'ASSIGNED']);
    expect(body.log[0]).toMatchObject({ byName: 'مدير التشغيل', reason: 'من صفحة المشرفين', trip: { id: tripId } });
    expect(body.summary.removed).toBe(1);
  });

  it('records crew changes made from the trip form too', async () => {
    await http().put(`${API}/trips/${tripId}`).set(admin.auth).send({ supervisorIds: [supervisorId] }).expect(200);
    const log = await prisma.crewAssignmentLog.findMany({ where: { tripId, userId: supervisorId }, orderBy: { createdAt: 'desc' } });
    expect(log[0]).toMatchObject({ action: 'ASSIGNED', role: 'SUPERVISOR', byName: 'مدير التشغيل', reason: null });
  });

  it('issues a custody to the supervisor and settles it from the supervisors page', async () => {
    await http().post(`${API}/cash/branches/${branchId}/sessions`).set(admin.auth).send({ openingBalance: 2000 }).expect(201);
    const custody = (await http().post(`${API}/cash/branches/${branchId}/custodies`).set(admin.auth).send({ recipientId: supervisorId, amount: 500, purpose: 'مصاريف رحلة', tripId, idempotencyKey: key() }).expect(201)).body;

    let list = (await http().get(`${API}/supervisors/${supervisorId}/custodies`).set(admin.auth).expect(200)).body;
    expect(list.summary).toMatchObject({ openCount: 1, inHand: 500 });
    expect(list.items[0]).toMatchObject({ id: custody.id, status: 'OPEN', branch: { id: branchId } });

    await http().post(`${API}/cash/custodies/${custody.id}/settle`).set(admin.auth).field('spentAmount', '350').attach('invoices', Buffer.from('%PDF-1.4 test'), 'invoice.pdf').expect(201);
    list = (await http().get(`${API}/supervisors/${supervisorId}/custodies`).set(admin.auth).expect(200)).body;
    expect(list.summary).toMatchObject({ openCount: 0, inHand: 0, totalSpent: 350 });
    expect(list.items[0]).toMatchObject({ status: 'SETTLED', returnedAmount: '150' });
  });

  it('keeps the custody log from staff without cash access', async () => {
    const viewer = await createStaff(prisma, 'STAFF');
    await prisma.user.update({ where: { id: viewer.id }, data: { rankId: null, extraPermissions: ['employees.view'] } });
    const session = await loginStaff(app, viewer.phone);
    await http().get(`${API}/supervisors/${supervisorId}/history`).set(session.auth).expect(200);
    await http().get(`${API}/supervisors/${supervisorId}/custodies`).set(session.auth).expect(403);
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Staff achievements (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  let reference = 0;
  const order = (data: { userId: string; tripId: string; createdById: string; groupReference?: string; kind?: any; status?: any; totalPrice: number; cancelReviewedById?: string }) =>
    prisma.booking.create({
      data: {
        bookingReference: `ACH-${++reference}`,
        source: 'BRANCH',
        ...data,
        ...(data.cancelReviewedById && { cancelReviewedAt: new Date() }),
      },
    });

  it("counts each employee's orders, packages, cancellations and solved problems, and lists what they did", async () => {
    const clerk = await createStaff(prisma, 'ADMIN');
    const other = await createStaff(prisma, 'ADMIN');
    const customer = await loginPassenger(app);
    const { body: me } = await request(http()).get(`${API}/users/profile`).set(customer.auth).expect(200);
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;

    // A round trip is one order across its two legs; a package is an order too.
    await order({ userId: me.id, tripId: trip.id, createdById: clerk.id, groupReference: 'G1', kind: 'TRANSPORT_ROUND', totalPrice: 100 });
    await order({ userId: me.id, tripId: trip.id, createdById: clerk.id, groupReference: 'G1', kind: 'TRANSPORT_ROUND', totalPrice: 100 });
    await order({ userId: me.id, tripId: trip.id, createdById: clerk.id, groupReference: 'G2', kind: 'PACKAGE_ROUND_STAY', totalPrice: 500 });
    await order({ userId: me.id, tripId: trip.id, createdById: clerk.id, kind: 'TRANSPORT_OUTBOUND', status: 'CANCELLED', totalPrice: 80, cancelReviewedById: other.id });

    const { body: complaint } = await request(http()).post(`${API}/complaints`).set(customer.auth).send({ category: 'APP', details: 'التطبيق يتوقف عند الدفع' }).expect(201);
    const otherSession = await loginStaff(app, other.phone);
    await request(http()).post(`${API}/complaints/${complaint.id}/resolve`).set(otherSession.auth).send({ resolution: 'أصلحنا المشكلة' }).expect(201);

    const { body: board } = await request(http()).get(`${API}/users/employees/achievements`).set(admin.auth).expect(200);
    const clerkRow = board.items.find((row: any) => row.id === clerk.id);
    expect(clerkRow).toMatchObject({ ordersRegistered: 3, ordersCancelled: 1, packagesBooked: 1, ordersValue: 700, cancellationsDone: 0 });
    const otherRow = board.items.find((row: any) => row.id === other.id);
    expect(otherRow).toMatchObject({ cancellationsDone: 1, customerComplaintsResolved: 1, problemsSolved: 1 });
    expect(board.items[0].id).toBe(clerk.id);
    expect(board.items.some((row: any) => row.id === me.id)).toBe(false);

    // The audit row is written after the response, so give it a moment.
    for (let tries = 0; tries < 20 && !(await prisma.auditLog.count({ where: { userId: other.id, action: { contains: 'resolve' } } })); tries++) await new Promise((r) => setTimeout(r, 50));
    const { body: detail } = await request(http()).get(`${API}/users/employees/${other.id}/achievements`).set(admin.auth).expect(200);
    expect(detail.figures.problemsSolved).toBe(1);
    expect(detail.log.items.map((item: any) => item.event)).toContain('الرد على شكوى عميل وإغلاقها');
    // Signing in is not an achievement.
    expect(detail.log.items.map((item: any) => item.section)).not.toContain('الدخول والحساب');

    // A period without them counts nothing, and reopening a complaint takes the credit back.
    const { body: past } = await request(http()).get(`${API}/users/employees/achievements`).set(admin.auth).query({ from: '2020-01-01', to: '2020-01-31' }).expect(200);
    expect(past.items.find((row: any) => row.id === clerk.id).ordersRegistered).toBe(0);
    await request(http()).post(`${API}/complaints/${complaint.id}/reopen`).set(admin.auth).expect(201);
    const { body: afterReopen } = await request(http()).get(`${API}/users/employees/${other.id}/achievements`).set(admin.auth).expect(200);
    expect(afterReopen.figures.customerComplaintsResolved).toBe(0);
  });

  it('refuses a bad period, a customer and an employee without the permission', async () => {
    await request(http()).get(`${API}/users/employees/achievements`).set(admin.auth).query({ from: '2026-13-01' }).expect(400);
    await request(http()).get(`${API}/users/employees/achievements`).set(admin.auth).query({ from: '2026-02-01', to: '2026-01-01' }).expect(400);
    const customer = await loginPassenger(app);
    const { body: me } = await request(http()).get(`${API}/users/profile`).set(customer.auth).expect(200);
    await request(http()).get(`${API}/users/employees/${me.id}/achievements`).set(admin.auth).expect(404);
    await request(http()).get(`${API}/users/employees/achievements`).set(customer.auth).expect(403);
  });
});

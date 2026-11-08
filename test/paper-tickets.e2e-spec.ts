import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Printed branch tickets and branch performance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let supervisor: { auth: Record<string, string> };
  let branchId: string;
  let trip: { id: string };
  let seat = 0;
  const http = () => request(app.getHttpServer());

  /** A ticket for several travellers, as the counter form sends it. */
  const counterBooking = async (travellers: number, names: string[] = []) => {
    const seats = Array.from({ length: travellers }, () => String(++seat));
    const res = await http()
      .post(`${API}/branch-bookings`)
      .set(admin.auth)
      .send({
        branchId,
        kind: 'TRANSPORT_OUTBOUND',
        legs: [{ leg: 'OUTBOUND', tripId: trip.id, seats }],
        customer: { name: 'صاحب الحجز', phone: nextPhone().replace('+966', '0') },
        passengers: seats.map((_, index) => ({ fullName: names[index] ?? `مسافر ${index + 1}` })),
        payments: [],
        idempotencyKey: `paper-${seat}-${Math.random()}`,
      })
      .expect(201);
    return res.body.legs[0] as { id: string; reference: string };
  };

  const printable = async (bookingId: string) => (await http().get(`${API}/invoices/bookings/${bookingId}`).set(admin.auth).expect(200)).body;
  const scan = (code: string, session = supervisor, extra: Record<string, unknown> = {}) =>
    http().post(`${API}/tickets/verify-paper`).set(session.auth).send({ code, tripId: trip.id, ...extra });


  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    branchId = (await http().post(`${API}/branches`).set(admin.auth).send({ name: 'فرع الاختبار' }).expect(201)).body.id;
    trip = (await http().post(`${API}/trips`).set(admin.auth).send(tripPayload({ price: 100 })).expect(201)).body;
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    supervisor = await loginStaff(app, staff.phone);
    await openBoarding(prisma, trip.id);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('counts every traveller on one ticket, in the price and on the invoice', async () => {
    const booking = await counterBooking(3);
    const invoice = await printable(booking.id);
    expect(invoice.passengerCount).toBe(3);
    expect(invoice.seats).toHaveLength(3);
    expect(invoice.total).toBe(300);
    expect(invoice.boardingCode).toMatch(new RegExp(`^${booking.reference}\\.`));
  });

  it('boards everyone on the ticket with one scan, and refuses a second', async () => {
    const booking = await counterBooking(2);
    const { boardingCode } = await printable(booking.id);

    const first = await scan(boardingCode, supervisor, { allowOtherPoint: true }).expect(201);
    expect(first.body).toMatchObject({ result: 'BOARDED', boardedCount: 2 });
    expect(await prisma.ticket.count({ where: { bookingId: booking.id, isBoarded: true } })).toBe(2);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('BOARDED');

    const again = await scan(boardingCode, supervisor, { allowOtherPoint: true }).expect(201);
    expect(again.body.result).toBe('ALREADY_USED');
  });

  it('refuses a printed reference with no signature, or a forged one', async () => {
    const booking = await counterBooking(1);
    expect((await scan(booking.reference).expect(201)).body.result).toBe('INVALID');
    expect((await scan(`${booking.reference}.AAAAAAAAAA`).expect(201)).body.result).toBe('INVALID');
    // A valid code cannot be moved onto another booking.
    const other = await counterBooking(1);
    const { boardingCode } = await printable(other.id);
    expect((await scan(`${booking.reference}.${boardingCode.split('.')[1]}`).expect(201)).body.result).toBe('INVALID');
    expect(await prisma.ticket.count({ where: { bookingId: booking.id, isBoarded: true } })).toBe(0);
  });

  it('gives an app booking no boarding code, so a printed copy boards nobody', async () => {
    const passenger = await loginPassenger(app);
    const created = await http()
      .post(`${API}/bookings`)
      .set(passenger.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: [String(++seat)] }], passengers: [{ fullName: 'مسافر التطبيق' }] })
      .expect(201);
    const booking = created.body.bookings[0];
    expect((await printable(booking.id)).boardingCode).toBeNull();
    const { signPaperCode } = await import('../src/common/utils/ticket-token.util');
    const forged = signPaperCode(booking.bookingReference, process.env.TICKET_SIGNING_SECRET as string);
    expect((await scan(forged).expect(201)).body.result).toBe('INVALID');
  });

  it('keeps the scan to the crew of the trip', async () => {
    const booking = await counterBooking(1);
    const { boardingCode } = await printable(booking.id);
    const stranger = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    const session = await loginStaff(app, stranger.phone);
    await scan(boardingCode, session).expect(403);
    const customer = await loginPassenger(app);
    await scan(boardingCode, customer).expect(403);
  });

  it('finds a booking in the quick search from the scanned code', async () => {
    const booking = await counterBooking(1);
    const { boardingCode } = await printable(booking.id);
    const res = await http().get(`${API}/bookings/admin/search?q=${encodeURIComponent(boardingCode)}`).set(admin.auth).expect(200);
    expect(JSON.stringify(res.body)).toContain(booking.reference);
  });

  describe('branch performance', () => {
    it('adds up sales and travellers by employee and route', async () => {
      const res = await http().get(`${API}/branches/${branchId}/performance?days=7`).set(admin.auth).expect(200);
      expect(res.body.series).toHaveLength(7);
      expect(res.body.bookings).toBeGreaterThan(0);
      expect(res.body.passengers).toBeGreaterThanOrEqual(res.body.bookings);
      expect(res.body.sales).toBe(res.body.series.reduce((sum: number, day: { value: number }) => sum + day.value, 0));
      expect(res.body.employees[0].bookings).toBeGreaterThan(0);
      expect(res.body.routes[0].label).toContain('←');
    });

    it('stays inside the branch for someone who only sees their own', async () => {
      const other = await createStaff(prisma, 'STAFF', undefined, 'rank-branch-clerk');
      const session = await loginStaff(app, other.phone);
      const res = await http().get(`${API}/branches/${branchId}/performance`).set(session.auth);
      expect([403]).toContain(res.status);
    });
  });
});

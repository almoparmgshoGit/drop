import { INestApplication } from '@nestjs/common';
import * as crypto from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Boarding without internet: the offline pack and the sync of queued scans', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;

  const http = () => app.getHttpServer();
  const hashOf = (text: string, length: number) => crypto.createHash('sha256').update(text).digest('hex').slice(0, length);

  const setup = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const customer = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '2'] }], passengers: [{ fullName: 'راكب أول' }, { fullName: 'راكب ثان' }] })
        .expect(201)
    ).body.bookings[0];
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    return { trip, booking, crew: await loginStaff(app, staff.phone) };
  };

  const pack = (crew: any, tripId: string) => request(http()).get(`${API}/tickets/trips/${tripId}/offline-pack`).set(crew.auth);
  const sync = (crew: any, tripId: string, items: object[]) => request(http()).post(`${API}/tickets/trips/${tripId}/offline-boardings`).set(crew.auth).send({ items });
  const tokenOf = (booking: any, index = 0) => booking.passengers[index].ticket.signedToken as string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.offlineBoardingSync.deleteMany();
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.offlineBoardingSync.deleteMany();
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  describe('offline pack', () => {
    it('lists the passengers with a hash of each QR code, never the code itself', async () => {
      const { trip, booking, crew } = await setup();
      const res = await pack(crew, trip.id).expect(200);

      expect(res.body.trip).toMatchObject({ id: trip.id, access: { isBoardingOpen: true } });
      expect(res.body.passengers).toHaveLength(2);
      const length = res.body.hash.length;
      const first = res.body.passengers.find((p: any) => p.seatNumber === '1');
      expect(first).toMatchObject({ fullName: 'راكب أول', bookingReference: booking.bookingReference, isBoarded: false });
      expect(first.tokenHash).toBe(hashOf(tokenOf(booking), length));
      expect(JSON.stringify(res.body)).not.toContain(tokenOf(booking));
      expect(JSON.stringify(res.body)).not.toContain('signedToken');
    });

    it('is refused to staff who are not on the trip', async () => {
      const { trip } = await setup();
      const stranger = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await pack(stranger, trip.id).expect(403);
      await sync(stranger, trip.id, [{ clientId: 'x-1', signedToken: 'DRB1.a.b', scannedAt: new Date().toISOString() }]).expect(403);
    });
  });

  describe('sync', () => {
    it('boards a queued scan at the time it was scanned and marks it as recorded without internet', async () => {
      const { trip, booking, crew } = await setup();
      const scannedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const res = await sync(crew, trip.id, [{ clientId: 'scan-1', signedToken: tokenOf(booking), scannedAt }]).expect(201);

      expect(res.body.results[0]).toMatchObject({ clientId: 'scan-1', status: 'ACCEPTED', result: 'BOARDED' });
      const ticket = await prisma.ticket.findFirstOrThrow({ where: { bookingId: booking.id, passenger: { seatNumber: '1' } } });
      expect(ticket).toMatchObject({ isBoarded: true, boardedOffline: true });
      expect(ticket.boardedAt!.toISOString()).toBe(scannedAt);
    });

    it('answers the same way when the same scan is sent again, without boarding twice', async () => {
      const { trip, booking, crew } = await setup();
      const item = { clientId: 'scan-again', signedToken: tokenOf(booking), scannedAt: new Date().toISOString() };
      await sync(crew, trip.id, [item]).expect(201);
      const again = await sync(crew, trip.id, [item]).expect(201);

      expect(again.body.results[0]).toMatchObject({ status: 'ACCEPTED', repeated: true });
      expect(await prisma.bookingEvent.count({ where: { bookingId: booking.id, action: 'BOARDED' } })).toBe(1);
    });

    it('reports a passenger boarded meanwhile as already boarded', async () => {
      const { trip, booking, crew } = await setup();
      await request(http()).post(`${API}/tickets/verify`).set(crew.auth).send({ signedToken: tokenOf(booking), tripId: trip.id, allowOtherPoint: true }).expect(201);
      const res = await sync(crew, trip.id, [{ clientId: 'late-1', signedToken: tokenOf(booking), scannedAt: new Date().toISOString() }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ status: 'ALREADY_BOARDED', result: 'ALREADY_USED' });
    });

    it('rejects a forged code, a wrong trip and a scan outside boarding time, each with its reason', async () => {
      const { trip, booking, crew } = await setup();
      const other = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      await prisma.tripSupervisor.create({ data: { tripId: other.id, userId: (await prisma.tripSupervisor.findFirstOrThrow({ where: { tripId: trip.id } })).userId } });
      await openBoarding(prisma, other.id);

      const forged = await sync(crew, trip.id, [{ clientId: 'forged', signedToken: `${tokenOf(booking)}x`, scannedAt: new Date().toISOString() }]).expect(201);
      expect(forged.body.results[0]).toMatchObject({ status: 'REJECTED', result: 'INVALID' });
      expect(forged.body.results[0].reason).toEqual(expect.any(String));

      const wrongTrip = await sync(crew, other.id, [{ clientId: 'wrong-trip', signedToken: tokenOf(booking), scannedAt: new Date().toISOString() }]).expect(201);
      expect(wrongTrip.body.results[0]).toMatchObject({ status: 'REJECTED', result: 'WRONG_TRIP' });

      // Boarding opens 24 hours before departure, so a scan 30 hours ago was before it.
      const early = await sync(crew, trip.id, [{ clientId: 'early', signedToken: tokenOf(booking, 1), scannedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() }]).expect(201);
      expect(early.body.results[0]).toMatchObject({ status: 'REJECTED', result: 'OUTSIDE_WINDOW' });
      expect(await prisma.ticket.count({ where: { bookingId: booking.id, isBoarded: true } })).toBe(0);
    });

    it('boards a passenger picked from the saved list by ticket number', async () => {
      const { trip, booking, crew } = await setup();
      const ticketNumber = booking.passengers[1].ticket.ticketNumber;
      const res = await sync(crew, trip.id, [{ clientId: 'manual-1', ticketNumber, scannedAt: new Date().toISOString() }]).expect(201);
      expect(res.body).toMatchObject({ accepted: 1, rejected: 0 });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketNumber } })).boardedOffline).toBe(true);
    });

    it('validates the queued items', async () => {
      const { trip, crew } = await setup();
      await sync(crew, trip.id, [{ clientId: 'no-time', signedToken: 'DRB1.a.b' }]).expect(400);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripExecutionService } from '../src/modules/trips/trip-execution.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const HOUR_MS = 3_600_000;

describe('Post-trip states: executed trips, no-shows and financial closing', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let execution: TripExecutionService;
  let admin: any;

  const http = () => app.getHttpServer();

  /** A published trip with one paid booking of two passengers. */
  const setup = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const point = await prisma.boardingPoint.findFirstOrThrow({ where: { tripId: trip.id } });
    const customer = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '2'], boardingPointId: point.id }], passengers: [{ fullName: 'راكب أول' }, { fullName: 'راكب ثان' }] })
        .expect(201)
    ).body.bookings[0];
    return { trip, point, customer, booking };
  };

  /** Moves the trip into the past: it left this many minutes ago. */
  const departedMinutesAgo = (tripId: string, minutes: number, boardingClosesAfterMinutes = 60) =>
    prisma.trip.update({
      where: { id: tripId },
      data: { departureTime: new Date(Date.now() - minutes * 60_000), arrivalTime: new Date(Date.now() + 5 * HOUR_MS), boardingClosesAfterMinutes },
    });

  const ticketsOf = (bookingId: string) => prisma.ticket.findMany({ where: { bookingId }, orderBy: { ticketNumber: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    execution = app.get(TripExecutionService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  it('an hour after departure, executes the trip and marks only the confirmed passengers who did not board as no-shows', async () => {
    const { trip, booking } = await setup();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    const [first] = await ticketsOf(booking.id);
    await prisma.ticket.update({ where: { id: first.id }, data: { isBoarded: true, boardedAt: new Date() } });

    // A cancelled booking on the same trip is never touched.
    const point = await prisma.boardingPoint.findFirstOrThrow({ where: { tripId: trip.id } });
    const otherCustomer = await loginPassenger(app);
    const other = (
      await request(http())
        .post(`${API}/bookings`)
        .set(otherCustomer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['3'], boardingPointId: point.id }], passengers: [{ fullName: 'راكب ملغى' }] })
        .expect(201)
    ).body.bookings[0];
    await prisma.booking.update({ where: { id: other.id }, data: { status: 'CANCELLED' } });

    await departedMinutesAgo(trip.id, 61);
    const executed = await execution.sweep();
    expect(executed).toContain(trip.id);

    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(after.executedAt).not.toBeNull();
    // Still published, so the crew can keep reporting the bus on the road; arrival completes it.
    expect(after.tripStatus).toBe('PUBLISHED');

    const [boarded, missing] = await ticketsOf(booking.id);
    expect(boarded.noShowAt).toBeNull();
    expect(missing.noShowAt).not.toBeNull();
    expect(missing.isBoarded).toBe(false);
    // The booking itself stays as it was: a no-show is still sold and paid.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
    for (const ticket of await ticketsOf(other.id)) expect(ticket.noShowAt).toBeNull();

    // Idempotent: a second run changes nothing.
    expect(await execution.sweep()).toEqual([]);
    const [, again] = await ticketsOf(booking.id);
    expect(again.noShowAt?.getTime()).toBe(missing.noShowAt?.getTime());
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).executedAt?.getTime()).toBe(after.executedAt?.getTime());

    // The panel shows them as no-shows.
    const manifest = (await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200)).body;
    expect(manifest.trip.executedAt).toBeTruthy();
    expect(manifest.summary.noShow).toBe(1);
    const left = await prisma.bookingPassenger.findUniqueOrThrow({ where: { id: missing.passengerId } });
    expect(manifest.passengers.filter((p: any) => p.isNoShow).map((p: any) => p.fullName)).toEqual([left.fullName]);

    const noShows = (await request(http()).get(`${API}/bookings/admin/all?boarding=NO_SHOW`).set(admin.auth).expect(200)).body;
    expect(noShows.items.map((b: any) => b.id)).toEqual([booking.id]);
    const waiting = (await request(http()).get(`${API}/bookings/admin/all?boarding=WAITING`).set(admin.auth).expect(200)).body;
    expect(waiting.items.map((b: any) => b.id)).not.toContain(booking.id);
  });

  it('waits for the hour after departure, and for a boarding window that closes later', async () => {
    const { trip, booking } = await setup();
    await departedMinutesAgo(trip.id, 30);
    expect(await execution.sweep()).toEqual([]);

    // Boarding stays open two hours after departure, so ninety minutes in it is not executed yet.
    await departedMinutesAgo(trip.id, 90, 120);
    expect(await execution.sweep()).toEqual([]);
    for (const ticket of await ticketsOf(booking.id)) expect(ticket.noShowAt).toBeNull();

    await departedMinutesAgo(trip.id, 121, 120);
    expect(await execution.sweep()).toEqual([trip.id]);
    for (const ticket of await ticketsOf(booking.id)) expect(ticket.noShowAt).not.toBeNull();
  });

  it('leaves unpaid, cancellation-pending and draft or cancelled trips alone', async () => {
    const { trip, booking } = await setup();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_CANCELLATION_REVIEW' } });
    const cancelledTrip = await setup();
    await prisma.trip.update({ where: { id: cancelledTrip.trip.id }, data: { tripStatus: 'CANCELLED' } });
    await departedMinutesAgo(trip.id, 120);
    await departedMinutesAgo(cancelledTrip.trip.id, 120);

    expect(await execution.sweep()).toEqual([trip.id]);
    for (const ticket of await ticketsOf(booking.id)) expect(ticket.noShowAt).toBeNull();
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: cancelledTrip.trip.id } })).executedAt).toBeNull();
  });

  it('puts the executed trip up for financial closing on the trip accounts page', async () => {
    const { trip } = await setup();
    const awaiting = () => request(http()).get(`${API}/trip-accounts?view=trip&closing=AWAITING_CLOSE`).set(admin.auth).expect(200);

    expect((await awaiting()).body.items).toEqual([]);
    await request(http()).post(`${API}/trip-accounts/${trip.id}/close`).set(admin.auth).expect(409);

    await departedMinutesAgo(trip.id, 61);
    await execution.sweep();

    const listed = (await awaiting()).body;
    expect(listed.items.map((row: any) => row.id)).toEqual([trip.id]);
    expect(listed.items[0].closing).toBe('AWAITING_CLOSE');
    expect(listed.summary.awaitingClose).toBe(1);

    await request(http()).post(`${API}/trip-accounts/${trip.id}/close`).set(admin.auth).expect(201);
    expect((await awaiting()).body.items).toEqual([]);
    const detail = (await request(http()).get(`${API}/trip-accounts/${trip.id}`).set(admin.auth).expect(200)).body;
    expect(detail.closing.state).toBe('CLOSED');
    await request(http()).post(`${API}/trip-accounts/${trip.id}/close`).set(admin.auth).expect(409);

    await request(http()).post(`${API}/trip-accounts/${trip.id}/reopen`).set(admin.auth).expect(201);
    expect((await awaiting()).body.items.map((row: any) => row.id)).toEqual([trip.id]);
  });

  it('boarding a no-show afterwards clears the mark', async () => {
    const { trip, booking } = await setup();
    await departedMinutesAgo(trip.id, 61);
    await execution.sweep();
    const passenger = booking.passengers[0];
    expect((await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } })).noShowAt).not.toBeNull();
    const fresh = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    await request(http())
      .post(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}/board`)
      .set(admin.auth)
      .send({ reason: 'صعد متأخرًا وسُجّل يدويًا', expectedUpdatedAt: fresh.updatedAt.toISOString() })
      .expect(201);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } });
    expect(ticket.isBoarded).toBe(true);
    expect(ticket.noShowAt).toBeNull();

    // Undoing it puts the mark back, since the trip is still executed.
    const boardedBooking = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    await request(http())
      .post(`${API}/bookings/admin/${booking.id}/passengers/${passenger.id}/unboard`)
      .set(admin.auth)
      .send({ reason: 'سُجّل بالخطأ', expectedUpdatedAt: boardedBooking.updatedAt.toISOString() })
      .expect(201);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { passengerId: passenger.id } })).noShowAt).not.toBeNull();
  });
});

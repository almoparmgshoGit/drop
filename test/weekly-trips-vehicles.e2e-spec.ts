import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { BUS_SEAT_LAYOUT, generateSeatLayout, seatNumbersOf } from '../src/common/utils/bus-layout.util';
import { nextWeeklyDate, riyadhWeekday } from '../src/common/utils/recurrence.util';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY = 86_400_000;

describe('Seat plans drawn from a count', () => {
  it('seats two by two across the aisle, with five left over as a back bench', () => {
    expect(seatNumbersOf(generateSeatLayout(13))).toHaveLength(13);
    expect(generateSeatLayout(13).at(-1)).toEqual(['9', '10', '11', '12', '13']);
    expect(generateSeatLayout(12).every((row) => row[2] === null)).toBe(true);
    expect(generateSeatLayout(14).at(-1)).toEqual(['13', '14', null, null, null]);
  });
});

describe('Weekly dates', () => {
  // 2026-11-16 is a Monday; 03:30 UTC is 06:30 in Riyadh.
  const monday = new Date('2026-11-16T03:30:00Z');

  it('lands on the chosen weekdays at the same Riyadh time', () => {
    const next = nextWeeklyDate(monday, [1, 4], monday)!;
    expect(next.toISOString()).toBe('2026-11-19T03:30:00.000Z');
    expect(riyadhWeekday(next)).toBe(4);
  });

  it('skips dates already gone', () => {
    expect(nextWeeklyDate(monday, [1], monday, new Date('2026-12-01T00:00:00Z'))!.toISOString()).toBe('2026-12-07T03:30:00.000Z');
  });
});

describe('Vehicles and weekly trips (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let trips: TripsService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const createVehicle = async (body: object) =>
    (await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: `V-${Date.now()}-${Math.random()}`.slice(0, 30), model: 'هايس', ...body }).expect(201)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    trips = app.get(TripsService);
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives a bus the fixed plan unless it seats another number, and a van the seats entered for it', async () => {
    const bus = await createVehicle({ kind: 'BUS' });
    expect(bus.seatCount).toBe(49);
    const larger = await createVehicle({ kind: 'BUS', seatCount: 50 });
    expect(larger).toMatchObject({ seatCount: 50, singlesToSeat: 50 });
    const onLarger = await createTrip({ busId: larger.id });
    expect(onLarger.totalSeats).toBe(50);
    expect(await prisma.seat.count({ where: { tripId: onLarger.id } })).toBe(50);
    await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'TOO-MANY', model: 'باص', kind: 'BUS', seatCount: 200 }).expect(400);
    const van = await createVehicle({ kind: 'VAN', seatCount: 13 });
    expect(van.seatCount).toBe(13);
    expect(van.singlesToSeat).toBeLessThanOrEqual(13);
    await request(http()).post(`${API}/buses`).set(admin.auth).send({ plateNumber: 'NO-COUNT', model: 'فان', kind: 'VAN' }).expect(400);
  });

  it('sells only the van seats on a trip with a van, and refits the seats when the vehicle changes', async () => {
    const van = await createVehicle({ kind: 'MINIBUS', seatCount: 25 });
    const trip = await createTrip({ busId: van.id });
    expect(trip.totalSeats).toBe(25);
    expect(await prisma.seat.count({ where: { tripId: trip.id } })).toBe(25);

    const bus = await createVehicle({ kind: 'BUS' });
    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ busId: bus.id }).expect(200);
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { seats: true } });
    expect(after.seats).toHaveLength(seatNumbersOf(BUS_SEAT_LAYOUT as any).length);
    expect(after.totalSeats).toBe(49);
    expect(after.seatLayout).toBeNull();
  });

  it('refuses a smaller vehicle when a sold seat would go away', async () => {
    const trip = await createTrip();
    await prisma.seat.update({ where: { tripId_seatNumber: { tripId: trip.id, seatNumber: '40' } }, data: { isBooked: true } });
    const van = await createVehicle({ kind: 'VAN', seatCount: 12 });
    const res = await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ busId: van.id }).expect(409);
    expect(res.body.message).toContain('40');
  });

  it('drafts a temporary weekly trip until its last day, and publishing makes them all public', async () => {
    const departure = new Date(Date.now() + 2 * DAY);
    const weekday = riyadhWeekday(departure);
    const first = await createTrip({
      departureTime: departure.toISOString(),
      arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString(),
      repeatWeekdays: [weekday],
      repeatUntil: new Date(departure.getTime() + 29 * DAY).toISOString(),
    });
    expect(first.seriesDrafting).toBe(true);
    await trips.extendSeries(first.id);

    const series = await prisma.trip.findMany({ where: { seriesId: first.id }, orderBy: { departureTime: 'asc' } });
    expect(series).toHaveLength(5);
    expect(series.slice(1).every((trip) => trip.tripStatus === 'DRAFT' && riyadhWeekday(trip.departureTime) === weekday)).toBe(true);

    const result = (await request(http()).post(`${API}/trips/series/${first.id}/publish`).set(admin.auth).expect(201)).body;
    expect(result).toEqual({ published: 4, failed: [] });
  });

  it('stops a series and removes its drafts on request', async () => {
    const departure = new Date(Date.now() + 2 * DAY);
    const first = await createTrip({
      departureTime: departure.toISOString(),
      arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString(),
      scheduleType: 'FIXED',
      repeatWeekdays: [riyadhWeekday(departure)],
    });
    await trips.extendSeries(first.id);
    expect(await prisma.trip.count({ where: { seriesId: first.id } })).toBeGreaterThan(50);

    await request(http()).post(`${API}/trips/series/${first.id}/stop`).set(admin.auth).send({ deleteDrafts: true }).expect(201);
    expect(await prisma.trip.count({ where: { seriesId: first.id } })).toBe(1);
    expect(await trips.extendSeries(first.id)).toBe(0);
  });

  it("fills a month's missing weekly drafts once, and skips days that already have one", async () => {
    const departure = new Date(Date.now() + 2 * DAY);
    const first = await createTrip({
      departureTime: departure.toISOString(),
      arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString(),
      scheduleType: 'FIXED',
      repeatWeekdays: [riyadhWeekday(departure)],
    });
    await trips.extendSeries(first.id);
    // Two months ahead is wholly inside the year the series is kept drafted for.
    const ahead = new Date(Date.now() + 3 * 3_600_000);
    const month = new Date(Date.UTC(ahead.getUTCFullYear(), ahead.getUTCMonth() + 2, 1)).toISOString().slice(0, 7);
    const inMonth = await prisma.trip.findMany({ where: { seriesId: first.id, codePeriod: month }, orderBy: { departureTime: 'asc' } });
    expect(inMonth.length).toBeGreaterThanOrEqual(4);
    await request(http()).delete(`${API}/trips/${inMonth[1].id}`).set(admin.auth).expect(200);

    const ofSeries = (body: any) => body.bySeries.find((entry: any) => entry.seriesId === first.id);
    const preview = (await request(http()).get(`${API}/trips/series/month-plan?month=${month}`).set(admin.auth).expect(200)).body;
    expect(ofSeries(preview)).toMatchObject({ created: 1, skipped: inMonth.length - 1 });
    expect(await prisma.trip.count({ where: { seriesId: first.id, codePeriod: month } })).toBe(inMonth.length - 1);

    const made = (await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month }).expect(201)).body;
    expect(ofSeries(made)).toMatchObject({ created: 1, skipped: inMonth.length - 1 });
    const refilled = await prisma.trip.findFirstOrThrow({ where: { seriesId: first.id, departureTime: inMonth[1].departureTime } });
    expect(refilled).toMatchObject({ tripStatus: 'DRAFT', repeatWeekdays: [riyadhWeekday(departure)] });

    const again = (await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month }).expect(201)).body;
    expect(ofSeries(again)).toMatchObject({ created: 0, skipped: inMonth.length });
    await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month: '2026-13' }).expect(400);
  });

  it('copies a trip to a new date as a one-off draft with a new number and no bookings', async () => {
    const source = await createTrip({ tripStatus: 'PUBLISHED' });
    const departure = new Date(new Date(source.departureTime).getTime() + 10 * DAY + 2 * 3_600_000);
    const copy = (await request(http()).post(`${API}/trips/${source.id}/duplicate`).set(admin.auth).send({ departureTime: departure.toISOString() }).expect(201)).body;
    expect(copy.id).not.toBe(source.id);
    expect(copy.tripCode).not.toBe(source.tripCode);
    const saved = await prisma.trip.findUniqueOrThrow({ where: { id: copy.id }, include: { boardingPoints: true, _count: { select: { bookings: true } } } });
    expect(saved).toMatchObject({ tripStatus: 'DRAFT', origin: source.origin, destination: source.destination, seriesId: null, repeatWeekdays: [] });
    expect(saved.departureTime.toISOString()).toBe(departure.toISOString());
    expect(saved.boardingPoints).toHaveLength(source.boardingPoints.length);
    expect(saved._count.bookings).toBe(0);

    await request(http()).post(`${API}/trips/${source.id}/duplicate`).set(admin.auth).send({ departureTime: new Date(Date.now() - DAY).toISOString() }).expect(400);
    await request(http()).post(`${API}/trips/${source.id}/duplicate`).set(admin.auth).send({}).expect(400);
  });

  it('refuses a temporary weekly trip without a last day', async () => {
    await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ repeatWeekdays: [1] })).expect(400);
  });
});

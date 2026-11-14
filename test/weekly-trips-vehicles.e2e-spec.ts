import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { BUS_SEAT_LAYOUT, generateSeatLayout, seatNumbersOf } from '../src/common/utils/bus-layout.util';
import { nextWeeklyDate, riyadhWeekday } from '../src/common/utils/recurrence.util';
import { TripsService } from '../src/modules/trips/trips.service';
import { bookingOpensAtFor, startOfNextRiyadhMonth } from '../src/common/utils/booking-opens.util';
import { riyadhMonth, startOfRiyadhMonth } from '../src/common/utils/time.util';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY = 86_400_000;
/** YYYY-MM of this Riyadh month and the next, the only two a weekly schedule is drafted for. */
const thisMonth = () => riyadhMonth(new Date());
const nextMonth = () => riyadhMonth(startOfNextRiyadhMonth(new Date()));

describe('When booking opens on a weekly copy', () => {
  const now = new Date('2026-11-13T09:00:00Z');
  const december = new Date('2026-12-10T05:00:00Z');

  it('opens on publish, on the 1st of the month at midnight Riyadh, or days before it', () => {
    expect(bookingOpensAtFor(december, { bookingOpens: 'ON_PUBLISH', openDaysBefore: 7 }, now)).toBeNull();
    expect(bookingOpensAtFor(december, { bookingOpens: 'MONTH_START', openDaysBefore: 7 }, now)!.toISOString()).toBe('2026-11-30T21:00:00.000Z');
    expect(bookingOpensAtFor(december, { bookingOpens: 'DAYS_BEFORE', openDaysBefore: 7 }, now)!.toISOString()).toBe('2026-11-23T21:00:00.000Z');
  });

  it('stores nothing once that moment has passed', () => {
    expect(bookingOpensAtFor(new Date('2026-11-20T05:00:00Z'), { bookingOpens: 'MONTH_START', openDaysBefore: 7 }, now)).toBeNull();
  });
});

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
    // The sweep reaches next month only close to it; the button drafts it at once. 31 days from now never pass next month's end.
    await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month: nextMonth() }).expect(201);

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
    await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month: nextMonth() }).expect(201);
    expect(await prisma.trip.count({ where: { seriesId: first.id } })).toBeGreaterThan(3);
    // A month at a time: nothing beyond next month.
    expect(await prisma.trip.count({ where: { seriesId: first.id, departureTime: { gte: startOfNextRiyadhMonth(startOfNextRiyadhMonth(new Date())) } } })).toBe(0);

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
    const month = nextMonth();
    await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month }).expect(201);
    const inMonth = await prisma.trip.findMany({ where: { seriesId: first.id, codePeriod: month }, orderBy: { departureTime: 'asc' } });
    expect(inMonth.length).toBeGreaterThanOrEqual(3);
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
    // Only this month and next; the rest follow in their time.
    const later = riyadhMonth(startOfNextRiyadhMonth(startOfNextRiyadhMonth(new Date())));
    const refused = await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month: later }).expect(400);
    expect(refused.body.message).toContain('الشهر القادم');
  });

  it("copies next month from the series' latest trip, edits included, and sets its booking opening from the settings", async () => {
    await request(http()).put(`${API}/settings`).set(admin.auth).send({ scheduleBookingOpens: 'MONTH_START' }).expect(200);
    const departure = new Date(Date.now() + 2 * DAY);
    const first = await createTrip({
      departureTime: departure.toISOString(),
      arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString(),
      scheduleType: 'FIXED',
      repeatWeekdays: [riyadhWeekday(departure)],
    });
    await trips.extendSeries(first.id);
    const latest = await prisma.trip.findFirstOrThrow({ where: { seriesId: first.id, departureTime: { lt: startOfNextRiyadhMonth(new Date()) } }, orderBy: { departureTime: 'desc' } });
    await request(http()).put(`${API}/trips/${latest.id}`).set(admin.auth).send({ price: 222 }).expect(200);

    await request(http()).post(`${API}/trips/series/generate-month`).set(admin.auth).send({ month: nextMonth() }).expect(201);
    const copies = await prisma.trip.findMany({ where: { seriesId: first.id, departureTime: { gte: startOfNextRiyadhMonth(new Date()) } } });
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every((copy) => Number(copy.price) === 222 && copy.tripStatus === 'DRAFT')).toBe(true);
    expect(copies.every((copy) => copy.bookingOpensAt?.getTime() === startOfNextRiyadhMonth(new Date()).getTime())).toBe(true);
    await request(http()).put(`${API}/settings`).set(admin.auth).send({ scheduleBookingOpens: 'ON_PUBLISH' }).expect(200);
  });

  it('publishes only drafts up to next month, reports older far drafts and lets only an admin delete them', async () => {
    const departure = new Date(Date.now() + 2 * DAY);
    const first = await createTrip({
      departureTime: departure.toISOString(),
      arrivalTime: new Date(departure.getTime() + 5 * 3_600_000).toISOString(),
      scheduleType: 'FIXED',
      repeatWeekdays: [riyadhWeekday(departure)],
    });
    await trips.extendSeries(first.id);
    // A draft from the old year-ahead rule, some months out.
    const far = await trips.duplicateTrip(first.id, new Date(departure.getTime() + 140 * DAY).toISOString());
    await prisma.trip.update({ where: { id: far.id }, data: { seriesId: first.id, scheduleType: 'FIXED', repeatWeekdays: [riyadhWeekday(departure)] } });

    const plan = (await request(http()).get(`${API}/trips/series/month-plan?month=${thisMonth()}`).set(admin.auth).expect(200)).body;
    expect(plan.farFutureDrafts).toBeGreaterThanOrEqual(1);
    expect(plan.months).toEqual([thisMonth(), nextMonth()]);
    // The sweep adds nothing after a far draft, and publishing leaves it a draft.
    expect(await trips.extendSeries(first.id)).toBe(0);
    await request(http()).post(`${API}/trips/series/${first.id}/publish`).set(admin.auth);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: far.id } })).tripStatus).toBe('DRAFT');

    const staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
    await request(http()).post(`${API}/trips/series/far-drafts/delete`).set(staff.auth).expect(403);
    const cleaned = (await request(http()).post(`${API}/trips/series/far-drafts/delete`).set(admin.auth).expect(201)).body;
    expect(cleaned.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.trip.count({ where: { id: far.id } })).toBe(0);
  });

  it('refuses bookings before the opening moment, everywhere, and keeps such trips out of the app and the counter', async () => {
    const opensAt = new Date(Date.now() + DAY);
    const trip = await createTrip({ bookingOpensAt: opensAt.toISOString() });
    expect(new Date(trip.bookingOpensAt).getTime()).toBe(opensAt.getTime());
    await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ bookingOpensAt: new Date(Date.now() + 365 * DAY).toISOString() })).expect(400);

    const search = (await request(http()).get(`${API}/trips/search`).expect(200)).body;
    expect(search.some((row: any) => row.id === trip.id)).toBe(false);
    const counter = (await request(http()).get(`${API}/branch-bookings/trips`).set(admin.auth).expect(200)).body;
    expect(counter.items.some((row: any) => row.id === trip.id)).toBe(false);

    const customer = await loginPassenger(app);
    const held = await request(http()).post(`${API}/bookings/holds`).set(customer.auth).send({ tripId: trip.id, seats: ['4'] }).expect(400);
    expect(held.body.message).toContain('يفتح');
    await request(http())
      .post(`${API}/branch-bookings/quote`)
      .set(admin.auth)
      .send({ kind: 'TRANSPORT_OUTBOUND', legs: [{ leg: 'OUTBOUND', tripId: trip.id, seats: ['4'] }] })
      .expect(400);

    // Cleared, it opens at once.
    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ bookingOpensAt: null }).expect(200);
    await request(http()).post(`${API}/bookings/holds`).set(customer.auth).send({ tripId: trip.id, seats: ['4'] }).expect(201);
  });

  it('lists only this month onward with from=currentMonth, and every trip without it', async () => {
    const old = await createTrip();
    const lastMonth = new Date(startOfRiyadhMonth().getTime() - 5 * DAY);
    await prisma.trip.update({ where: { id: old.id }, data: { departureTime: lastMonth, arrivalTime: new Date(lastMonth.getTime() + 5 * 3_600_000), tripStatus: 'COMPLETED' } });
    const scoped = (await request(http()).get(`${API}/trips/admin/all?from=currentMonth`).set(admin.auth).expect(200)).body;
    expect(scoped.some((row: any) => row.id === old.id)).toBe(false);
    const all = (await request(http()).get(`${API}/trips/admin/all`).set(admin.auth).expect(200)).body;
    expect(all.some((row: any) => row.id === old.id)).toBe(true);
    await request(http()).get(`${API}/trips/admin/all?from=lastYear`).set(admin.auth).expect(400);
  });

  it('lists from now nearest departure first, with each trip expected revenue, and a date range by Riyadh day', async () => {
    const past = await createTrip();
    await prisma.trip.update({ where: { id: past.id }, data: { departureTime: new Date(Date.now() - 2 * DAY), arrivalTime: new Date(Date.now() - 2 * DAY + 5 * 3_600_000) } });
    const far = await createTrip();
    const near = await createTrip();
    await prisma.trip.update({ where: { id: far.id }, data: { departureTime: new Date(Date.now() + 300 * DAY), arrivalTime: new Date(Date.now() + 300 * DAY + 5 * 3_600_000) } });
    await prisma.trip.update({ where: { id: near.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 6 * 3_600_000) } });

    const upcoming = (await request(http()).get(`${API}/trips/admin/all?from=now`).set(admin.auth).expect(200)).body;
    expect(upcoming.some((row: any) => row.id === past.id)).toBe(false);
    expect(upcoming[0].id).toBe(near.id);
    const times = upcoming.map((row: any) => new Date(row.departureTime).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(upcoming.every((row: any) => typeof row.expectedRevenue === 'number')).toBe(true);

    await request(http()).get(`${API}/trips/admin/all?from=2026-02-02&to=2026-02-01`).set(admin.auth).expect(400);
    const occupancy = (await request(http()).get(`${API}/trips/admin/occupancy`).set(admin.auth).expect(200)).body;
    expect(occupancy).toMatchObject({ windowDays: 30, executed: expect.any(Object), next30: expect.any(Object), umrah: expect.any(Object), madinah: expect.any(Object) });
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

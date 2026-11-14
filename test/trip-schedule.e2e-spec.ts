import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { nextYearlyDate } from '../src/common/utils/recurrence.util';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const hijri = (date: Date) => new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Riyadh' }).format(date);

describe('Yearly dates', () => {
  it('keeps the Gregorian day, month and Riyadh time', () => {
    expect(nextYearlyDate(new Date('2027-03-15T05:30:00Z'), 'GREGORIAN').toISOString()).toBe('2028-03-15T05:30:00.000Z');
  });

  it('falls back to 28 February when the next year has no 29th', () => {
    expect(nextYearlyDate(new Date('2028-02-29T05:30:00Z'), 'GREGORIAN').toISOString()).toBe('2029-02-28T05:30:00.000Z');
  });

  it('reads the Gregorian date in Riyadh, not in UTC', () => {
    // 22:00 UTC on 31 December is already 1 January in Riyadh.
    expect(nextYearlyDate(new Date('2027-12-31T22:00:00Z'), 'GREGORIAN').toISOString()).toBe('2028-12-31T22:00:00.000Z');
  });

  it('keeps the Hijri day and month, whatever Gregorian date that lands on', () => {
    const from = new Date('2027-03-01T05:30:00Z');
    const next = nextYearlyDate(from, 'HIJRI');
    expect(hijri(next)).toBe(hijri(from));
    expect(next.toISOString().slice(11)).toBe('05:30:00.000Z');
    const days = (next.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(353);
    expect(days).toBeLessThanOrEqual(356);
  });

  it('finds a Hijri date every day for years, including the 30th of a shorter month', () => {
    for (let day = 0; day < 2000; day++) {
      const from = new Date(Date.UTC(2026, 0, 1 + day, 6));
      const next = nextYearlyDate(from, 'HIJRI');
      const [fromMonth, fromDay] = hijri(from).split('/').map(Number);
      const [nextMonth, nextDay] = hijri(next).split('/').map(Number);
      expect(nextMonth).toBe(fromMonth);
      expect(fromDay - nextDay === 0 || (fromDay === 30 && nextDay === 29)).toBe(true);
    }
  });
});

describe('Trip scheduling and editing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let trips: TripsService;
  let http: () => any;
  let admin: any;
  let driver: any;
  let hotelCounter = 0;

  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  const edit = (id: string, body: object) => request(http()).put(`${API}/trips/${id}`).set(admin.auth).send(body);
  const createBus = () =>
    prisma.bus.create({ data: { plateNumber: `B-${Date.now()}-${Math.random()}`, model: 'فولفو' } });
  const createHotel = async (extra = {}) => (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق جدولة ${++hotelCounter}`, city: 'مكة', ...extra }).expect(201)).body;

  /** Moves a saved trip into the past, as if its date had simply gone by. */
  const pastTrip = (id: string) =>
    prisma.trip.update({
      where: { id },
      data: {
        departureTime: new Date(Date.now() - 2 * 86_400_000),
        arrivalTime: new Date(Date.now() - 86_400_000),
        tripStatus: 'COMPLETED',
      },
    });

  const nextDrafts = () => prisma.trip.findMany({ where: { tripStatus: 'DRAFT', scheduleType: 'FIXED' }, include: { accommodations: true, hotelBookings: true, seats: true, drivers: true, supervisors: true, boardingPoints: true, services: true, visits: true } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    trips = app.get(TripsService);
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    driver = await createStaff(prisma, 'DRIVER');
  });

  beforeEach(async () => {
    await prisma.trip.updateMany({ where: { scheduleType: 'FIXED' }, data: { scheduleType: 'TEMPORARY', recurrenceCalendar: null } });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('bus is optional', () => {
    it('creates and publishes a trip with no bus, and customers can book it', async () => {
      const trip = await createTrip({ tripStatus: 'PUBLISHED' });
      expect(trip.busId).toBeNull();
      expect(trip.totalSeats).toBe(49);
      const customer = await loginPassenger(app);
      await request(http()).post(`${API}/bookings`).set(customer.auth).send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['26'] }], passengers: [{ fullName: 'مسافر تجريبي' }] }).expect(201);
    });

    it('assigns the bus later', async () => {
      const trip = await createTrip();
      const bus = await createBus();
      const res = await edit(trip.id, { busId: bus.id }).expect(200);
      expect(res.body.busId).toBe(bus.id);
    });
  });

  describe('fixed or temporary', () => {
    it('is temporary unless stated, and a fixed trip must name its calendar', async () => {
      expect((await createTrip()).scheduleType).toBe('TEMPORARY');
      await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ scheduleType: 'FIXED' })).expect(400);
      const fixed = await createTrip({ scheduleType: 'FIXED', recurrenceCalendar: 'HIJRI' });
      expect(fixed).toMatchObject({ scheduleType: 'FIXED', recurrenceCalendar: 'HIJRI' });
      const cleared = await edit(fixed.id, { scheduleType: 'TEMPORARY' }).expect(200);
      expect(cleared.body).toMatchObject({ scheduleType: 'TEMPORARY', recurrenceCalendar: null });
    });

    it('keeps the schedule out of the customer API', async () => {
      const fixed = await createTrip({ scheduleType: 'FIXED', recurrenceCalendar: 'GREGORIAN' });
      const res = await request(http()).get(`${API}/trips/${fixed.id}`).expect(200);
      expect(res.body.scheduleType).toBeUndefined();
      expect(res.body.recurrenceCalendar).toBeUndefined();
    });

    it('drafts next year after the date passes: same details, no bus or crew, and exactly once', async () => {
      const bus = await createBus();
      const hotel = await createHotel();
      const service = await prisma.service.create({ data: { name: `خدمة ${Date.now()}` } });
      const source = await createTrip({
        scheduleType: 'FIXED',
        recurrenceCalendar: 'GREGORIAN',
        bookingType: 'WITH_HOTEL',
        busId: bus.id,
        price: 333,
        busRentalPrice: 5000,
        driverIds: [driver.id],
        serviceIds: [service.id],
        accommodation: { name: hotel.name, nights: 3, hotelId: hotel.id },
      });
      await pastTrip(source.id);
      await trips.draftNextFixedTrips();
      await trips.draftNextFixedTrips();

      const drafts = await nextDrafts();
      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      const saved = await prisma.trip.findUniqueOrThrow({ where: { id: source.id } });
      // Next year's copy takes the next number of its own month.
      expect(draft.tripCode).toMatch(/^D\d{3}-\d{2}\/\d{4}$/);
      expect(draft.codePeriod).toBe(new Date(draft.departureTime.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 7));
      expect(draft.recurrenceCalendar).toBe('GREGORIAN');
      expect(draft.departureTime.getTime()).toBeGreaterThan(Date.now());
      expect(draft.arrivalTime.getTime() - draft.departureTime.getTime()).toBe(saved.arrivalTime.getTime() - saved.departureTime.getTime());
      expect(Number(draft.price)).toBe(333);
      expect(draft.totalSeats).toBe(49);
      expect(draft.seats).toHaveLength(49);
      expect(draft.seats.every((seat) => !seat.isBooked)).toBe(true);
      expect(draft.boardingPoints.map((p) => p.name)).toEqual(['فرع ينبع']);
      expect(draft.services.map((s) => s.serviceId)).toEqual([service.id]);
      expect(draft.accommodations[0]).toMatchObject({ name: hotel.name, nights: 3 });
      expect(draft.hotelBookings[0]).toMatchObject({ hotelId: hotel.id, status: 'CONFIRMED' });
      expect(draft.busId).toBeNull();
      expect(draft.busRentalPrice).toBeNull();
      expect(draft.drivers).toHaveLength(0);
      expect(draft.supervisors).toHaveLength(0);

      expect(await prisma.notification.count({ where: { event: 'STAFF_FIXED_TRIP_DRAFTED', body: { contains: draft.tripCode } } })).toBeGreaterThan(0);
      // A draft is invisible to customers until it is published.
      await request(http()).get(`${API}/trips/${draft.id}`).expect(404);
    });

    it('does not bring back a draft someone deleted, and stops for a temporary trip', async () => {
      const fixed = await createTrip({ scheduleType: 'FIXED', recurrenceCalendar: 'HIJRI' });
      const temporary = await createTrip();
      await Promise.all([pastTrip(fixed.id), pastTrip(temporary.id)]);
      await trips.draftNextFixedTrips();
      const drafts = await nextDrafts();
      const draft = drafts.find((t) => t.hijriDate && t.recurrenceCalendar === 'HIJRI');
      await request(http()).delete(`${API}/trips/${draft.id}`).set(admin.auth).expect(200);
      await trips.draftNextFixedTrips();
      expect(await prisma.trip.count({ where: { tripStatus: 'DRAFT', recurrenceCalendar: 'HIJRI' } })).toBe(0);
    });

    it('carries the series on from a year that was cancelled', async () => {
      const fixed = await createTrip({ scheduleType: 'FIXED', recurrenceCalendar: 'GREGORIAN' });
      await request(http()).post(`${API}/trips/${fixed.id}/cancel`).set(admin.auth).send({ reason: 'ظرف طارئ' });
      await prisma.trip.update({ where: { id: fixed.id }, data: { tripStatus: 'CANCELLED', departureTime: new Date(Date.now() - 2 * 86_400_000), arrivalTime: new Date(Date.now() - 86_400_000) } });
      await trips.draftNextFixedTrips();
      expect(await nextDrafts()).toHaveLength(1);
    });

    it('jumps ahead to a future date when the source is several years old', async () => {
      const fixed = await createTrip({ scheduleType: 'FIXED', recurrenceCalendar: 'GREGORIAN' });
      await prisma.trip.update({ where: { id: fixed.id }, data: { departureTime: new Date('2020-03-15T05:30:00Z'), arrivalTime: new Date('2020-03-15T10:30:00Z') } });
      await trips.draftNextFixedTrips();
      const [draft] = await nextDrafts();
      expect(draft.departureTime.getTime()).toBeGreaterThan(Date.now());
      expect(draft.departureTime.toISOString().slice(4)).toBe('-03-15T05:30:00.000Z');
    });

    it('refuses to make a reverse trip fixed', async () => {
      const outbound = await createTrip();
      const reverse = await prisma.trip.create({
        data: { tripCode: 'REV1', origin: 'مكة', destination: 'ينبع', departureTime: new Date(Date.now() + 5e8), arrivalTime: new Date(Date.now() + 6e8), hijriDate: '-', price: 10, reverseOfTripId: outbound.id },
      });
      await edit(reverse.id, { scheduleType: 'FIXED', recurrenceCalendar: 'HIJRI' }).expect(400);
    });
  });

  describe('editing every detail', () => {
    it('saves what the old edit screen could not reach', async () => {
      const trip = await createTrip({ bookingType: 'TRANSPORT_ONLY' });
      const service = await prisma.service.create({ data: { name: `خدمة تعديل ${Date.now()}` } });
      const supervisor = await createStaff(prisma, 'STAFF');
      const secondDriver = await createStaff(prisma, 'DRIVER');
      const res = await edit(trip.id, {
        title: 'عمرة رمضان',
        miqat: 'ميقات يلملم',
        direction: 'ROUND_TRIP',
        bookingType: 'WITH_VISITS',
        serviceIds: [service.id],
        visits: [{ title: 'مسجد قباء', expectedTime: '09:00' }],
        driverIds: [driver.id, secondDriver.id],
        supervisorIds: [supervisor.id],
        reverseEnabled: true,
        reverseDepartureAt: new Date(new Date(trip.departureTime).getTime() + 86_400_000).toISOString(),
        reversePrice: 90,
        channelApp: false,
      }).expect(200);
      expect(res.body).toMatchObject({ title: 'عمرة رمضان', miqat: 'ميقات يلملم', direction: 'ROUND_TRIP', bookingType: 'WITH_VISITS', reverseEnabled: true, channelApp: false });
      expect(res.body.drivers).toHaveLength(2);
      expect(res.body.supervisors).toHaveLength(1);
      expect(res.body.visits[0].title).toBe('مسجد قباء');
      expect(res.body.services.map((s: any) => s.serviceId)).toEqual([service.id]);
    });

    it('keeps the length of the trip when only the departure moves', async () => {
      const trip = await createTrip();
      const later = new Date(new Date(trip.arrivalTime).getTime() + 10 * 86_400_000);
      const res = await edit(trip.id, { departureTime: later.toISOString() }).expect(200);
      expect(new Date(res.body.arrivalTime).getTime() - new Date(res.body.departureTime).getTime()).toBe(new Date(trip.arrivalTime).getTime() - new Date(trip.departureTime).getTime());
    });

    it('moves the hotel stay with the trip and its nights', async () => {
      const hotel = await createHotel();
      const trip = await createTrip({ bookingType: 'WITH_HOTEL', departureTime: '2031-05-10T05:00:00Z', arrivalTime: '2031-05-10T10:00:00Z', accommodation: { name: hotel.name, nights: 2, hotelId: hotel.id } });
      await edit(trip.id, { departureTime: '2031-06-20T05:00:00Z', accommodation: { name: hotel.name, nights: 4, hotelId: hotel.id } }).expect(200);
      const stay = await prisma.hotelBooking.findFirstOrThrow({ where: { tripId: trip.id, status: 'CONFIRMED' } });
      expect(stay.checkIn.toISOString().slice(0, 10)).toBe('2031-06-20');
      expect(stay.checkOut.toISOString().slice(0, 10)).toBe('2031-06-24');
    });

    it('changes the hotel, and refuses while guests are in rooms there', async () => {
      const first = await createHotel();
      const second = await createHotel();
      const trip = await createTrip({ bookingType: 'WITH_HOTEL', accommodation: { name: first.name, nights: 1, hotelId: first.id } });

      await edit(trip.id, { accommodation: { name: second.name, nights: 1, hotelId: second.id } }).expect(200);
      const stays = await prisma.hotelBooking.findMany({ where: { tripId: trip.id }, orderBy: { number: 'asc' } });
      expect(stays.map((s) => s.status)).toEqual(['CANCELLED', 'CONFIRMED']);

      // Going back reopens the first stay instead of failing on the duplicate.
      await edit(trip.id, { accommodation: { name: first.name, nights: 1, hotelId: first.id } }).expect(200);
      const reopened = await prisma.hotelBooking.findMany({ where: { tripId: trip.id, status: 'CONFIRMED' } });
      expect(reopened.map((s) => s.hotelId)).toEqual([first.id]);

      const customer = await loginPassenger(app);
      const booked = await request(http()).post(`${API}/bookings`).set(customer.auth).send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['26'], roomChoice: 'SHARED' }], passengers: [{ fullName: 'مسافر تجريبي' }] }).expect(201);
      await request(http()).post(`${API}/hotels/bookings/${reopened[0].id}/rooms`).set(admin.auth).send({ passengerIds: [booked.body.bookings[0].passengers[0].id], roomNumber: '1', roomType: 'SHARED' }).expect(201);
      await edit(trip.id, { accommodation: { name: second.name, nights: 1, hotelId: second.id } }).expect(409);
      await edit(trip.id, { bookingType: 'TRANSPORT_ONLY' }).expect(409);
    });

    it('drops the hotel when the trip stops including housing', async () => {
      const hotel = await createHotel();
      const trip = await createTrip({ bookingType: 'WITH_HOTEL', accommodation: { name: hotel.name, nights: 1, hotelId: hotel.id } });
      const res = await edit(trip.id, { bookingType: 'TRANSPORT_ONLY' }).expect(200);
      expect(res.body.accommodations).toEqual([]);
      expect(res.body.hotelBookings).toEqual([]);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Hotels and rooming (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let staff: any;
  let hotelCounter = 0;

  const createHotel = async (nightlyRate = 50) =>
    (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق ${++hotelCounter}`, city: 'مكة', nightlyRate }).expect(201)).body;

  const hotelTrip = async (overrides = {}) =>
    (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ bookingType: 'WITH_HOTEL', housingPrice: 40, ...overrides })).expect(201)).body;

  const book = async (trip: any, seats: string[], user?: any) => {
    const session = user ?? (await loginPassenger(app));
    const res = await request(http())
      .post(`${API}/bookings`)
      .set(session.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats, roomChoice: 'SHARED' }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })) })
      .expect(201);
    return { user: session, booking: res.body.bookings[0] };
  };

  const bookHotel = async (trip: any, hotel: any, session = staff, extra = {}) =>
    (await request(http()).post(`${API}/hotels/bookings`).set(session.auth).send({ tripId: trip.id, hotelId: hotel.id, checkIn: '2030-01-10', checkOut: '2030-01-12', ...extra }).expect(201)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    staff = await loginStaff(app, (await createStaff(prisma, 'STAFF')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    it('keeps customers out and contract rates with admins', async () => {
      const hotel = await createHotel(100);
      const user = await loginPassenger(app);
      await request(http()).get(`${API}/hotels`).set(user.auth).expect(403);
      await request(http()).get(`${API}/hotels`).expect(401);
      await request(http()).post(`${API}/hotels`).set(staff.auth).send({ name: 'تجربة', city: 'مكة', nightlyRate: 1 }).expect(403);
      await request(http()).get(`${API}/hotels/overview`).set(staff.auth).expect(403);

      const seenByStaff = await request(http()).get(`${API}/hotels`).set(staff.auth).expect(200);
      expect(seenByStaff.body.find((h: any) => h.id === hotel.id).nightlyRate).toBeUndefined();
      const seenByAdmin = await request(http()).get(`${API}/hotels`).set(admin.auth).expect(200);
      expect(Number(seenByAdmin.body.find((h: any) => h.id === hotel.id).nightlyRate)).toBe(100);
    });

    it('books staff at the contract rate whatever they send', async () => {
      const hotel = await createHotel(50);
      const trip = await hotelTrip();
      const { id } = await bookHotel(trip, hotel, staff, { nightlyRate: 1, extraCost: 9999 });
      const saved = await prisma.hotelBooking.findUniqueOrThrow({ where: { id } });
      expect(Number(saved.nightlyRate)).toBe(50);
      expect(Number(saved.extraCost)).toBe(0);
    });
  });

  describe('booking rules', () => {
    it('refuses trips without housing, reversed dates and impossible dates', async () => {
      const hotel = await createHotel();
      const transport = await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201);
      const trip = await hotelTrip();
      const send = (body: object) => request(http()).post(`${API}/hotels/bookings`).set(staff.auth).send(body);
      await send({ tripId: transport.body.id, hotelId: hotel.id, checkIn: '2030-01-10', checkOut: '2030-01-12' }).expect(409);
      await send({ tripId: trip.id, hotelId: hotel.id, checkIn: '2030-01-12', checkOut: '2030-01-10' }).expect(400);
      await send({ tripId: trip.id, hotelId: hotel.id, checkIn: '2030-02-31', checkOut: '2030-03-02' }).expect(400);
      await send({ tripId: trip.id, hotelId: hotel.id, checkIn: 'tomorrow', checkOut: '2030-01-10' }).expect(400);
    });

    it('allows one active booking per hotel on a trip', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      await bookHotel(trip, hotel);
      await request(http()).post(`${API}/hotels/bookings`).set(staff.auth).send({ tripId: trip.id, hotelId: hotel.id, checkIn: '2030-01-10', checkOut: '2030-01-12' }).expect(409);
    });
  });

  describe('rooming', () => {
    it('lists the passengers of the trip and puts several in one room', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const { booking } = await book(trip, ['5', '6']);
      const { id } = await bookHotel(trip, hotel);

      const before = await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(staff.auth).expect(200);
      expect(before.body.passengers.map((p: any) => p.seatNumber)).toEqual(['5', '6']);
      expect(before.body.hotelBookings[0].nightlyRate).toBeUndefined();

      await request(http())
        .post(`${API}/hotels/bookings/${id}/rooms`)
        .set(staff.auth)
        .send({ passengerIds: booking.passengers.map((p: any) => p.id), roomNumber: '101', roomType: 'SHARED', roomNote: 'الدور الأول' })
        .expect(201);

      const after = await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(admin.auth).expect(200);
      expect(after.body.passengers.every((p: any) => p.room.number === '101')).toBe(true);
      expect(after.body.hotelBookings[0].rooms[0].occupants).toBe(2);
      // 1 room × 2 nights × 50.
      expect(after.body.hotelBookings[0].cost).toBe(100);
    });

    it('never fills a room past its capacity, even under simultaneous requests', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const first = await book(trip, ['1']);
      const second = await book(trip, ['2']);
      const { id } = await bookHotel(trip, hotel);
      const assign = (passenger: any) =>
        request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [passenger.id], roomNumber: '7', roomType: 'PRIVATE', capacity: 1 });

      const results = await Promise.all([assign(first.booking.passengers[0]), assign(second.booking.passengers[0])]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const room = await prisma.hotelRoom.findFirstOrThrow({ where: { hotelBookingId: id }, include: { occupants: true } });
      expect(room.occupants).toHaveLength(1);
    });

    it('refuses a passenger from another trip or a cancelled booking', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const other = await hotelTrip();
      const stranger = await book(other, ['1']);
      const cancelled = await book(trip, ['2']);
      const { id } = await bookHotel(trip, hotel);
      const assign = (passengerIds: string[]) =>
        request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds, roomNumber: '1', roomType: 'SHARED' });
      await assign([stranger.booking.passengers[0].id]).expect(400);
      await assign(['does-not-exist']).expect(404);
      await request(http()).post(`${API}/bookings/${cancelled.booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      await assign([cancelled.booking.passengers[0].id]).expect(409);
    });

    it('drops a room from the cost once it is empty', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const { booking } = await book(trip, ['3']);
      const { id } = await bookHotel(trip, hotel);
      const passengerId = booking.passengers[0].id;
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [passengerId], roomNumber: '1', roomType: 'SHARED' }).expect(201);
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [passengerId], roomNumber: '2', roomType: 'SHARED' }).expect(201);
      expect((await prisma.hotelRoom.findMany({ where: { hotelBookingId: id } })).map((r) => r.number)).toEqual(['2']);

      await request(http()).delete(`${API}/hotels/passengers/${passengerId}/room`).set(staff.auth).expect(200);
      expect(await prisma.hotelRoom.count({ where: { hotelBookingId: id } })).toBe(0);
      await request(http()).delete(`${API}/hotels/passengers/${passengerId}/room`).set(staff.auth).expect(409);
    });
  });

  describe('gender and nationality', () => {
    const rooming = async (trip: any) => (await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(staff.auth).expect(200)).body;
    const setProfile = (passengerId: string, body: object, session = staff) =>
      request(http()).patch(`${API}/hotels/passengers/${passengerId}/profile`).set(session.auth).send(body);
    const assign = (hotelBookingId: string, passengerIds: string[], extra: object = {}) =>
      request(http()).post(`${API}/hotels/bookings/${hotelBookingId}/rooms`).set(staff.auth).send({ passengerIds, roomNumber: '50', roomType: 'SHARED', ...extra });

    it('lists them, takes the owner\'s from their account, and lets housing staff fill in the rest', async () => {
      const trip = await hotelTrip();
      const { user, booking } = await book(trip, ['1', '2']);
      await prisma.user.update({ where: { id: user.user.id }, data: { gender: 'FEMALE', nationality: 'مصري' } });
      const [owner, companion] = booking.passengers;

      let listed = (await rooming(trip)).passengers;
      expect(listed.find((p: any) => p.passengerId === owner.id)).toMatchObject({ gender: 'FEMALE', nationality: 'مصري', fromAccount: true });
      expect(listed.find((p: any) => p.passengerId === companion.id)).toMatchObject({ gender: null, nationality: null, fromAccount: false });

      await setProfile(companion.id, { gender: 'MALE', nationality: 'غير موجودة' }).expect(400);
      await setProfile(companion.id, { gender: 'MALE', nationality: 'مصري' }, await loginPassenger(app)).expect(403);
      await setProfile(companion.id, { gender: 'MALE', nationality: 'مصري' }).expect(200);
      listed = (await rooming(trip)).passengers;
      expect(listed.find((p: any) => p.passengerId === companion.id)).toMatchObject({ gender: 'MALE', nationality: 'مصري', fromAccount: false });

      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: booking.id, action: 'PASSENGER_UPDATED' } });
      expect(event.after).toMatchObject({ gender: 'MALE', nationality: 'مصري' });
    });

    it('keeps men and women of different bookings out of one shared room, but not a family', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const family = await book(trip, ['1', '2']);
      const man = await book(trip, ['3']);
      const woman = await book(trip, ['4']);
      await prisma.bookingPassenger.update({ where: { id: family.booking.passengers[0].id }, data: { gender: 'MALE' } });
      await prisma.bookingPassenger.update({ where: { id: family.booking.passengers[1].id }, data: { gender: 'FEMALE' } });
      await prisma.bookingPassenger.update({ where: { id: man.booking.passengers[0].id }, data: { gender: 'MALE' } });
      await prisma.bookingPassenger.update({ where: { id: woman.booking.passengers[0].id }, data: { gender: 'FEMALE' } });
      const { id } = await bookHotel(trip, hotel);

      await assign(id, family.booking.passengers.map((p: any) => p.id)).expect(201);
      const refused = await assign(id, [man.booking.passengers[0].id]).expect(409);
      expect(refused.body.message).toContain('رجالًا ونساءً');
      await assign(id, [man.booking.passengers[0].id, woman.booking.passengers[0].id], { roomNumber: '51' }).expect(409);
      // Someone the office chose to place there anyway, knowingly.
      await assign(id, [man.booking.passengers[0].id], { allowMixedGender: true }).expect(201);
    });

    it('saves a whole plan at once, or nothing when one room is refused', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const men = await book(trip, ['1', '2']);
      const women = await book(trip, ['3']);
      const ids = [...men.booking.passengers, ...women.booking.passengers].map((p: any) => p.id);
      await prisma.bookingPassenger.updateMany({ where: { id: { in: ids.slice(0, 2) } }, data: { gender: 'MALE' } });
      await prisma.bookingPassenger.update({ where: { id: ids[2] }, data: { gender: 'FEMALE' } });
      const { id } = await bookHotel(trip, hotel);
      const bulk = (rooms: object[]) => request(http()).post(`${API}/hotels/bookings/${id}/rooms/bulk`).set(staff.auth).send({ rooms });

      await bulk([{ roomNumber: '1', roomType: 'SHARED', capacity: 4, passengerIds: ids }]).expect(409);
      await bulk([
        { roomNumber: '1', roomType: 'SHARED', capacity: 4, passengerIds: [ids[0]] },
        { roomNumber: '1', roomType: 'SHARED', capacity: 4, passengerIds: [ids[1]] },
      ]).expect(400);
      await bulk([
        { roomNumber: '1', roomType: 'SHARED', capacity: 4, passengerIds: [ids[0]] },
        { roomNumber: '2', roomType: 'SHARED', capacity: 4, passengerIds: [ids[0]] },
      ]).expect(400);
      expect(await prisma.bookingPassenger.count({ where: { id: { in: ids }, hotelRoomId: { not: null } } })).toBe(0);

      const saved = await bulk([
        { roomNumber: '1', roomType: 'SHARED', capacity: 4, passengerIds: ids.slice(0, 2) },
        { roomNumber: '2', roomType: 'SHARED', capacity: 2, passengerIds: [ids[2]] },
      ]).expect(201);
      expect(saved.body).toEqual({ rooms: 2, passengers: 3 });
      const rooms = await prisma.hotelRoom.findMany({ where: { hotelBookingId: id }, orderBy: { number: 'asc' }, include: { _count: { select: { occupants: true } } } });
      expect(rooms.map((r) => [r.number, r.capacity, r._count.occupants])).toEqual([['1', 4, 2], ['2', 2, 1]]);
    });
  });

  describe('booking-table shortcut', () => {
    it('finds the trip itself, opens the hotel booking and houses the whole booking', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip({ accommodation: { name: 'x', nights: 3 } });
      const { booking } = await book(trip, ['8', '9']);
      await request(http()).post(`${API}/hotels/assign-booking`).set(staff.auth).send({ bookingId: booking.id, hotelId: hotel.id, roomNumber: '305', roomType: 'PRIVATE' }).expect(201);

      const rooming = await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(staff.auth).expect(200);
      expect(rooming.body.hotelBookings[0].nights).toBe(3);
      expect(rooming.body.passengers.every((p: any) => p.room.number === '305')).toBe(true);
    });

    it('rejects a passenger outside the booking and a booking on a trip without housing', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const mine = await book(trip, ['1']);
      const theirs = await book(trip, ['2']);
      const send = (body: object) => request(http()).post(`${API}/hotels/assign-booking`).set(staff.auth).send({ hotelId: hotel.id, roomNumber: '1', roomType: 'SHARED', ...body });
      await send({ bookingId: mine.booking.id, passengerIds: [theirs.booking.passengers[0].id] }).expect(400);

      const transport = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      const plain = await book(transport, ['1']);
      await send({ bookingId: plain.booking.id }).expect(409);
    });
  });

  describe('cancellation', () => {
    it('releases everyone and takes the cost off, for admins only', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const { booking } = await book(trip, ['4']);
      const { id } = await bookHotel(trip, hotel);
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [booking.passengers[0].id], roomNumber: '1', roomType: 'SHARED' }).expect(201);

      await request(http()).post(`${API}/hotels/bookings/${id}/cancel`).set(staff.auth).send({ reason: 'تغيير الفندق' }).expect(403);
      await request(http()).post(`${API}/hotels/bookings/${id}/cancel`).set(admin.auth).send({ reason: 'تغيير الفندق' }).expect(201);
      await request(http()).post(`${API}/hotels/bookings/${id}/cancel`).set(admin.auth).send({ reason: 'مرة ثانية' }).expect(409);
      const passenger = await prisma.bookingPassenger.findUniqueOrThrow({ where: { id: booking.passengers[0].id } });
      expect(passenger.hotelRoomId).toBeNull();
    });
  });

  describe('overview', () => {
    it('reports cost, sales and profit, and flags trips without a hotel', async () => {
      const departure = new Date('2031-03-15T06:00:00Z');
      const dates = { departureTime: departure.toISOString(), arrivalTime: new Date(departure.getTime() + 18_000_000).toISOString() };
      const hotel = await createHotel(50);
      const booked = await hotelTrip(dates);
      const unbooked = await hotelTrip(dates);
      const a = await book(booked, ['1', '2']);
      await book(unbooked, ['1']);
      const { id } = await bookHotel(booked, hotel, admin, { extraCost: 30 });
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [a.booking.passengers[0].id], roomNumber: '1', roomType: 'SHARED' }).expect(201);

      const res = await request(http()).get(`${API}/hotels/overview?month=2031-03`).set(admin.auth).expect(200);
      const row = res.body.rows.find((r: any) => r.tripCode === booked.tripCode);
      // 1 occupied room × 2 nights × 50 + 30 extra; the unroomed passenger still counts toward sales.
      expect(row.cost).toBe(130);
      expect(row.sales).toBe(80);
      expect(row.profit).toBe(-50);
      expect(row.reference).toMatch(/^HB-\d+$/);
      expect(res.body.rows.find((r: any) => r.tripCode === unbooked.tripCode).status).toBe('NOT_BOOKED');
      expect(res.body.summary.tripsWithoutHotel).toEqual([unbooked.tripCode]);
      await request(http()).get(`${API}/hotels/overview?month=nope`).set(admin.auth).expect(400);
    });
  });

  describe('rooms out of service', () => {
    const inventoryHotel = () => createHotel();
    const block = (hotel: any, body: object, session = admin) =>
      request(http()).post(`${API}/hotels/${hotel.id}/room-blocks`).set(session.auth).send({ roomNumber: '1', type: 'MAINTENANCE', fromDate: '2030-01-10', ...body });
    const stayRooms = (id: string) => prisma.hotelRoom.findMany({ where: { hotelBookingId: id }, orderBy: { number: 'asc' } });

    it('is limited to managers and checks its dates', async () => {
      const hotel = await inventoryHotel();
      await block(hotel, {}, staff).expect(403);
      await block(hotel, { fromDate: '2020-01-01' }).expect(400);
      await block(hotel, { untilDate: '2030-01-10' }).expect(400);
      await block(hotel, { type: 'NOPE' }).expect(400);
      await request(http()).post(`${API}/hotels/missing/room-blocks`).set(admin.auth).send({ roomNumber: '1', type: 'MAINTENANCE', fromDate: '2030-01-10' }).expect(404);
    });

    it('keeps a blocked room out of stays only while the dates overlap', async () => {
      const hotel = await inventoryHotel();
      await block(hotel, { untilDate: '2030-01-11' }).expect(201);
      const place = async (stayExtra: object) => {
        const trip = await hotelTrip();
        const { booking } = await book(trip, ['1']);
        const { id } = await bookHotel(trip, hotel, staff, stayExtra);
        return request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [booking.passengers[0].id], roomNumber: '1', roomType: 'SHARED' });
      };
      expect((await place({})).status).toBe(409);
      expect((await place({ checkIn: '2030-01-11', checkOut: '2030-01-13' })).status).toBe(201);
    });

    it('removes an empty room from a stay so customers cannot be placed in it', async () => {
      const hotel = await inventoryHotel();
      const trip = await hotelTrip();
      const { id } = await bookHotel(trip, hotel);
      await prisma.hotelRoom.createMany({ data: [{ hotelBookingId: id, number: '1' }, { hotelBookingId: id, number: '2' }] });
      await block(hotel, {}).expect(201);
      expect((await stayRooms(id)).map((r) => r.number)).toEqual(['2']);
    });

    it('refuses a room with guests, and refuses placing a guest in a blocked room', async () => {
      const hotel = await inventoryHotel();
      const trip = await hotelTrip();
      const { booking } = await book(trip, ['3']);
      const { id } = await bookHotel(trip, hotel);
      const place = (roomNumber: string) => request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [booking.passengers[0].id], roomNumber, roomType: 'SHARED' });

      await place('1').expect(201);
      const refused = await block(hotel, {}).expect(409);
      expect(refused.body.message).toContain(trip.tripCode);

      await block(hotel, { roomNumber: '2' }).expect(201);
      await place('2').expect(409);
      expect((await prisma.bookingPassenger.findUniqueOrThrow({ where: { id: booking.passengers[0].id }, include: { hotelRoom: true } })).hotelRoom?.number).toBe('1');
    });

    it('allows one period at a time for a room, including an open-ended one', async () => {
      const hotel = await inventoryHotel();
      await block(hotel, {}).expect(201);
      await block(hotel, { fromDate: '2031-06-01', type: 'OUT_OF_SERVICE' }).expect(409);
      await block(hotel, { roomNumber: '2', untilDate: '2030-02-01' }).expect(201);
      await block(hotel, { roomNumber: '2', fromDate: '2030-02-01' }).expect(201);
    });

    it('returns a room to service and shows the state to staff', async () => {
      const hotel = await inventoryHotel();
      const created = (await block(hotel, { notes: 'تسريب مياه' }).expect(201)).body;
      const seen = await request(http()).get(`${API}/hotels/${hotel.id}`).set(staff.auth).expect(200);
      expect(seen.body.roomBlocks[0]).toMatchObject({ roomNumber: '1', type: 'MAINTENANCE', notes: 'تسريب مياه' });

      await request(http()).post(`${API}/hotels/${hotel.id}/room-blocks/${created.id}/release`).set(staff.auth).expect(403);
      await request(http()).post(`${API}/hotels/${hotel.id}/room-blocks/${created.id}/release`).set(admin.auth).expect(201);
      await block(hotel, {}).expect(201);
      await request(http()).post(`${API}/hotels/${hotel.id}/room-blocks/${created.id}/release`).set(admin.auth).expect(409);
    });

    it('ends a running period today, so history stays and the room is free from today', async () => {
      const hotel = await inventoryHotel();
      const riyadhToday = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
      const started = await prisma.hotelRoomBlock.create({ data: { hotelId: hotel.id, roomNumber: '1', type: 'OUT_OF_SERVICE', fromDate: new Date('2026-01-01T00:00:00Z') } });
      await request(http()).post(`${API}/hotels/${hotel.id}/room-blocks/${started.id}/release`).set(admin.auth).expect(201);
      const saved = await prisma.hotelRoomBlock.findUniqueOrThrow({ where: { id: started.id } });
      expect(saved.untilDate?.toISOString().slice(0, 10)).toBe(riyadhToday);
      expect(saved.releasedAt).not.toBeNull();
      expect(saved.releasedByName).toBeTruthy();
    });

    it('counts rooms out of service today on the hotel list', async () => {
      const hotel = await inventoryHotel();
      await prisma.hotelRoomBlock.create({ data: { hotelId: hotel.id, roomNumber: '1', type: 'MAINTENANCE', fromDate: new Date('2026-01-01T00:00:00Z') } });
      await block(hotel, { roomNumber: '2' }).expect(201);
      const list = await request(http()).get(`${API}/hotels/registry`).set(staff.auth).expect(200);
      expect(list.body.find((h: any) => h.id === hotel.id).blockedRooms).toBe(1);
    });
  });

  describe('naming a traveler on a complaint', () => {
    const record = (hotel: any, body: object) =>
      request(http()).post(`${API}/hotels/${hotel.id}/complaints`).set(staff.auth).send({ source: 'HOTEL', subject: 'إزعاج ليلي', details: 'تفاصيل الشكوى', ...body });
    const search = async (hotel: any, q = '') => (await request(http()).get(`${API}/hotels/${hotel.id}/complaint-travelers`).query({ q }).set(staff.auth).expect(200)).body;

    it('finds everyone on the hotel\'s trips, roomed or not, and nobody else', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const roomed = await book(trip, ['1']);
      const unroomed = await book(trip, ['2']);
      const stranger = await book(await hotelTrip(), ['1']);
      const { id } = await bookHotel(trip, hotel);
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [roomed.booking.passengers[0].id], roomNumber: '7', roomType: 'SHARED' }).expect(201);

      const found = await search(hotel);
      expect(found.map((t: any) => t.passengerId).sort()).toEqual([roomed.booking.passengers[0].id, unroomed.booking.passengers[0].id].sort());
      expect(found.find((t: any) => t.passengerId === roomed.booking.passengers[0].id).roomNumber).toBe('7');
      expect(found.find((t: any) => t.passengerId === unroomed.booking.passengers[0].id).roomNumber).toBeNull();
      expect(found.some((t: any) => t.passengerId === stranger.booking.passengers[0].id)).toBe(false);

      expect((await search(hotel, roomed.booking.bookingReference))).toHaveLength(1);
      expect(await search(hotel, 'لا يوجد هذا الاسم')).toEqual([]);
      const customer = await loginPassenger(app);
      await request(http()).get(`${API}/hotels/${hotel.id}/complaint-travelers`).set(customer.auth).expect(403);
    });

    it('accepts a traveler who left their room and keeps the room they were in', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const { booking } = await book(trip, ['4']);
      const { id } = await bookHotel(trip, hotel);
      const passengerId = booking.passengers[0].id;
      await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(staff.auth).send({ passengerIds: [passengerId], roomNumber: '9', roomType: 'SHARED' }).expect(201);

      const whileRoomed = (await record(hotel, { passengerId }).expect(201)).body;
      await request(http()).delete(`${API}/hotels/passengers/${passengerId}/room`).set(staff.auth).expect(200);
      const afterLeaving = (await record(hotel, { passengerId }).expect(201)).body;

      const saved = await prisma.hotelComplaint.findUniqueOrThrow({ where: { id: whileRoomed.id } });
      expect(saved).toMatchObject({ roomNumber: '9', travelerName: 'مسافر 4', bookingId: booking.id, hotelBookingId: id });
      expect(await prisma.hotelComplaint.findUniqueOrThrow({ where: { id: afterLeaving.id } })).toMatchObject({ roomNumber: null, travelerName: 'مسافر 4', hotelBookingId: id });
    });

    it('refuses someone from another hotel\'s trip, and accepts a typed name', async () => {
      const hotel = await createHotel();
      const stranger = await book(await hotelTrip(), ['5']);
      await record(hotel, { passengerId: stranger.booking.passengers[0].id }).expect(400);
      await record(hotel, { passengerId: 'missing' }).expect(404);

      const typed = (await record(hotel, { travelerName: 'ضيف غير مسجل', roomNumber: '12' }).expect(201)).body;
      expect(await prisma.hotelComplaint.findUniqueOrThrow({ where: { id: typed.id } })).toMatchObject({ travelerName: 'ضيف غير مسجل', roomNumber: '12', passengerId: null });
    });
  });

  describe('complaints from the app', () => {
    const complaintsOf = (session: any, bookingId: string) => request(http()).get(`${API}/bookings/${bookingId}/hotel-complaints`).set(session.auth);
    const send = (session: any, bookingId: string, body: object) =>
      request(http()).post(`${API}/bookings/${bookingId}/hotel-complaints`).set(session.auth).send({ subject: 'نظافة الغرفة', details: 'الغرفة غير نظيفة', ...body });

    const housedBooking = async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip();
      const stay = await bookHotel(trip, hotel);
      const { user, booking } = await book(trip, ['6', '7']);
      return { hotel, trip, stay, user, booking };
    };

    it('lets the owner complain even before a room is assigned, and tells staff', async () => {
      const { hotel, stay, user, booking } = await housedBooking();
      const options = await complaintsOf(user, booking.id).expect(200);
      expect(options.body.hotels).toEqual([{ hotelBookingId: stay.id, name: hotel.name, city: 'مكة' }]);

      const sent = await send(user, booking.id, { hotelBookingId: stay.id, passengerId: booking.passengers[1].id }).expect(201);
      expect(sent.body.reference).toMatch(/^HC-\d+$/);

      const saved = await prisma.hotelComplaint.findUniqueOrThrow({ where: { id: sent.body.id } });
      expect(saved).toMatchObject({ hotelId: hotel.id, source: 'TRAVELER', submittedByTraveler: true, bookingId: booking.id, passengerId: booking.passengers[1].id, status: 'OPEN' });
      expect(await prisma.notification.count({ where: { event: 'STAFF_HOTEL_COMPLAINT', body: { contains: hotel.name } } })).toBeGreaterThan(0);

      const seenByStaff = await request(http()).get(`${API}/hotels/${hotel.id}`).set(staff.auth).expect(200);
      expect(seenByStaff.body.complaints[0]).toMatchObject({ id: sent.body.id, submittedByTraveler: true, bookingId: booking.id });
    });

    it('keeps other customers out, whichever booking they guess', async () => {
      const { stay, booking } = await housedBooking();
      const someoneElse = await loginPassenger(app);
      await complaintsOf(someoneElse, booking.id).expect(404);
      await send(someoneElse, booking.id, { hotelBookingId: stay.id }).expect(404);
      await request(http()).get(`${API}/bookings/${booking.id}/hotel-complaints`).expect(401);
    });

    it('refuses another trip\'s hotel, another booking\'s passenger, and bad input', async () => {
      const { user, booking, stay } = await housedBooking();
      const other = await housedBooking();
      await send(user, booking.id, { hotelBookingId: other.stay.id }).expect(400);
      await send(user, booking.id, { hotelBookingId: stay.id, passengerId: other.booking.passengers[0].id }).expect(400);
      await send(user, booking.id, { hotelBookingId: stay.id, details: ' ' }).expect(400);
    });

    it('closes the door on a cancelled booking and limits open complaints', async () => {
      const { user, booking, stay } = await housedBooking();
      for (let i = 0; i < 5; i++) await send(user, booking.id, { hotelBookingId: stay.id }).expect(201);
      await send(user, booking.id, { hotelBookingId: stay.id }).expect(409);

      await request(http()).post(`${API}/bookings/${booking.id}/admin-cancel`).set(admin.auth).send({ note: 'قرار إداري' }).expect(201);
      await send(user, booking.id, { hotelBookingId: stay.id }).expect(409);
      expect((await complaintsOf(user, booking.id).expect(200)).body.hotels).toEqual([]);
    });

    it('sends the reply to the customer, and shows only what they sent', async () => {
      const { hotel, user, booking, stay } = await housedBooking();
      const sent = (await send(user, booking.id, { hotelBookingId: stay.id }).expect(201)).body;
      const fromHotel = await request(http())
        .post(`${API}/hotels/${hotel.id}/complaints`)
        .set(staff.auth)
        .send({ source: 'HOTEL', subject: 'سلوك النزيل السري', details: 'شكوى داخلية سرية', passengerId: booking.passengers[0].id })
        .expect(201);
      const byPhone = await request(http())
        .post(`${API}/hotels/${hotel.id}/complaints`)
        .set(staff.auth)
        .send({ source: 'TRAVELER', subject: 'اتصال هاتفي داخلي', details: 'سجلها الموظف', passengerId: booking.passengers[0].id })
        .expect(201);

      const before = await complaintsOf(user, booking.id).expect(200);
      expect(before.body.complaints.map((c: any) => c.id)).toEqual([sent.id]);
      const text = JSON.stringify(before.body);
      for (const secret of ['سلوك النزيل السري', 'شكوى داخلية سرية', 'اتصال هاتفي داخلي', 'createdByName', 'resolvedByName', 'nightlyRate']) {
        expect(text).not.toContain(secret);
      }

      const close = (id: string, resolution: string) => request(http()).post(`${API}/hotels/${hotel.id}/complaints/${id}/resolve`).set(admin.auth).send({ resolution }).expect(201);
      await close(fromHotel.body.id, 'تنبيه داخلي للفريق');
      await close(byPhone.body.id, 'رد داخلي آخر');
      expect(await prisma.notification.count({ where: { userId: user.user.id, event: 'HOTEL_COMPLAINT_RESOLVED' } })).toBe(0);

      await close(sent.id, 'تم تنظيف الغرفة والاعتذار');
      const notices = await prisma.notification.findMany({ where: { userId: user.user.id, event: 'HOTEL_COMPLAINT_RESOLVED' } });
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toContain('تم تنظيف الغرفة والاعتذار');
      expect(notices[0].bookingId).toBe(booking.id);

      const after = await complaintsOf(user, booking.id).expect(200);
      expect(after.body.complaints[0]).toMatchObject({ status: 'RESOLVED', resolution: 'تم تنظيف الغرفة والاعتذار', hotelName: hotel.name });
    });

    it('does not put hotel complaints in the customer booking response', async () => {
      const { hotel, user, booking } = await housedBooking();
      await request(http()).post(`${API}/hotels/${hotel.id}/complaints`).set(staff.auth).send({ source: 'HOTEL', subject: 'موضوع سري جدا', details: 'تفاصيل سرية جدا', passengerId: booking.passengers[0].id }).expect(201);
      const res = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('موضوع سري جدا');
    });
  });

  describe('what the customer sees', () => {
    it('shows their room and updates, and nothing internal', async () => {
      const hotel = await createHotel();
      const trip = await hotelTrip({ busRentalPrice: 1800 });
      const { user, booking } = await book(trip, ['5']);
      const passengerId = booking.passengers[0].id;
      await request(http())
        .patch(`${API}/bookings/admin/${booking.id}/passengers/${passengerId}`)
        .set(staff.auth)
        .send({ nationalId: 'SECRETID1', notes: 'ملاحظة داخلية', reason: 'سبب داخلي', expectedUpdatedAt: booking.updatedAt })
        .expect(200);
      await request(http()).post(`${API}/hotels/assign-booking`).set(staff.auth).send({ bookingId: booking.id, hotelId: hotel.id, roomNumber: '210', roomType: 'SHARED', roomNote: 'المصعد الشرقي' }).expect(201);

      const res = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      const passenger = res.body.passengers[0];
      expect(passenger.hotelRoom.number).toBe('210');
      expect(passenger.hotelRoom.hotelBooking.hotel.name).toBe(hotel.name);
      expect(passenger.roomNote).toBe('المصعد الشرقي');
      expect(res.body.updates.some((u: any) => u.type === 'ROOM_ASSIGNED' && u.message.includes('210'))).toBe(true);

      const text = JSON.stringify(res.body);
      for (const secret of ['SECRETID1', 'ملاحظة داخلية', 'سبب داخلي', 'nightlyRate', 'busRentalPrice', 'actorName']) {
        expect(text).not.toContain(secret);
      }
      const list = await request(http()).get(`${API}/bookings`).set(user.auth).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('SECRETID1');
    });

    it('keeps internal trip numbers out of the public API', async () => {
      const trip = await hotelTrip({ busRentalPrice: 1800, reverseEnabled: false });
      const res = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(res.body.busRentalPrice).toBeUndefined();
      expect(res.body.housingPrice).toBeUndefined();
      const search = await request(http()).get(`${API}/trips/search`).expect(200);
      expect(JSON.stringify(search.body)).not.toContain('busRentalPrice');
    });

    it('withholds boarding tokens from staff but not from the owner', async () => {
      const trip = await hotelTrip();
      const { user, booking } = await book(trip, ['6']);
      const asStaff = await request(http()).get(`${API}/bookings/${booking.id}`).set(staff.auth).expect(200);
      expect(asStaff.body.passengers[0].ticket.signedToken).toBeUndefined();
      const tickets = await request(http()).get(`${API}/tickets/booking/${booking.id}`).set(staff.auth).expect(200);
      expect(tickets.body[0].signedToken).toBeUndefined();
      const asOwner = await request(http()).get(`${API}/bookings/${booking.id}`).set(user.auth).expect(200);
      expect(asOwner.body.passengers[0].ticket.signedToken).toBeTruthy();
    });
  });

  describe('photos', () => {
    const photo = () => `/trips/images/${randomUUID()}`;
    const urlsOf = (hotel: any) => hotel.images.map((image: any) => image.url);
    const patch = (hotel: any, body: object, session = admin) => request(http()).patch(`${API}/hotels/${hotel.id}`).set(session.auth).send(body);

    it('keeps the gallery in the order sent, everywhere staff see the hotel', async () => {
      const gallery = [photo(), photo(), photo()];
      const created = (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق ${++hotelCounter}`, city: 'مكة', images: gallery }).expect(201)).body;
      expect(urlsOf(created)).toEqual(gallery);

      const list = await request(http()).get(`${API}/hotels`).set(staff.auth).expect(200);
      expect(urlsOf(list.body.find((h: any) => h.id === created.id))).toEqual(gallery);
      const registry = await request(http()).get(`${API}/hotels/registry`).set(staff.auth).expect(200);
      expect(urlsOf(registry.body.find((h: any) => h.id === created.id))).toEqual(gallery);
      const detail = await request(http()).get(`${API}/hotels/${created.id}`).set(staff.auth).expect(200);
      expect(urlsOf(detail.body.hotel)).toEqual(gallery);
    });

    it('reorders, removes and leaves the gallery alone when it is not sent', async () => {
      const [a, b, c] = [photo(), photo(), photo()];
      const hotel = await createHotel();
      expect(urlsOf((await patch(hotel, { images: [a, b, c] }).expect(200)).body)).toEqual([a, b, c]);
      expect(urlsOf((await patch(hotel, { images: [c, a] }).expect(200)).body)).toEqual([c, a]);
      expect(urlsOf((await patch(hotel, { description: 'قريب من الحرم' }).expect(200)).body)).toEqual([c, a]);
      expect(urlsOf((await patch(hotel, { images: [] }).expect(200)).body)).toEqual([]);
      expect(await prisma.hotelImage.count({ where: { hotelId: hotel.id } })).toBe(0);
    });

    it('refuses too many photos, repeats, and anything but an uploaded photo or a web address', async () => {
      const hotel = await createHotel();
      await patch(hotel, { images: Array.from({ length: 11 }, photo) }).expect(400);
      const same = photo();
      await patch(hotel, { images: [same, same] }).expect(400);
      await patch(hotel, { images: ['javascript:alert(1)'] }).expect(400);
      await patch(hotel, { images: ['/trips/images/../../etc/passwd'] }).expect(400);
      await patch(hotel, { images: [photo()] }, staff).expect(403);
      expect(await prisma.hotelImage.count({ where: { hotelId: hotel.id } })).toBe(0);
    });

    it('lets hotel managers upload photos, and keeps everyone else out', async () => {
      const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
      // A rank that manages hotels and nothing else that uploads photos.
      const rank = await prisma.rank.create({ data: { name: `فنادق فقط ${Date.now()}`, role: 'STAFF', jobId: 'job-office', permissions: ['hotels.view', 'hotels.manage'] } });
      const manager = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, rank.id)).phone);
      const upload = await request(http()).post(`${API}/trips/images`).set(manager.auth).attach('images', PNG, 'hotel.png').expect(201);
      const hotel = await createHotel();
      expect(urlsOf((await patch(hotel, { images: [upload.body[0].url] }, manager).expect(200)).body)).toEqual([upload.body[0].url]);
      await request(http()).post(`${API}/trips/images`).set(staff.auth).attach('images', PNG, 'hotel.png').expect(403);
      // Signed in first: logging in halfway through building this request would close the server it was opened on.
      const passenger = await loginPassenger(app);
      await request(http()).post(`${API}/trips/images`).set(passenger.auth).attach('images', PNG, 'hotel.png').expect(403);
    });

    it('shows customers the photos of the trip\'s hotel and of a custom package\'s hotel, and nothing else of them', async () => {
      const gallery = [photo(), photo()];
      const hotel = (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق ${++hotelCounter}`, city: 'مكة', nightlyRate: 75, images: gallery }).expect(201)).body;
      const trip = await hotelTrip();
      await bookHotel(trip, hotel);

      const seen = (await request(http()).get(`${API}/trips/${trip.id}`).expect(200)).body;
      expect(seen.hotelBookings[0].hotel.images).toEqual(gallery.map((url) => ({ url })));
      expect(JSON.stringify(seen.hotelBookings[0].hotel.images)).not.toContain('sortOrder');

      await prisma.package.create({
        data: { name: 'صمم باقتك', kind: 'CUSTOM', status: 'PUBLISHED', price: 0, price2: 0, price3: 0, price4: 0, origin: 'ينبع', destination: 'مكة المكرمة', hotelId: hotel.id, nightlyBedPrice: 50, minDepartureHour: 0 },
      });
      const custom = (await request(http()).get(`${API}/packages/custom`).expect(200)).body;
      expect(custom.find((pkg: any) => pkg.hotel?.name === hotel.name).hotel.images).toEqual(gallery.map((url) => ({ url })));
    });

    it('goes with the hotel when the hotel is deleted', async () => {
      const hotel = await createHotel();
      await patch(hotel, { images: [photo()] }).expect(200);
      await prisma.hotel.delete({ where: { id: hotel.id } });
      expect(await prisma.hotelImage.count({ where: { hotelId: hotel.id } })).toBe(0);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Supervisor room placement and the housing sheet (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let counter = 0;

  /** A published housing trip with its hotel and an assigned supervisor, already open to the crew. */
  const scenario = async (overrides = {}) => {
    const hotel = (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق تسكين ${++counter}`, city: 'مكة' }).expect(201)).body;
    const trip = (
      await request(http())
        .post(`${API}/trips`)
        .set(admin.auth)
        .send(tripPayload({ bookingType: 'WITH_HOTEL', tripStatus: 'PUBLISHED', accommodation: { name: hotel.name, nights: 2, hotelId: hotel.id }, ...overrides }))
        .expect(201)
    ).body;
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    return { trip, staff, session: await loginStaff(app, staff.phone) };
  };

  const book = async (trip: any, seats: string[], roomChoice: string) => {
    const customer = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats, roomChoice }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })) })
        .expect(201)
    ).body.bookings[0];
    return { booking, customer };
  };

  const place = (session: any, trip: any, passenger: any, body: object) =>
    request(http()).post(`${API}/crew/trips/${trip.id}/passengers/${passenger.id}/room`).set(session.auth).send(body);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives the permission to supervisors and not to drivers', async () => {
    const ranks = await prisma.rank.findMany({ where: { id: { in: ['rank-supervisor', 'rank-driver'] } } });
    expect(ranks.find((rank) => rank.id === 'rank-supervisor')!.permissions).toContain('crew.housing');
    expect(ranks.find((rank) => rank.id === 'rank-driver')!.permissions).not.toContain('crew.housing');
  });

  it('places one passenger, takes the type from the booking, tells the customer, and leaves the others', async () => {
    const { trip, session } = await scenario();
    const { booking, customer } = await book(trip, ['1', '2'], 'SHARED');

    const res = await place(session, trip, booking.passengers[0], { roomNumber: ' 305 ' }).expect(201);
    expect(res.body).toEqual({ roomNumber: '305', roomType: 'SHARED', passengers: 1 });

    const passengers = await prisma.bookingPassenger.findMany({ where: { bookingId: booking.id }, include: { hotelRoom: true } });
    expect(passengers.find((p) => p.id === booking.passengers[0].id)!.hotelRoom).toMatchObject({ number: '305', type: 'SHARED' });
    expect(passengers.find((p) => p.id === booking.passengers[1].id)!.hotelRoom).toBeNull();

    const seen = await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200);
    expect(seen.body.passengers.find((p: any) => p.id === booking.passengers[0].id).hotelRoom.number).toBe('305');
    const notices = await prisma.notification.findMany({ where: { userId: customer.user?.id ?? booking.userId } });
    expect(notices.some((n) => n.body.includes('305'))).toBe(true);
  });

  it('mixes customers who chose shared, up to the capacity the trip set', async () => {
    const { trip, session } = await scenario({ sharedRoomCapacity: 2 });
    const first = await book(trip, ['1'], 'SHARED');
    const second = await book(trip, ['2'], 'SHARED');
    const third = await book(trip, ['3'], 'SHARED');

    await place(session, trip, first.booking.passengers[0], { roomNumber: '10' }).expect(201);
    await place(session, trip, second.booking.passengers[0], { roomNumber: '10' }).expect(201);
    const full = await place(session, trip, third.booking.passengers[0], { roomNumber: '10' }).expect(409);
    expect(full.body.message).toContain('تتسع لـ 2');
  });

  it('applies a capacity the admin raises to shared rooms already in use', async () => {
    const { trip, session } = await scenario({ sharedRoomCapacity: 1 });
    const first = await book(trip, ['1'], 'SHARED');
    const second = await book(trip, ['2'], 'SHARED');
    await place(session, trip, first.booking.passengers[0], { roomNumber: '11' }).expect(201);
    await place(session, trip, second.booking.passengers[0], { roomNumber: '11' }).expect(409);

    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ sharedRoomCapacity: 2 }).expect(200);
    await place(session, trip, second.booking.passengers[0], { roomNumber: '11' }).expect(201);
  });

  it('keeps a private room to one booking, whichever way the supervisor splits it', async () => {
    const { trip, session } = await scenario({ privateRoomCapacity: 2, privateRoomPrice: 50 });
    const family = await book(trip, ['1', '2', '3'], 'PRIVATE');
    const other = await book(trip, ['4'], 'PRIVATE');

    const all = await place(session, trip, family.booking.passengers[0], { roomNumber: '20', wholeBooking: true }).expect(201);
    expect(all.body.passengers).toBe(3);
    await place(session, trip, other.booking.passengers[0], { roomNumber: '20' }).expect(409);

    await place(session, trip, family.booking.passengers[2], { roomNumber: '21' }).expect(201);
    const rooms = await prisma.bookingPassenger.findMany({ where: { bookingId: family.booking.id }, include: { hotelRoom: true } });
    expect(rooms.map((p) => p.hotelRoom!.number).sort()).toEqual(['20', '20', '21']);
  });

  it('never mixes the two room types, and whole-booking is for private rooms only', async () => {
    const { trip, session } = await scenario();
    const shared = await book(trip, ['1', '2'], 'SHARED');
    const privately = await book(trip, ['3'], 'PRIVATE');

    await place(session, trip, shared.booking.passengers[0], { roomNumber: '30', wholeBooking: true }).expect(400);
    await place(session, trip, shared.booking.passengers[0], { roomNumber: '30' }).expect(201);
    await place(session, trip, privately.booking.passengers[0], { roomNumber: '30' }).expect(409);
  });

  it('refuses a passenger already in that room, so the customer is not told twice', async () => {
    const { trip, session } = await scenario();
    const { booking } = await book(trip, ['1'], 'SHARED');
    await place(session, trip, booking.passengers[0], { roomNumber: '40' }).expect(201);
    await place(session, trip, booking.passengers[0], { roomNumber: '40' }).expect(409);
    await place(session, trip, booking.passengers[0], { roomNumber: '41' }).expect(201);
    expect(await prisma.hotelRoom.count({ where: { number: '40', hotelBooking: { tripId: trip.id } } })).toBe(0);
  });

  it('is for the supervisor of this trip only, and only once it is open to them', async () => {
    const { trip, staff, session } = await scenario();
    const { booking } = await book(trip, ['1'], 'SHARED');

    const outsider = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
    await place(outsider, trip, booking.passengers[0], { roomNumber: '50' }).expect(403);

    const driverUser = await createStaff(prisma, 'STAFF', undefined, 'rank-driver');
    await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driverUser.id, isPrimary: true } });
    await place(await loginStaff(app, driverUser.phone), trip, booking.passengers[0], { roomNumber: '50' }).expect(403);

    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 72 * 3_600_000), arrivalTime: new Date(Date.now() + 77 * 3_600_000), crewOpensBeforeMinutes: 60, boardingOpensBeforeMinutes: 30 } });
    await place(session, trip, booking.passengers[0], { roomNumber: '50' }).expect(409);
    expect(staff.id).toBeTruthy();
  });

  it('refuses a passenger of another trip, and a finished trip', async () => {
    const { trip, session } = await scenario();
    const elsewhere = await scenario();
    const { booking } = await book(elsewhere.trip, ['1'], 'SHARED');
    await place(session, trip, booking.passengers[0], { roomNumber: '60' }).expect(404);

    const own = await book(trip, ['1'], 'SHARED');
    await prisma.trip.update({ where: { id: trip.id }, data: { tripStatus: 'COMPLETED' } });
    await place(session, trip, own.booking.passengers[0], { roomNumber: '60' }).expect(409);
  });

  it('shows the crew who needs a room and which one they have', async () => {
    const { trip, session } = await scenario();
    const { booking } = await book(trip, ['1', '2'], 'PRIVATE');
    await place(session, trip, booking.passengers[0], { roomNumber: '70' }).expect(201);

    const manifest = (await request(http()).get(`${API}/tickets/manifest/${trip.id}`).set(session.auth).expect(200)).body;
    const row = manifest.passengers.find((p: any) => p.passengerId === booking.passengers[0].id);
    expect(row).toMatchObject({ needsRoom: true, roomChoice: 'PRIVATE', roomNumber: '70', roomType: 'PRIVATE', bookingPassengers: 2 });
    expect(manifest.passengers.find((p: any) => p.passengerId === booking.passengers[1].id).roomNumber).toBeNull();
  });

  it('counts beds and rooms from what was booked, before anyone is placed', async () => {
    const { trip } = await scenario({ sharedRoomCapacity: 4, privateRoomCapacity: 2, privateRoomPrice: 50 });
    await book(trip, ['1', '2', '3', '4', '5'], 'SHARED');
    await book(trip, ['6', '7', '8'], 'PRIVATE');
    await book(trip, ['9'], 'PRIVATE');

    const { housing, passengers } = (await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200)).body;
    expect(housing).toMatchObject({
      persons: 9,
      sharedBeds: 5,
      estimatedSharedRooms: 2,
      privateBeds: 4,
      privateBookings: 2,
      // Three people at two a room need two rooms, and the single traveler one.
      estimatedPrivateRooms: 3,
      sharedRooms: 0,
      privateRooms: 0,
      unassigned: 9,
    });
    expect(passengers.every((p: any) => p.isHoused)).toBe(true);
    expect(housing.stays[0].nights).toBe(2);
  });

  it('saves what goes to the hotel on the trip, keeps out what it should not, and hides it from customers', async () => {
    const { trip } = await scenario();
    const { booking } = await book(trip, ['1'], 'SHARED');
    const url = `${API}/manifests/${trip.id}/housing-sheet`;

    await request(http()).put(url).set(admin.auth).send({ columns: ['nope'] }).expect(400);
    await request(http())
      .put(url)
      .set(admin.auth)
      .send({ columns: ['room', 'room', 'hotelNote'], note: ' وصول متأخر ', passengerNotes: { [booking.passengers[0].id]: ' سرير سفلي ', 'not-on-trip': 'لا يُحفظ' } })
      .expect(200);

    const { sheet } = (await request(http()).get(`${API}/manifests/${trip.id}`).set(admin.auth).expect(200)).body.housing;
    expect(sheet).toMatchObject({ columns: ['room', 'hotelNote'], note: 'وصول متأخر', passengerNotes: { [booking.passengers[0].id]: 'سرير سفلي' } });

    const customer = await loginPassenger(app);
    await request(http()).put(url).set(customer.auth).send({ columns: [] }).expect(403);
    const publicTrip = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
    expect(JSON.stringify(publicTrip.body)).not.toContain('سرير سفلي');
    expect(publicTrip.body.sharedRoomCapacity).toBeUndefined();
  });
});

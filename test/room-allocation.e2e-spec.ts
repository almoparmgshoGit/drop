import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Room type at booking time (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;
  let hotelCounter = 0;

  const createHotel = async (extra: object = {}) =>
    (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق توزيع ${++hotelCounter}`, city: 'مكة', ...extra }).expect(201)).body;

  /** A published trip with its hotel already chosen. */
  const tripWithHotel = async (hotel: any, overrides = {}) =>
    (
      await request(http())
        .post(`${API}/trips`)
        .set(admin.auth)
        .send(tripPayload({ bookingType: 'WITH_HOTEL', housingPrice: 40, tripStatus: 'PUBLISHED', accommodation: { name: hotel.name, nights: 2, hotelId: hotel.id }, ...overrides }))
        .expect(201)
    ).body;

  const quote = async (session: any, trip: any, seats: string[], roomChoice?: string) =>
    (await request(http()).post(`${API}/bookings/quote`).set(session.auth).send({ legs: [{ tripId: trip.id, seats, roomChoice }] }).expect(201)).body;

  const book = (session: any, trip: any, seats: string[], roomChoice?: string) =>
    request(http())
      .post(`${API}/bookings`)
      .set(session.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats, roomChoice }], passengers: seats.map((s) => ({ fullName: `مسافر ${s}` })) });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows the customer the place, its features and the room types, and nothing about stock or cost', async () => {
    const hotel = await createHotel({ nightlyRate: 98765.43, description: 'قريب من الحرم', address: 'العزيزية', features: ['إفطار', 'نقل للحرم'], rateUnit: 'BED' });
    const trip = await tripWithHotel(hotel);

    const preview = await quote(await loginPassenger(app), trip, ['1']);
    expect(preview.legs[0].housing).toEqual({
      name: hotel.name,
      city: 'مكة',
      address: 'العزيزية',
      description: 'قريب من الحرم',
      features: ['إفطار', 'نقل للحرم'],
      services: [expect.objectContaining({ name: 'إفطار' }), expect.objectContaining({ name: 'نقل للحرم' })],
      options: ['SHARED', 'PRIVATE'],
      optionAmounts: { SHARED: 0, PRIVATE: 0 },
      choice: null,
      // The stay is part of this trip's price, so it cannot be left out.
      canSkip: false,
      withoutHousing: false,
    });

    const publicTrip = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
    expect(publicTrip.body.hotelBookings[0].hotel).toMatchObject({ name: hotel.name, features: ['إفطار', 'نقل للحرم'] });
    for (const text of [JSON.stringify(preview), JSON.stringify(publicTrip.body)]) {
      for (const secret of ['nightlyRate', '98765', 'rateUnit', 'capacity']) expect(text).not.toContain(secret);
    }
  });

  it('makes the customer pick when both types are offered, and keeps the choice on the booking', async () => {
    const trip = await tripWithHotel(await createHotel());
    const customer = await loginPassenger(app);

    await book(customer, trip, ['1']).expect(400);
    expect(await prisma.booking.count({ where: { tripId: trip.id } })).toBe(0);
    expect(await prisma.seat.count({ where: { tripId: trip.id, isBooked: true } })).toBe(0);

    const res = await book(customer, trip, ['1', '2'], 'PRIVATE').expect(201);
    expect(res.body.bookings[0].roomChoice).toBe('PRIVATE');
  });

  it('offers only what the hotel enabled, and needs no choice when one type is left', async () => {
    const privateOnly = await createHotel({ offersSharedRoom: false });
    const trip = await tripWithHotel(privateOnly);
    const customer = await loginPassenger(app);

    const preview = await quote(customer, trip, ['1']);
    expect(preview.legs[0].housing).toMatchObject({ options: ['PRIVATE'], choice: 'PRIVATE' });
    await book(customer, trip, ['1'], 'SHARED').expect(400);
    const res = await book(customer, trip, ['1']).expect(201);
    expect(res.body.bookings[0].roomChoice).toBe('PRIVATE');
  });

  it('refuses a hotel offering no room type at all', async () => {
    await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: 'بلا خيارات', city: 'مكة', offersSharedRoom: false, offersPrivateRoom: false }).expect(400);
    const hotel = await createHotel({ offersPrivateRoom: false });
    await request(http()).patch(`${API}/hotels/${hotel.id}`).set(admin.auth).send({ offersSharedRoom: false }).expect(400);
  });

  it('never limits bookings by rooms: only seats limit them, and nobody is placed in a room automatically', async () => {
    const trip = await tripWithHotel(await createHotel());
    for (let seat = 1; seat <= 12; seat++) {
      const res = await book(await loginPassenger(app), trip, [String(seat)], 'SHARED').expect(201);
      expect(res.body.bookings[0].passengers[0].hotelRoom).toBeNull();
    }
    await book(await loginPassenger(app), trip, ['1'], 'SHARED').expect(409);
    expect(await prisma.hotelRoom.count({ where: { hotelBooking: { tripId: trip.id } } })).toBe(0);
  });

  it('shows staff what each customer asked for, and staff then set the room and its capacity', async () => {
    const trip = await tripWithHotel(await createHotel());
    const res = await book(await loginPassenger(app), trip, ['1', '2'], 'SHARED').expect(201);
    const rooming = await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(admin.auth).expect(200);
    expect(rooming.body.passengers.map((p: any) => p.roomChoice)).toEqual(['SHARED', 'SHARED']);

    await request(http())
      .post(`${API}/hotels/bookings/${rooming.body.hotelBookings[0].id}/rooms`)
      .set(admin.auth)
      .send({ passengerIds: res.body.bookings[0].passengers.map((p: any) => p.id), roomNumber: '305', roomType: 'SHARED', capacity: 6 })
      .expect(201);
    const room = await prisma.hotelRoom.findFirstOrThrow({ where: { hotelBooking: { tripId: trip.id } }, include: { occupants: true } });
    expect(room).toMatchObject({ number: '305', capacity: 6 });
    expect(room.occupants).toHaveLength(2);
  });

  it('bills a stay by the room or by the bed, as the hotel was registered', async () => {
    const bill = async (rateUnit: string) => {
      const trip = await tripWithHotel(await createHotel({ nightlyRate: 100, rateUnit }));
      const res = await book(await loginPassenger(app), trip, ['1', '2', '3'], 'SHARED').expect(201);
      const rooming = await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(admin.auth).expect(200);
      await request(http())
        .post(`${API}/hotels/bookings/${rooming.body.hotelBookings[0].id}/rooms`)
        .set(admin.auth)
        .send({ passengerIds: res.body.bookings[0].passengers.map((p: any) => p.id), roomNumber: '1', roomType: 'SHARED' })
        .expect(201);
      return (await request(http()).get(`${API}/hotels/trips/${trip.id}`).set(admin.auth).expect(200)).body.hotelBookings[0];
    };
    // 1 room × 2 nights × 100.
    expect((await bill('ROOM')).cost).toBe(200);
    // 3 beds × 2 nights × 100.
    expect((await bill('BED')).cost).toBe(600);
  });

  it('keeps a stay billed the way it was booked when the contract changes later', async () => {
    const hotel = await createHotel({ nightlyRate: 100, rateUnit: 'ROOM' });
    const trip = await tripWithHotel(hotel);
    await request(http()).patch(`${API}/hotels/${hotel.id}`).set(admin.auth).send({ rateUnit: 'BED', nightlyRate: 50 }).expect(200);
    const stay = await prisma.hotelBooking.findFirstOrThrow({ where: { tripId: trip.id } });
    expect(stay.rateUnit).toBe('ROOM');
    expect(Number(stay.nightlyRate)).toBe(100);
  });

  it('removes a room once its last guest leaves or cancels', async () => {
    const trip = await tripWithHotel(await createHotel());
    const res = await book(await loginPassenger(app), trip, ['1'], 'SHARED').expect(201);
    const { id } = await prisma.hotelBooking.findFirstOrThrow({ where: { tripId: trip.id } });
    await request(http()).post(`${API}/hotels/bookings/${id}/rooms`).set(admin.auth).send({ passengerIds: [res.body.bookings[0].passengers[0].id], roomNumber: '9', roomType: 'SHARED' }).expect(201);
    await request(http()).post(`${API}/bookings/${res.body.bookings[0].id}/admin-cancel`).set(admin.auth).send({ note: 'إلغاء للتجربة' }).expect(201);
    expect(await prisma.hotelRoom.count({ where: { hotelBookingId: id } })).toBe(0);
  });

  it('still lets customers book a housing trip with no hotel chosen, and asks them nothing', async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ bookingType: 'WITH_HOTEL', accommodation: { name: 'لاحقًا', nights: 1 } })).expect(201)).body;
    const customer = await loginPassenger(app);
    expect((await quote(customer, trip, ['1'])).legs[0].housing).toBeNull();
    const res = await book(customer, trip, ['1']).expect(201);
    expect(res.body.bookings[0].roomChoice).toBeNull();
  });

  it('adds nothing to transport-only trips', async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ tripStatus: 'PUBLISHED' })).expect(201)).body;
    const preview = await quote(await loginPassenger(app), trip, ['1']);
    expect(preview.legs[0].housing).toBeNull();
  });
});

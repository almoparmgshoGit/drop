import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

describe('Housing prices chosen by the admin', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: { auth: Record<string, string> };
  let customer: { auth: Record<string, string> };
  let hotelCounter = 0;

  const createHotel = async (overrides = {}) =>
    (await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: `فندق ${++hotelCounter}`, city: 'مكة', ...overrides }).expect(201)).body;

  const createTrip = async (hotel: any, overrides = {}) =>
    (
      await request(http())
        .post(`${API}/trips`)
        .set(admin.auth)
        .send(tripPayload({ bookingType: 'WITH_HOTEL', price: 200, accommodation: { name: hotel.name, nights: 3, hotelId: hotel.id }, ...overrides }))
        .expect(201)
    ).body;

  const quote = async (trip: any, seats: string[], roomChoice?: string) =>
    (await request(http()).post(`${API}/bookings/quote`).set(customer.auth).send({ legs: [{ tripId: trip.id, seats, roomChoice }] }).expect(201)).body;

  const FIVE = ['1', '2', '3', '4', '5'];
  const ADDED = { housingPriceMode: 'ADDED_TO_BASE', housingPrice: 100, privateRoomPrice: 300, privateRoomCapacity: 4 };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    customer = await loginPassenger(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('adds the bed price per person to the base price', async () => {
    const trip = await createTrip(await createHotel(), ADDED);
    const body = await quote(trip, ['1', '2'], 'SHARED');
    expect(body.legs[0].seatsSubtotal).toBe(400);
    expect(body.legs[0].housingAmount).toBe(200);
    expect(body.subtotal).toBe(600);
  });

  it('prices a private room once per booking, however many companions share it', async () => {
    const trip = await createTrip(await createHotel(), ADDED);
    expect((await quote(trip, ['1', '2'], 'PRIVATE')).legs[0].housingAmount).toBe(300);
    const five = await quote(trip, FIVE, 'PRIVATE');
    expect(five.legs[0].housingAmount).toBe(300);
    expect(five.subtotal).toBe(1300);
  });

  it('ignores an old per-person or per-room setting', async () => {
    const perPerson = await createTrip(await createHotel(), { ...ADDED, privateRoomPriceBasis: 'PER_PERSON' });
    expect((await quote(perPerson, FIVE, 'PRIVATE')).legs[0].housingAmount).toBe(300);
    const perRoom = await createTrip(await createHotel(), { ...ADDED, privateRoomPriceBasis: 'PER_ROOM', privateRoomCapacity: 2 });
    expect((await quote(perRoom, FIVE, 'PRIVATE')).legs[0].housingAmount).toBe(300);
  });

  it('multiplies by the trip nights when priced per night', async () => {
    const trip = await createTrip(await createHotel(), { ...ADDED, housingPricePeriod: 'PER_NIGHT' });
    expect((await quote(trip, ['1', '2'], 'SHARED')).legs[0].housingAmount).toBe(600);
    expect((await quote(trip, ['1', '2'], 'PRIVATE')).legs[0].housingAmount).toBe(900);
  });

  it('charges only a private room extra when housing is included in the base price', async () => {
    const trip = await createTrip(await createHotel(), { housingPriceMode: 'INCLUDED_IN_BASE', housingPrice: 40, privateRoomPrice: 150, privateRoomPriceBasis: 'PER_PERSON' });
    const shared = await quote(trip, ['1', '2'], 'SHARED');
    expect(shared.legs[0].housingAmount).toBe(0);
    expect(shared.subtotal).toBe(400);
    const privately = await quote(trip, ['1', '2'], 'PRIVATE');
    expect(privately.legs[0].housingAmount).toBe(150);
    expect(privately.subtotal).toBe(550);
  });

  it('keeps charging existing trips the seat price alone', async () => {
    const trip = await createTrip(await createHotel(), { housingPrice: 40 });
    expect((await quote(trip, ['1', '2'], 'PRIVATE')).subtotal).toBe(400);
  });

  it('tells the app what each room type costs before one is chosen', async () => {
    const trip = await createTrip(await createHotel(), ADDED);
    const body = await quote(trip, FIVE);
    expect(body.legs[0].housing.choice).toBeNull();
    expect(body.legs[0].housing.optionAmounts).toEqual({ SHARED: 500, PRIVATE: 600 });
    expect(body.subtotal).toBe(1000);
  });

  it('does not sell a room type left without a price when housing is added', async () => {
    const trip = await createTrip(await createHotel(), { housingPriceMode: 'ADDED_TO_BASE', housingPrice: 100 });
    const body = await quote(trip, ['1']);
    expect(body.legs[0].housing.options).toEqual(['SHARED']);
    expect(body.legs[0].housing.choice).toBe('SHARED');
    await request(http()).post(`${API}/bookings/quote`).set(customer.auth).send({ legs: [{ tripId: trip.id, seats: ['1'], roomChoice: 'PRIVATE' }] }).expect(400);
  });

  it('charges nothing more on a trip sold through an all-inclusive package', async () => {
    const pkg = await prisma.package.create({ data: { name: 'باقة شاملة', price: 900, price2: 1800, price3: 2700, price4: 3600, nights: 3 } });
    const trip = await createTrip(await createHotel(), { ...ADDED, packageId: pkg.id });
    const body = await quote(trip, ['1', '2'], 'PRIVATE');
    expect(body.legs[0].housingAmount).toBe(0);
    expect(body.subtotal).toBe(1800);
  });

  it('saves the housing amount on the booking, and a later price change leaves it alone', async () => {
    const trip = await createTrip(await createHotel(), ADDED);
    const created = await request(http())
      .post(`${API}/bookings`)
      .set(customer.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '2'], roomChoice: 'SHARED' }], passengers: [{ fullName: 'مسافر أول' }, { fullName: 'مسافر ثان' }] })
      .expect(201);
    const booking = created.body.bookings[0];
    expect(Number(booking.housingAmount)).toBe(200);
    expect(Number(booking.subtotal)).toBe(600);
    expect(Number(booking.totalPrice)).toBe(600);

    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ housingPrice: 999 }).expect(200);
    const saved = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(Number(saved.housingAmount)).toBe(200);
  });

  it('puts a private room on the booking owner, and the companions carry their transport only', async () => {
    const trip = await createTrip(await createHotel(), ADDED);
    const created = await request(http())
      .post(`${API}/bookings`)
      .set(customer.auth)
      .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['3', '1', '2'], roomChoice: 'PRIVATE' }], passengers: [{ fullName: 'صاحب الحجز' }, { fullName: 'مرافق أول' }, { fullName: 'مرافق ثان' }] })
      .expect(201);
    const booking = created.body.bookings[0];
    expect(Number(booking.housingAmount)).toBe(300);
    expect(Number(booking.totalPrice)).toBe(900);

    const inventory = (await request(http()).get(`${API}/manifests/${trip.id}/inventory`).set(admin.auth).expect(200)).body;
    const priceOf = (name: string) => inventory.rows.find((row: any) => row.fullName === name).price;
    expect(priceOf('صاحب الحجز')).toBe(500);
    expect(priceOf('مرافق أول')).toBe(200);
    expect(priceOf('مرافق ثان')).toBe(200);

    const found = (await request(http()).get(`${API}/bookings/admin/search?q=${booking.bookingReference}`).set(admin.auth).expect(200)).body;
    expect(found.items.map((row: any) => [row.fullName, row.price])).toEqual([['صاحب الحجز', 500], ['مرافق أول', 200], ['مرافق ثان', 200]]);
  });

  it('refuses a booking when housing is added but the trip has no hotel', async () => {
    const trip = await createTrip({ name: 'مكتوب يدويًا' }, { ...ADDED });
    await request(http()).post(`${API}/bookings/quote`).set(customer.auth).send({ legs: [{ tripId: trip.id, seats: ['1'], roomChoice: 'SHARED' }] }).expect(400);
  });

  it('shows customers the prices and a starting price, but never the raw settings', async () => {
    const trip = await createTrip(await createHotel(), { ...ADDED, housingPricePeriod: 'PER_NIGHT' });
    const { body } = await request(http()).get(`${API}/trips/${trip.id}`).set(customer.auth).expect(200);
    expect(body.pricePerSeat).toBe(200);
    expect(body.startingPrice).toBe(500);
    expect(body.housingOffer).toMatchObject({ addedToBase: true, bedPrice: 100, privateRoomPrice: 300, privateRoomCapacity: 4, period: 'PER_NIGHT' });
    expect(body.housingPrice).toBeUndefined();
    expect(body.housingPriceMode).toBeUndefined();
  });

  it('rejects prices that cannot be calculated', async () => {
    const hotel = await createHotel();
    const refuse = (overrides: object) =>
      request(http())
        .post(`${API}/trips`)
        .set(admin.auth)
        .send(tripPayload({ bookingType: 'WITH_HOTEL', accommodation: { name: hotel.name, nights: 1, hotelId: hotel.id }, ...overrides }))
        .expect(400);
    await refuse({ housingPriceMode: 'ADDED_TO_BASE' });
    await refuse({ privateRoomPrice: 300 });
    await request(http()).post(`${API}/hotels`).set(admin.auth).send({ name: 'بلا سعة', city: 'مكة', privateRoomPrice: 300 }).expect(400);
  });

  it('keeps hotel prices and details so a trip can copy them', async () => {
    const hotel = await createHotel({ bedPrice: 100, privateRoomPrice: 300, privateRoomCapacity: 4, housingPriceMode: 'ADDED_TO_BASE', housingPricePeriod: 'PER_NIGHT', features: ['قريب من الحرم', 'إفطار'] });
    expect(Number(hotel.bedPrice)).toBe(100);
    expect(hotel.features).toEqual(['إفطار', 'قريب من الحرم']);
    // Typed names become shared services, each with an icon guessed from its words.
    expect(hotel.services.find((service: { name: string }) => service.name === 'إفطار')).toMatchObject({ icon: 'Croissant' });
    const updated = await request(http()).patch(`${API}/hotels/${hotel.id}`).set(admin.auth).send({ bedPrice: null, privateRoomPriceBasis: 'PER_PERSON' }).expect(200);
    expect(updated.body.bedPrice).toBeNull();
    expect(updated.body.privateRoomPriceBasis).toBe('PER_PERSON');
  });

  it('copies the housing prices into next year\'s draft of a fixed trip', async () => {
    const trip = await createTrip(await createHotel(), { ...ADDED, housingPricePeriod: 'PER_NIGHT', scheduleType: 'FIXED', recurrenceCalendar: 'GREGORIAN' });
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 2 * 86400000), arrivalTime: new Date(Date.now() - 86400000) } });
    await app.get(TripsService).draftNextFixedTrips();
    const draft = await prisma.trip.findFirstOrThrow({ where: { tripStatus: 'DRAFT', scheduleType: 'FIXED' }, orderBy: { createdAt: 'desc' } });
    expect(draft.housingPriceMode).toBe('ADDED_TO_BASE');
    expect(Number(draft.privateRoomPrice)).toBe(300);
    expect(draft.privateRoomCapacity).toBe(4);
    expect(draft.housingPricePeriod).toBe('PER_NIGHT');
  });
});

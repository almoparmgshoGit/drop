import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { seatPricing } from '../src/common/utils/dynamic-pricing.util';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Flexible pricing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;
  /** Sells this many seats from the top of the bus, as if other customers had bought them. */
  const sell = async (tripId: string, count: number) => {
    const seats = await prisma.seat.findMany({ where: { tripId }, select: { id: true, seatNumber: true } });
    const top = seats.sort((a, b) => Number(b.seatNumber) - Number(a.seatNumber)).slice(0, count);
    await prisma.seat.updateMany({ where: { id: { in: top.map((seat) => seat.id) } }, data: { isBooked: true } });
    await prisma.trip.update({ where: { id: tripId }, data: { availableSeats: { decrement: count } } });
  };
  const quote = (user: any, tripId: string, seats: string[]) => request(http()).post(`${API}/bookings/quote`).set(user.auth).send({ legs: [{ tripId, seats }] });
  /** A traveller booking alone sits with the singles (26-49 on these trips), so a one-seat booking is a singles one. */
  const book = (user: any, tripId: string, seats: string[]) =>
    request(http())
      .post(`${API}/bookings`)
      .set(user.auth)
      .send({ paymentMethod: 'mada', ...(seats.length === 1 && { category: 'SINGLES' }), legs: [{ tripId, seats }], passengers: seats.map((_, i) => ({ fullName: `مسافر ${i + 1}` })) });

  // Neutral on every day of the week, so the result does not depend on the day the test runs.
  const rules = (extra = {}) => ({ enabled: true, occupancyTiers: [{ fromPercent: 50, adjustPercent: 20 }], earlyBird: { minDays: 2, adjustPercent: -10 }, ...extra });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the fixed price on a trip without rules, everywhere', async () => {
    const trip = await createTrip();
    const user = await loginPassenger(app);
    const page = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
    expect(page.body).toMatchObject({ pricePerSeat: 180, basePricePerSeat: 180 });
    expect(page.body).not.toHaveProperty('pricingRules');
    expect((await quote(user, trip.id, ['30']).expect(201)).body.legs[0]).toMatchObject({ pricePerSeat: 180, basePricePerSeat: 180 });
    const booking = (await book(user, trip.id, ['30']).expect(201)).body.bookings[0];
    expect(Number(booking.subtotal)).toBe(180);
    expect(Number(booking.seatPrice)).toBe(180);
  });

  it('keeps the fixed price while the rules are switched off', async () => {
    const trip = await createTrip({ pricingRules: rules({ enabled: false }) });
    await sell(trip.id, 30);
    const page = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
    expect(page.body.pricePerSeat).toBe(180);
  });

  it('charges exactly the price the search, the seat map and the quote show', async () => {
    const trip = await createTrip({ pricingRules: rules() });
    const user = await loginPassenger(app);

    // Early bird alone: 180 − 10%.
    expect((await request(http()).get(`${API}/trips/${trip.id}`).expect(200)).body).toMatchObject({ pricePerSeat: 162, basePricePerSeat: 180 });

    // Past half sold the occupancy tier adds 20%: 180 × 1.10.
    await sell(trip.id, 30);
    const search = await request(http()).get(`${API}/trips/search`).query({ origin: trip.origin, destination: trip.destination }).expect(200);
    expect(search.body.find((row: any) => row.id === trip.id)).toMatchObject({ pricePerSeat: 198, basePricePerSeat: 180 });
    const map = await request(http()).get(`${API}/bookings/seat-map/${trip.id}`).set(user.auth).expect(200);
    expect(map.body).toMatchObject({ pricePerSeat: 198, basePricePerSeat: 180 });
    const priced = await quote(user, trip.id, ['1', '2']).expect(201);
    expect(priced.body.legs[0]).toMatchObject({ pricePerSeat: 198, basePricePerSeat: 180, seatsSubtotal: 396 });

    const booking = (await book(user, trip.id, ['1', '2']).expect(201)).body.bookings[0];
    expect(Number(booking.subtotal)).toBe(396);
    expect(Number(booking.totalPrice)).toBe(priced.body.total);
    expect(Number(booking.seatPrice)).toBe(198);
    expect(Number(booking.seatBasePrice)).toBe(180);

    // Changing the rules later never rewrites what was sold.
    await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ pricingRules: null }).expect(200);
    const saved = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(Number(saved.seatPrice)).toBe(198);
    expect((await request(http()).get(`${API}/trips/${trip.id}`).expect(200)).body.pricePerSeat).toBe(180);
  });

  it('keeps the price within the floor and ceiling', async () => {
    const capped = await createTrip({ pricingRules: rules({ earlyBird: null, maxPrice: 190 }) });
    await sell(capped.id, 30);
    expect((await request(http()).get(`${API}/trips/${capped.id}`).expect(200)).body.pricePerSeat).toBe(190);

    const floored = await createTrip({ pricingRules: rules({ earlyBird: { minDays: 1, adjustPercent: -50 }, minPrice: 150 }) });
    expect((await request(http()).get(`${API}/trips/${floored.id}`).expect(200)).body.pricePerSeat).toBe(150);

    await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ pricingRules: rules({ minPrice: 300, maxPrice: 200 }) })).expect(400);
  });

  it('shows staff the rules with the base and current price', async () => {
    const trip = await createTrip({ pricingRules: rules() });
    const view = await request(http()).get(`${API}/trips/admin/${trip.id}`).set(admin.auth).expect(200);
    expect(view.body).toMatchObject({ basePricePerSeat: 180, pricePerSeat: 162, pricingRules: expect.objectContaining({ enabled: true }) });
    expect(view.body.priceAdjustments).toEqual([expect.objectContaining({ kind: 'EARLY_BIRD', percent: -10 })]);
  });

  it('adjusts by the departure weekday and the last minute', () => {
    const now = new Date('2026-12-01T09:00:00Z');
    // 2026-12-04 is a Friday in Riyadh.
    const friday = new Date('2026-12-04T10:00:00Z');
    const base = { price: 100, totalSeats: 49, availableSeats: 49, departureTime: friday };
    const weekend = { enabled: true, weekendAdjustPercent: 15, weekdayAdjustPercent: -5 };
    expect(seatPricing({ ...base, pricingRules: weekend }, now).price).toBe(11500);
    expect(seatPricing({ ...base, departureTime: new Date(friday.getTime() - 2 * DAY_MS), pricingRules: weekend }, now).price).toBe(9500);
    const late = { enabled: true, lastMinute: { withinHours: 24, adjustPercent: 25 } };
    expect(seatPricing({ ...base, departureTime: new Date(now.getTime() + 5 * 60 * 60 * 1000), pricingRules: late }, now).price).toBe(12500);
    // A package's trip never moves.
    expect(seatPricing({ ...base, packageId: 'p', pricingRules: weekend }, now).price).toBe(10000);
  });
});

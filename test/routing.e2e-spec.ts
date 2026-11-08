import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const MAPBOX_TOKEN = 'pk.mapbox_token_that_stays_on_the_server_1111';
const GOOGLE_KEY = 'AIza_google_key_that_stays_on_the_server_2222';
const BUS = { lat: 24.7136, lng: 46.6753 };
const POINT = { lat: 24.1554, lng: 47.3346 };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mapboxOk = (seconds = 3600, meters = 90_000) => reply({ code: 'Ok', routes: [{ duration: seconds, distance: meters }] });
const googleOk = (seconds = 1800, meters = 45_000) => reply({ routes: [{ duration: `${seconds}s`, distanceMeters: meters }] });

describe('Routing platforms chosen from the panel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;
  let fetchMock: jest.SpyInstance;
  const http = () => app.getHttpServer();

  const save = (values: Record<string, unknown>) => request(http()).put(`${API}/settings/integrations`).set(admin.auth).send({ values });
  const test = () => request(http()).post(`${API}/settings/integrations/routing/test`).set(admin.auth);

  /** A bus broadcasting now, and passengers waiting at one point that has coordinates. */
  const liveTrip = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ boardingPoints: [{ name: 'فرع الخرج', time: '09:30', address: 'الخرج' }] })).expect(201)).body;
    const point = await prisma.boardingPoint.findFirstOrThrow({ where: { tripId: trip.id } });
    await prisma.boardingPoint.update({ where: { id: point.id }, data: POINT });
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 600_000), arrivalTime: new Date(Date.now() + 5 * 3_600_000) } });
    const position = { ...BUS, reportedById: (await createStaff(prisma, 'DRIVER')).id, recordedAt: new Date() };
    await prisma.tripLocation.upsert({ where: { tripId: trip.id }, create: { tripId: trip.id, ...position }, update: position });
    const passengerOn = async (seat: string) => {
      const who = await loginPassenger(app);
      // A trip that has left no longer sells seats, so its clock goes back only for the booking.
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 600_000) } });
      const booking = (await request(http()).post(`${API}/bookings`).set(who.auth).send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: [seat], boardingPointId: point.id }], passengers: [{ fullName: `راكب ${seat}` }] }).expect(201)).body.bookings[0];
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 600_000) } });
      return { who, booking };
    };
    return { trip, point, passengerOn };
  };
  const track = async (who: any, bookingId: string) => (await request(http()).get(`${API}/tracking/bookings/${bookingId}`).set(who.auth).expect(200)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  beforeEach(async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => mapboxOk());
    await prisma.setting.deleteMany({ where: { key: { in: ['integration.routingProvider', 'integration.mapboxAccessToken', 'integration.googleMapsApiKey'] } } });
  });

  afterEach(() => fetchMock.mockRestore());

  afterAll(async () => {
    await app.close();
  });

  describe('connecting a platform', () => {
    it('tells the panel which fields each platform needs', async () => {
      const { body } = await request(http()).get(`${API}/settings/integrations`).set(admin.auth).expect(200);
      const fields = body.groups.find((group: any) => group.id === 'routing').fields;
      expect(fields.find((field: any) => field.key === 'routingProvider').options.map((option: any) => option.value)).toEqual(['', 'mapbox', 'google_essentials', 'google_pro']);
      expect(fields.find((field: any) => field.key === 'mapboxAccessToken').showFor).toEqual(['mapbox']);
      expect(fields.find((field: any) => field.key === 'googleMapsApiKey').showFor).toEqual(['google_essentials', 'google_pro']);
    });

    it('refuses a platform without its key, an unknown platform, and removing the key in use', async () => {
      await save({ routingProvider: 'mapbox' }).expect(400);
      await save({ routingProvider: 'google_pro' }).expect(400);
      await save({ routingProvider: 'waze' }).expect(400);
      await save({ routingProvider: 'mapbox', mapboxAccessToken: 'not-a-token' }).expect(400);
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      await save({ mapboxAccessToken: null }).expect(400);
      await save({ routingProvider: '', mapboxAccessToken: null }).expect(200);
    });

    it('keeps the test to those allowed to manage keys', async () => {
      await request(http()).post(`${API}/settings/integrations/routing/test`).expect(401);
      const passenger = await loginPassenger(app);
      await request(http()).post(`${API}/settings/integrations/routing/test`).set(passenger.auth).expect(403);
    });

    it('tests Mapbox with the road format and token it expects', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      const { body } = await test().expect(200);
      expect(body).toEqual({ ok: true, platform: 'Mapbox', minutes: 60, km: 90, trafficAware: true });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/directions/v5/mapbox/driving-traffic/39.6111,24.4672;39.8262,21.4225');
      expect(url).toContain(`access_token=${encodeURIComponent(MAPBOX_TOKEN)}`);
    });

    it.each([
      ['google_essentials', 'Google (Essentials)', 'TRAFFIC_UNAWARE', false],
      ['google_pro', 'Google (Pro)', 'TRAFFIC_AWARE', true],
    ])('tests %s with the routing preference that sets its price', async (provider, platform, preference, trafficAware) => {
      fetchMock.mockImplementation(async () => googleOk());
      await save({ routingProvider: provider, googleMapsApiKey: GOOGLE_KEY }).expect(200);
      const { body } = await test().expect(200);
      expect(body).toEqual({ ok: true, platform, minutes: 30, km: 45, trafficAware });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
      expect(init.headers).toMatchObject({ 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' });
      expect(JSON.parse(init.body)).toMatchObject({ travelMode: 'DRIVE', routingPreference: preference, origin: { location: { latLng: { latitude: 24.4672 } } } });
    });

    it('explains a rejected key without repeating it or the platform reply', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      fetchMock.mockImplementation(async () => reply({ message: `Not Authorized ${MAPBOX_TOKEN}` }, 401));
      const { body } = await test().expect(200);
      expect(body.ok).toBe(false);
      expect(body.message).toContain('Mapbox');
      expect(JSON.stringify(body)).not.toContain(MAPBOX_TOKEN);
      expect(JSON.stringify(body)).not.toContain('Not Authorized');
    });

    it('reports a platform that cannot be reached and a pair with no road', async () => {
      await save({ routingProvider: 'google_essentials', googleMapsApiKey: GOOGLE_KEY }).expect(200);
      fetchMock.mockImplementation(async () => { throw new Error(`connect failed ${GOOGLE_KEY}`); });
      const down = (await test().expect(200)).body;
      expect(down.ok).toBe(false);
      expect(JSON.stringify(down)).not.toContain(GOOGLE_KEY);
      fetchMock.mockImplementation(async () => reply({}));
      expect((await test().expect(200)).body).toMatchObject({ ok: false, message: 'لم تجد المنصة طريقًا بين النقطتين' });
    });
  });

  describe('what the passenger sees', () => {
    it('makes no outside request and gives no estimate while no platform is chosen', async () => {
      const { passengerOn } = await liveTrip();
      const { who, booking } = await passengerOn('1');
      const seen = await track(who, booking.id);
      expect(seen.etaToMyPoint).toBeNull();
      expect(seen.distanceToMyPointKm).toBeGreaterThan(85);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('gives an estimate from the bus to the point, and never sends the key to the phone', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      const { passengerOn } = await liveTrip();
      const { who, booking } = await passengerOn('1');
      const before = Date.now();
      const seen = await track(who, booking.id);
      expect(seen.etaToMyPoint).toMatchObject({ minutes: 60, km: 90, trafficAware: true });
      expect(new Date(seen.etaToMyPoint.arrivesAt).getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(fetchMock.mock.calls[0][0]).toContain(`${BUS.lng},${BUS.lat};${POINT.lng},${POINT.lat}`);
      expect(JSON.stringify(seen)).not.toContain(MAPBOX_TOKEN);
      const config = await request(http()).get(`${API}/settings/app-config`).expect(200);
      expect(JSON.stringify(config.body)).not.toContain(MAPBOX_TOKEN);
    });

    it('pays once however many phones are polling the same point', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      const { passengerOn } = await liveTrip();
      const first = await passengerOn('1');
      const second = await passengerOn('2');
      await Promise.all([track(first.who, first.booking.id), track(second.who, second.booking.id), track(first.who, first.booking.id)]);
      await track(second.who, second.booking.id);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('switches platform at once when the admin changes it', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      const { passengerOn } = await liveTrip();
      const { who, booking } = await passengerOn('1');
      expect((await track(who, booking.id)).etaToMyPoint.minutes).toBe(60);

      fetchMock.mockImplementation(async () => googleOk());
      await save({ routingProvider: 'google_essentials', googleMapsApiKey: GOOGLE_KEY }).expect(200);
      expect((await track(who, booking.id)).etaToMyPoint).toMatchObject({ minutes: 30, trafficAware: false });

      await save({ routingProvider: '' }).expect(200);
      expect((await track(who, booking.id)).etaToMyPoint).toBeNull();
    });

    it('falls back when the platform fails, waits before retrying, and recovers at once with a new key', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      fetchMock.mockImplementation(async () => reply({ message: 'Not Authorized' }, 401));
      const { passengerOn } = await liveTrip();
      const { who, booking } = await passengerOn('1');
      const failed = await track(who, booking.id);
      expect(failed.etaToMyPoint).toBeNull();
      expect(failed.distanceToMyPointKm).toBeGreaterThan(85);
      await track(who, booking.id);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockImplementation(async () => mapboxOk());
      await save({ mapboxAccessToken: 'pk.a_replacement_token_3333' }).expect(200);
      expect((await track(who, booking.id)).etaToMyPoint.minutes).toBe(60);
    });

    it('spends nothing when the position is old, the bus has reached the point, or the point has no coordinates', async () => {
      await save({ routingProvider: 'mapbox', mapboxAccessToken: MAPBOX_TOKEN }).expect(200);
      const stale = await liveTrip();
      const waitingOnStale = await stale.passengerOn('1');
      await prisma.tripLocation.update({ where: { tripId: stale.trip.id }, data: { recordedAt: new Date(Date.now() - 600_000) } });
      expect((await track(waitingOnStale.who, waitingOnStale.booking.id)).etaToMyPoint).toBeNull();

      const here = await liveTrip();
      const waitingHere = await here.passengerOn('1');
      await prisma.trip.update({ where: { id: here.trip.id }, data: { currentBoardingPointId: here.point.id } });
      expect((await track(waitingHere.who, waitingHere.booking.id)).etaToMyPoint).toBeNull();

      const unmapped = await liveTrip();
      const waitingUnmapped = await unmapped.passengerOn('1');
      await prisma.boardingPoint.update({ where: { id: unmapped.point.id }, data: { lat: null, lng: null } });
      expect((await track(waitingUnmapped.who, waitingUnmapped.booking.id)).etaToMyPoint).toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

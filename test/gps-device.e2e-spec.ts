import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';
import { API, createStaff, createTestApp, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Bus GPS device (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let admin: any;
  const http = () => app.getHttpServer();

  beforeAll(async () => {
    ({ app, prisma, redis } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  /** A bus on a trip that is inside its tracking hours, with a supervisor, and a registered device with a token. */
  const setup = async (deviceId = `IMEI${Date.now()}`) => {
    const bus = await prisma.bus.create({ data: { plateNumber: `GPS ${Math.floor(Math.random() * 1e6)}`, model: 'Volvo' } });
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    await prisma.trip.update({ where: { id: trip.id }, data: { busId: bus.id, departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 6 * 3_600_000) } });
    await request(http()).put(`${API}/gps-devices/buses/${bus.id}`).set(admin.auth).send({ deviceId }).expect(200);
    const issued = await request(http()).post(`${API}/gps-devices/buses/${bus.id}/token`).set(admin.auth).expect(201);
    return { bus, trip, deviceId, token: issued.body.token as string, crew: await loginStaff(app, staff.phone) };
  };
  /** Each bus may store one fix every two seconds; tests send faster than that. */
  const allowNextFix = (busId: string) => redis.del(`gps:fix:${busId}`);

  it('issues the token once, keeps only its hash, and never lists it', async () => {
    const { bus, token } = await setup();
    expect(token).toMatch(/^gps_/);
    const stored = await prisma.busGpsDevice.findUnique({ where: { busId: bus.id } });
    expect(stored.tokenHash).toBeTruthy();
    expect(stored.tokenHash).not.toContain(token);
    const shown = await request(http()).get(`${API}/gps-devices/buses/${bus.id}`).set(admin.auth).expect(200);
    expect(shown.body.device).toMatchObject({ hasToken: true, tokenHint: token.slice(-4) });
    expect(JSON.stringify(shown.body)).not.toContain(token);
    const listed = await request(http()).get(`${API}/gps-devices`).set(admin.auth).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain('tokenHash');
  });

  it('accepts an OsmAnd fix by GET, converts knots, and feeds the trip position as DEVICE', async () => {
    const { trip, deviceId, token } = await setup();
    const res = await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24.71, lon: 46.67, speed: 10, bearing: 90, accuracy: 8 }).expect(200);
    expect(res.body).toMatchObject({ ok: true, used: true, tripId: trip.id });
    const location = await prisma.tripLocation.findUnique({ where: { tripId: trip.id } });
    expect(location).toMatchObject({ lat: 24.71, lng: 46.67, source: 'DEVICE', reportedById: null, heading: 90, accuracy: 8 });
    expect(location.speed).toBeCloseTo(5.144, 2);
  });

  it('accepts the Traccar Client JSON body with the token in a header', async () => {
    const { trip, deviceId, token } = await setup();
    await request(http())
      .post(`${API}/gps/ingest`)
      .set('X-Device-Token', token)
      .send({ device_id: deviceId, location: { timestamp: new Date().toISOString(), coords: { latitude: 21.42, longitude: 39.82, speed: 12, heading: 180, accuracy: 5 } } })
      .expect(200);
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toMatchObject({ lat: 21.42, lng: 39.82, speed: 12, source: 'DEVICE' });
  });

  it('refuses a wrong token, another device id and a disabled device', async () => {
    const { bus, deviceId, token } = await setup();
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token: 'gps_wrong', lat: 24, lon: 46 }).expect(401);
    await request(http()).get(`${API}/gps/ingest`).query({ id: 'someone-else', token, lat: 24, lon: 46 }).expect(401);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, lat: 24, lon: 46 }).expect(401);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 124, lon: 46 }).expect(400);
    await request(http()).put(`${API}/gps-devices/buses/${bus.id}`).set(admin.auth).send({ deviceId, isEnabled: false }).expect(200);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24, lon: 46 }).expect(403);
  });

  it('stops the old token the moment a new one is issued', async () => {
    const { bus, deviceId, token } = await setup();
    const rotated = await request(http()).post(`${API}/gps-devices/buses/${bus.id}/token`).set(admin.auth).expect(201);
    expect(rotated.body.token).not.toBe(token);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24, lon: 46 }).expect(401);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token: rotated.body.token, lat: 24, lon: 46 }).expect(200);
  });

  it('prefers the device over the phone, and lets the phone take over when the device falls silent', async () => {
    const { bus, trip, deviceId, token, crew } = await setup();
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24.7, lon: 46.7 }).expect(200);

    const phone = await request(http()).post(`${API}/tracking/trips/${trip.id}/location`).set(crew.auth).send({ lat: 10, lng: 10, speed: 3 }).expect(201);
    expect(phone.body.source).toBe('DEVICE');
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toMatchObject({ lat: 24.7, source: 'DEVICE' });

    // The crew stopping its sharing leaves the device's position on the map.
    await request(http()).post(`${API}/tracking/trips/${trip.id}/stop`).set(crew.auth).expect(201);
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toMatchObject({ source: 'DEVICE' });

    // Ten minutes without the device: the phone's fix is used.
    await prisma.tripLocation.update({ where: { tripId: trip.id }, data: { recordedAt: new Date(Date.now() - 10 * 60_000) } });
    await prisma.busGpsDevice.update({ where: { busId: bus.id }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    const takeover = await request(http()).post(`${API}/tracking/trips/${trip.id}/location`).set(crew.auth).send({ lat: 11, lng: 12, speed: 3 }).expect(201);
    expect(takeover.body.source).toBe('PHONE');
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toMatchObject({ lat: 11, lng: 12, source: 'PHONE' });

    // The device coming back takes the map again.
    await allowNextFix(bus.id);
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24.8, lon: 46.8 }).expect(200);
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toMatchObject({ lat: 24.8, source: 'DEVICE' });
  });

  it('shows the source and the device on the operations map', async () => {
    const { bus, trip, deviceId, token } = await setup();
    await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24.7, lon: 46.7 }).expect(200);
    const live = await request(http()).get(`${API}/tracking/live`).set(admin.auth).expect(200);
    const row = live.body.trips.find((item: any) => item.id === trip.id);
    expect(row.location).toMatchObject({ source: 'DEVICE', isLive: true });
    expect(row.gpsDevice).toMatchObject({ deviceId, isOnline: true, isEnabled: true });
    expect(bus.id).toBeTruthy();
  });

  it('records the device as seen but uses no fix while its bus has no trip in tracking hours', async () => {
    const { bus, trip, deviceId, token } = await setup();
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 5 * 24 * 3_600_000), arrivalTime: new Date(Date.now() + 5 * 24 * 3_600_000 + 5 * 3_600_000) } });
    const res = await request(http()).get(`${API}/gps/ingest`).query({ id: deviceId, token, lat: 24.7, lon: 46.7 }).expect(200);
    expect(res.body).toMatchObject({ ok: true, used: false, reason: 'no_open_trip' });
    expect((await prisma.busGpsDevice.findUnique({ where: { busId: bus.id } })).lastSeenAt).toBeTruthy();
    expect(await prisma.tripLocation.findUnique({ where: { tripId: trip.id } })).toBeNull();
  });

  it('keeps one device to one bus', async () => {
    const first = await setup('SAME-IMEI');
    const other = await prisma.bus.create({ data: { plateNumber: 'OTHER 1', model: 'Volvo' } });
    await request(http()).put(`${API}/gps-devices/buses/${other.id}`).set(admin.auth).send({ deviceId: first.deviceId }).expect(409);
  });
});

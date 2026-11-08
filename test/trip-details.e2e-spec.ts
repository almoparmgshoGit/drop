import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const HOUR = 60 * 60 * 1000;

describe('Trip details the admin panel enters (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => any;
  let admin: any;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    http = () => app.getHttpServer();
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  afterAll(async () => {
    await app.close();
  });

  const createTrip = async (overrides = {}) => (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload(overrides)).expect(201)).body;

  describe('photos', () => {
    it('stores an image and serves it to anyone, including another origin', async () => {
      const upload = await request(http()).post(`${API}/trips/images`).set(admin.auth).attach('images', PNG, 'bus.png').expect(201);
      expect(upload.body).toEqual([{ url: expect.stringMatching(/^\/trips\/images\//) }]);

      const image = await request(http()).get(`${API}${upload.body[0].url}`).expect(200);
      expect(image.headers['content-type']).toContain('image/png');
      expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(image.body, PNG)).toBe(0);
    });

    it('judges a file by its bytes, whatever it claims to be', async () => {
      await request(http()).post(`${API}/trips/images`).set(admin.auth)
        .attach('images', Buffer.from('<svg onload="alert(1)"/>'), { filename: 'bus.png', contentType: 'image/png' })
        .expect(400);
    });

    it('needs a manager to upload', async () => {
      await request(http()).post(`${API}/trips/images`).attach('images', PNG, 'bus.png').expect(401);
    });

    it('answers 404 for a photo that does not exist', async () => {
      await request(http()).get(`${API}/trips/images/missing`).expect(404);
    });
  });

  describe('route and arrival', () => {
    const stops = [
      { title: 'القويعية', time: '01:30', kind: 'REST' },
      { title: 'ظلم', time: '03:15' },
      { title: 'السيل الكبير', time: '05:00', kind: 'MIQAT' },
    ];

    it('shows customers what was entered, with stops in road order across midnight', async () => {
      const departure = new Date(Date.now() + 10 * 24 * HOUR);
      const trip = await createTrip({
        departureTime: departure.toISOString(),
        arrivalTime: new Date(departure.getTime() + 72 * HOUR).toISOString(),
        estimatedArrivalAt: new Date(departure.getTime() + 9 * HOUR).toISOString(),
        departureStation: ' المحطة الرئيسية ',
        images: ['/trips/images/one'],
        itineraryStops: [{ title: 'نقطة سابقة', time: '23:30' }, ...stops],
      });

      const { body } = await request(http()).get(`${API}/trips/${trip.id}`).expect(200);
      expect(body.departureStation).toBe('المحطة الرئيسية');
      expect(new Date(body.estimatedArrivalAt).getTime()).toBe(departure.getTime() + 9 * HOUR);
      expect(body.images.map((image: any) => image.url)).toEqual(['/trips/images/one']);
      expect(body.itineraryStops.map((stop: any) => [stop.title, stop.kind])).toEqual([
        ['نقطة سابقة', 'STOP'],
        ['القويعية', 'REST'],
        ['ظلم', 'STOP'],
        ['السيل الكبير', 'MIQAT'],
      ]);
    });

    it('refuses a stop kind it does not know', async () => {
      await request(http()).post(`${API}/trips`).set(admin.auth)
        .send(tripPayload({ itineraryStops: [{ title: 'ظلم', time: '03:15', kind: 'OTHER' }] }))
        .expect(400);
    });

    it('ends a one-way trip on arrival, so the bus is not held for the default length', async () => {
      const departure = Date.now() + 40 * 24 * HOUR;
      const estimate = new Date(departure + 3 * HOUR).toISOString();
      const { arrivalTime: _ignored, ...payload } = tripPayload({ departureTime: new Date(departure).toISOString(), estimatedArrivalAt: estimate });
      const { body } = await request(http()).post(`${API}/trips`).set(admin.auth).send(payload).expect(201);
      expect(new Date(body.arrivalTime).toISOString()).toBe(estimate);
    });

    it('refuses an expected arrival outside the trip', async () => {
      const departure = Date.now() + 50 * 24 * HOUR;
      const base = { departureTime: new Date(departure).toISOString(), arrivalTime: new Date(departure + 5 * HOUR).toISOString() };
      await request(http()).post(`${API}/trips`).set(admin.auth)
        .send(tripPayload({ ...base, estimatedArrivalAt: new Date(departure - HOUR).toISOString() }))
        .expect(400);
      await request(http()).post(`${API}/trips`).set(admin.auth)
        .send(tripPayload({ ...base, estimatedArrivalAt: new Date(departure + 6 * HOUR).toISOString() }))
        .expect(400);
    });

    it('edits and clears them, and carries the arrival along when only the departure moves', async () => {
      const departure = Date.now() + 60 * 24 * HOUR;
      const trip = await createTrip({
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 9 * HOUR).toISOString(),
        estimatedArrivalAt: new Date(departure + 8 * HOUR).toISOString(),
        departureStation: 'المحطة',
        itineraryStops: stops,
      });

      const moved = departure + 24 * HOUR;
      const { body: shifted } = await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ departureTime: new Date(moved).toISOString() }).expect(200);
      expect(new Date(shifted.estimatedArrivalAt).getTime()).toBe(moved + 8 * HOUR);
      expect(shifted.itineraryStops).toHaveLength(3);
      expect(shifted.departureStation).toBe('المحطة');

      const { body: cleared } = await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth)
        .send({ estimatedArrivalAt: null, departureStation: null, itineraryStops: [stops[2], stops[0]] })
        .expect(200);
      expect(cleared.estimatedArrivalAt).toBeNull();
      expect(cleared.departureStation).toBeNull();
      expect(cleared.itineraryStops.map((stop: any) => stop.title)).toEqual(['السيل الكبير', 'القويعية']);
    });

    it("copies all of it to a fixed trip's draft for next year", async () => {
      const departure = Date.now() + 70 * 24 * HOUR;
      const trip = await createTrip({
        departureTime: new Date(departure).toISOString(),
        arrivalTime: new Date(departure + 9 * HOUR).toISOString(),
        estimatedArrivalAt: new Date(departure + 8 * HOUR).toISOString(),
        departureStation: 'المحطة',
        images: ['/trips/images/one'],
        itineraryStops: stops,
        scheduleType: 'FIXED',
        recurrenceCalendar: 'GREGORIAN',
      });
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 2 * 24 * HOUR), arrivalTime: new Date(Date.now() - 24 * HOUR), estimatedArrivalAt: new Date(Date.now() - 40 * HOUR), tripStatus: 'COMPLETED' } });

      await app.get(TripsService).draftNextFixedTrips();

      const draft = await prisma.trip.findFirst({
        where: { tripStatus: 'DRAFT', departureStation: 'المحطة', departureTime: { gt: new Date() } },
        include: { itineraryStops: { orderBy: { sortOrder: 'asc' } }, images: true },
      });
      expect(draft?.images.map((image) => image.url)).toEqual(['/trips/images/one']);
      expect(draft?.itineraryStops.map((stop) => stop.kind)).toEqual(['REST', 'STOP', 'MIQAT']);
      expect(draft!.estimatedArrivalAt!.getTime()).toBeLessThan(draft!.arrivalTime.getTime());
      expect(draft!.estimatedArrivalAt!.getTime()).toBeGreaterThan(draft!.departureTime.getTime());
    });
  });
});

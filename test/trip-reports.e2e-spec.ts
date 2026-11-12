import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, openBoarding, resetDatabase, tripPayload } from './helpers';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

describe('Bus position, ticket points and crew reports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;

  const http = () => app.getHttpServer();
  const POINTS = [
    { name: 'فرع الرياض', time: '08:00', address: 'الرياض' },
    { name: 'فرع الخرج', time: '09:30', address: 'الخرج' },
  ];

  const setup = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ boardingPoints: POINTS })).expect(201)).body;
    const points = await prisma.boardingPoint.findMany({ where: { tripId: trip.id }, orderBy: { time: 'asc' } });
    const passenger = await loginPassenger(app);
    const other = await loginPassenger(app);
    const bookOn = async (who: any, seat: string, boardingPointId?: string) =>
      (await request(http()).post(`${API}/bookings`).set(who.auth).send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: [seat], boardingPointId }], passengers: [{ fullName: `راكب ${seat}` }] }).expect(201)).body.bookings[0];
    const atFirst = await bookOn(passenger, '1', points[0].id);
    const atSecond = await bookOn(other, '2', points[1].id);
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    const driver = await createStaff(prisma, 'DRIVER');
    await prisma.tripDriver.create({ data: { tripId: trip.id, userId: driver.id } });
    await openBoarding(prisma, trip.id);
    return { trip, points, passenger, other, atFirst, atSecond, staff, driver, crew: await loginStaff(app, staff.phone), driverSession: await loginStaff(app, driver.phone) };
  };

  const setStatus = (session: any, tripId: string, body: object) => request(http()).post(`${API}/tickets/trips/${tripId}/status`).set(session.auth).send(body);
  const tokenOf = (booking: any) => booking.passengers[0].ticket.signedToken;
  const scan = (session: any, tripId: string, booking: any, extra: object = {}) =>
    request(http()).post(`${API}/tickets/verify`).set(session.auth).send({ signedToken: tokenOf(booking), tripId, ...extra }).expect(201);
  const eventsFor = (userId: string, event: string) => prisma.notification.findMany({ where: { userId, event } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-report-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  describe('where the bus is', () => {
    it('moves the bus, keeps the history, and tells only the passengers who board at that point', async () => {
      const { trip, points, passenger, other, atFirst, crew, driverSession, driver } = await setup();
      const res = await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      expect(res.body).toMatchObject({ liveStatus: 'AT_POINT', changed: true });

      expect((await eventsFor(passenger.user.id, 'BUS_AT_YOUR_POINT'))[0].body).toContain('فرع الرياض');
      expect(await prisma.notification.count({ where: { userId: other.user.id, event: { startsWith: 'BUS_' } } })).toBe(0);
      expect(await eventsFor(driver.id, 'CREW_TRIP_STATUS_CHANGED')).toHaveLength(1);

      const details = (await request(http()).get(`${API}/tickets/trips/${trip.id}/details`).set(driverSession.auth).expect(200)).body;
      expect(details).toMatchObject({ liveStatus: 'AT_POINT', currentBoardingPointId: points[0].id });

      const seen = (await request(http()).get(`${API}/tracking/bookings/${atFirst.id}`).set(passenger.auth).expect(200)).body;
      expect(seen.liveStatus).toBe('AT_POINT');
      expect(seen.points[0]).toMatchObject({ name: 'فرع الرياض', isMine: true, isCurrent: true, reached: true });
      expect(seen.points[1]).toMatchObject({ name: 'فرع الخرج', isMine: false, isCurrent: false, reached: false });
    });

    it('does not notify again on a repeated tap', async () => {
      const { trip, points, passenger, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      const again = await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      expect(again.body.changed).toBe(false);
      expect(await eventsFor(passenger.user.id, 'BUS_AT_YOUR_POINT')).toHaveLength(1);
      expect(await prisma.tripStatusUpdate.count({ where: { tripId: trip.id } })).toBe(1);
    });

    it('tells those still waiting when it leaves, and everyone when it arrives', async () => {
      const { trip, points, passenger, other, atFirst, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      await scan(crew, trip.id, atFirst);
      await setStatus(crew, trip.id, { status: 'ON_ROAD' }).expect(201);
      expect(await eventsFor(passenger.user.id, 'BUS_ON_ROAD')).toHaveLength(0);
      expect((await eventsFor(other.user.id, 'BUS_ON_ROAD'))[0].body).toContain('فرع الرياض');

      await setStatus(crew, trip.id, { status: 'ARRIVED' }).expect(201);
      expect(await eventsFor(passenger.user.id, 'BUS_ARRIVED')).toHaveLength(1);
      // Never scanned, so they did not travel: they hear their ticket stopped, not "you have arrived".
      expect(await eventsFor(other.user.id, 'BUS_ARRIVED')).toHaveLength(0);
      expect(await eventsFor(other.user.id, 'TICKET_STOPPED')).toHaveLength(1);
      const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(stored.currentBoardingPointId).toBeNull();
    });

    it('refuses a point of another trip, a missing point, and going back to not started', async () => {
      const { trip, crew } = await setup();
      const another = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: another.points[0].id }).expect(400);
      await setStatus(crew, trip.id, { status: 'AT_POINT' }).expect(400);
      await setStatus(crew, trip.id, { status: 'NOT_STARTED' }).expect(400);
    });

    it('is closed to crew of other trips and to customers', async () => {
      const { trip, points, passenger } = await setup();
      const stranger = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      await setStatus(await loginStaff(app, stranger.phone), trip.id, { status: 'ON_ROAD' }).expect(403);
      await setStatus(passenger, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(403);
    });

    it('keeps the bus at its point when editing the trip recreates the points', async () => {
      const { trip, points, atFirst, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      await request(http()).put(`${API}/trips/${trip.id}`).set(admin.auth).send({ boardingPoints: POINTS }).expect(200);

      const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { currentBoardingPoint: true } });
      expect(stored.currentBoardingPoint?.name).toBe('فرع الرياض');
      expect(stored.currentBoardingPointId).not.toBe(points[0].id);
      // The booking still holds the old id, and its ticket must not be turned away for that.
      expect((await scan(crew, trip.id, atFirst)).body.result).toBe('BOARDED');
    });
  });

  describe('live tracking', () => {
    const RIYADH = { lat: 24.7136, lng: 46.6753 };
    const KHARJ = { lat: 24.1554, lng: 47.3346 };

    /** Inside the two hours before departure, when the location may be broadcast, with both points on the map. */
    const liveTrip = async () => {
      const scene = await setup();
      await prisma.trip.update({ where: { id: scene.trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 5 * 3_600_000) } });
      await prisma.boardingPoint.update({ where: { id: scene.points[0].id }, data: RIYADH });
      await prisma.boardingPoint.update({ where: { id: scene.points[1].id }, data: KHARJ });
      return scene;
    };
    const send = (session: any, tripId: string, position: object) => request(http()).post(`${API}/tracking/trips/${tripId}/location`).set(session.auth).send(position);
    const track = async (who: any, bookingId: string) => (await request(http()).get(`${API}/tracking/bookings/${bookingId}`).set(who.auth).expect(200)).body;

    it('suggests a point only when the bus is near one it has not already been set to', async () => {
      const { trip, points, crew } = await liveTrip();
      expect((await send(crew, trip.id, { lat: 24.45, lng: 47.0 }).expect(201)).body.nearPoint).toBeNull();

      const near = (await send(crew, trip.id, { lat: RIYADH.lat + 0.001, lng: RIYADH.lng }).expect(201)).body.nearPoint;
      expect(near).toMatchObject({ id: points[0].id, name: 'فرع الرياض' });
      expect(near.meters).toBeGreaterThan(100);
      expect(near.meters).toBeLessThan(120);

      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      expect((await send(crew, trip.id, { lat: RIYADH.lat + 0.001, lng: RIYADH.lng }).expect(201)).body.nearPoint).toBeNull();
    });

    it('never moves the bus by itself: being near a point changes nothing until the crew confirms', async () => {
      const { trip, atFirst, passenger, crew } = await liveTrip();
      await send(crew, trip.id, RIYADH).expect(201);
      const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
      expect(stored).toMatchObject({ liveStatus: 'NOT_STARTED', currentBoardingPointId: null });
      expect(await eventsFor(passenger.user.id, 'BUS_AT_YOUR_POINT')).toHaveLength(0);
      expect((await scan(crew, trip.id, atFirst)).body.result).toBe('WRONG_POINT');
    });

    it('shows the customer the bus, the points and how far their own point is', async () => {
      const { trip, atSecond, other, crew } = await liveTrip();
      await send(crew, trip.id, RIYADH).expect(201);
      const seen = await track(other, atSecond.id);
      expect(seen.location).toMatchObject({ ...RIYADH, isLive: true });
      expect(seen.points.map((point: any) => [point.name, point.lat, point.isMine])).toEqual([['فرع الرياض', RIYADH.lat, false], ['فرع الخرج', KHARJ.lat, true]]);
      expect(seen.distanceToMyPointKm).toBeGreaterThan(85);
      expect(seen.distanceToMyPointKm).toBeLessThan(95);
    });

    it('stops counting the distance once the bus has been at the point', async () => {
      const { trip, points, atSecond, other, crew } = await liveTrip();
      await send(crew, trip.id, RIYADH).expect(201);
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[1].id }).expect(201);
      expect((await track(other, atSecond.id)).distanceToMyPointKm).toBeNull();
    });

    it('calls a position stale after two minutes', async () => {
      const { trip, atFirst, passenger, crew } = await liveTrip();
      await send(crew, trip.id, RIYADH).expect(201);
      await prisma.tripLocation.update({ where: { tripId: trip.id }, data: { recordedAt: new Date(Date.now() - 3 * 60_000) } });
      expect((await track(passenger, atFirst.id)).location.isLive).toBe(false);
    });

    it('ends tracking when the crew says the bus has arrived', async () => {
      const { trip, atFirst, passenger, crew } = await liveTrip();
      await send(crew, trip.id, RIYADH).expect(201);
      await setStatus(crew, trip.id, { status: 'ARRIVED' }).expect(201);
      // 409 is what tells a phone left broadcasting to stop.
      await send(crew, trip.id, RIYADH).expect(409);
      const seen = await track(passenger, atFirst.id);
      expect(seen.location).toBeNull();
      expect(seen.stage).toBe('ARRIVED');
    });

    it('does not let another customer follow a booking that is not theirs', async () => {
      const { atFirst } = await liveTrip();
      const stranger = await loginPassenger(app);
      await request(http()).get(`${API}/tracking/bookings/${atFirst.id}`).set(stranger.auth).expect(404);
    });
  });

  describe('scanning against the bus position', () => {
    it('boards a ticket whose point is where the bus is', async () => {
      const { trip, points, atFirst, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      const res = await scan(crew, trip.id, atFirst);
      expect(res.body.result).toBe('BOARDED');
      expect(res.body.ticket.boardingPointName).toBe('فرع الرياض');
    });

    it('warns about a ticket from another point, without boarding it', async () => {
      const { trip, points, atSecond, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      const res = await scan(crew, trip.id, atSecond);
      expect(res.body.result).toBe('WRONG_POINT');
      expect(res.body.ticket).toMatchObject({ boardingPointName: 'فرع الخرج', bus: { liveStatus: 'AT_POINT', pointName: 'فرع الرياض' } });
      expect((await prisma.ticket.findFirstOrThrow({ where: { bookingId: atSecond.id } })).isBoarded).toBe(false);
    });

    it('warns when no point has been chosen yet or the bus is on the road', async () => {
      const { trip, atFirst, crew } = await setup();
      expect((await scan(crew, trip.id, atFirst)).body.result).toBe('WRONG_POINT');
      await setStatus(crew, trip.id, { status: 'ON_ROAD' }).expect(201);
      const onRoad = await scan(crew, trip.id, atFirst);
      expect(onRoad.body.result).toBe('WRONG_POINT');
      expect(onRoad.body.ticket.bus).toEqual({ liveStatus: 'ON_ROAD', pointName: null });
    });

    it('boards after the crew accepts the warning, and leaves that on the record', async () => {
      const { trip, points, atSecond, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      expect((await scan(crew, trip.id, atSecond, { allowOtherPoint: true })).body.result).toBe('BOARDED');
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: atSecond.id, action: 'BOARDED' } });
      expect((event.after as any).otherPoint).toEqual({ ticket: 'فرع الخرج', bus: 'فرع الرياض' });
    });

    it('applies to manual boarding from the list too', async () => {
      const { trip, points, atSecond, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      const number = atSecond.passengers[0].ticket.ticketNumber;
      const warned = await request(http()).post(`${API}/tickets/${number}/board`).set(crew.auth).send({ tripId: trip.id }).expect(201);
      expect(warned.body.result).toBe('WRONG_POINT');
      const accepted = await request(http()).post(`${API}/tickets/${number}/board`).set(crew.auth).send({ tripId: trip.id, allowOtherPoint: true }).expect(201);
      expect(accepted.body.result).toBe('BOARDED');
    });

    it('never warns about a booking that chose no point', async () => {
      const { trip, crew } = await setup();
      const passenger = await loginPassenger(app);
      const booking = (await request(http()).post(`${API}/bookings`).set(passenger.auth).send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['9'] }], passengers: [{ fullName: 'راكب' }] }).expect(201)).body.bookings[0];
      expect((await scan(crew, trip.id, booking)).body.result).toBe('BOARDED');
    });

    it('still reports a used ticket as used, whatever the bus position', async () => {
      const { trip, points, atFirst, crew } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      await scan(crew, trip.id, atFirst);
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[1].id }).expect(201);
      expect((await scan(crew, trip.id, atFirst)).body.result).toBe('ALREADY_USED');
    });
  });

  describe('crew reports', () => {
    const file = (session: any, id: string, name: string, content: Buffer) => request(http()).post(`${API}/crew/reports/${id}/attachments`).set(session.auth).attach('files', content, name);
    const report = (session: any, tripId: string, body: object = {}) => request(http()).post(`${API}/tickets/trips/${tripId}/reports`).set(session.auth).send({ type: 'BREAKDOWN', details: 'عطل في التكييف', ...body });

    it('files with the location and the bus position at that moment, and reaches the office and the crew', async () => {
      const { trip, points, crew, driver } = await setup();
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[1].id }).expect(201);
      const created = (await report(crew, trip.id, { category: 'HELP', lat: 24.7, lng: 46.6, accuracy: 12 }).expect(201)).body;
      expect(created.code).toMatch(/^BL-\d{4,}$/);
      expect(created).toMatchObject({ category: 'HELP', status: 'OPEN', lat: 24.7, lng: 46.6, liveStatusAtReport: 'AT_POINT', pointNameAtReport: 'فرع الخرج' });

      const officeRow = await prisma.notification.findFirstOrThrow({ where: { event: 'STAFF_TRIP_REPORT', tripId: trip.id } });
      expect(officeRow.reportId).toBe(created.id);
      expect((await eventsFor(driver.id, 'CREW_COLLEAGUE_REPORT'))[0].reportId).toBe(created.id);
    });

    it('sends a distress call its own alert, even before the trip opens to the crew', async () => {
      const { trip, crew } = await setup();
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 72 * 3_600_000), arrivalTime: new Date(Date.now() + 77 * 3_600_000), crewOpensBeforeMinutes: 60 } });
      await report(crew, trip.id).expect(409);
      await report(crew, trip.id, { category: 'SOS', type: 'OTHER', details: 'طلب استغاثة عاجل' }).expect(201);
      const alert = await prisma.notification.findFirstOrThrow({ where: { event: 'STAFF_TRIP_SOS', tripId: trip.id } });
      expect(alert.title).toContain('استغاثة');
    });

    it('does not create two reports when a retry repeats its key', async () => {
      const { trip, crew } = await setup();
      const first = (await report(crew, trip.id, { idempotencyKey: 'retry-1' }).expect(201)).body;
      const second = (await report(crew, trip.id, { idempotencyKey: 'retry-1' }).expect(201)).body;
      expect(second.id).toBe(first.id);
      expect(await prisma.tripReport.count({ where: { tripId: trip.id } })).toBe(1);
    });

    it('refuses half a location', async () => {
      const { trip, crew } = await setup();
      await report(crew, trip.id, { lat: 24.7 }).expect(400);
      await report(crew, trip.id, { lat: 200, lng: 46 }).expect(400);
    });

    it('takes photos and videos judged by their bytes, and nothing else', async () => {
      const { trip, crew, driverSession } = await setup();
      const created = (await report(crew, trip.id).expect(201)).body;

      const photo = (await file(crew, created.id, 'a.jpg', JPEG).expect(201)).body;
      expect(photo[0]).toMatchObject({ mimeType: 'image/jpeg', fileName: 'a.jpg' });
      expect(photo[0].data).toBeUndefined();
      const both = (await file(crew, created.id, 'clip.bin', MP4).expect(201)).body;
      expect(both[1].mimeType).toBe('video/mp4');

      await file(crew, created.id, 'fake.jpg', Buffer.from('<html><script>alert(1)</script>')).expect(400);

      const download = await request(http()).get(`${API}/crew/reports/attachments/${photo[0].id}`).set(driverSession.auth).expect(200);
      expect(download.headers['content-disposition']).toContain('attachment');
      await request(http()).get(`${API}/trip-reports/attachments/${photo[0].id}`).set(admin.auth).expect(200);
      await request(http()).get(`${API}/trip-reports/attachments/${photo[0].id}`).set(driverSession.auth).expect(403);
    });

    it('shows the crew of the trip its history, and nobody else', async () => {
      const { trip, crew, driverSession } = await setup();
      const created = (await report(crew, trip.id).expect(201)).body;
      const list = (await request(http()).get(`${API}/crew/trips/${trip.id}/reports`).set(driverSession.auth).expect(200)).body;
      expect(list[0]).toMatchObject({ id: created.id, status: 'OPEN', attachmentCount: 0, updateCount: 0 });

      const stranger = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await request(http()).get(`${API}/crew/trips/${trip.id}/reports`).set(stranger.auth).expect(403);
      await request(http()).get(`${API}/crew/reports/${created.id}`).set(stranger.auth).expect(403);
    });

    it('notifies the crew of every office update and the office of every crew note', async () => {
      const { trip, staff, driver, crew, driverSession } = await setup();
      const created = (await report(crew, trip.id).expect(201)).body;

      const updated = (await request(http()).post(`${API}/trip-reports/${created.id}/updates`).set(admin.auth).send({ status: 'IN_PROGRESS', note: 'أرسلنا فني صيانة' }).expect(201)).body;
      expect(updated.status).toBe('IN_PROGRESS');
      const [toReporter] = await eventsFor(staff.id, 'CREW_REPORT_UPDATED');
      expect(toReporter.body).toContain('قيد المعالجة');
      expect(toReporter.body).toContain('أرسلنا فني صيانة');
      expect(toReporter.reportId).toBe(created.id);
      expect(await eventsFor(driver.id, 'CREW_REPORT_UPDATED')).toHaveLength(1);

      await request(http()).post(`${API}/crew/reports/${created.id}/updates`).set(driverSession.auth).send({ note: 'وصل الفني' }).expect(201);
      expect(await prisma.notification.count({ where: { event: 'STAFF_REPORT_UPDATED', tripId: trip.id } })).toBeGreaterThan(0);
      expect(await eventsFor(staff.id, 'CREW_REPORT_UPDATED')).toHaveLength(2);
      expect(await eventsFor(driver.id, 'CREW_REPORT_UPDATED')).toHaveLength(1);

      const seen = (await request(http()).get(`${API}/crew/reports/${created.id}`).set(crew.auth).expect(200)).body;
      expect(seen.updates.map((row: any) => [row.status, row.note, row.fromOffice])).toEqual([['IN_PROGRESS', 'أرسلنا فني صيانة', true], [null, 'وصل الفني', false]]);
    });

    it('refuses an office update that says nothing new, and a crew member changing the state', async () => {
      const { trip, crew } = await setup();
      const created = (await report(crew, trip.id).expect(201)).body;
      await request(http()).post(`${API}/trip-reports/${created.id}/updates`).set(admin.auth).send({ status: 'OPEN' }).expect(400);
      await request(http()).post(`${API}/trip-reports/${created.id}/updates`).set(crew.auth).send({ status: 'RESOLVED' }).expect(403);
      await request(http()).post(`${API}/crew/reports/${created.id}/updates`).set(crew.auth).send({ note: '   ' }).expect(400);
    });

    it('gives the office everything about the trip behind a report', async () => {
      const { trip, points, atFirst, staff, crew } = await setup();
      // Inside the two hours before departure, when the location may be broadcast.
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 5 * 3_600_000) } });
      await request(http()).post(`${API}/tracking/trips/${trip.id}/location`).set(crew.auth).send({ lat: 24.1, lng: 46.2 }).expect(201);
      await setStatus(crew, trip.id, { status: 'AT_POINT', boardingPointId: points[0].id }).expect(201);
      await scan(crew, trip.id, atFirst);
      await request(http()).post(`${API}/tickets/trips/${trip.id}/notices`).set(crew.auth).send({ message: 'تأخرنا نصف ساعة' }).expect(201);
      const earlier = (await report(crew, trip.id, { details: 'بلاغ سابق' }).expect(201)).body;
      const created = (await report(crew, trip.id, { category: 'SOS', lat: 24.7, lng: 46.6 }).expect(201)).body;
      await file(crew, created.id, 'a.jpg', JPEG).expect(201);

      const shown = (await request(http()).get(`${API}/trip-reports/${created.id}`).set(admin.auth).expect(200)).body;
      expect(shown.reporter).toMatchObject({ id: staff.id, phone: staff.phone });
      expect(shown.attachments).toHaveLength(1);
      expect(shown.attachments[0].data).toBeUndefined();
      expect(shown.tripInfo).toMatchObject({ tripCode: trip.tripCode, liveStatus: 'AT_POINT', passengerCount: 2, boardedCount: 1 });
      expect(shown.tripInfo.currentPoint.name).toBe('فرع الرياض');
      expect(shown.tripInfo.location).toMatchObject({ lat: 24.1, lng: 46.2, isLive: true });
      expect(shown.tripInfo.supervisors[0]).toMatchObject({ id: staff.id, phone: staff.phone });
      expect(shown.tripInfo.points[0]).toMatchObject({ name: 'فرع الرياض', isCurrent: true, visited: true, passengerCount: 1, boardedCount: 1 });
      expect(shown.tripInfo.points[1]).toMatchObject({ name: 'فرع الخرج', isCurrent: false, visited: false, passengerCount: 1, boardedCount: 0 });
      expect(shown.statusHistory[0]).toMatchObject({ status: 'AT_POINT', pointName: 'فرع الرياض' });
      expect(shown.otherReports[0].id).toBe(earlier.id);
      expect(shown.notices).toHaveLength(1);
      expect(shown.notices[0].message).toBe('تأخرنا نصف ساعة');
      // National ids and payment details have no place on this page.
      expect(JSON.stringify(shown)).not.toContain('nationalId');
    });

    it('lists what still needs someone first, and filters', async () => {
      const { trip, crew } = await setup();
      const solved = (await report(crew, trip.id, { details: 'حُل' }).expect(201)).body;
      await request(http()).post(`${API}/trip-reports/${solved.id}/updates`).set(admin.auth).send({ status: 'RESOLVED' }).expect(201);
      const sos = (await report(crew, trip.id, { category: 'SOS', details: 'خطر' }).expect(201)).body;

      const all = (await request(http()).get(`${API}/trip-reports`).set(admin.auth).expect(200)).body;
      expect(all.items.map((row: any) => row.id)).toEqual([sos.id, solved.id]);
      expect(all.summary).toMatchObject({ open: 1, resolved: 1, activeSos: 1 });
      expect((await request(http()).get(`${API}/trip-reports?category=SOS`).set(admin.auth).expect(200)).body.items).toHaveLength(1);
      expect((await request(http()).get(`${API}/trip-reports?status=RESOLVED`).set(admin.auth).expect(200)).body.items[0].id).toBe(solved.id);
      expect((await request(http()).get(`${API}/trip-reports?search=${sos.code}`).set(admin.auth).expect(200)).body.items[0].id).toBe(sos.id);
      expect((await request(http()).get(`${API}/trip-reports/counts`).set(admin.auth).expect(200)).body).toEqual({ open: 1, sos: 1 });
    });

    it('separates reading reports from handling them', async () => {
      await prisma.rank.upsert({ where: { id: 'test-report-reader' }, create: { id: 'test-report-reader', name: 'test-report-reader', role: 'STAFF', jobId: 'job-office', permissions: ['reports.view'] }, update: {} });
      const { trip, crew } = await setup();
      const reader = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-report-reader')).phone);
      const created = (await report(crew, trip.id).expect(201)).body;
      await request(http()).get(`${API}/trip-reports/${created.id}`).set(reader.auth).expect(200);
      await request(http()).post(`${API}/trip-reports/${created.id}/updates`).set(reader.auth).send({ status: 'RESOLVED' }).expect(403);
      await request(http()).get(`${API}/trip-reports`).set(crew.auth).expect(403);
    });

    it('will not delete a trip that has reports', async () => {
      const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
      await prisma.tripReport.create({ data: { tripId: trip.id, type: 'OTHER', details: 'x', createdById: adminUser.id } });
      await expect(prisma.trip.delete({ where: { id: trip.id } })).rejects.toThrow();
    });
  });
});

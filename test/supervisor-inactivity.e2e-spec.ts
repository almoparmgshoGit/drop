import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { CrewWatchdogService } from '../src/modules/tracking/crew-watchdog.service';
import { API, createStaff, createTestApp, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

const MINUTE = 60_000;

describe('Supervisor did not open the app, and silent tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let watchdog: CrewWatchdogService;
  let admin: any;
  let adminId: string;
  const http = () => app.getHttpServer();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    watchdog = app.get(CrewWatchdogService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createStaff(prisma, 'ADMIN');
    adminId = user.id;
    admin = await loginStaff(app, user.phone);
  });

  /** A published trip leaving in `minutes` (negative: already left), with one supervisor. */
  const tripLeavingIn = async (minutes: number) => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + minutes * MINUTE), arrivalTime: new Date(Date.now() + (minutes + 300) * MINUTE) } });
    return { trip, supervisor: staff };
  };
  const eventsOf = (userId: string, event: string) => prisma.notification.count({ where: { userId, event } });

  describe('the supervisor has not opened the app before departure', () => {
    it('tells the office and reminds the supervisor once, then clears when the app is opened', async () => {
      const { trip, supervisor } = await tripLeavingIn(30);
      const first = await watchdog.sweep();
      expect(first.notOpened).toEqual([trip.id]);
      expect(await eventsOf(adminId, 'STAFF_SUPERVISOR_APP_NOT_OPENED')).toBe(1);
      expect(await eventsOf(supervisor.id, 'CREW_OPEN_APP_REMINDER')).toBe(1);

      // Once per trip, however many sweeps run.
      expect((await watchdog.sweep()).notOpened).toEqual([]);
      expect(await eventsOf(adminId, 'STAFF_SUPERVISOR_APP_NOT_OPENED')).toBe(1);

      const status = await request(http()).get(`${API}/tracking/trips/${trip.id}/crew-status`).set(admin.auth).expect(200);
      expect(status.body).toMatchObject({ supervisorAppNotOpened: true, supervisors: [{ id: supervisor.id, appSeenAt: null }] });

      const live = await request(http()).get(`${API}/tracking/live`).set(admin.auth).expect(200);
      expect(live.body.alerts.some((alert: any) => alert.tripId === trip.id && alert.message.includes('لم يفتح التطبيق'))).toBe(true);

      const crew = await loginStaff(app, supervisor.phone);
      await request(http()).post(`${API}/tracking/heartbeat`).set(crew.auth).send({ tripId: trip.id, platform: 'android' }).expect(200);
      expect((await prisma.user.findUnique({ where: { id: supervisor.id } })).crewAppSeenAt).toBeTruthy();
      await watchdog.sweep();
      expect((await prisma.tripCrewAlert.findFirst({ where: { tripId: trip.id } })).resolvedAt).toBeTruthy();
      const after = await request(http()).get(`${API}/tracking/live`).set(admin.auth).expect(200);
      expect(after.body.alerts.some((alert: any) => alert.tripId === trip.id && alert.id.startsWith('crew:'))).toBe(false);
    });

    it('says nothing when the supervisor opened the app in time', async () => {
      const { supervisor } = await tripLeavingIn(30);
      const crew = await loginStaff(app, supervisor.phone);
      await request(http()).post(`${API}/tracking/heartbeat`).set(crew.auth).send({}).expect(200);
      expect((await watchdog.sweep()).notOpened).toEqual([]);
      expect(await eventsOf(adminId, 'STAFF_SUPERVISOR_APP_NOT_OPENED')).toBe(0);
    });

    it('waits for the configured window before departure', async () => {
      await tripLeavingIn(180);
      expect((await watchdog.sweep()).notOpened).toEqual([]);
      await prisma.setting.create({ data: { key: 'supervisorAppCheckBeforeMinutes', value: '240' } });
      expect((await watchdog.sweep()).notOpened).toHaveLength(1);
    });

    it('refuses a heartbeat about a trip that is not the caller\'s', async () => {
      const { trip } = await tripLeavingIn(30);
      const stranger = await loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor')).phone);
      await request(http()).post(`${API}/tracking/heartbeat`).set(stranger.auth).send({ tripId: trip.id }).expect(403);
    });
  });

  describe('the bus position goes silent during the trip', () => {
    it('tells the office and the supervisor once when no position has come since departure', async () => {
      const { trip, supervisor } = await tripLeavingIn(-30);
      const swept = await watchdog.sweep();
      expect(swept.silent).toEqual([trip.id]);
      expect(await eventsOf(adminId, 'STAFF_TRACKING_SILENT')).toBe(1);
      expect(await eventsOf(supervisor.id, 'CREW_TRACKING_SILENT_REMINDER')).toBe(1);
      expect((await watchdog.sweep()).silent).toEqual([]);
    });

    it('stays quiet while a phone or GPS device position is fresh', async () => {
      const { trip, supervisor } = await tripLeavingIn(-30);
      // Upsert: the id middleware adds an id to every plain create, and this table has none.
      const fix = { lat: 24.7, lng: 46.7, source: 'DEVICE', recordedAt: new Date(Date.now() - 2 * MINUTE) };
      await prisma.tripLocation.upsert({ where: { tripId: trip.id }, create: { tripId: trip.id, ...fix }, update: fix });
      expect((await watchdog.sweep()).silent).toEqual([]);
      expect(await eventsOf(supervisor.id, 'CREW_TRACKING_SILENT_REMINDER')).toBe(0);
    });

    it('counts a supervisor sending positions as having opened the app', async () => {
      const { trip, supervisor } = await tripLeavingIn(60);
      const crew = await loginStaff(app, supervisor.phone);
      await request(http()).post(`${API}/tracking/trips/${trip.id}/location`).set(crew.auth).send({ lat: 24.7, lng: 46.7 }).expect(201);
      expect((await watchdog.sweep()).notOpened).toEqual([]);
    });
  });
});

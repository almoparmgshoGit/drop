import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import * as request from 'supertest';
import { NotificationsService } from '../src/common/services/notifications.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

const QUIET_MS = 400;

describe('Realtime delivery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;
  let url: string;
  const sockets: Socket[] = [];
  const http = () => app.getHttpServer();

  const open = (token?: string) => {
    const socket = io(url, { path: '/api/v1/realtime', transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    sockets.push(socket);
    return socket;
  };

  const connected = (token: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = open(token);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  const next = <T = any>(socket: Socket, event: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${event} arrived`)), 5000);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  /** Resolves with whatever arrives during a short wait, for proving that something did not. */
  const during = async (socket: Socket, event: string, action: () => Promise<unknown>) => {
    const received: any[] = [];
    const listener = (payload: unknown) => received.push(payload);
    socket.on(event, listener);
    await action();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    socket.off(event, listener);
    return received;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  const connectError = (socket: Socket) => new Promise<Error>((resolve) => socket.once('connect_error', resolve));

  describe('connecting', () => {
    it('refuses a missing token, a forged token and an expired token', async () => {
      expect((await connectError(open())).message).toBe('unauthorized');
      expect((await connectError(open('not-a-token'))).message).toBe('unauthorized');
      const customer = await loginPassenger(app);
      const expired = await app.get(JwtService).signAsync({ sub: customer.user.id }, { expiresIn: -10 });
      expect((await connectError(open(expired))).message).toBe('unauthorized');
    });

    it('ends the connection when its token runs out, since no further request would ever be refused', async () => {
      const customer = await loginPassenger(app);
      const brief = await app.get(JwtService).signAsync({ sub: customer.user.id }, { expiresIn: 1 });
      const socket = await connected(brief);
      expect(await next<string>(socket, 'disconnect')).toBe('io server disconnect');
    });

    it('drops a blocked account at once and refuses it afterwards', async () => {
      const customer = await loginPassenger(app);
      const socket = await connected(customer.accessToken);
      const gone = next<string>(socket, 'disconnect');
      await request(http()).put(`${API}/users/${customer.user.id}/block`).set(admin.auth).send({ blocked: true, reason: 'اختبار' }).expect((res) => {
        if (res.status >= 400) throw new Error(`Block failed: ${res.status} ${JSON.stringify(res.body)}`);
      });
      expect(await gone).toBe('io server disconnect');
      expect((await connectError(open(customer.accessToken))).message).toBe('unauthorized');
    });
  });

  describe('chat', () => {
    it('delivers each side the message at once, without telling the customer who answered', async () => {
      const customer = await loginPassenger(app);
      const stranger = await loginPassenger(app);
      const [customerSocket, staffSocket, strangerSocket] = await Promise.all([connected(customer.accessToken), connected(admin.accessToken), connected(stranger.accessToken)]);

      const toStaff = next(staffSocket, 'chat:message');
      const leaked = await during(strangerSocket, 'chat:message', async () => {
        await request(http()).post(`${API}/chat/mine/messages`).set(customer.auth).send({ body: 'مرحبا', clientId: 'mine-1' }).expect(201);
      });
      const received = await toStaff;
      expect(received).toMatchObject({ clientId: 'mine-1', message: { body: 'مرحبا', sender: 'CUSTOMER' } });
      expect(leaked).toEqual([]);

      const toCustomer = next(customerSocket, 'chat:message');
      const stafferCopy = next(staffSocket, 'chat:message');
      await request(http()).post(`${API}/chat/conversations/${received.conversationId}/messages`).set(admin.auth).send({ body: 'أهلا بك' }).expect(201);
      const reply = await toCustomer;
      expect(reply.message).toMatchObject({ body: 'أهلا بك', sender: 'STAFF' });
      expect(reply.message.staffId).toBeUndefined();
      expect(reply.message.staffName).toBeUndefined();
      expect(reply.conversationId).toBeUndefined();
      expect((await stafferCopy).message.staffId).toBeDefined();
    });

    it('keeps conversations from staff who cannot read them', async () => {
      const customer = await loginPassenger(app);
      const driver = await createStaff(prisma, 'DRIVER');
      const socket = await connected((await loginStaff(app, driver.phone)).accessToken);
      const received = await during(socket, 'chat:message', () => request(http()).post(`${API}/chat/mine/messages`).set(customer.auth).send({ body: 'سر' }).expect(201));
      expect(received).toEqual([]);
    });
  });

  describe('notifications', () => {
    it('signals the recipient only, and carries no wording', async () => {
      const customer = await loginPassenger(app);
      const other = await loginPassenger(app);
      const [mine, theirs] = await Promise.all([connected(customer.accessToken), connected(other.accessToken)]);
      const notifications = app.get(NotificationsService);
      const leaked = await during(theirs, 'notification:new', async () => {
        const received = next(mine, 'notification:new');
        await notifications.toUser(prisma, 'CHAT_STAFF_REPLY', customer.user.id, { message: 'ردنا' });
        expect(await received).toBeUndefined();
      });
      expect(leaked).toEqual([]);
    });

    it('stays silent until the transaction commits, and for good if it rolls back', async () => {
      const customer = await loginPassenger(app);
      const socket = await connected(customer.accessToken);
      const notifications = app.get(NotificationsService);

      const rolledBack = await during(socket, 'notification:new', () =>
        prisma.$transaction(async (tx) => {
          await notifications.toUser(tx, 'CHAT_STAFF_REPLY', customer.user.id, { message: 'لن يصل' });
          throw new Error('rollback');
        }).catch(() => {}),
      );
      expect(rolledBack).toEqual([]);
      expect(await prisma.notification.count({ where: { userId: customer.user.id } })).toBe(0);

      const arrivals: number[] = [];
      socket.on('notification:new', () => arrivals.push(Date.now()));
      let committedAt = 0;
      await prisma.$transaction(async (tx) => {
        await notifications.toUser(tx, 'CHAT_STAFF_REPLY', customer.user.id, { message: 'يصل' });
        await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
        expect(arrivals).toEqual([]);
        committedAt = Date.now();
      });
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]).toBeGreaterThanOrEqual(committedAt);
    });
  });

  describe('trip tracking', () => {
    const setup = async () => {
      const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload()).expect(201)).body;
      const passenger = await loginPassenger(app);
      const booking = (await request(http()).post(`${API}/bookings`).set(passenger.auth).send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1'] }], passengers: [{ fullName: 'راكب' }] }).expect(201)).body.bookings[0];
      const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
      await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
      await openBoarding(prisma, trip.id);
      // Inside the hours the crew may share a position.
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000), arrivalTime: new Date(Date.now() + 6 * 3_600_000) } });
      return { trip, passenger, booking, crew: await loginStaff(app, staff.phone) };
    };
    const subscribe = (socket: Socket, bookingId: unknown) => socket.emitWithAck('trip:subscribe', { bookingId });
    const report = (crew: any, tripId: string) => request(http()).post(`${API}/tracking/trips/${tripId}/location`).set(crew.auth).send({ lat: 24.7, lng: 46.7, speed: 20 }).expect(201);

    it('streams the position to the booking owner, including when sharing stops', async () => {
      const { trip, passenger, booking, crew } = await setup();
      const socket = await connected(passenger.accessToken);
      expect(await subscribe(socket, booking.id)).toEqual({ ok: true, tripId: trip.id });

      const moved = next(socket, 'trip:location');
      await report(crew, trip.id);
      expect(await moved).toMatchObject({ tripId: trip.id, location: { lat: 24.7, lng: 46.7, speed: 20, isLive: true } });

      const stopped = next(socket, 'trip:location');
      await request(http()).post(`${API}/tracking/trips/${trip.id}/stop`).set(crew.auth).expect(201);
      expect(await stopped).toEqual({ tripId: trip.id, location: null });
    });

    it('tells followers the moment the crew changes the status', async () => {
      const { trip, passenger, booking, crew } = await setup();
      const socket = await connected(passenger.accessToken);
      await subscribe(socket, booking.id);
      const changed = next(socket, 'trip:changed');
      await request(http()).post(`${API}/tickets/trips/${trip.id}/status`).set(crew.auth).send({ status: 'ON_ROAD' }).expect(201);
      expect(await changed).toEqual({ tripId: trip.id });
    });

    it('refuses someone else\'s booking, a cancelled one and bad input', async () => {
      const { trip, passenger, booking, crew } = await setup();
      const stranger = await loginPassenger(app);
      const socket = await connected(stranger.accessToken);
      expect(await subscribe(socket, booking.id)).toEqual({ ok: false });
      expect(await subscribe(socket, { $ne: null })).toEqual({ ok: false });
      expect(await subscribe(socket, 'x'.repeat(65))).toEqual({ ok: false });
      expect(await during(socket, 'trip:location', () => report(crew, trip.id))).toEqual([]);

      await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
      const owner = await connected(passenger.accessToken);
      expect(await subscribe(owner, booking.id)).toEqual({ ok: false });
    });

    it('stops delivering after unsubscribing', async () => {
      const { trip, passenger, booking, crew } = await setup();
      const socket = await connected(passenger.accessToken);
      await subscribe(socket, booking.id);
      await socket.emitWithAck('trip:unsubscribe', { tripId: trip.id });
      expect(await during(socket, 'trip:location', () => report(crew, trip.id))).toEqual([]);
    });
  });
});

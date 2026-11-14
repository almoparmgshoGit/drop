import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { inTravelOrder } from '../src/common/utils/trip-route.util';
import { TripsService } from '../src/modules/trips/trips.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, openBoarding, resetDatabase, tripPayload } from './helpers';

describe('Late and stopped tickets, and the booking card in support chat', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;

  const http = () => app.getHttpServer();
  // A point's time has no date and is read against departure, so these stay in order whatever hour the suite runs.
  const hoursBeforeOpenBoardingDeparture = (hours: number) => new Date(Date.now() + (20 - hours + 3) * 3_600_000).toISOString().slice(11, 16);
  const POINTS = [
    { name: 'النقطة الأولى', time: hoursBeforeOpenBoardingDeparture(3), address: 'أ' },
    { name: 'النقطة الثانية', time: hoursBeforeOpenBoardingDeparture(2), address: 'ب' },
    { name: 'النقطة الثالثة', time: hoursBeforeOpenBoardingDeparture(1), address: 'ج' },
  ];

  const setup = async () => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ boardingPoints: POINTS })).expect(201)).body;
    const stored = await prisma.boardingPoint.findMany({ where: { tripId: trip.id } });
    const points = POINTS.map((point) => stored.find((row) => row.name === point.name)!);
    const customer = await loginPassenger(app);
    const booking = (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ paymentMethod: 'mada', legs: [{ tripId: trip.id, seats: ['1', '2'], boardingPointId: points[0].id }], passengers: [{ fullName: 'راكب أول' }, { fullName: 'راكب ثان' }] })
        .expect(201)
    ).body.bookings[0];
    const staff = await createStaff(prisma, 'STAFF', undefined, 'rank-supervisor');
    await prisma.tripSupervisor.create({ data: { tripId: trip.id, userId: staff.id, isPrimary: true } });
    await openBoarding(prisma, trip.id);
    return { trip, points, customer, booking, crew: await loginStaff(app, staff.phone) };
  };

  const setAt = (crew: any, tripId: string, boardingPointId: string) => request(http()).post(`${API}/tickets/trips/${tripId}/status`).set(crew.auth).send({ status: 'AT_POINT', boardingPointId }).expect(201);
  const setOnRoad = (crew: any, tripId: string) => request(http()).post(`${API}/tickets/trips/${tripId}/status`).set(crew.auth).send({ status: 'ON_ROAD' }).expect(201);
  const boardingOf = async (customer: any, bookingId: string) => (await request(http()).get(`${API}/bookings/${bookingId}`).set(customer.auth).expect(200)).body.boarding;
  const scan = (crew: any, tripId: string, booking: any, index = 0, extra: object = {}) =>
    request(http()).post(`${API}/tickets/verify`).set(crew.auth).send({ signedToken: booking.passengers[index].ticket.signedToken, tripId, ...extra }).expect(201);
  const sendCard = (customer: any, bookingId: string) => request(http()).post(`${API}/chat/mine/booking-card`).set(customer.auth).send({ bookingId });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-comp-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
  });

  describe('ticket state', () => {
    it('waits until the bus leaves the booked point, then is late and lists the points ahead', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      expect((await boardingOf(customer, booking.id)).state).toBe('WAITING');

      await setAt(crew, trip.id, points[0].id);
      expect((await boardingOf(customer, booking.id)).state).toBe('WAITING');

      await setOnRoad(crew, trip.id);
      const late = await boardingOf(customer, booking.id);
      expect(late.state).toBe('LATE');
      expect(late.otherPoints.map((point: any) => point.name)).toEqual(['النقطة الثانية', 'النقطة الثالثة']);

      await setAt(crew, trip.id, points[1].id);
      const atSecond = await boardingOf(customer, booking.id);
      expect(atSecond.state).toBe('LATE');
      expect(atSecond.otherPoints).toEqual([
        { name: 'النقطة الثانية', time: POINTS[1].time, isCurrent: true },
        { name: 'النقطة الثالثة', time: POINTS[2].time, isCurrent: false },
      ]);
      expect((await request(http()).get(`${API}/bookings`).set(customer.auth).expect(200)).body[0].boarding.state).toBe('LATE');
      expect((await request(http()).get(`${API}/tracking/bookings/${booking.id}`).set(customer.auth).expect(200)).body.boarding.state).toBe('LATE');
    });

    it('still boards a late ticket at a later point once the crew accepts it', async () => {
      const { trip, points, booking, crew } = await setup();
      await setAt(crew, trip.id, points[0].id);
      await setAt(crew, trip.id, points[1].id);
      expect((await scan(crew, trip.id, booking)).body.result).toBe('WRONG_POINT');
      expect((await scan(crew, trip.id, booking, 0, { allowOtherPoint: true })).body.result).toBe('BOARDED');
    });

    it('stops the ticket once the bus has left every point, and refuses the scan', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[2].id);
      expect((await boardingOf(customer, booking.id)).state).toBe('LATE');
      await setOnRoad(crew, trip.id);

      expect(await boardingOf(customer, booking.id)).toMatchObject({ state: 'STOPPED', reason: 'BUS_LEFT', otherPoints: [] });
      expect((await scan(crew, trip.id, booking, 0, { allowOtherPoint: true })).body.result).toBe('TICKET_STOPPED');
      expect((await prisma.ticket.count({ where: { bookingId: booking.id, isBoarded: true } }))).toBe(0);
    });

    it('lifts the stop when the crew says the bus is still at a point', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[2].id);
      await setOnRoad(crew, trip.id);
      await setAt(crew, trip.id, points[2].id);
      expect((await boardingOf(customer, booking.id)).state).toBe('LATE');
      expect((await scan(crew, trip.id, booking, 0, { allowOtherPoint: true })).body.result).toBe('BOARDED');
    });

    it('reads the points in travel order however long before departure passengers gather, and across midnight', () => {
      const names = (times: string[]) => inTravelOrder(times.map((time) => ({ time }))).map((point) => point.time);
      expect(names(['09:30', '08:00', '02:00'])).toEqual(['02:00', '08:00', '09:30']);
      expect(names(['01:00', '23:00', '00:15'])).toEqual(['23:00', '00:15', '01:00']);
      expect(names(['08:00'])).toEqual(['08:00']);
    });

    it('does not stop tickets for a mistaken tap on the last point once it is corrected', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[2].id);
      await setAt(crew, trip.id, points[0].id);
      expect((await boardingOf(customer, booking.id)).state).toBe('WAITING');
      await setOnRoad(crew, trip.id);
      expect((await boardingOf(customer, booking.id)).state).toBe('LATE');
    });

    it('stops the ticket when boarding time is over, whatever the crew reported', async () => {
      const { trip, customer, booking } = await setup();
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 2 * 3_600_000), boardingClosesAfterMinutes: 30 } });
      expect(await boardingOf(customer, booking.id)).toMatchObject({ state: 'STOPPED', reason: 'TIME_OVER' });
    });

    it('leaves the office able to board a stopped ticket, since support may resolve it that way', async () => {
      const { trip, points, booking, crew } = await setup();
      await setAt(crew, trip.id, points[2].id);
      await setOnRoad(crew, trip.id);
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() + 3_600_000) } });
      await request(http()).post(`${API}/bookings/admin/${booking.id}/passengers/${booking.passengers[0].id}/board`).set(admin.auth).send({ reason: 'حلها الدعم مع العميل', expectedUpdatedAt: booking.updatedAt }).expect(201);
    });

    it('has nothing to say once everyone has boarded, and marks a part-boarded booking', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[0].id);
      await scan(crew, trip.id, booking, 0);
      expect(await boardingOf(customer, booking.id)).toMatchObject({ state: 'WAITING', isPartial: true });
      await scan(crew, trip.id, booking, 1);
      expect(await boardingOf(customer, booking.id)).toBeNull();
    });
  });

  describe('alerts', () => {
    const eventsFor = (userId: string, event: string) => prisma.notification.findMany({ where: { userId, event } });

    it('tells the customer once when late, naming the points ahead, in place of the general alert', async () => {
      const { trip, points, customer, crew } = await setup();
      await setAt(crew, trip.id, points[0].id);
      expect(await eventsFor(customer.user.id, 'TICKET_LATE')).toHaveLength(0);

      await setOnRoad(crew, trip.id);
      const [late, ...others] = await eventsFor(customer.user.id, 'TICKET_LATE');
      expect(others).toHaveLength(0);
      expect(late.body).toContain('النقطة الأولى');
      expect(late.body).toContain('النقطة الثانية');
      expect(late.body).toContain(POINTS[2].time);
      expect(await eventsFor(customer.user.id, 'BUS_ON_ROAD')).toHaveLength(0);

      await setAt(crew, trip.id, points[1].id);
      await setOnRoad(crew, trip.id);
      expect(await eventsFor(customer.user.id, 'TICKET_LATE')).toHaveLength(1);
    });

    it('tells the customer once when stopped, and goes straight to it if the bus skipped the rest', async () => {
      const { trip, points, customer, crew } = await setup();
      await setAt(crew, trip.id, points[2].id);
      await setOnRoad(crew, trip.id);
      expect(await eventsFor(customer.user.id, 'TICKET_STOPPED')).toHaveLength(1);
      await setAt(crew, trip.id, points[2].id);
      await setOnRoad(crew, trip.id);
      expect(await eventsFor(customer.user.id, 'TICKET_STOPPED')).toHaveLength(1);
    });

    it('says nothing to someone already on board or at a later point', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[0].id);
      await scan(crew, trip.id, booking, 0);
      await scan(crew, trip.id, booking, 1);
      await setOnRoad(crew, trip.id);
      await setAt(crew, trip.id, points[2].id);
      await setOnRoad(crew, trip.id);
      expect(await eventsFor(customer.user.id, 'TICKET_LATE')).toHaveLength(0);
      expect(await eventsFor(customer.user.id, 'TICKET_STOPPED')).toHaveLength(0);
    });

    it('tells the customer when boarding time ends with no word from the crew, once', async () => {
      const { trip, customer } = await setup();
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(Date.now() - 2 * 3_600_000), boardingClosesAfterMinutes: 30 } });
      await app.get(TripsService).announceCrewWindows();
      await app.get(TripsService).announceCrewWindows();
      expect(await eventsFor(customer.user.id, 'TICKET_STOPPED')).toHaveLength(1);
    });
  });

  describe('compensation', () => {
    const url = (bookingId: string) => `${API}/bookings/admin/${bookingId}/compensation`;
    const setSetting = (key: string, value: string) => prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    const stop = async (ctx: any) => {
      await setAt(ctx.crew, ctx.trip.id, ctx.points[2].id);
      await setOnRoad(ctx.crew, ctx.trip.id);
    };
    const balanceOf = async (customer: any) => Number((await prisma.user.findUniqueOrThrow({ where: { id: customer.user.id } })).walletBalance);
    const paidOf = async (bookingId: string) => {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId } });
      return Number(payment.amount) + Number(payment.walletAmount);
    };

    it('refuses until the ticket is stopped', async () => {
      const { booking } = await setup();
      const { body } = await request(http()).get(url(booking.id)).set(admin.auth).expect(200);
      expect(body.isEligible).toBe(false);
      await request(http()).post(url(booking.id)).set(admin.auth).send({ amount: 10, note: 'تعويض' }).expect(409);
      expect(await prisma.ticketCompensation.count()).toBe(0);
    });

    it('suggests the policy amount, credits the wallet once, tells the customer and leaves a record', async () => {
      const ctx = await setup();
      await stop(ctx);
      await setSetting('ticketCompensationPercent', '50');
      const paid = await paidOf(ctx.booking.id);

      const { body: quote } = await request(http()).get(url(ctx.booking.id)).set(admin.auth).expect(200);
      expect(quote).toMatchObject({ isEligible: true, percent: 50, cap: paid, suggested: paid / 2 });

      const { body } = await request(http()).post(url(ctx.booking.id)).set(admin.auth).send({ note: 'لم يلحق بالحافلة' }).expect(201);
      expect(body.amount).toBe(paid / 2);
      expect(await balanceOf(ctx.customer)).toBe(paid / 2);
      expect(await prisma.walletTransaction.count({ where: { userId: ctx.customer.user.id, type: 'COMPENSATION', bookingId: ctx.booking.id } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: ctx.customer.user.id, event: 'TICKET_COMPENSATED' } })).toBe(1);
      expect(await prisma.bookingEvent.count({ where: { bookingId: ctx.booking.id, action: 'COMPENSATED' } })).toBe(1);

      await request(http()).post(url(ctx.booking.id)).set(admin.auth).send({ note: 'مرة ثانية' }).expect(409);
      expect(await balanceOf(ctx.customer)).toBe(paid / 2);
      expect((await boardingOf(ctx.customer, ctx.booking.id)).reason).toBe('COMPENSATED');
    });

    it('caps a part-boarded booking at the share of those who did not travel', async () => {
      const ctx = await setup();
      await setAt(ctx.crew, ctx.trip.id, ctx.points[0].id);
      await scan(ctx.crew, ctx.trip.id, ctx.booking, 0);
      await setAt(ctx.crew, ctx.trip.id, ctx.points[2].id);
      await setOnRoad(ctx.crew, ctx.trip.id);
      const paid = await paidOf(ctx.booking.id);
      const { body: quote } = await request(http()).get(url(ctx.booking.id)).set(admin.auth).expect(200);
      expect(quote.cap).toBe(paid / 2);
      await request(http()).post(url(ctx.booking.id)).set(admin.auth).send({ amount: paid, note: 'أكثر من الحصة' }).expect(409);
    });

    it('takes refund-override permission to go above the policy, and its own permission at all', async () => {
      const ctx = await setup();
      await stop(ctx);
      await setSetting('ticketCompensationPercent', '10');
      const paid = await paidOf(ctx.booking.id);
      const rank = (permissions: string[]) => prisma.rank.create({ data: { id: `test-comp-${permissions.length}`, name: `تعويض ${permissions.length}`, role: 'STAFF', jobId: 'job-office', permissions } as any });
      await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-comp-' } } });
      const staffWith = async (permissions: string[]) => {
        const created = await rank(permissions);
        return loginStaff(app, (await createStaff(prisma, 'STAFF', undefined, created.id)).phone);
      };
      const none = await staffWith(['bookings.view', 'bookings.all_branches']);
      await request(http()).post(url(ctx.booking.id)).set(none.auth).send({ note: 'بدون صلاحية' }).expect(403);

      const limited = await staffWith(['bookings.view', 'bookings.all_branches', 'bookings.compensate']);
      await request(http()).post(url(ctx.booking.id)).set(limited.auth).send({ amount: paid, note: 'فوق النسبة' }).expect(403);
      await request(http()).post(url(ctx.booking.id)).set(limited.auth).send({ note: 'ضمن النسبة' }).expect(201);
    });

    it('does not let the crew reopen a compensated ticket, or a refund pay the same money again', async () => {
      const ctx = await setup();
      await stop(ctx);
      const paid = await paidOf(ctx.booking.id);
      await request(http()).post(url(ctx.booking.id)).set(admin.auth).send({ amount: paid / 2, note: 'تعويض' }).expect(201);

      await setAt(ctx.crew, ctx.trip.id, ctx.points[2].id);
      expect((await scan(ctx.crew, ctx.trip.id, ctx.booking, 0, { allowOtherPoint: true })).body.result).toBe('TICKET_STOPPED');
      await request(http()).post(`${API}/bookings/${ctx.booking.id}/admin-cancel`).set(admin.auth).send({ refundAmount: paid, note: 'إلغاء' }).expect(400);
    });

    describe('automatic', () => {
      const finish = async (ctx: any, boardOne = true) => {
        if (boardOne) {
          await setAt(ctx.crew, ctx.trip.id, ctx.points[0].id);
          const other = await loginPassenger(app);
          const rider = (await request(http()).post(`${API}/bookings`).set(other.auth).send({ paymentMethod: 'mada', category: 'SINGLES', legs: [{ tripId: ctx.trip.id, seats: ['34'], boardingPointId: ctx.points[0].id }], passengers: [{ fullName: 'راكب ثالث' }] }).expect(201)).body.bookings[0];
          await scan(ctx.crew, ctx.trip.id, rider);
        }
        // Arrived, because a trip the crew still reports at a point or on the road stays open past its arrival time.
        await prisma.trip.update({ where: { id: ctx.trip.id }, data: { departureTime: new Date(Date.now() - 7_200_000), arrivalTime: new Date(Date.now() - 1000), liveStatus: 'ARRIVED' } });
        await app.get(TripsService).completeFinishedTrips();
      };

      it('pays nothing while the switch is off', async () => {
        const ctx = await setup();
        await setSetting('ticketCompensationPercent', '50');
        await finish(ctx);
        expect(await prisma.ticketCompensation.count()).toBe(0);
      });

      it('pays the percentage once when on, only after the trip ends', async () => {
        const ctx = await setup();
        await setSetting('ticketCompensationPercent', '50');
        await setSetting('ticketCompensationAutomatic', 'true');
        await prisma.setting.update({ where: { key: 'ticketCompensationAutomatic' }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
        const paid = await paidOf(ctx.booking.id);
        await finish(ctx);
        await app.get(TripsService).completeFinishedTrips();

        const row = await prisma.ticketCompensation.findUniqueOrThrow({ where: { bookingId: ctx.booking.id } });
        expect(row.isAutomatic).toBe(true);
        expect(await balanceOf(ctx.customer)).toBe(paid / 2);
      });

      it('leaves a trip nobody was scanned on to staff, and trips ended before the switch', async () => {
        const noScans = await setup();
        await setSetting('ticketCompensationPercent', '50');
        await setSetting('ticketCompensationAutomatic', 'true');
        await prisma.setting.update({ where: { key: 'ticketCompensationAutomatic' }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
        await finish(noScans, false);
        expect(await prisma.ticketCompensation.count()).toBe(0);

        const before = await setup();
        await prisma.setting.update({ where: { key: 'ticketCompensationAutomatic' }, data: { updatedAt: new Date(Date.now() + 3_600_000) } });
        await finish(before);
        expect(await prisma.ticketCompensation.count()).toBe(0);
      });
    });
  });

  describe('booking card', () => {
    it('sends the booking as it stands to support, without anything that boards the bus', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      await setAt(crew, trip.id, points[0].id);
      await setOnRoad(crew, trip.id);

      const { body: sent } = await sendCard(customer, booking.id).expect(201);
      expect(sent.sender).toBe('CUSTOMER');
      expect(sent.body).toContain(booking.bookingReference);
      expect(sent.bookingCard).toMatchObject({
        bookingId: booking.id,
        reference: booking.bookingReference,
        status: 'CONFIRMED',
        boardingState: 'LATE',
        boardingPointName: 'النقطة الأولى',
        tripCode: trip.tripCode,
        isPaid: true,
      });
      expect(sent.bookingCard.otherPoints).toHaveLength(2);
      expect(sent.bookingCard.passengers).toHaveLength(2);
      expect(sent.bookingCard.passengers[0]).toMatchObject({ name: 'راكب أول', isBoarded: false });
      expect(JSON.stringify(sent.bookingCard)).not.toContain('signedToken');
      expect(JSON.stringify(sent.bookingCard)).not.toContain(booking.passengers[0].ticket.signedToken);

      const list = (await request(http()).get(`${API}/chat/conversations`).set(admin.auth).expect(200)).body;
      expect(list.items[0].staffUnread).toBe(1);
      expect(list.items[0].lastMessagePreview).toContain(booking.bookingReference);
      const thread = (await request(http()).get(`${API}/chat/conversations/${list.items[0].id}`).set(admin.auth).expect(200)).body;
      expect(thread.messages[0].bookingCard.reference).toBe(booking.bookingReference);
    });

    it('works for any ticket, not only a late one', async () => {
      const { customer, booking } = await setup();
      const { body } = await sendCard(customer, booking.id).expect(201);
      expect(body.bookingCard.boardingState).toBe('WAITING');
    });

    it('does not repeat an unchanged card, but sends again when the ticket changed or the thread moved on', async () => {
      const { trip, points, customer, booking, crew } = await setup();
      const first = (await sendCard(customer, booking.id).expect(201)).body;
      expect((await sendCard(customer, booking.id).expect(201)).body.id).toBe(first.id);

      await request(http()).post(`${API}/chat/mine/messages`).set(customer.auth).send({ body: 'رسالة أخرى' }).expect(201);
      const afterMessage = (await sendCard(customer, booking.id).expect(201)).body;
      expect(afterMessage.id).not.toBe(first.id);

      await setAt(crew, trip.id, points[0].id);
      await setOnRoad(crew, trip.id);
      const afterLate = (await sendCard(customer, booking.id).expect(201)).body;
      expect(afterLate.id).not.toBe(afterMessage.id);
      expect(afterLate.bookingCard.boardingState).toBe('LATE');
    });

    it("refuses another customer's booking and accounts that are not customers", async () => {
      const { booking, crew } = await setup();
      const stranger = await loginPassenger(app);
      await sendCard(stranger, booking.id).expect(404);
      await sendCard(crew, booking.id).expect(403);
      expect(await prisma.chatMessage.count()).toBe(0);
    });

    it('reopens a closed conversation', async () => {
      const { customer, booking } = await setup();
      await sendCard(customer, booking.id).expect(201);
      const conversation = await prisma.conversation.findFirstOrThrow();
      await request(http()).put(`${API}/chat/conversations/${conversation.id}`).set(admin.auth).send({ status: 'CLOSED' }).expect(200);
      await sendCard(customer, booking.id).expect(201);
      expect((await prisma.conversation.findFirstOrThrow()).status).toBe('OPEN');
      expect(await prisma.chatMessage.count()).toBe(2);
    });
  });
});

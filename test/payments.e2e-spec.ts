import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('Payments register, cancellation review and refunds', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: any;
  let customer: any;
  let tripCounter = 0;

  const http = () => app.getHttpServer();

  const makeTrip = async (price = 300, daysAhead = 10) => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ price, tripCode: `PAY-${++tripCounter}` })).expect(201)).body;
    const departureTime = new Date(Date.now() + daysAhead * DAY);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime, arrivalTime: new Date(departureTime.getTime() + 3600000), tripStatus: 'PUBLISHED' } });
    return trip;
  };
  const book = async (user: any, trip: any, body: object = {}) => {
    const res = await request(http())
      .post(`${API}/bookings`)
      .set(user.auth)
      .send({ category: 'SINGLES', legs: [{ tripId: trip.id, seats: ['30'] }], passengers: [{ fullName: 'عبدالله العتيبي' }], paymentMethod: 'mada', ...body })
      .expect(201);
    return res.body.bookings[0];
  };
  const requestCancel = (user: any, id: string, reason = 'ظرف طارئ') => request(http()).post(`${API}/bookings/${id}/cancel`).set(user.auth).send({ reason }).expect(201);
  const review = (id: string, body: object, auth = admin.auth) => request(http()).post(`${API}/bookings/${id}/cancellation/review`).set(auth).send(body);
  const details = async (id: string) => (await request(http()).get(`${API}/cancellations/${id}`).set(admin.auth).expect(200)).body;
  const tab = async (name: string) => (await request(http()).get(`${API}/cancellations?tab=${name}`).set(admin.auth).expect(200)).body;
  const payments = async (query = '') => (await request(http()).get(`${API}/payments${query}`).set(admin.auth).expect(200)).body;
  const walletOf = async (id: string) => Number((await prisma.user.findUniqueOrThrow({ where: { id }, select: { walletBalance: true } })).walletBalance);
  const customerNotification = (event: string) => prisma.notification.findFirstOrThrow({ where: { userId: customer.user.id, event }, orderBy: { createdAt: 'desc' } });
  const credited = async (bookingId: string) => (await prisma.creditNote.findMany({ where: { bookingId } })).reduce((sum, note) => sum + Number(note.total), 0);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-pay-' } } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    customer = await loginPassenger(app);
  });

  describe('the register', () => {
    it('records an online charge and nothing for a booking paid wholly from the wallet', async () => {
      const online = await book(customer, await makeTrip());
      const rows = await prisma.paymentTransaction.findMany({ where: { bookingId: online.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'CHARGE', status: 'SUCCEEDED', method: 'mada', simulated: true });
      expect(Number(rows[0].amount)).toBe(300);

      await prisma.user.update({ where: { id: customer.user.id }, data: { walletBalance: 500 } });
      const fromWallet = await book(customer, await makeTrip(), { useWallet: true });
      expect(await prisma.paymentTransaction.count({ where: { bookingId: fromWallet.id } })).toBe(0);
    });

    it('charges only what went through the gateway when the wallet paid part of it', async () => {
      await prisma.user.update({ where: { id: customer.user.id }, data: { walletBalance: 100 } });
      const booking = await book(customer, await makeTrip(), { useWallet: true });
      const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(Number(row.amount)).toBe(200);
    });

    it('summarises the month, filters, and finds a row by its code', async () => {
      const first = await book(customer, await makeTrip(200));
      await book(customer, await makeTrip(300));
      await prisma.paymentTransaction.create({ data: { type: 'CHARGE', status: 'FAILED', bookingId: first.id, amount: 200, method: 'mada', failureReason: 'رفض البنك' } });
      await prisma.paymentTransaction.create({ data: { type: 'CHARGE', status: 'CANCELLED', bookingId: first.id, amount: 200, method: 'card' } });

      const all = await payments();
      expect(all.summary.succeeded).toEqual({ count: 2, amount: 500 });
      expect(all.summary.failed.count).toBe(2);
      expect(all.items).toHaveLength(4);
      expect(all.gatewayConnected).toBe(false);

      const failed = await payments('?state=FAILED');
      expect(failed.items.map((row: any) => row.state)).toEqual(['FAILED']);
      // The cards describe the month, whatever the table is filtered to.
      expect(failed.summary.succeeded.count).toBe(2);

      expect((await payments('?method=card')).items).toHaveLength(1);

      const code = all.items[0].code;
      expect(code).toMatch(/^TX-\d{8}-\d{4,}$/);
      const byCode = await payments(`?search=${code}`);
      expect(byCode.items).toHaveLength(1);
      expect(byCode.items[0].code).toBe(code);
      expect((await payments(`?search=${first.bookingReference}`)).items.length).toBe(3);

      const lastMonth = await payments('?month=2020-01');
      expect(lastMonth.items).toHaveLength(0);
      expect(lastMonth.summary.succeeded.count).toBe(0);
    });

    it('tells bookings made in the app from those made at a branch', async () => {
      await book(customer, await makeTrip(200));
      const atCounter = await book(customer, await makeTrip(300));
      const branch = await prisma.branch.create({ data: { name: 'فرع الحدائق' } });
      await prisma.booking.update({ where: { id: atCounter.id }, data: { source: 'BRANCH', branchId: branch.id } });

      const all = await payments();
      expect(all.summary.fromApp).toEqual({ count: 1, amount: 200 });
      expect(all.summary.fromBranches).toEqual({ count: 1, amount: 300 });
      expect(all.items.find((row: any) => row.bookingId === atCounter.id)).toMatchObject({ source: 'BRANCH', place: 'فرع الحدائق' });

      const fromBranches = await payments('?source=BRANCH');
      expect(fromBranches.items.map((row: any) => row.bookingId)).toEqual([atCounter.id]);
      expect((await payments('?source=APP')).items.map((row: any) => row.place)).toEqual(['التطبيق']);

      const csv = await request(http()).get(`${API}/payments/export?source=BRANCH`).set(admin.auth).expect(200);
      expect(csv.text).toContain('فرع الحدائق');
    });

    it('exports the filtered rows and logs that it happened', async () => {
      await book(customer, await makeTrip());
      const res = await request(http()).get(`${API}/payments/export`).set(admin.auth).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain('رقم العملية');
      expect(res.text).toContain('ناجحة');
      expect(await prisma.auditLog.count({ where: { action: 'GET /payments/export' } })).toBe(1);
    });

    it('freezes a settled row in the database', async () => {
      const booking = await book(customer, await makeTrip());
      const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { bookingId: booking.id } });
      await expect(prisma.paymentTransaction.update({ where: { id: row.id }, data: { amount: 1 } })).rejects.toThrow();
      await expect(prisma.paymentTransaction.delete({ where: { id: row.id } })).rejects.toThrow();
    });

    it('is closed to customers and to staff without the permission', async () => {
      await request(http()).get(`${API}/payments`).set(customer.auth).expect(403);
      await request(http()).get(`${API}/cancellations`).set(customer.auth).expect(403);
      await prisma.rank.upsert({ where: { id: 'test-pay-none' }, create: { id: 'test-pay-none', name: 'test-pay-none', role: 'STAFF', jobId: 'job-office', permissions: ['bookings.view'] }, update: {} });
      const staff = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-pay-none')).phone);
      await request(http()).get(`${API}/payments`).set(staff.auth).expect(403);
      await request(http()).get(`${API}/cancellations/counts`).set(staff.auth).expect(403);
    });
  });

  describe('reviewing a request', () => {
    it('lists a request with its payment and moves it through the tabs on a wallet refund', async () => {
      const booking = await book(customer, await makeTrip());
      await requestCancel(customer, booking.id);

      const waiting = await tab('review');
      expect(waiting.counts).toMatchObject({ review: 1, refunding: 0, finished: 0 });
      expect(waiting.items[0]).toMatchObject({ id: booking.id, paid: 300 });

      const before = await details(booking.id);
      expect(before.money).toMatchObject({ paid: 300, original: 300, wallet: 0, method: 'mada' });
      expect(before.money.chargeCode).toMatch(/^TX-/);
      expect(before.cancelReason).toBe('ظرف طارئ');

      await review(booking.id, { approve: true, refundAmount: 300, refundDestination: 'WALLET', note: 'نأمل خدمتكم قريبًا' }).expect(201);
      expect(await walletOf(customer.user.id)).toBe(300);
      const finished = await tab('finished');
      expect(finished.counts).toMatchObject({ review: 0, refunding: 0, finished: 1 });
      expect(finished.counts.reviewedThisMonth).toBe(1);

      const after = await details(booking.id);
      expect(after.refunds).toHaveLength(1);
      expect(after.refunds[0]).toMatchObject({ status: 'SUCCEEDED', destination: 'WALLET', amount: 300 });
      expect(after.refunds[0].code).toMatch(/^RF-/);
      expect((await customerNotification('BOOKING_CANCELLED')).body).toContain('نأمل خدمتكم قريبًا');
      expect((await payments()).summary.walletRefunds).toEqual({ count: 1, amount: 300 });
    });

    it('leaves no dash behind when the reviewer writes no note', async () => {
      const booking = await book(customer, await makeTrip());
      await requestCancel(customer, booking.id);
      await review(booking.id, { approve: false }).expect(201);
      expect((await customerNotification('CANCELLATION_REJECTED')).body).toMatch(/مؤكدًا\.$/);
      expect((await tab('finished')).items[0].id).toBe(booking.id);
    });

    it('refunds nothing on rejection and shows the note to the customer', async () => {
      const booking = await book(customer, await makeTrip());
      await requestCancel(customer, booking.id);
      await review(booking.id, { approve: false, note: 'انتهت مدة الإلغاء' }).expect(201);
      expect(await walletOf(customer.user.id)).toBe(0);
      expect(await prisma.paymentTransaction.count({ where: { bookingId: booking.id, type: 'REFUND' } })).toBe(0);
      expect((await customerNotification('CANCELLATION_REJECTED')).body).toContain('انتهت مدة الإلغاء');
    });

    it('refuses more than was paid', async () => {
      const booking = await book(customer, await makeTrip());
      await requestCancel(customer, booking.id);
      await review(booking.id, { approve: true, refundAmount: 301, refundDestination: 'ORIGINAL' }).expect(400);
      expect(await prisma.paymentTransaction.count({ where: { bookingId: booking.id, type: 'REFUND' } })).toBe(0);
    });

    it('still lets a rank without approval only reject', async () => {
      await prisma.rank.upsert({ where: { id: 'test-pay-reviewer' }, create: { id: 'test-pay-reviewer', name: 'test-pay-reviewer', role: 'STAFF', jobId: 'job-office', permissions: ['cancellations.review'] }, update: {} });
      const reviewer = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-pay-reviewer')).phone);
      const booking = await book(customer, await makeTrip());
      await requestCancel(customer, booking.id);
      await request(http()).get(`${API}/cancellations?tab=review`).set(reviewer.auth).expect(200);
      await review(booking.id, { approve: true, refundAmount: 300 }, reviewer.auth).expect(403);
      await review(booking.id, { approve: false }, reviewer.auth).expect(201);
    });
  });

  describe('refunding to the original method', () => {
    const approveOriginal = async (bookingId: string, refundAmount: number) => {
      await requestCancel(customer, bookingId);
      await review(bookingId, { approve: true, refundAmount, refundDestination: 'ORIGINAL' }).expect(201);
    };
    const pendingRow = (bookingId: string) => prisma.paymentTransaction.findFirstOrThrow({ where: { bookingId, type: 'REFUND', status: 'PENDING' } });
    const execute = (id: string, body: object) => request(http()).post(`${API}/cancellations/refunds/${id}/execute`).set(admin.auth).send(body);

    it('cancels at once but keeps the money pending until it is executed', async () => {
      const trip = await makeTrip();
      const booking = await book(customer, trip);
      await approveOriginal(booking.id, 300);

      const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(stored.status).toBe('CANCELLED');
      expect(Number(stored.refundAmount)).toBe(0);
      expect(await walletOf(customer.user.id)).toBe(0);
      expect(await credited(booking.id)).toBe(0);

      const seat = await prisma.seat.findFirstOrThrow({ where: { tripId: trip.id, seatNumber: '30' } });
      expect(seat.isBooked).toBe(false);

      expect((await tab('refunding')).items[0].id).toBe(booking.id);
      expect((await tab('finished')).items).toHaveLength(0);
      expect((await payments()).summary.pendingRefunds).toEqual({ count: 1, amount: 300 });
      expect((await customerNotification('BOOKING_CANCELLED_REFUND_PENDING')).body).toContain('300 ر.س');
      expect(await prisma.notification.count({ where: { event: 'STAFF_REFUND_PENDING' } })).toBe(0); // the only other admin is the one who approved

      const seen = (await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200)).body;
      expect(seen.paymentTransactions[0]).toMatchObject({ status: 'PENDING', destination: 'ORIGINAL' });
      expect(seen.paymentTransactions[0].gatewayReference).toBeUndefined();
    });

    it('needs a reference, then settles once and tells the customer', async () => {
      const booking = await book(customer, await makeTrip());
      await approveOriginal(booking.id, 300);
      const row = await pendingRow(booking.id);

      await execute(row.id, {}).expect(400);
      await execute(row.id, { gatewayReference: 'GW-778899' }).expect(201);
      await execute(row.id, { gatewayReference: 'GW-778899' }).expect(409);

      const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(Number(stored.externalRefunded)).toBe(300);
      expect(await credited(booking.id)).toBe(300);
      expect((await customerNotification('REFUND_COMPLETED')).body).toContain('مدى');

      const after = await tab('finished');
      expect(after.items[0].refunded).toBe(300);
      expect((await payments()).summary.originalRefunds).toEqual({ count: 1, amount: 300 });

      // The invoice's collected figure must drop by the refund.
      const invoices = (await request(http()).get(`${API}/invoices`).set(admin.auth).expect(200)).body;
      expect(invoices.items.find((item: any) => item.bookingId === booking.id).paid).toBe(0);
    });

    it('sends the wallet-paid part back to the wallet immediately', async () => {
      await prisma.user.update({ where: { id: customer.user.id }, data: { walletBalance: 100 } });
      const booking = await book(customer, await makeTrip(), { useWallet: true });
      await approveOriginal(booking.id, 300);

      expect(await walletOf(customer.user.id)).toBe(100);
      expect(Number((await pendingRow(booking.id)).amount)).toBe(200);
      expect(await credited(booking.id)).toBe(100);
      await execute((await pendingRow(booking.id)).id, { gatewayReference: 'GW-1' }).expect(201);
      expect(await credited(booking.id)).toBe(300);
    });

    it('takes a partial refund from the original method first', async () => {
      await prisma.user.update({ where: { id: customer.user.id }, data: { walletBalance: 100 } });
      const booking = await book(customer, await makeTrip(), { useWallet: true });
      await approveOriginal(booking.id, 150);
      expect(Number((await pendingRow(booking.id)).amount)).toBe(150);
      expect(await walletOf(customer.user.id)).toBe(0);
    });

    it('refuses the original method for a booking paid wholly from the wallet', async () => {
      await prisma.user.update({ where: { id: customer.user.id }, data: { walletBalance: 500 } });
      const booking = await book(customer, await makeTrip(), { useWallet: true });
      await requestCancel(customer, booking.id);
      await review(booking.id, { approve: true, refundAmount: 300, refundDestination: 'ORIGINAL' }).expect(400);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PENDING_CANCELLATION_REVIEW');
    });

    it('can move a stuck refund to the wallet, once', async () => {
      const booking = await book(customer, await makeTrip());
      await approveOriginal(booking.id, 300);
      const row = await pendingRow(booking.id);
      const move = () => request(http()).post(`${API}/cancellations/refunds/${row.id}/move-to-wallet`).set(admin.auth).send({ reason: 'البطاقة منتهية' });

      await request(http()).post(`${API}/cancellations/refunds/${row.id}/move-to-wallet`).set(admin.auth).send({ reason: '' }).expect(400);
      await move().expect(201);
      await move().expect(409);
      await execute(row.id, { gatewayReference: 'GW-2' }).expect(409);

      expect(await walletOf(customer.user.id)).toBe(300);
      const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(Number(stored.refundAmount)).toBe(300);
      expect(Number(stored.externalRefunded)).toBe(0);
      expect(await credited(booking.id)).toBe(300);
      expect((await details(booking.id)).refunds.map((refund: any) => refund.status)).toEqual(['FAILED', 'SUCCEEDED']);
      expect((await customerNotification('REFUND_COMPLETED')).body).toContain('محفظتك');
    });

    it('requires its own permission to execute', async () => {
      await prisma.rank.upsert({ where: { id: 'test-pay-approver' }, create: { id: 'test-pay-approver', name: 'test-pay-approver', role: 'STAFF', jobId: 'job-office', permissions: ['cancellations.approve'] }, update: {} });
      const approver = await loginStaff(app, (await createStaff(prisma, 'STAFF', nextPhone(), 'test-pay-approver')).phone);
      const booking = await book(customer, await makeTrip());
      await approveOriginal(booking.id, 300);
      const row = await pendingRow(booking.id);
      await request(http()).post(`${API}/cancellations/refunds/${row.id}/execute`).set(approver.auth).send({ gatewayReference: 'GW-3' }).expect(403);
    });

    describe('a booking paid in cash at a branch', () => {
      let branchId: string;

      const makeCashBooking = async (trip: any) => {
        const booking = await prisma.booking.create({
          data: {
            bookingReference: `DR-CASH-${++tripCounter}`,
            userId: customer.user.id,
            tripId: trip.id,
            branchId,
            source: 'BRANCH',
            status: 'CONFIRMED',
            totalPrice: 100,
            passengers: { create: [{ fullName: 'ناصر', seatNumber: '4' }] },
            payment: { create: { amount: 100, status: 'PENDING' } },
          },
        });
        await request(http())
          .post(`${API}/collections/bookings/${booking.id}`)
          .set(admin.auth)
          .send({ method: 'CASH', amount: 100, branchId, idempotencyKey: `cash-${booking.id}` })
          .expect(201);
        return booking;
      };
      const drawer = async () => (await request(http()).get(`${API}/cash/branches/${branchId}/overview`).set(admin.auth).expect(200)).body.lines;

      beforeEach(async () => {
        branchId = (await prisma.branch.create({ data: { name: 'فرع الحدائق' } })).id;
        await request(http()).post(`${API}/cash/branches/${branchId}/sessions`).set(admin.auth).send({ openingBalance: 50 }).expect(201);
      });

      it('pays out of the drawer only when executed, and needs no reference', async () => {
        const booking = await makeCashBooking(await makeTrip());
        await approveOriginal(booking.id, 100);
        const row = await pendingRow(booking.id);
        expect(row).toMatchObject({ method: 'cash', branchId });
        expect((await drawer()).refunds).toBe(0);

        await execute(row.id, {}).expect(201);
        expect((await drawer()).refunds).toBe(100);
        expect((await drawer()).expected).toBe(50);
        expect(await credited(booking.id)).toBe(100);
        await execute(row.id, {}).expect(409);
        expect((await drawer()).refunds).toBe(100);
      });

      it('stops at another branch', async () => {
        const booking = await makeCashBooking(await makeTrip());
        await approveOriginal(booking.id, 100);
        const row = await pendingRow(booking.id);

        const otherBranch = await prisma.branch.create({ data: { name: 'فرع العليا' } });
        await prisma.rank.upsert({ where: { id: 'test-pay-cashier' }, create: { id: 'test-pay-cashier', name: 'test-pay-cashier', role: 'STAFF', jobId: 'job-office', permissions: ['refunds.execute'] }, update: {} });
        const cashierUser = await createStaff(prisma, 'STAFF', nextPhone(), 'test-pay-cashier');
        await prisma.user.update({ where: { id: cashierUser.id }, data: { branchId: otherBranch.id } });
        const cashier = await loginStaff(app, cashierUser.phone);
        await request(http()).post(`${API}/cancellations/refunds/${row.id}/execute`).set(cashier.auth).send({}).expect(403);
      });

      it('refuses while the drawer is closed, and the refund stays pending', async () => {
        const booking = await makeCashBooking(await makeTrip());
        await approveOriginal(booking.id, 100);
        const row = await pendingRow(booking.id);
        const overview = (await request(http()).get(`${API}/cash/branches/${branchId}/overview`).set(admin.auth).expect(200)).body;
        await request(http())
          .post(`${API}/cash/sessions/${overview.session.id}/close`)
          .set(admin.auth)
          .send({ expectedBalance: overview.lines.expected, countedCash: overview.lines.expected })
          .expect(201);
        await execute(row.id, {}).expect(409);
        expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
      });
    });
  });

  describe('the policy', () => {
    const saveRules = (cancellationRules: object[]) => request(http()).put(`${API}/settings`).set(admin.auth).send({ cancellationRules });

    it('suggests the refund from the request date and tells the customer first', async () => {
      await saveRules([{ minDays: 0, percent: 0 }, { minDays: 7, percent: 100 }, { minDays: 3, percent: 50 }]).expect(200);
      const settings = (await request(http()).get(`${API}/settings`).expect(200)).body;
      expect(settings.cancellationRules.map((rule: any) => rule.minDays)).toEqual([7, 3, 0]);

      const trip = await makeTrip(300, 5);
      const booking = await book(customer, trip);
      const seen = (await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200)).body;
      expect(seen.cancellationEstimate).toEqual({ percent: 50, amount: 150 });

      await requestCancel(customer, booking.id);
      // Time passing during the review must not lower what the request earned.
      const now = Date.now();
      await prisma.trip.update({ where: { id: trip.id }, data: { departureTime: new Date(now + DAY), arrivalTime: new Date(now + 2 * DAY) } });
      await prisma.booking.update({ where: { id: booking.id }, data: { cancelRequestedAt: new Date(now - 4 * DAY) } });
      const later = await details(booking.id);
      expect(later.policy.daysLeft).toBe(5);
      expect(later.policy.rule.percent).toBe(50);
      expect(later.policy.suggested).toBe(150);
    });

    it('offers no suggestion when no rules are set', async () => {
      const booking = await book(customer, await makeTrip());
      expect((await request(http()).get(`${API}/bookings/${booking.id}`).set(customer.auth).expect(200)).body.cancellationEstimate).toBeNull();
      await requestCancel(customer, booking.id);
      const shown = await details(booking.id);
      expect(shown.policy.rule).toBeNull();
      expect(shown.policy.suggested).toBeNull();
    });

    it('rejects two rules for the same number of days and out-of-range values', async () => {
      await saveRules([{ minDays: 3, percent: 50 }, { minDays: 3, percent: 20 }]).expect(400);
      await saveRules([{ minDays: 3, percent: 150 }]).expect(400);
    });
  });
});

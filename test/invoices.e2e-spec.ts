import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { BookingCancellationService } from '../src/common/services/booking-cancellation.service';
import { InvoiceLedgerService } from '../src/common/services/invoice-ledger.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { amountInWords, zatcaQr } from '../src/common/utils/invoice.util';
import { riyadhMonth } from '../src/common/utils/time.util';
import { CashService } from '../src/modules/cash/cash.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, nextPhone, resetDatabase, tripPayload } from './helpers';

let keyCounter = 0;
const key = () => `invoice-key-${++keyCounter}`;
const DAY = 24 * 60 * 60 * 1000;
const VAT_NUMBER = '311304811500003';
const PDF = Buffer.from('%PDF-1.7 test', 'latin1');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'latin1');

describe('Invoices, tax report and trip accounts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let adminUser: { id: string; phone: string };
  let branchId: string;
  let otherBranchId: string;
  let tripId: string;

  const http = () => app.getHttpServer();
  const get = (url: string, auth = admin.auth) => request(http()).get(`${API}${url}`).set(auth);
  const post = (url: string, body: object, auth = admin.auth) => request(http()).post(`${API}${url}`).set(auth).send(body);
  const month = () => riyadhMonth(new Date());
  const makeTrip = async (overrides: Record<string, unknown> = {}, daysAhead = 2) => {
    const trip = (await post('/trips', tripPayload(overrides)).expect(201)).body;
    const departureTime = new Date(Date.now() + daysAhead * DAY);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime, arrivalTime: new Date(departureTime.getTime() + 3600000) } });
    return trip.id as string;
  };
  /** Staff-entered bookings skip the app flow, so the invoice is issued the way a branch screen will issue it. */
  const makeBooking = async (options: { due?: number; total?: number; wallet?: number; status?: string; branch?: string | null; trip?: string; passenger?: string } = {}) => {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `DR-${key()}`,
        userId: adminUser.id,
        tripId: options.trip ?? tripId,
        branchId: options.branch === undefined ? branchId : options.branch,
        source: 'BRANCH',
        status: 'CONFIRMED',
        totalPrice: options.total ?? options.due ?? 115,
        passengers: { create: [{ fullName: options.passenger ?? 'ناصر الحربي', nationalId: '1012345678', phone: '+966544102231', seatNumber: '4' }] },
        payment: { create: { amount: options.due ?? 115, walletAmount: options.wallet ?? 0, status: options.status ?? 'PENDING', method: options.status ? 'cash' : null } },
      },
    });
    await prisma.$transaction((tx) => app.get(InvoiceLedgerService).ensure(tx, booking.id));
    return booking;
  };
  const staffWith = async (id: string, permissions: string[], branch?: string) => {
    await prisma.rank.upsert({
      where: { id },
      create: { id, name: id, role: 'STAFF', jobId: 'job-office', permissions },
      update: { permissions },
    });
    const user = await createStaff(prisma, 'STAFF', nextPhone(), id);
    if (branch) await prisma.user.update({ where: { id: user.id }, data: { branchId: branch } });
    return loginStaff(app, user.phone);
  };
  /** Sends the entry the way the form does, as multipart with its files. */
  const entryWithFiles = (trip: string, body: Record<string, unknown>, files: { data: Buffer; name: string }[], auth = admin.auth) => {
    let req = request(http()).post(`${API}/trip-accounts/${trip}/entries`).set(auth);
    const fields = { categoryId: 'acct-fuel', amount: 115, spentOn: new Date().toISOString().slice(0, 10), hasTaxInvoice: false, idempotencyKey: key(), ...body };
    for (const [name, value] of Object.entries(fields)) req = req.field(name, String(value));
    for (const file of files) req = req.attach('invoices', file.data, file.name);
    return req;
  };
  const taxedEntry = (trip: string, body: Record<string, unknown> = {}) => entryWithFiles(trip, { hasTaxInvoice: true, ...body }, [{ data: PDF, name: 'فاتورة.pdf' }]);
  const entry = (trip: string, body: Record<string, unknown> = {}, auth = admin.auth) =>
    post(`/trip-accounts/${trip}/entries`, { categoryId: 'acct-fuel', amount: 115, spentOn: new Date().toISOString().slice(0, 10), hasTaxInvoice: false, idempotencyKey: key(), ...body }, auth);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.rank.deleteMany({ where: { id: { startsWith: 'test-inv-' } } });
    await prisma.accountCategory.deleteMany({ where: { isSystem: false } });
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.accountCategory.deleteMany({ where: { isSystem: false } });
    adminUser = (await createStaff(prisma, 'ADMIN')) as any;
    admin = await loginStaff(app, adminUser.phone);
    branchId = (await prisma.branch.create({ data: { name: 'فرع الحدائق' } })).id;
    otherBranchId = (await prisma.branch.create({ data: { name: 'فرع العليا' } })).id;
    tripId = await makeTrip();
  });

  describe('access', () => {
    const PROTECTED: [string, string][] = [
      ['get', '/invoices'],
      ['get', '/invoices/tax-report?month=2026-10'],
      ['get', '/invoices/bookings/any'],
      ['get', '/trip-accounts'],
      ['get', '/trip-accounts/categories'],
      ['get', '/trip-accounts/any'],
      ['post', '/trip-accounts/any/entries'],
      ['post', '/trip-accounts/categories'],
      ['post', '/trip-accounts/entries/any/void'],
      ['post', '/trip-accounts/entries/any/settle'],
      ['patch', '/trip-accounts/any/tax-flags'],
      ['patch', '/trip-accounts/categories/any'],
    ];

    it('refuses anonymous callers, customers and staff without the permission on every route', async () => {
      const customer = await loginPassenger(app);
      const driver = await loginStaff(app, (await createStaff(prisma, 'DRIVER')).phone);
      for (const [method, url] of PROTECTED) {
        await (request(http()) as any)[method](`${API}${url}`).expect(401);
        for (const who of [customer, driver]) await (request(http()) as any)[method](`${API}${url}`).set(who.auth).expect(403);
      }
    });

    it('keeps each permission to its own screen', async () => {
      const taxOnly = await staffWith('test-inv-tax', ['tax.view']);
      await get('/invoices/tax-report?month=2026-10', taxOnly.auth).expect(200);
      await get('/invoices', taxOnly.auth).expect(403);
      await get('/trip-accounts', taxOnly.auth).expect(403);

      const reader = await staffWith('test-inv-reader', ['trip_accounts.view']);
      await get('/trip-accounts', reader.auth).expect(200);
      await entry(tripId, {}, reader.auth).expect(403);
      await post('/trip-accounts/categories', { name: 'بند', group: 'OTHER' }, reader.auth).expect(403);
      await get('/invoices/tax-report?month=2026-10', reader.auth).expect(403);
    });

    it('lets whoever collects print a receipt, but not browse the register', async () => {
      const booking = await makeBooking();
      const collector = await staffWith('test-inv-collector', ['collections.view', 'collections.collect'], branchId);
      await get(`/invoices/bookings/${booking.id}`, collector.auth).expect(200);
      await get('/invoices', collector.auth).expect(403);
    });

    it('confines invoices to the employee branch, including by direct id', async () => {
      const mine = await makeBooking();
      const theirs = await makeBooking({ branch: otherBranchId });
      const online = await makeBooking({ branch: null });
      const clerk = await staffWith('test-inv-clerk', ['invoices.view'], branchId);

      const seen = (await get('/invoices', clerk.auth).expect(200)).body;
      expect(seen.items.map((row: { bookingId: string }) => row.bookingId)).toEqual([mine.id]);
      expect(seen.summary.count).toBe(1);
      await get(`/invoices/bookings/${mine.id}`, clerk.auth).expect(200);
      await get(`/invoices/bookings/${theirs.id}`, clerk.auth).expect(403);
      await get(`/invoices/bookings/${online.id}`, clerk.auth).expect(403);

      const unassigned = await staffWith('test-inv-noBranch', ['invoices.view']);
      await get('/invoices', unassigned.auth).expect(403);
    });

    it('gives the accountant rank the new screens through the migration', async () => {
      const rank = await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-accountant' } });
      expect(rank.permissions).toEqual(expect.arrayContaining(['invoices.view', 'tax.view', 'trip_accounts.view', 'trip_accounts.manage']));
      const staff = await prisma.rank.findUniqueOrThrow({ where: { id: 'rank-staff' } });
      expect(staff.permissions).not.toContain('tax.view');
    });
  });

  describe('invoices', () => {
    it('issues one for an app booking, with VAT taken out of the inclusive price', async () => {
      const customer = await loginPassenger(app);
      await prisma.trip.update({ where: { id: tripId }, data: { price: 115 } });
      await post('/bookings', { category: 'SINGLES', legs: [{ tripId, seats: ['30'] }], passengers: [{ fullName: 'يوسف شعبان' }], paymentMethod: 'mada' }, customer.auth).expect(201);
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { tripId } });
      expect(invoice.passengerName).toBe('يوسف شعبان');
      expect(Number(invoice.total)).toBe(115);
      expect(Number(invoice.vat)).toBe(15);
      expect(Number(invoice.taxable)).toBe(100);
    });

    it('rejects editing or deleting an invoice or credit note at the database', async () => {
      const booking = await makeBooking();
      await prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, booking.id));
      await expect(prisma.invoice.updateMany({ data: { total: 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.invoice.deleteMany()).rejects.toThrow(/append-only/);
      await expect(prisma.creditNote.updateMany({ data: { total: 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.creditNote.deleteMany()).rejects.toThrow(/append-only/);
    });

    it('keeps what was issued when the booking, trip or settings change afterwards', async () => {
      const booking = await makeBooking({ passenger: 'الاسم الأول' });
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ vatNumber: VAT_NUMBER, vatRate: 5, sellerName: 'اسم جديد' }).expect(200);
      await prisma.bookingPassenger.updateMany({ where: { bookingId: booking.id }, data: { fullName: 'الاسم الثاني' } });
      await prisma.trip.update({ where: { id: tripId }, data: { tripCode: 'CHANGED', destination: 'جدة' } });

      const printed = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
      expect(printed).toMatchObject({ passengerName: 'الاسم الأول', vatRate: 15, vat: 15, total: 115 });
      expect(printed.tripCode).not.toBe('CHANGED');
      expect(printed.destination).toBe('مكة المكرمة');
      expect(printed.seller.name).toBe('دروب الهجرة');
      // An invoice issued before a number was set picks it up, rather than printing none.
      expect(printed.seller.vatNumber).toBe(VAT_NUMBER);
    });

    it('numbers invoices in sequence, and only ever one per booking', async () => {
      const first = await makeBooking();
      const second = await makeBooking();
      const [a, b] = await Promise.all([prisma.invoice.findUniqueOrThrow({ where: { bookingId: first.id } }), prisma.invoice.findUniqueOrThrow({ where: { bookingId: second.id } })]);
      expect(b.number).toBe(a.number + 1);
      await post(`/collections/bookings/${first.id}`, { method: 'NETWORK', amount: 10, idempotencyKey: key() }).expect(201);
      expect(await prisma.invoice.count({ where: { bookingId: first.id } })).toBe(1);
    });

    it('builds the register figures and the design 99.5% collection rate', async () => {
      await makeBooking({ total: 73920, due: 73920, status: 'SIMULATED' });
      await makeBooking({ total: 390, due: 390 });
      const { summary, items, trips } = (await get(`/invoices?month=${month()}`).expect(200)).body;
      expect(summary).toMatchObject({ count: 2, total: 74310, collected: 73920, remaining: 390, rate: 99.5 });
      expect(summary.vat).toBeCloseTo(9692.61, 1);
      expect(summary.taxable).toBeCloseTo(64617.39, 1);
      expect(items[0].number).toMatch(/^INV-D\d{3}-\d{2}\/\d{4}-\d{4}$/);
      expect(trips).toHaveLength(1);
    });

    it('filters by month and trip, and validates them', async () => {
      const otherTrip = await makeTrip();
      await makeBooking();
      await makeBooking({ trip: otherTrip });
      expect((await get(`/invoices?month=${month()}&tripId=${otherTrip}`).expect(200)).body.summary.count).toBe(1);
      expect((await get('/invoices?month=2020-01').expect(200)).body.summary).toMatchObject({ count: 0, rate: null });
      await get('/invoices?month=2026-13').expect(400);
      await get('/invoices?month=abc').expect(400);
      await get('/invoices?page=0').expect(400);
    });

    it('counts wallet money as paid and stops chasing a cancelled booking', async () => {
      const paidByWallet = await makeBooking({ total: 100, due: 60, wallet: 40 });
      const cancelled = await makeBooking({ total: 50, due: 50 });
      await prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, cancelled.id));
      const { items } = (await get('/invoices').expect(200)).body;
      expect(items.find((row: any) => row.bookingId === paidByWallet.id)).toMatchObject({ paid: 40, remaining: 60, isCancelled: false });
      expect(items.find((row: any) => row.bookingId === cancelled.id)).toMatchObject({ paid: 0, remaining: 0, isCancelled: true, credited: 50 });
    });

    it('prints live payment figures beside the frozen invoice', async () => {
      const booking = await makeBooking({ due: 115 });
      await post(`/collections/bookings/${booking.id}`, { method: 'NETWORK', amount: 40, reference: 'POS-4471', idempotencyKey: key() }).expect(201);
      let printed = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
      expect(printed).toMatchObject({ paid: 40, remaining: 75, paymentState: 'جزئي', paymentLabel: 'شبكة', taxable: 100, vat: 15, branchName: 'فرع الحدائق', seats: ['4'] });
      expect(printed.amountInWords).toBe('مائة وخمسة عشر ريالًا فقط لا غير');
      await post(`/collections/bookings/${booking.id}`, { method: 'NETWORK', amount: 75, idempotencyKey: key() }).expect(201);
      printed = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
      expect(printed).toMatchObject({ remaining: 0, paymentState: 'مكتمل' });
      expect(printed.nationalId).toBeUndefined();
    });

    it('answers 404 for a booking that does not exist', async () => {
      await get('/invoices/bookings/missing').expect(404);
    });

    it('encodes the authority QR with byte lengths and only once a VAT number exists', async () => {
      const booking = await makeBooking();
      expect((await get(`/invoices/bookings/${booking.id}`).expect(200)).body.qr).toBeNull();
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ vatNumber: VAT_NUMBER }).expect(200);
      const printed = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;

      const bytes = Buffer.from(printed.qr, 'base64');
      const fields: string[] = [];
      for (let at = 0, tag = 1; at < bytes.length; tag++) {
        expect(bytes[at]).toBe(tag);
        const length = bytes[at + 1];
        fields.push(bytes.subarray(at + 2, at + 2 + length).toString('utf8'));
        at += 2 + length;
      }
      expect(fields).toEqual(['دروب الهجرة', VAT_NUMBER, new Date(printed.issuedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'), '115.00', '15.00']);
    });

    it('writes amounts the way the design does', () => {
      expect(amountInWords(50)).toBe('خمسون ريالًا فقط لا غير');
      expect(amountInWords(1)).toBe('ريال واحد فقط لا غير');
      expect(amountInWords(2)).toBe('ريالان فقط لا غير');
      expect(amountInWords(7)).toBe('سبعة ريالات فقط لا غير');
      expect(amountInWords(100)).toBe('مائة ريال فقط لا غير');
      expect(amountInWords(21.25)).toBe('واحد وعشرون ريالًا وخمس وعشرون هللة فقط لا غير');
      expect(amountInWords(1250)).toBe('ألف ومائتان وخمسون ريالًا فقط لا غير');
      expect(amountInWords(3000)).toBe('ثلاثة آلاف ريال فقط لا غير');
      expect(amountInWords(0.5)).toBe('خمسون هللة فقط لا غير');
    });

    it('rejects a malformed VAT number in settings', async () => {
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ vatNumber: '12345' }).expect(400);
      await request(http()).put(`${API}/settings`).set(admin.auth).send({ vatNumber: '' }).expect(200);
    });

    it('fits an Arabic seller name of the longest allowed length in the QR', () => {
      const qr = zatcaQr({ seller: 'س'.repeat(100), vatNumber: VAT_NUMBER, issuedAt: new Date(), total: 1, vat: 0.13 });
      expect(Buffer.from(qr, 'base64')[1]).toBe(200);
    });
  });

  describe('credit notes', () => {
    const cancel = (bookingId: string, options?: { refundAmount: number }) => prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, bookingId, options));
    const notes = (bookingId: string) => prisma.creditNote.findMany({ where: { bookingId }, orderBy: { number: 'asc' } });

    it('reverses the whole invoice of a fully refunded booking', async () => {
      const booking = await makeBooking({ total: 115, due: 115, status: 'SIMULATED' });
      await cancel(booking.id);
      const [note] = await notes(booking.id);
      expect(Number(note.total)).toBe(115);
      expect(Number(note.vat)).toBe(15);
      expect(Number(note.taxable)).toBe(100);
    });

    it('keeps only what the company held on to as a sale', async () => {
      const booking = await makeBooking({ total: 115, due: 115, status: 'SIMULATED' });
      await cancel(booking.id, { refundAmount: 46 });
      const [note] = await notes(booking.id);
      expect(Number(note.total)).toBe(46);
      expect(Number(note.vat)).toBe(6);
    });

    it('reverses a cancelled booking nobody paid, without crediting any money', async () => {
      const booking = await makeBooking({ total: 115, due: 115 });
      const cancelled = await cancel(booking.id);
      expect(Number(cancelled.refundAmount)).toBe(0);
      expect(Number((await notes(booking.id))[0].total)).toBe(115);
    });

    it('issues none when everything paid is retained', async () => {
      const booking = await makeBooking({ total: 115, due: 115, status: 'SIMULATED' });
      await cancel(booking.id, { refundAmount: 0 });
      expect(await notes(booking.id)).toHaveLength(0);
    });

    it('adds a note for a later cash refund, and notes add up to exactly the invoice VAT', async () => {
      await post(`/cash/branches/${branchId}/sessions`, { openingBalance: 500 }).expect(201);
      const booking = await makeBooking({ total: 100, due: 100 });
      await post(`/collections/bookings/${booking.id}`, { method: 'CASH', amount: 100, branchId, idempotencyKey: key() }).expect(201);
      await cancel(booking.id, { refundAmount: 0 });
      const cash = app.get(CashService);
      const actor = { userId: adminUser.id, role: 'ADMIN', name: 'x', permissions: ['cash.all_branches'] } as any;
      await prisma.$transaction((tx) => cash.recordBookingRefund(tx, actor, { branchId, bookingId: booking.id, amount: 33.33 }));
      await prisma.$transaction((tx) => cash.recordBookingRefund(tx, actor, { branchId, bookingId: booking.id, amount: 33.33 }));
      await prisma.$transaction((tx) => cash.recordBookingRefund(tx, actor, { branchId, bookingId: booking.id, amount: 33.34 }));

      const rows = await notes(booking.id);
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { bookingId: booking.id } });
      expect(rows).toHaveLength(3);
      expect(rows.reduce((sum, row) => sum + Math.round(Number(row.total) * 100), 0)).toBe(10000);
      expect(rows.reduce((sum, row) => sum + Math.round(Number(row.vat) * 100), 0)).toBe(Math.round(Number(invoice.vat) * 100));
    });
  });

  describe('tax report', () => {
    const report = async (query = `month=${month()}`) => (await get(`/invoices/tax-report?${query}`).expect(200)).body;

    it('reproduces the sums in the design', async () => {
      await makeBooking({ total: 74310, due: 74310, status: 'SIMULATED' });
      const refunded = await makeBooking({ total: 1140, due: 1140, status: 'SIMULATED' });
      await prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, refunded.id));
      await taxedEntry(tripId, { amount: 47407.33 }).expect(201);

      const { totals } = await report();
      expect(totals).toMatchObject({ salesCount: 2, sales: 75450, credits: 1140 });
      expect(totals.outputVat).toBeCloseTo(9841.3, 1);
      expect(totals.creditsVat).toBeCloseTo(148.7, 1);
      expect(totals.netOutputVat).toBeCloseTo(totals.outputVat - totals.creditsVat, 2);
      expect(totals.inputVat).toBeCloseTo(6183.57, 1);
      expect(totals.netDue).toBeCloseTo(totals.netOutputVat - totals.inputVat, 2);
    });

    it('counts input VAT only with a tax invoice, and drops it when voided', async () => {
      await entry(tripId, { amount: 115, hasTaxInvoice: false }).expect(201);
      expect((await report()).totals.inputVat).toBe(0);
      const taxed = await taxedEntry(tripId, { amount: 115 }).expect(201);
      expect((await report()).totals.inputVat).toBe(15);
      await post(`/trip-accounts/entries/${taxed.body.id}/void`, { reason: 'خطأ في الإدخال' }).expect(201);
      expect((await report()).totals.inputVat).toBe(0);
    });

    it('takes input VAT from the bus rent and hotels only once flagged, by departure month', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1150 } });
      const before = await report(`month=${riyadhMonth(new Date(Date.now() + 2 * DAY))}`);
      await request(http()).patch(`${API}/trip-accounts/${tripId}/tax-flags`).set(admin.auth).send({ rentHasTaxInvoice: true }).expect(200);
      const after = await report(`month=${riyadhMonth(new Date(Date.now() + 2 * DAY))}`);
      expect(after.totals.inputVat - before.totals.inputVat).toBe(150);
    });

    it('leaves a cancelled trip rent out of input VAT', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1150, tripStatus: 'CANCELLED' } });
      await request(http()).patch(`${API}/trip-accounts/${tripId}/tax-flags`).set(admin.auth).send({ rentHasTaxInvoice: true }).expect(200);
      expect((await report(`month=${riyadhMonth(new Date(Date.now() + 2 * DAY))}`)).totals.inputVat).toBe(0);
    });

    it('adds a quarter up from its months, and covers every branch', async () => {
      await makeBooking({ branch: branchId });
      await makeBooking({ branch: otherBranchId });
      await makeBooking({ branch: null });
      const current = month();
      const quarter = `${current.slice(0, 4)}-Q${Math.ceil(Number(current.slice(5)) / 3)}`;
      const { months, totals } = await report(`quarter=${quarter}`);
      expect(months).toHaveLength(3);
      expect(totals.sales).toBe(345);
      expect(months.reduce((sum: number, row: { sales: number }) => sum + row.sales, 0)).toBe(345);
      await get('/invoices/tax-report?quarter=2026-Q5').expect(400);
    });
  });

  describe('trip accounts', () => {
    const account = async (id = tripId) => (await get(`/trip-accounts/${id}`).expect(200)).body;

    it('adds up a trip the way the design does', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1800 } });
      await makeBooking({ total: 1550, due: 1550, status: 'SIMULATED' });
      await entry(tripId, { categoryId: 'acct-income', amount: 90 }).expect(201);
      await entry(tripId, { categoryId: 'acct-driver', amount: 100 }).expect(201);
      await entry(tripId, { categoryId: 'acct-admin', amount: 60 }).expect(201);
      await entry(tripId, { categoryId: 'acct-other', amount: 40 }).expect(201);
      const hotel = await prisma.hotel.create({ data: { name: 'فندق', city: 'مكة', nightlyRate: 175 } });
      await prisma.hotelBooking.create({
        data: {
          tripId,
          hotelId: hotel.id,
          checkIn: new Date('2026-10-01'),
          checkOut: new Date('2026-10-03'),
          nightlyRate: 175,
          rooms: { create: [{ number: '1', occupants: { connect: { id: (await prisma.bookingPassenger.findFirstOrThrow()).id } } }, { number: '2' }] },
        },
      });

      const { figures } = await account();
      expect(figures).toMatchObject({ tickets: 1550, otherIncome: 90, revenue: 1640, hotels: 350, bus: 1800, driver: 100, admin: 60, other: 40, expenses: 2350, net: -710, collected: 1550, passengers: 1 });
    });

    it('does not double count the driver allowance already inside the rent', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1800, busCost: { create: { driverExpense: 300, delegationExpense: 100 } } } });
      expect((await account()).figures).toMatchObject({ bus: 1800, driver: 0, expenses: 1800 });
    });

    it('counts sold value as revenue, and only what was kept from a cancellation', async () => {
      await makeBooking({ total: 200, due: 200 });
      const cancelled = await makeBooking({ total: 100, due: 100, status: 'SIMULATED' });
      await prisma.$transaction((tx) => app.get(BookingCancellationService).cancel(tx, cancelled.id, { refundAmount: 70 }));
      expect((await account()).figures).toMatchObject({ tickets: 230, collected: 30, remaining: 200 });
    });

    it('includes spending settled from a custody on the trip', async () => {
      await post(`/cash/branches/${branchId}/sessions`, { openingBalance: 1000 }).expect(201);
      const custody = await post(`/cash/branches/${branchId}/custodies`, { recipientId: adminUser.id, purpose: 'وقود الرحلة', amount: 500, tripId, idempotencyKey: key() });
      expect(custody.status).toBe(201);
      await request(http()).post(`${API}/cash/custodies/${custody.body.id}/settle`).set(admin.auth).field('spentAmount', '430').attach('invoices', Buffer.from('%PDF-1.7 test', 'latin1'), 'fuel.pdf').expect(201);
      const body = await account();
      expect(body.figures.other).toBe(430);
      expect(body.custodies[0]).toMatchObject({ spent: 430, purpose: 'وقود الرحلة' });
    });

    it('drops the rent and hotels of a cancelled trip but keeps what was spent', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1800 } });
      await entry(tripId, { amount: 50 }).expect(201);
      await prisma.trip.update({ where: { id: tripId }, data: { tripStatus: 'CANCELLED' } });
      expect((await account()).figures).toMatchObject({ bus: 0, other: 50, net: -50 });
    });

    it('filters by day, week, month, destination and trip code', async () => {
      const riyadh = await makeTrip({ destination: 'المدينة المنورة' }, 2);
      const far = await makeTrip({}, 60);
      const date = new Date(Date.now() + 2 * DAY + 3 * 3600000).toISOString().slice(0, 10);
      const ids = async (query: string) => (await get(`/trip-accounts?${query}`).expect(200)).body.items.map((row: { id: string }) => row.id);

      expect(await ids(`view=day&date=${date}`)).toEqual(expect.arrayContaining([tripId, riyadh]));
      expect(await ids(`view=week&date=${date}`)).not.toContain(far);
      expect(await ids(`view=week&date=${date}&destination=${encodeURIComponent('المدينة المنورة')}`)).toEqual([riyadh]);
      const code = (await prisma.trip.findUniqueOrThrow({ where: { id: far } })).tripCode;
      expect(await ids(`view=trip&q=${code}`)).toEqual([far]);
      await get('/trip-accounts?view=year').expect(400);
      await get('/trip-accounts?view=day&date=2026-02-31').expect(400);
    });

    it('runs a week Saturday to Friday', async () => {
      const { range } = (await get('/trip-accounts?view=week&date=2026-10-28').expect(200)).body;
      expect(range).toEqual({ from: '2026-10-24', to: '2026-10-30' });
    });

    it('sums the summary and finds the best trip', async () => {
      const other = await makeTrip();
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 100 } });
      await prisma.trip.update({ where: { id: other }, data: { busRentalPrice: 500 } });
      await makeBooking({ total: 300, due: 300 });
      const date = new Date(Date.now() + 2 * DAY + 3 * 3600000).toISOString().slice(0, 10);
      const { summary } = (await get(`/trip-accounts?view=day&date=${date}`).expect(200)).body;
      expect(summary).toMatchObject({ trips: 2, revenue: 300, expenses: 600, net: -300 });
      expect(summary.best.net).toBe(200);
    });

    it('hides drafts, and cancelled trips with no money on them', async () => {
      const draft = await makeTrip({ tripStatus: 'DRAFT' });
      const cancelled = await makeTrip();
      await prisma.trip.update({ where: { id: cancelled }, data: { tripStatus: 'CANCELLED' } });
      const ids = (await get('/trip-accounts?view=trip').expect(200)).body.items.map((row: { id: string }) => row.id);
      expect(ids).toEqual([tripId]);
      await entry(draft).expect(409);
    });

    it('validates entries server-side', async () => {
      await entry(tripId, { amount: 0 }).expect(400);
      await entry(tripId, { amount: -5 }).expect(400);
      await entry(tripId, { amount: 1.234 }).expect(400);
      await entry(tripId, { spentOn: 'yesterday' }).expect(400);
      await entry(tripId, { spentOn: '2026-02-31' }).expect(400);
      await entry(tripId, { spentOn: '2099-01-01' }).expect(400);
      await entry(tripId, { categoryId: 'missing' }).expect(400);
      await entry(tripId, { status: 'x' }).expect(400);
      await entry('missing').expect(404);
    });

    describe('uploaded invoices', () => {
      it('requires a file for a tax invoice, and reads the form fields as numbers and booleans', async () => {
        const refused = await entryWithFiles(tripId, { hasTaxInvoice: true }, []).expect(400);
        expect(refused.body.message).toContain('الفاتورة');
        const saved = await entryWithFiles(tripId, { hasTaxInvoice: true, amount: 115 }, [{ data: PDF, name: 'a.pdf' }]).expect(201);
        expect(saved.body).toMatchObject({ hasTaxInvoice: true });
        expect(Number(saved.body.vat)).toBe(15);
      });

      it('keeps a file optional without a tax invoice', async () => {
        await entryWithFiles(tripId, { hasTaxInvoice: false }, []).expect(201);
        await entryWithFiles(tripId, { hasTaxInvoice: false }, [{ data: PNG, name: 'r.png' }]).expect(201);
        const { entries } = await account();
        expect(entries.map((row: { attachments: unknown[] }) => row.attachments.length).sort()).toEqual([0, 1]);
      });

      it('judges a file by its bytes, and saves nothing when one is refused', async () => {
        await entryWithFiles(tripId, { hasTaxInvoice: true }, [{ data: HTML, name: 'invoice.pdf' }]).expect(400);
        await entryWithFiles(tripId, {}, [{ data: PDF, name: 'a.pdf' }, { data: HTML, name: 'b.png' }]).expect(400);
        expect(await prisma.tripAccountEntry.count()).toBe(0);
        expect(await prisma.tripAccountAttachment.count()).toBe(0);
      });

      it('refuses more than five files and files over the size limit', async () => {
        const six = Array.from({ length: 6 }, (_, index) => ({ data: PDF, name: `${index}.pdf` }));
        expect((await entryWithFiles(tripId, {}, six)).status).toBeGreaterThanOrEqual(400);
        const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
        expect((await entryWithFiles(tripId, {}, [{ data: big, name: 'big.pdf' }])).status).toBeGreaterThanOrEqual(400);
        expect(await prisma.tripAccountEntry.count()).toBe(0);
      });

      it('lists files without their bytes, and serves them as a download with the stored type', async () => {
        await entryWithFiles(tripId, {}, [{ data: PDF, name: 'فاتورة وقود.pdf' }]).expect(201);
        const [row] = (await account()).entries;
        const [file] = row.attachments;
        expect(file).toEqual({ id: file.id, fileName: 'فاتورة وقود.pdf', size: PDF.length });
        const res = await get(`/trip-accounts/attachments/${file.id}`).expect(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.headers['content-disposition']).toMatch(/^attachment/);
        expect(Buffer.from(res.body).equals(PDF)).toBe(true);
        await get('/trip-accounts/attachments/missing').expect(404);
      });

      it('lets only trip account readers download, and only managers upload', async () => {
        await entryWithFiles(tripId, {}, [{ data: PDF, name: 'a.pdf' }]).expect(201);
        const [file] = (await account()).entries[0].attachments;
        const url = `${API}/trip-accounts/attachments/${file.id}`;
        await request(http()).get(url).expect(401);
        const outsider = await staffWith('test-inv-outsider', ['invoices.view']);
        await request(http()).get(url).set(outsider.auth).expect(403);
        const reader = await staffWith('test-inv-downloader', ['trip_accounts.view']);
        await request(http()).get(url).set(reader.auth).expect(200);
        await entryWithFiles(tripId, {}, [{ data: PDF, name: 'b.pdf' }], reader.auth).expect(403);
        await entryWithFiles(tripId, {}, [{ data: PDF, name: 'b.pdf' }], outsider.auth).expect(403);
      });

      it('stores one set of files when a submit is repeated', async () => {
        const idempotencyKey = key();
        const results = await Promise.all(Array.from({ length: 3 }, () => entryWithFiles(tripId, { idempotencyKey }, [{ data: PDF, name: 'a.pdf' }])));
        expect(results.every((res) => res.status === 201)).toBe(true);
        expect(await prisma.tripAccountAttachment.count()).toBe(1);
      });

      it('keeps the file on record after the entry is voided', async () => {
        const created = await entryWithFiles(tripId, {}, [{ data: PDF, name: 'a.pdf' }]).expect(201);
        await post(`/trip-accounts/entries/${created.body.id}/void`, { reason: 'خطأ في الإدخال' }).expect(201);
        expect((await account()).entries[0].attachments).toHaveLength(1);
      });
    });

    it('refuses hand entries on lines worked out automatically', async () => {
      await entry(tripId, { categoryId: 'acct-bus' }).expect(400);
      await entry(tripId, { categoryId: 'acct-hotel' }).expect(400);
    });

    it('does not take VAT on other income, whatever the form says', async () => {
      const res = await taxedEntry(tripId, { categoryId: 'acct-income' }).expect(201);
      expect(res.body).toMatchObject({ hasTaxInvoice: false });
      expect(Number(res.body.vat)).toBe(0);
    });

    it('records a repeated submit once, even when they race', async () => {
      const idempotencyKey = key();
      const results = await Promise.all(Array.from({ length: 4 }, () => entry(tripId, { idempotencyKey })));
      expect(results.every((res) => res.status === 201)).toBe(true);
      expect(new Set(results.map((res) => res.body.id)).size).toBe(1);
      expect((await account()).figures.other).toBe(115);
    });

    it('voids an entry once, keeps it on record, and writes the audit log', async () => {
      const created = await entry(tripId).expect(201);
      await post(`/trip-accounts/entries/${created.body.id}/void`, { reason: 'x' }).expect(400);
      await post(`/trip-accounts/entries/${created.body.id}/void`, { reason: 'خطأ في المبلغ' }).expect(201);
      await post(`/trip-accounts/entries/${created.body.id}/void`, { reason: 'مرة ثانية' }).expect(409);
      await post('/trip-accounts/entries/missing/void', { reason: 'لا يوجد' }).expect(404);
      const body = await account();
      expect(body.figures.other).toBe(0);
      expect(body.entries[0]).toMatchObject({ voidReason: 'خطأ في المبلغ' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await prisma.auditLog.count({ where: { entity: 'TripAccounts' } })).toBeGreaterThanOrEqual(2);
    });

    it('posts lines to a party, counts nothing twice, and settles what is due at the month end', async () => {
      await prisma.trip.update({ where: { id: tripId }, data: { busRentalPrice: 1800 } });
      const hotel = await prisma.hotel.create({ data: { name: 'فندق الدين', city: 'مكة', nightlyRate: 100 } });
      await prisma.hotelBooking.create({ data: { tripId, hotelId: hotel.id, checkIn: new Date('2026-10-01'), checkOut: new Date('2026-10-02'), nightlyRate: 100, extraCost: 400 } });
      const before = (await account()).figures;

      // Paid on the bus company's behalf: comes out of its rent, so the expenses stay as they were.
      await entry(tripId, { categoryId: 'acct-driver', amount: 200, chargedTo: 'BUS_COMPANY', settlement: 'DUE_MONTH_END' }).expect(201);
      // A hotel prepayment is offset against the hotel bill; a fine is a cost of its own.
      await entry(tripId, { amount: 150, chargedTo: 'HOTEL', settlement: 'PREPAID' }).expect(201);
      const fine = await entry(tripId, { amount: 80, chargedTo: 'HOTEL', settlement: 'DUE_MONTH_END' }).expect(201);
      await entry(tripId, { amount: 50 }).expect(201);
      await entry(tripId, { categoryId: 'acct-income', amount: 10, chargedTo: 'HOTEL' }).expect(400);
      await entry(tripId, { amount: 10, settlement: 'LATER' }).expect(400);

      const body = await account();
      expect(body.figures.expenses).toBe(before.expenses + 80 + 50);
      expect(body.figures.hotels).toBe(before.hotels + 80);
      expect(body.parties).toMatchObject({
        busCompany: { rent: 1800, deducted: 200, balance: 1600, dueMonthEnd: 200 },
        hotel: { extras: 80, prepaid: 150, dueMonthEnd: 80 },
        office: { amount: 50, dueMonthEnd: 0 },
        dueMonthEnd: 280,
        prepaid: 150,
      });
      expect(body.entries.find((row: { id: string }) => row.id === fine.body.id)).toMatchObject({ settlement: 'DUE_MONTH_END', settledAt: null });

      await post(`/trip-accounts/entries/${fine.body.id}/settle`, {}).expect(201);
      await post(`/trip-accounts/entries/${fine.body.id}/settle`, {}).expect(409);
      await post('/trip-accounts/entries/missing/settle', {}).expect(404);
      const after = await account();
      expect(after.parties.dueMonthEnd).toBe(200);
      expect(after.figures.expenses).toBe(body.figures.expenses);
    });

    it('refuses a hotel booking of another trip in the tax flags', async () => {
      const other = await makeTrip();
      const hotel = await prisma.hotel.create({ data: { name: 'فندق آخر', city: 'مكة', nightlyRate: 100 } });
      const booking = await prisma.hotelBooking.create({ data: { tripId: other, hotelId: hotel.id, checkIn: new Date('2026-10-01'), checkOut: new Date('2026-10-02'), nightlyRate: 100 } });
      await request(http()).patch(`${API}/trip-accounts/${tripId}/tax-flags`).set(admin.auth).send({ hotels: [{ id: booking.id, hasTaxInvoice: true }] }).expect(400);
      await request(http()).patch(`${API}/trip-accounts/${other}/tax-flags`).set(admin.auth).send({ hotels: [{ id: booking.id, hasTaxInvoice: true }] }).expect(200);
    });

    it('manages lines: adds, refuses duplicates and automatic groups, and retires them', async () => {
      const created = await post('/trip-accounts/categories', { name: ' رسوم طريق ', group: 'OTHER' }).expect(201);
      expect(created.body.name).toBe('رسوم طريق');
      await post('/trip-accounts/categories', { name: 'رسوم طريق', group: 'OTHER' }).expect(409);
      await post('/trip-accounts/categories', { name: 'بند', group: 'BUS' }).expect(400);
      await post('/trip-accounts/categories', { name: 'ب', group: 'OTHER' }).expect(400);

      await request(http()).patch(`${API}/trip-accounts/categories/${created.body.id}`).set(admin.auth).send({ isActive: false }).expect(200);
      await entry(tripId, { categoryId: created.body.id }).expect(400);
      await request(http()).patch(`${API}/trip-accounts/categories/acct-bus`).set(admin.auth).send({ isActive: false }).expect(409);
    });

    it('will not delete a trip with money recorded on it', async () => {
      await entry(tripId).expect(201);
      await request(http()).delete(`${API}/trips/${tripId}`).set(admin.auth).expect(409);
    });

    it('answers 404 for a trip that does not exist', async () => {
      await get('/trip-accounts/missing').expect(404);
    });
  });
});

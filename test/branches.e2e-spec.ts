import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginStaff, nextPhone, resetDatabase, STAFF_PASSWORD, tripPayload } from './helpers';

describe('Branches, their staff and counter bookings', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => app.getHttpServer();

  let admin: { auth: Record<string, string> };
  let managerUser: { id: string };
  let manager: { auth: Record<string, string> };
  let clerkUser: { id: string };
  let clerk: { auth: Record<string, string> };
  let otherClerk: { auth: Record<string, string> };
  let branchId: string;
  let otherBranchId: string;
  let outbound: any;
  let inbound: any;
  let hotelId: string;

  const inRank = async (rankId: string, branch: string) => {
    const user = await createStaff(prisma, 'STAFF', nextPhone(), rankId);
    await prisma.user.update({ where: { id: user.id }, data: { branchId: branch } });
    return { user, session: await loginStaff(app, user.phone) };
  };
  const dateOf = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  let seatCounter = 0;
  const nextSeat = () => String(++seatCounter);

  const single = (overrides: Record<string, unknown> = {}) => ({
    kind: 'TRANSPORT_OUTBOUND',
    legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats: [nextSeat()] }],
    customer: { name: 'عبدالله العتيبي', phone: nextPhone().replace('+966', '0') },
    passengers: [{ fullName: 'عبدالله العتيبي', nationalId: '1087345291' }],
    ...overrides,
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    admin = await loginStaff(app, adminUser.phone);

    const created = await request(http()).post(`${API}/branches`).set(admin.auth).send({ name: 'فرع ينبع البحر', code: 'ynb', city: 'ينبع', phone: '0500000000' }).expect(201);
    branchId = created.body.id;
    const other = await request(http()).post(`${API}/branches`).set(admin.auth).send({ name: 'فرع الخالدية' }).expect(201);
    otherBranchId = other.body.id;

    ({ user: managerUser, session: manager } = await inRank('rank-branch-manager', branchId));
    ({ user: clerkUser, session: clerk } = await inRank('rank-branch-clerk', branchId));
    ({ session: otherClerk } = await inRank('rank-branch-clerk', otherBranchId));

    outbound = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ price: 110 })).expect(201)).body;
    inbound = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ price: 110, origin: 'مكة المكرمة', destination: 'ينبع' })).expect(201)).body;

    const hotel = await prisma.hotel.create({
      data: { name: 'فندق إيلاف المشاعر', city: 'مكة المكرمة', nightlyRate: 200, bedPrice: 80, privateRoomPrice: 250, housingPriceMode: 'INCLUDED_IN_BASE', housingPricePeriod: 'PER_NIGHT', privateRoomPriceBasis: 'PER_ROOM', privateRoomCapacity: 4 },
    });
    hotelId = hotel.id;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  describe('branch records', () => {
    it('saves the full profile and normalizes the code', async () => {
      const res = await request(http()).get(`${API}/branches/${branchId}`).set(admin.auth).expect(200);
      expect(res.body).toMatchObject({ name: 'فرع ينبع البحر', code: 'YNB', city: 'ينبع' });
      expect(res.body.figures.today.bookings).toBe(0);
    });

    it('refuses a duplicate code', async () => {
      await request(http()).patch(`${API}/branches/${otherBranchId}`).set(admin.auth).send({ code: 'YNB' }).expect(409);
    });

    it('shows a branch employee only their own branch', async () => {
      const list = await request(http()).get(`${API}/branches`).set(clerk.auth).expect(200);
      expect(list.body.map((row: any) => row.id)).toEqual([branchId]);
      await request(http()).get(`${API}/branches/${otherBranchId}`).set(clerk.auth).expect(403);
    });

    it('lets only a branch administrator edit branch records', async () => {
      await request(http()).patch(`${API}/branches/${branchId}`).set(manager.auth).send({ city: 'جدة' }).expect(403);
    });

    it('will not stop a branch whose drawer is open', async () => {
      const session = await request(http()).post(`${API}/cash/branches/${otherBranchId}/sessions`).set(admin.auth).send({ openingBalance: 0 }).expect(201);
      await request(http()).patch(`${API}/branches/${otherBranchId}`).set(admin.auth).send({ isActive: false }).expect(409);
      await request(http()).post(`${API}/cash/sessions/${session.body.id}/close`).set(admin.auth).send({ expectedBalance: 0, countedCash: 0 }).expect(201);
    });
  });

  describe('branch staff and access', () => {
    it('registers a new employee in the manager’s own branch only', async () => {
      const body = { name: 'موظف جديد', phone: nextPhone(), rankId: 'rank-branch-clerk', password: STAFF_PASSWORD };
      const created = await request(http()).post(`${API}/branches/${branchId}/employees`).set(manager.auth).send(body).expect(201);
      const saved = await prisma.user.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(saved.branchId).toBe(branchId);
      await request(http()).post(`${API}/branches/${otherBranchId}/employees`).set(manager.auth).send({ ...body, phone: nextPhone() }).expect(403);
    });

    it('refuses a rank above the manager’s own access', async () => {
      await request(http()).post(`${API}/branches/${branchId}/employees`).set(manager.auth).send({ name: 'مدير كبير', phone: nextPhone(), rankId: 'rank-operations', password: STAFF_PASSWORD }).expect(403);
    });

    it('applies personal additions and removals immediately, on top of the rank', async () => {
      await request(http()).put(`${API}/branches/${branchId}/employees/${clerkUser.id}/access`).set(manager.auth).send({ extraPermissions: ['bookings.price_override'], revokedPermissions: ['bookings.edit'] }).expect(200);
      const me = await request(http()).get(`${API}/auth/me`).set(clerk.auth).expect(200);
      expect(me.body.permissions).toContain('bookings.price_override');
      expect(me.body.permissions).not.toContain('bookings.edit');
      expect(me.body.permissions).toContain('bookings.create');
      await request(http()).put(`${API}/branches/${branchId}/employees/${clerkUser.id}/access`).set(manager.auth).send({ extraPermissions: [], revokedPermissions: [] }).expect(200);
    });

    it('does not let a manager hand out what they do not hold, or edit their own access', async () => {
      await request(http()).put(`${API}/branches/${branchId}/employees/${clerkUser.id}/access`).set(manager.auth).send({ extraPermissions: ['settings.manage'], revokedPermissions: [] }).expect(403);
      await request(http()).put(`${API}/branches/${branchId}/employees/${managerUser.id}/access`).set(manager.auth).send({ extraPermissions: [], revokedPermissions: [] }).expect(400);
    });

    it('moves an appointed manager to the branch and tells them', async () => {
      const staff = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-branch-manager');
      await request(http()).put(`${API}/branches/${otherBranchId}/manager`).set(admin.auth).send({ userId: staff.id }).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).branchId).toBe(otherBranchId);
      expect(await prisma.notification.count({ where: { userId: staff.id, event: 'BRANCH_ASSIGNED' } })).toBe(1);

      // Taking them out of the branch ends their being its manager.
      await request(http()).delete(`${API}/branches/${otherBranchId}/employees/${staff.id}`).set(admin.auth).expect(200);
      expect((await prisma.branch.findUniqueOrThrow({ where: { id: otherBranchId } })).managerId).toBeNull();
    });
  });

  describe('counter booking', () => {
    it('registers an unpaid booking with the branch, seat, invoice and customer account', async () => {
      const body = single();
      const res = await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(body).expect(201);
      expect(res.body).toMatchObject({ total: 110, paid: 0, remaining: 110 });
      expect(res.body.legs[0].reference).toMatch(/^DR-\d+$/);

      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.legs[0].id }, include: { invoice: true, payment: true, passengers: { include: { ticket: true } }, user: true } });
      expect(booking).toMatchObject({ source: 'BRANCH', branchId, kind: 'TRANSPORT_OUTBOUND', leg: 'OUTBOUND', status: 'CONFIRMED' });
      expect(booking.payment?.status).toBe('PENDING');
      expect(booking.invoice).not.toBeNull();
      expect(booking.user.role).toBe('PASSENGER');
      expect(booking.passengers[0].nationalId).toBe('1087345291');
      expect(booking.passengers[0].ticket).not.toBeNull();
      const seat = await prisma.seat.findFirstOrThrow({ where: { tripId: outbound.id, seatNumber: booking.passengers[0].seatNumber } });
      expect(seat.isBooked).toBe(true);
    });

    it('splits payment across cash, network and transfer, and cash reaches the drawer', async () => {
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ payments: [{ method: 'CASH', amount: 50 }] })).expect(409);

      const session = await request(http()).post(`${API}/cash/branches/${branchId}/sessions`).set(manager.auth).send({ openingBalance: 100 }).expect(201);
      const res = await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ payments: [{ method: 'CASH', amount: 50 }, { method: 'NETWORK', amount: 40 }, { method: 'TRANSFER', amount: 20, reference: 'T1' }] })).expect(201);
      expect(res.body).toMatchObject({ total: 110, paid: 110, remaining: 0 });

      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.legs[0].id }, include: { payment: true, collections: true } });
      expect(booking.payment?.status).toBe('COMPLETED');
      expect(booking.payment?.method).toBe('mixed');
      expect(booking.collections).toHaveLength(3);
      const movements = await prisma.cashMovement.findMany({ where: { sessionId: session.body.id, bookingId: booking.id } });
      expect(movements.map((row) => Number(row.amount))).toEqual([50]);
    });

    it('refuses more money than the booking is worth, and frees the seat', async () => {
      const body = single({ payments: [{ method: 'NETWORK', amount: 500 }] });
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(body).expect(400);
      const seat = await prisma.seat.findFirstOrThrow({ where: { tripId: outbound.id, seatNumber: (body.legs as any)[0].seats[0] } });
      expect(seat.isBooked).toBe(false);
    });

    it('will not sell a seat twice', async () => {
      const seats = [nextSeat()];
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }] })).expect(201);
      await request(http()).post(`${API}/branch-bookings`).set(otherClerk.auth).send(single({ legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }] })).expect(409);
    });

    it('saves one booking once however often the request repeats', async () => {
      const body = single({ idempotencyKey: 'same-click' });
      const first = await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(body).expect(201);
      const again = await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(body).expect(201);
      expect(again.body.groupReference).toBe(first.body.groupReference);
    });

    it('needs its own permission to change a price, and records both figures', async () => {
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ finalTotal: 90 })).expect(403);
      const res = await request(http()).post(`${API}/branch-bookings`).set(manager.auth).send(single({ finalTotal: 90 })).expect(201);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.legs[0].id }, include: { events: true, invoice: true } });
      expect(Number(booking.totalPrice)).toBe(90);
      expect(Number(booking.discountAmount)).toBe(20);
      expect(Number(booking.vatAmount)).toBeCloseTo(11.74, 2);
      expect(Number(booking.invoice?.vat)).toBeCloseTo(11.74, 2);
      const event = booking.events.find((row) => row.action === 'PRICE_OVERRIDDEN');
      expect(event).toMatchObject({ before: { total: 110 }, after: { total: 90 } });
    });

    it('needs collection rights to take money', async () => {
      const { session } = await inRank('rank-branch-clerk', branchId);
      const me = await request(http()).get(`${API}/auth/me`).set(session.auth).expect(200);
      await prisma.user.update({ where: { id: me.body.id }, data: { revokedPermissions: ['collections.collect'] } });
      await request(http()).post(`${API}/branch-bookings`).set(session.auth).send(single({ payments: [{ method: 'NETWORK', amount: 10 }] })).expect(403);
    });

    it('keeps an employee to their own branch', async () => {
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ branchId: otherBranchId })).expect(403);
      const noBranch = await createStaff(prisma, 'STAFF', nextPhone(), 'rank-branch-clerk');
      const session = await loginStaff(app, noBranch.phone);
      await request(http()).post(`${API}/branch-bookings`).set(session.auth).send(single()).expect(400);
    });

    it('does not sell a trip closed to branches', async () => {
      const closed = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ channelBranch: false })).expect(201)).body;
      await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single({ legs: [{ leg: 'OUTBOUND', tripId: closed.id, seats: ['1'] }] })).expect(400);
      const found = await request(http()).get(`${API}/branch-bookings/trips`).set(clerk.auth).expect(200);
      expect(found.body.items.map((trip: any) => trip.id)).not.toContain(closed.id);
    });
  });

  describe('packages', () => {
    const stayBody = () => ({
      hotelId,
      roomType: 'PRIVATE',
      checkIn: dateOf(outbound.departureTime),
      checkOut: dateOf(inbound.departureTime),
    });
    const nightsOfStay = () => Math.round((new Date(dateOf(inbound.departureTime)).getTime() - new Date(dateOf(outbound.departureTime)).getTime()) / 86_400_000);

    it('prices two trips and a stay on the server, without showing the contract rate', async () => {
      const seats = ['30', '31', '32'];
      const res = await request(http()).post(`${API}/branch-bookings/quote`).set(clerk.auth).send({
        kind: 'PACKAGE_ROUND_STAY',
        legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }, { leg: 'RETURN', tripId: inbound.id, seats }],
        stay: stayBody(),
      }).expect(201);
      expect(res.body.tickets).toBe(6);
      expect(res.body.transport).toBe(660);
      expect(res.body.stay.nights).toBe(nightsOfStay());
      expect(res.body.stay.amount).toBe(250 * nightsOfStay());
      expect(res.body.total).toBe(660 + 250 * nightsOfStay());
      expect(res.body.vat).toBeCloseTo(res.body.total - res.body.total / 1.15, 1);

      const hotels = await request(http()).get(`${API}/branch-bookings/hotels`).set(clerk.auth).expect(200);
      expect(hotels.body[0]).not.toHaveProperty('nightlyRate');
    });

    it('creates one linked booking per trip, carries the stay on the first, and fills invoices in order', async () => {
      const seats = ['33', '34'];
      const stay = stayBody();
      const res = await request(http()).post(`${API}/branch-bookings`).set(manager.auth).send({
        kind: 'PACKAGE_ROUND_STAY',
        legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }, { leg: 'RETURN', tripId: inbound.id, seats }],
        stay,
        customer: { name: 'سالم الجهني', phone: nextPhone() },
        passengers: [{ fullName: 'سالم الجهني' }, { fullName: 'محمد الجهني' }],
        finalTotal: 500,
        payments: [{ method: 'NETWORK', amount: 500 }],
      }).expect(201);
      expect(res.body).toMatchObject({ total: 500, paid: 500, remaining: 0 });
      expect(res.body.legs).toHaveLength(2);

      const bookings = await prisma.booking.findMany({ where: { groupReference: res.body.groupReference }, include: { payment: true, invoice: true }, orderBy: { leg: 'asc' } });
      expect(bookings.map((b) => b.leg)).toEqual(['OUTBOUND', 'RETURN']);
      expect(bookings[0].stayHotelId).toBe(hotelId);
      expect(bookings[0].stayNights).toBe(nightsOfStay());
      expect(bookings[0].roomChoice).toBe('PRIVATE');
      expect(bookings[1].stayHotelId).toBeNull();
      expect(bookings.reduce((sum, b) => sum + Number(b.totalPrice), 0)).toBe(500);
      expect(bookings.every((b) => b.payment?.status === 'COMPLETED' && b.invoice)).toBe(true);
    });

    it('lists the kind and the chosen hotel on the manifest and rooming sheet, and lets staff open rooms for it', async () => {
      const manifest = await request(http()).get(`${API}/manifests/${outbound.id}`).set(admin.auth).expect(200);
      const row = manifest.body.passengers.find((p: any) => p.stayHotelName);
      expect(row.bookingKind).toContain('باقة');
      expect(manifest.body.housing.hasHousing).toBe(true);

      const rooming = await request(http()).get(`${API}/hotels/trips/${outbound.id}`).set(admin.auth).expect(200);
      expect(rooming.body.trip.hasHousing).toBe(true);
      expect(rooming.body.passengers.some((p: any) => p.stayHotel?.id === hotelId && p.bookingKind)).toBe(true);
      await request(http()).post(`${API}/hotels/bookings`).set(admin.auth).send({ tripId: outbound.id, hotelId, checkIn: stayBody().checkIn, checkOut: stayBody().checkOut }).expect(201);
    });

    it('rejects a journey that does not match its kind, wrong dates, and a room with no price', async () => {
      const seats = ['35'];
      const quote = (body: Record<string, unknown>) => request(http()).post(`${API}/branch-bookings/quote`).set(clerk.auth).send(body);
      await quote({ kind: 'PACKAGE_ROUND_STAY', legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }], stay: stayBody() }).expect(400);
      await quote({ kind: 'TRANSPORT_OUTBOUND', legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }], stay: stayBody() }).expect(400);
      await quote({ kind: 'TRANSPORT_ROUND', legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }, { leg: 'RETURN', tripId: inbound.id, seats: ['35', '36'] }] }).expect(400);
      await quote({ kind: 'PACKAGE_OUTBOUND_STAY', legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }], stay: { ...stayBody(), checkOut: stayBody().checkIn } }).expect(400);

      const unpriced = await prisma.hotel.create({ data: { name: 'فندق بلا سعر', city: 'مكة المكرمة', nightlyRate: 100, bedPrice: null, privateRoomPrice: null } });
      await quote({ kind: 'PACKAGE_OUTBOUND_STAY', legs: [{ leg: 'OUTBOUND', tripId: outbound.id, seats }], stay: { ...stayBody(), hotelId: unpriced.id, roomType: 'SHARED' } }).expect(400);
    });
  });

  describe('branch visibility of bookings', () => {
    let bookingId: string;

    beforeAll(async () => {
      const res = await request(http()).post(`${API}/branch-bookings`).set(clerk.auth).send(single()).expect(201);
      bookingId = res.body.legs[0].id;
    });

    it('lists only the employee’s branch', async () => {
      const own = await request(http()).get(`${API}/bookings/admin/all`).set(clerk.auth).expect(200);
      expect(own.body.items.length).toBeGreaterThan(0);
      expect(own.body.items.every((row: any) => row.branchId === branchId)).toBe(true);
      const other = await request(http()).get(`${API}/bookings/admin/all`).set(otherClerk.auth).expect(200);
      expect(other.body.items.map((row: any) => row.id)).not.toContain(bookingId);
    });

    it('refuses another branch’s booking on every route', async () => {
      await request(http()).get(`${API}/bookings/admin/${bookingId}`).set(otherClerk.auth).expect(403);
      await request(http()).get(`${API}/bookings/${bookingId}`).set(otherClerk.auth).expect(403);
      await request(http()).post(`${API}/bookings/admin/${bookingId}/notes`).set(otherClerk.auth).send({ text: 'ملاحظة' }).expect(403);
      const search = await request(http()).get(`${API}/bookings/admin/search?q=${encodeURIComponent('عبدالله')}`).set(otherClerk.auth).expect(200);
      expect(search.body.items.map((row: any) => row.bookingId)).not.toContain(bookingId);
    });

    it('still shows everything to ranks with all-branch access', async () => {
      await request(http()).get(`${API}/bookings/admin/${bookingId}`).set(admin.auth).expect(200);
      const staff = await createStaff(prisma, 'STAFF');
      const session = await loginStaff(app, staff.phone);
      await request(http()).get(`${API}/bookings/admin/${bookingId}`).set(session.auth).expect(200);
    });

    it('shows the last ten with what changed last, newest first', async () => {
      const recent = await request(http()).get(`${API}/branch-bookings/recent`).set(clerk.auth).expect(200);
      expect(recent.body.length).toBeLessThanOrEqual(10);
      expect(recent.body[0].id).toBe(bookingId);
      expect(recent.body[0].lastChange.label).toBe('جديد');
      expect(recent.body[0].paymentState).toBe('UNPAID');
      const other = await request(http()).get(`${API}/branch-bookings/recent`).set(otherClerk.auth).expect(200);
      expect(other.body.map((row: any) => row.id)).not.toContain(bookingId);
    });

    it('counts sales and the amount still owed on the branch page', async () => {
      const res = await request(http()).get(`${API}/branches/${branchId}`).set(admin.auth).expect(200);
      expect(res.body.figures.today.bookings).toBeGreaterThan(0);
      expect(res.body.figures.today.cash).toBe(50);
      expect(res.body.figures.remaining).toBeGreaterThan(0);
      expect(res.body.employees.length).toBeGreaterThan(1);
    });

    it('never gives the customer the employee who registered it', async () => {
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { user: true } });
      const sent = await request(http()).post(`${API}/auth/send-otp`).send({ phone: booking.user.phone }).expect(201);
      const login = await request(http()).post(`${API}/auth/verify-otp`).send({ phone: booking.user.phone, code: sent.body.devCode }).expect(201);
      const mine = await request(http()).get(`${API}/bookings`).set({ Authorization: `Bearer ${login.body.accessToken}` }).expect(200);
      const row = mine.body.find((b: any) => b.id === bookingId);
      expect(row.kind).toBe('TRANSPORT_OUTBOUND');
      expect(row).not.toHaveProperty('createdById');
      expect(row).not.toHaveProperty('createdByName');
    });
  });
});

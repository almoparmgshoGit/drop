import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { WalletService } from '../src/common/services/wallet.service';
import { earnedPoints } from '../src/common/services/loyalty.service';
import { API, createStaff, createTestApp, loginPassenger, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

// Compensations, promotional credit and staff credit marked so pay for transport only; refunds are ordinary money.
describe('Wallet: transport-only credit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let admin: any;
  let customer: any;
  let tripCounter = 0;

  const http = () => app.getHttpServer();
  const balances = async (id: string) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { walletBalance: true, walletTransportBalance: true } });
    return { total: Number(user.walletBalance), transport: Number(user.walletTransportBalance) };
  };
  const makeTrip = async (price = 300) => {
    const trip = (await request(http()).post(`${API}/trips`).set(admin.auth).send(tripPayload({ price, tripCode: `WTO-${++tripCounter}` })).expect(201)).body;
    const departureTime = new Date(Date.now() + 10 * DAY);
    await prisma.trip.update({ where: { id: trip.id }, data: { departureTime, arrivalTime: new Date(departureTime.getTime() + 3600000), tripStatus: 'PUBLISHED' } });
    return trip;
  };
  const book = async (trip: any) =>
    (
      await request(http())
        .post(`${API}/bookings`)
        .set(customer.auth)
        .send({ legs: [{ tripId: trip.id, seats: ['1'] }], passengers: [{ fullName: 'عبدالله العتيبي' }], paymentMethod: 'mada', useWallet: true })
        .expect(201)
    ).body.bookings[0];

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    wallet = app.get(WalletService);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    customer = await loginPassenger(app);
  });

  it('keeps compensations transport-only and refunds ordinary', async () => {
    const id = customer.user.id;
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 80, type: 'COMPENSATION', description: 'تعويض' }));
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 50, type: 'REFUND', description: 'استرداد' }));
    expect(await balances(id)).toEqual({ total: 130, transport: 80 });
  });

  it('refuses to pay a stay from transport-only credit', async () => {
    const id = customer.user.id;
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 100, type: 'COMPENSATION', description: 'تعويض' }));
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 20, type: 'REFUND', description: 'استرداد' }));
    // 50 for housing alone: only the 20 of ordinary money may pay for it.
    await expect(prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: -50, transportAmount: 0, type: 'DEBIT_SPENT', description: 'سكن' }))).rejects.toThrow();
    expect(await balances(id)).toEqual({ total: 120, transport: 100 });
  });

  it('spends transport-only credit first on tickets', async () => {
    const id = customer.user.id;
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 100, type: 'COMPENSATION', description: 'تعويض' }));
    await prisma.$transaction((tx) => wallet.apply(tx, { userId: id, amount: 100, type: 'REFUND', description: 'استرداد' }));
    const booking = await book(await makeTrip(150));
    expect(await balances(id)).toEqual({ total: 50, transport: 0 });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    expect(Number(payment.walletAmount)).toBe(150);
    expect(Number(payment.walletTransportAmount)).toBe(100);
  });

  it('lets staff choose the kind of a manual credit', async () => {
    const id = customer.user.id;
    await request(http()).put(`${API}/users/${id}/wallet`).set(admin.auth).send({ amount: 40, description: 'تعويض يدوي', transportOnly: true }).expect(200);
    await request(http()).put(`${API}/users/${id}/wallet`).set(admin.auth).send({ amount: 10, description: 'رصيد أساسي' }).expect(200);
    expect(await balances(id)).toEqual({ total: 50, transport: 40 });
  });

  it('earns no points on a booking with no tickets in it', () => {
    expect(earnedPoints(50000, 0, { rate: 1, bonus: 100 })).toBe(0);
    expect(earnedPoints(50000, 0.5, { rate: 1, bonus: 0 })).toBe(250);
  });
});

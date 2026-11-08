import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/common/services/prisma.service';
import { RedisService } from '../src/common/services/redis.service';

export const API = '/api/v1';
export const STAFF_PASSWORD = 'correct-horse-battery';

export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), redis: app.get(RedisService) };
}

export async function resetDatabase(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(`
    TRUNCATE "PayrollRun","AppPresence","ChatMessage","Conversation","AppEvent","BookingCollection","CustodyAttachment","CashMovement","Custody","CashSession","Branch","AuditLog","BookingEvent","LoyaltyTransaction","LoyaltyRule","LoyaltyVoucher","TripLocation","HotelRoom","HotelBooking","Hotel","Payment","Ticket","BookingPassenger","Booking","Seat","BoardingPoint","ItineraryStop",
    "TripSupervisor","TripDriver","Accommodation","TripVisit","TripService","TripImage","Trip","Bus","BusOfficePayment","BusOfficeRate","BusOffice","PackageService",
    "PackageImage","Package","Service","RefreshToken","WalletTransaction","Coupon","Setting","NotificationTemplate","MessageDelivery","WhatsAppTemplate","Campaign","StationAlertRule","TripStationRule","StationAlert","User" CASCADE`);
}

/** Test trips leave days from now; this opens one to its crew and starts its boarding. */
export const openBoarding = (prisma: PrismaService, tripId: string) =>
  prisma.trip.update({
    where: { id: tripId },
    data: {
      departureTime: new Date(Date.now() + 20 * 3_600_000),
      arrivalTime: new Date(Date.now() + 25 * 3_600_000),
      crewOpensBeforeMinutes: 1440,
      boardingOpensBeforeMinutes: 1440,
    },
  });

let phoneCounter = 500000000;
export const nextPhone = () => `+966${++phoneCounter}`;

export async function loginPassenger(app: INestApplication, phone = nextPhone()) {
  const sent = await request(app.getHttpServer()).post(`${API}/auth/send-otp`).send({ phone }).expect(201);
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/verify-otp`)
    .send({ phone, code: sent.body.devCode })
    .expect(201);
  return { ...res.body, phone, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

// The ranks the migration gives existing accounts, so these users behave like real ones.
const RANK_OF_ROLE = { ADMIN: 'rank-admin', STAFF: 'rank-staff', DRIVER: 'rank-driver' } as const;

export async function createStaff(prisma: PrismaService, role: 'ADMIN' | 'STAFF' | 'DRIVER', phone = nextPhone(), rankId: string = RANK_OF_ROLE[role]) {
  const user = await prisma.user.create({
    data: { phone, role, rankId, name: `${role} user`, passwordHash: await argon2.hash(STAFF_PASSWORD), isVerified: true },
  });
  return user;
}

export async function loginStaff(app: INestApplication, phone: string) {
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/login`)
    .send({ phone, password: STAFF_PASSWORD })
    .expect(201);
  return { ...res.body, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

let tripCounter = 0;
export function tripPayload(overrides: Record<string, unknown> = {}) {
  const departure = Date.now() + 3 * 24 * 60 * 60 * 1000 + tripCounter * 2 * 24 * 60 * 60 * 1000;
  return {
    tripCode: `T${++tripCounter}`,
    origin: 'ينبع',
    destination: 'مكة المكرمة',
    departureTime: new Date(departure).toISOString(),
    arrivalTime: new Date(departure + 5 * 60 * 60 * 1000).toISOString(),
    price: 180,
    tripStatus: 'PUBLISHED',
    boardingPoints: [{ name: 'فرع ينبع', time: '05:15', address: 'الشارع الرئيسي' }],
    ...overrides,
  };
}

/** A valid iqama: starts with 2 and ends in the check digit the server verifies. */
export function validIqama(seed: number) {
  const body = `2${String(Math.abs(Math.trunc(seed)) % 100_000_000).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = Number(body[i]);
    sum += i % 2 === 0 ? Math.floor((digit * 2) / 10) + ((digit * 2) % 10) : digit;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

let identityCounter = Math.floor(Date.now() / 1000) % 1_000_000;
/** The official details every new employee or driver now has to be registered with. */
export const officialDetails = () => ({ nationality: 'باكستاني', gender: 'MALE', idType: 'IQAMA', idNumber: validIqama(++identityCounter), birthDate: '1990-05-01', idIssueDate: '2024-01-15', idExpiryDate: '2030-06-30' });

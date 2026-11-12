import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Gender, IdType, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { startOfRiyadhDay } from '../../common/utils/time.util';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { LoyaltyService } from '../../common/services/loyalty.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { WalletService } from '../../common/services/wallet.service';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { MESSAGE_LANGUAGES, MessageLanguage } from '../../common/notification-catalog';
import { permissionsOf } from '../../common/permissions';
import { NATIONALITIES } from '../../common/profile-options';
import { CustomerLookupService, LOOKUP_RESULT_LIMIT, LookupActor } from '../../common/services/customer-lookup.service';
import { CustomerLookup, identityData, parseCustomerLookup } from '../../common/utils/identity.util';
import { imageTypeOf } from '../../common/utils/image-type.util';
import { legacyIdentity, staffIdentityData, StaffIdentityInput } from '../../common/utils/staff-identity.util';

export interface UserActor {
  userId: string;
  role: string;
  permissions: string[];
  name?: string | null;
}

interface ProfileDetails {
  nationality?: string | null;
  city?: string | null;
  nativeLanguage?: string | null;
  gender?: Gender | null;
  idType?: IdType | null;
  idNumber?: string | null;
}

/** The two unique fields a person can edit share one error code; the index name tells them apart. */
const uniqueConflict = (err: unknown) => {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
  if (target.includes('idNumber') || target.includes('iqamaNumber')) return new ConflictException('رقم الهوية هذا مسجل في حساب آخر');
  if (target.includes('phone')) return new ConflictException('رقم الجوال هذا مسجل في حساب آخر');
  return new ConflictException('هذا البريد الإلكتروني مستخدم في حساب آخر');
};

/** Profile details plus the identity document; a national ID decides the nationality, so it is applied last. */
const detailsWithIdentity = (existing: { nationality: string | null; nativeLanguage: string | null }, data: ProfileDetails) => {
  const details = profileDetailsData(existing, data);
  const nationality = 'nationality' in details ? details.nationality : existing.nationality;
  return { ...details, ...identityData(data, nationality) };
};

/** Choosing a language alerts are written in also moves their alerts to it; any other language leaves them as they are. */
const profileDetailsData = (existing: { nationality: string | null; nativeLanguage: string | null }, data: ProfileDetails) => {
  const nationality = data.nationality?.trim() || null;
  // A value typed before the list existed may stay, or saving anything else on the record would fail.
  if (data.nationality !== undefined && nationality && nationality !== existing.nationality && !NATIONALITIES.includes(nationality)) {
    throw new BadRequestException('اختر الجنسية من القائمة');
  }
  const movesAlerts = data.nativeLanguage && data.nativeLanguage !== existing.nativeLanguage && MESSAGE_LANGUAGES.includes(data.nativeLanguage as MessageLanguage);
  return {
    ...(data.nationality !== undefined && { nationality }),
    ...(data.city !== undefined && { city: data.city || null }),
    ...(data.gender !== undefined && { gender: data.gender }),
    ...(data.nativeLanguage !== undefined && { nativeLanguage: data.nativeLanguage }),
    ...(movesAlerts && { messageLanguage: data.nativeLanguage! }),
  };
};

/** The driver registry reads these, so a driver added elsewhere is complete there too. */
const driverProfileData = (data: { iqamaNumber?: string; nationality?: string; licenseExpiry?: string }) => {
  let licenseExpiry: Date | undefined;
  if (data.licenseExpiry) {
    licenseExpiry = new Date(`${data.licenseExpiry}T00:00:00.000Z`);
    // Rejects dates like 02-31, which JavaScript would otherwise roll over silently.
    if (Number.isNaN(licenseExpiry.getTime()) || licenseExpiry.toISOString().slice(0, 10) !== data.licenseExpiry) {
      throw new BadRequestException('تاريخ انتهاء الرخصة غير صحيح');
    }
  }
  return { iqamaNumber: data.iqamaNumber, nationality: data.nationality, licenseExpiry };
};

const EMPLOYEE_SELECT = { driverProfile: { select: { iqamaNumber: true } } } as const;

export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const USER_SELECT = {
  id: true,
  phone: true,
  email: true,
  name: true,
  role: true,
  rank: { select: { id: true, name: true, job: { select: { id: true, name: true } } } },
  isVerified: true,
  walletBalance: true,
  loyaltyPoints: true,
  nationality: true,
  city: true,
  nativeLanguage: true,
  gender: true,
  idType: true,
  idNumber: true,
  idIssueDate: true,
  idExpiryDate: true,
  birthDate: true,
  messageLanguage: true,
  marketingOptOutAt: true,
  tripAlertsEnabled: true,
  alertLeadMinutes: true,
  alertRepeatMinutes: true,
  photoUpdatedAt: true,
  createdAt: true,
} as const;

const CUSTOMER_ROW_SELECT = {
  ...USER_SELECT,
  blockedAt: true,
  _count: { select: { bookings: true } },
  bookings: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
  conversation: { select: { id: true } },
} satisfies Prisma.UserSelect;

const customerRow = ({ _count, bookings, conversation, ...user }: Prisma.UserGetPayload<{ select: typeof CUSTOMER_ROW_SELECT }>) => ({
  ...user,
  bookingCount: _count.bookings,
  lastBookingAt: bookings[0]?.createdAt ?? null,
  conversationId: conversation?.id ?? null,
});

/** A search that names one person: the whole phone or ID number, or a name of at least two words. */
export const customerLookupWhere = (lookup: CustomerLookup): Prisma.UserWhereInput => {
  if (lookup.kind === 'phone') return { phone: lookup.phone };
  if (lookup.kind === 'idNumber') return { idNumber: lookup.idNumber };
  if (lookup.kind === 'name') return { name: { contains: lookup.name, mode: 'insensitive' } };
  return { id: { in: [] } };
};

const PROMO_SWEEP_MS = 60 * 60_000;

const CUSTOMER_SORTS: Record<string, Prisma.UserOrderByWithRelationInput> = {
  newest: { createdAt: 'desc' },
  bookings: { bookings: { _count: 'desc' } },
  wallet: { walletBalance: 'desc' },
};

const startOfRiyadhMonth = () => {
  const today = startOfRiyadhDay();
  const riyadh = new Date(today.getTime() + 3 * 3_600_000);
  return new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), 1) - 3 * 3_600_000);
};

@Injectable()
export class UsersService implements OnModuleInit, OnModuleDestroy {
  private promoTimer: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private loyalty: LoyaltyService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
    private realtime: RealtimeService,
    private lookup: CustomerLookupService,
  ) {}

  onModuleInit() {
    this.promoTimer = setInterval(() => {
      this.wallet.expirePromos(this.prisma).catch((err) => console.error('Promo credit sweep failed:', err.message));
    }, PROMO_SWEEP_MS);
    this.promoTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.promoTimer);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, data: ProfileDetails & { name: string; email?: string | null }) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true, nationality: true, nativeLanguage: true, idType: true, idNumber: true } });
    if (!existing) throw new NotFoundException('User not found');

    const email = data.email === undefined ? undefined : data.email?.trim().toLowerCase() || null;
    // An employee signs in with this address, so an open session alone must not be able to change it.
    if (email !== undefined && email !== (existing.email?.toLowerCase() ?? null) && existing.role !== 'PASSENGER') {
      throw new ForbiddenException('بريد الموظف وسيلة دخوله، ويُعدَّل من لوحة الإدارة');
    }

    const details = detailsWithIdentity(existing, data);
    // The customer enters their document once; after that a phone that was picked up must not be able to swap it.
    if (existing.idNumber && 'idNumber' in details && (details.idNumber !== existing.idNumber || details.idType !== existing.idType)) {
      throw new ForbiddenException('رقم الهوية المسجل لا يُعدَّل من التطبيق، تواصل مع خدمة العملاء لتعديله');
    }

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: {
          name: data.name.trim(),
          ...(email !== undefined && { email }),
          ...details,
        },
        select: USER_SELECT,
      });
    } catch (err) {
      throw uniqueConflict(err) ?? err;
    }
  }

  /** The city the customer lives in; asked when the app first opens, before they sign in. */
  async updateCity(userId: string, city: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { city }, select: USER_SELECT });
  }

  /** The customer's own choices about what reaches them and in which language. */
  async updateMessaging(userId: string, data: { messageLanguage?: string; acceptsOffers?: boolean; tripAlertsEnabled?: boolean; alertLeadMinutes?: number | null; alertRepeatMinutes?: number | null }) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.messageLanguage !== undefined && { messageLanguage: data.messageLanguage }),
        ...(data.acceptsOffers !== undefined && { marketingOptOutAt: data.acceptsOffers ? null : new Date() }),
        ...(data.tripAlertsEnabled !== undefined && { tripAlertsEnabled: data.tripAlertsEnabled }),
        ...(data.alertLeadMinutes !== undefined && { alertLeadMinutes: data.alertLeadMinutes }),
        ...(data.alertRepeatMinutes !== undefined && { alertRepeatMinutes: data.alertRepeatMinutes }),
      },
      select: USER_SELECT,
    });
  }

  async getWalletTransactions(userId: string) {
    const transactions = await this.prisma.walletTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.withBookingDetails(userId, transactions);
  }

  async getWalletTransaction(userId: string, id: string) {
    // Scoped to the owner, so another customer's id simply does not exist.
    const transaction = await this.prisma.walletTransaction.findFirst({ where: { id, userId } });
    if (!transaction) throw new NotFoundException('الحركة غير موجودة');
    const [detailed] = await this.withBookingDetails(userId, [transaction]);
    return detailed;
  }

  private async withBookingDetails<T extends { bookingId: string | null }>(userId: string, transactions: T[]) {
    const bookingIds = [...new Set(transactions.map((t) => t.bookingId).filter((id): id is string => !!id))];
    const bookings = bookingIds.length
      ? await this.prisma.booking.findMany({
          where: { id: { in: bookingIds }, userId },
          select: { id: true, bookingReference: true, trip: { select: { origin: true, destination: true, departureTime: true } } },
        })
      : [];
    const byId = new Map(bookings.map((b) => [b.id, b]));
    return transactions.map((t) => {
      const booking = t.bookingId ? byId.get(t.bookingId) : undefined;
      return {
        ...t,
        bookingReference: booking?.bookingReference ?? null,
        trip: booking?.trip ?? null,
      };
    });
  }

  getLoyalty(userId: string) {
    return this.loyalty.customerSummary(userId);
  }

  applyReferralCode(userId: string, code: string) {
    return this.loyalty.applyReferralCode(userId, code);
  }

  redeemVoucher(userId: string, voucherId: string) {
    return this.loyalty.redeemVoucher(userId, voucherId);
  }

  /** Without customers.list an employee gets no table: only the few customers one exact search points at. */
  async getCustomers(actor: LookupActor, query: { search?: string; page?: number; limit?: number; status?: string; sort?: string; nationality?: string; city?: string; gender?: string }, ip?: string) {
    if (!actor.permissions.includes('customers.list')) return this.lookupCustomers(actor, query.search ?? '', ip);
    const { search, page = 1, limit = 50, status, sort = 'newest', nationality, city, gender } = query;
    const where: Prisma.UserWhereInput = { role: 'PASSENGER' };
    if (status === 'blocked') where.blockedAt = { not: null };
    if (status === 'active') where.blockedAt = null;
    if (nationality) where.nationality = nationality === 'none' ? null : nationality;
    if (city) where.city = city === 'none' ? null : city;
    if (gender) where.gender = gender === 'none' ? null : (gender as Gender);
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: /^0\d+$/.test(search) ? search.slice(1) : search, mode: 'insensitive' } },
        { idNumber: { contains: search.trim().toUpperCase() } },
      ];
    }
    const [items, total, passengers, staff, walletSum, blocked, joinedThisMonth, nationalities, cities] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: CUSTOMER_ROW_SELECT,
        orderBy: CUSTOMER_SORTS[sort] ?? CUSTOMER_SORTS.newest,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { role: 'PASSENGER' } }),
      this.prisma.user.count({ where: { role: { not: 'PASSENGER' } } }),
      this.prisma.user.aggregate({ _sum: { walletBalance: true } }),
      this.prisma.user.count({ where: { role: 'PASSENGER', blockedAt: { not: null } } }),
      this.prisma.user.count({ where: { role: 'PASSENGER', createdAt: { gte: startOfRiyadhMonth() } } }),
      this.prisma.user.groupBy({ by: ['nationality'], where: { role: 'PASSENGER' }, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['city'], where: { role: 'PASSENGER' }, _count: { _all: true } }),
    ]);
    const byCity = cities.map((row) => ({ city: row.city, count: row._count._all })).sort((a, b) => b.count - a.count);
    const byNationality = nationalities.map((row) => ({ nationality: row.nationality, count: row._count._all })).sort((a, b) => b.count - a.count);
    return {
      items: items.map(customerRow),
      total,
      page,
      limit,
      restricted: false,
      summary: { passengers, staff, walletTotal: Number(walletSum._sum.walletBalance ?? 0), blocked, joinedThisMonth, byNationality, byCity },
    };
  }

  /** Counted and logged, capped to a handful of rows, and without the totals the full table shows. */
  private async lookupCustomers(actor: LookupActor, search: string, ip?: string) {
    const empty = { items: [], total: 0, page: 1, limit: LOOKUP_RESULT_LIMIT, restricted: true, tooMany: false, summary: null };
    if (!search.trim()) return empty;
    const lookup = parseCustomerLookup(search);
    await this.lookup.consume(actor);
    const where: Prisma.UserWhereInput = { role: 'PASSENGER', ...customerLookupWhere(lookup) };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: CUSTOMER_ROW_SELECT, orderBy: { name: 'asc' }, take: LOOKUP_RESULT_LIMIT }),
      this.prisma.user.count({ where }),
    ]);
    await this.lookup.record(actor, 'GET /users/lookup', lookup, items.length, ip);
    return { ...empty, items: items.map(customerRow), total: items.length, tooMany: total > LOOKUP_RESULT_LIMIT };
  }

  /** A customer is stopped by customers.block, an employee by employees.manage. Either way, open sessions end at once. */
  async setBlocked(actor: UserActor, userId: string, blocked: boolean, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { rank: true } });
    if (!user) throw new NotFoundException('User not found');
    if (actor.userId === userId) throw new BadRequestException('لا يمكنك إيقاف حسابك بنفسك');
    if (user.role === 'PASSENGER') {
      if (!actor.permissions.includes('customers.block')) throw new ForbiddenException('ليست لديك صلاحية حظر العملاء');
    } else {
      if (!actor.permissions.includes('employees.manage')) throw new ForbiddenException('ليست لديك صلاحية إيقاف الموظفين');
      await this.assertCanManage(actor, user);
      if (blocked && user.role === 'ADMIN') await this.assertNotLastChange(actor.userId, userId, 'إيقاف');
    }
    if (blocked && !reason?.trim()) throw new BadRequestException('اكتب سبب الإيقاف');

    return this.prisma.$transaction(async (tx) => {
      if (blocked) {
        await tx.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
        await tx.appPresence.deleteMany({ where: { userId } });
        this.realtime.disconnectUser(userId);
      }
      return tx.user.update({
        where: { id: userId },
        data: { blockedAt: blocked ? new Date() : null, blockedReason: blocked ? reason!.trim() : null },
        select: { id: true, blockedAt: true, blockedReason: true },
      });
    });
  }

  /** Internal credit for bookings only. Counted against the same daily limit as any other wallet change. */
  async grantPromoCredit(actor: UserActor, userId: string, amount: number, expiresOn: string, reason: string) {
    const expiresAt = new Date(`${expiresOn}T23:59:59+03:00`);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw new BadRequestException('تاريخ انتهاء الصلاحية يجب أن يكون في المستقبل');
    const customer = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, blockedAt: true } });
    if (!customer || customer.role !== 'PASSENGER') throw new NotFoundException('العميل غير موجود');
    if (customer.blockedAt) throw new ConflictException('هذا العميل محظور');
    return this.prisma.$transaction(async (tx) => {
      await this.assertCanAdjustWallet(tx, actor, userId, amount);
      const walletBalance = await this.wallet.apply(tx, {
        userId,
        amount,
        type: 'PROMO_CREDIT',
        description: `رصيد ترويجي: ${reason.trim()} (بواسطة: ${actor.name || 'الإدارة'})`,
        createdById: actor.userId,
        expiresAt,
      });
      await this.notifications.toUser(tx, 'WALLET_CREDITED', userId, { amount: formatSar(amount), walletBalance: formatSar(walletBalance) });
      return { walletBalance: Number(walletBalance) };
    });
  }

  /** The balances page: a row per customer holding anything, and the totals behind its cards. */
  async getWallets(search?: string, filter?: string, page = 1, limit = 50) {
    const now = new Date();
    const liveCredit = { type: 'PROMO_CREDIT', promoRemaining: { gt: 0 }, expiresAt: { gt: now } } satisfies Prisma.WalletTransactionWhereInput;
    const where: Prisma.UserWhereInput = { role: 'PASSENGER' };
    if (filter === 'promo') where.walletTransactions = { some: liveCredit };
    else if (filter !== 'all') where.walletBalance = { gt: 0 };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: /^0\d+$/.test(search) ? search.slice(1) : search } },
      ];
    }
    const [items, total, balances, promo, refundsThisMonth, holders, promoHolders] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { walletBalance: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          phone: true,
          walletBalance: true,
          loyaltyPoints: true,
          walletTransactions: {
            where: { OR: [liveCredit, { type: { not: 'PROMO_CREDIT' } }] },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { type: true, amount: true, description: true, promoRemaining: true, expiresAt: true, createdAt: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.aggregate({ where: { role: 'PASSENGER' }, _sum: { walletBalance: true, loyaltyPoints: true } }),
      this.prisma.walletTransaction.aggregate({ where: liveCredit, _sum: { promoRemaining: true } }),
      this.prisma.walletTransaction.aggregate({ where: { type: 'REFUND', createdAt: { gte: startOfRiyadhMonth() } }, _sum: { amount: true }, _count: true }),
      this.prisma.user.count({ where: { role: 'PASSENGER', walletBalance: { gt: 0 } } }),
      this.prisma.walletTransaction.findMany({ where: liveCredit, distinct: ['userId'], select: { userId: true } }),
    ]);
    return {
      total,
      summary: {
        balances: Number(balances._sum.walletBalance ?? 0),
        holders,
        promo: Number(promo._sum.promoRemaining ?? 0),
        promoHolders: promoHolders.length,
        refundsThisMonth: Number(refundsThisMonth._sum.amount ?? 0),
        refundCount: refundsThisMonth._count,
        points: Number(balances._sum.loyaltyPoints ?? 0),
      },
      items: items.map(({ walletTransactions, ...user }) => {
        const credits = walletTransactions.filter((row) => row.type === 'PROMO_CREDIT');
        const last = walletTransactions[0];
        return {
          ...user,
          promo: credits.reduce((sum, row) => sum + Number(row.promoRemaining ?? 0), 0),
          nextExpiry: credits.map((row) => row.expiresAt).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null,
          last: last ? { type: last.type, amount: Number(last.amount), description: last.description, createdAt: last.createdAt } : null,
        };
      }),
    };
  }

  async getEmployees(search?: string, page = 1, limit = 50, jobId?: string, branchId?: string) {
    const where: any = { role: { not: 'PASSENGER' } };
    if (jobId) where.rank = { jobId };
    if (branchId) where.branchId = branchId === 'none' ? null : branchId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: { id: true, phone: true, email: true, name: true, role: true, branchId: true, branch: { select: { id: true, name: true } }, extraPermissions: true, revokedPermissions: true, rank: { select: { id: true, name: true, permissions: true, job: { select: { id: true, name: true } } } }, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async getCrew() {
    // The rank and phone tell apart two staff with the same name, so the right account gets the trip.
    const select = { id: true, name: true, phone: true, role: true, rank: { select: { name: true } } } as const;
    // Someone whose rank cannot open their trips in the app would be assigned work they cannot see.
    const crewRank = (tripRole: 'DRIVER' | 'SUPERVISOR') => ({ job: { tripRole }, permissions: { has: 'crew.trips' } });
    // Blocked, suspended and departed staff cannot be given a trip, so they are not offered.
    const working = { blockedAt: null, NOT: { employeeProfile: { is: { status: { in: ['TERMINATED', 'SUSPENDED'] as ('TERMINATED' | 'SUSPENDED')[] } } } } };
    const [drivers, supervisors] = await Promise.all([
      this.prisma.user.findMany({
        where: { rank: crewRank('DRIVER'), ...working, AND: [{ NOT: { driverProfile: { is: { isActive: false } } } }] },
        select: { ...select, driverProfile: { select: { iqamaNumber: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({ where: { rank: crewRank('SUPERVISOR'), ...working }, select, orderBy: { name: 'asc' } }),
    ]);
    return { drivers, supervisors };
  }

  async getCandidates(search: string) {
    const term = search.trim();
    // Phones are stored as +966 5..., so a local 05... has to lose its leading zero to match.
    const phone = /^0\d+$/.test(term) ? term.slice(1) : term;
    const users = await this.prisma.user.findMany({
      where: {
        role: { not: 'ADMIN' },
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: phone } },
        ],
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        passwordHash: true,
        nationality: true,
        gender: true,
        birthDate: true,
        idType: true,
        idNumber: true,
        idIssueDate: true,
        idExpiryDate: true,
        rank: { select: { name: true, job: { select: { name: true } } } },
      },
      orderBy: { name: 'asc' },
      take: 10,
    });
    return users.map(({ passwordHash, ...user }) => ({ ...user, hasPassword: !!passwordHash }));
  }

  /** Replaces the account's photo; the bytes decide whether it is an image, not the name or type the phone sent. */
  async setPhoto(userId: string, file?: UploadedPhoto) {
    if (!file?.buffer?.length) throw new BadRequestException('اختر صورة');
    const mimeType = imageTypeOf(file.buffer);
    if (!mimeType) throw new BadRequestException('الصور المقبولة: JPG أو PNG أو WEBP');
    const exists = await this.prisma.user.count({ where: { id: userId } });
    if (!exists) throw new NotFoundException('User not found');
    const photoUpdatedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.userPhoto.upsert({
        where: { userId },
        create: { userId, mimeType, size: file.buffer.length, data: file.buffer },
        update: { mimeType, size: file.buffer.length, data: file.buffer },
      }),
      this.prisma.user.update({ where: { id: userId }, data: { photoUpdatedAt } }),
    ]);
    return { photoUpdatedAt };
  }

  async removePhoto(userId: string) {
    await this.prisma.$transaction([
      this.prisma.userPhoto.deleteMany({ where: { userId } }),
      this.prisma.user.updateMany({ where: { id: userId }, data: { photoUpdatedAt: null } }),
    ]);
    return { photoUpdatedAt: null };
  }

  async getPhoto(userId: string) {
    const photo = await this.prisma.userPhoto.findUnique({ where: { userId } });
    if (!photo) throw new NotFoundException('لا توجد صورة');
    return photo;
  }

  /** Staff reach a customer's photo with the same right that opens the customer; an employee's photo is HR's. */
  async assertCustomerPhotoAccess(actor: UserActor, userId: string, write: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== 'PASSENGER') {
      if (write) throw new ForbiddenException('صورة الموظف تُدار من ملفه في الموارد البشرية');
      if (!actor.permissions.includes('employees.view')) throw new ForbiddenException('ليست لديك صلاحية لعرض هذا الحساب');
    }
  }

  async getUserDetails(actor: UserActor, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...USER_SELECT,
        passwordHash: true,
        blockedAt: true,
        blockedReason: true,
        conversation: { select: { id: true } },
        bookings: {
          // Field by field: a ticket's signed token boards whoever holds it, and costs are not a support employee's concern.
          include: {
            trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, arrivalTime: true, tripStatus: true } },
            passengers: { select: { id: true, fullName: true, phone: true, seatNumber: true } },
            tickets: { select: { id: true, passengerId: true, ticketNumber: true, isBoarded: true, boardedAt: true } },
            payment: { select: { id: true, amount: true, walletAmount: true, currency: true, status: true, method: true, createdAt: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        walletTransactions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');
    if (!actor.permissions.includes(user.role === 'PASSENGER' ? 'customers.view' : 'employees.view')) {
      throw new ForbiddenException('ليست لديك صلاحية لعرض هذا الحساب');
    }
    const { passwordHash, ...details } = user;
    return { ...details, hasPassword: !!passwordHash };
  }

  /** Nobody can hand out, or take over an account holding, access beyond their own. */
  private assertWithinOwnAccess(actor: UserActor, permissions: string[]) {
    if (!permissions.every((permission) => actor.permissions.includes(permission))) {
      throw new ForbiddenException('لا يمكنك إدارة حساب أو رتبة تتجاوز صلاحياتك');
    }
  }

  private async assignableRank(actor: UserActor, rankId: string) {
    const rank = await this.prisma.rank.findUnique({ where: { id: rankId } });
    if (!rank) throw new BadRequestException('الرتبة غير موجودة');
    this.assertWithinOwnAccess(actor, permissionsOf({ role: rank.role, rank }));
    return rank;
  }

  /** A rank plus what was added or removed for this one employee. Nobody can give more than they hold or change their own. */
  async updateAccess(actor: UserActor, userId: string, data: { rankId?: string; extraPermissions: string[]; revokedPermissions: string[] }) {
    if (actor.userId === userId) throw new BadRequestException('لا يمكنك تعديل صلاحيات حسابك بنفسك');
    const target = await this.prisma.user.findUnique({ where: { id: userId }, include: { rank: true } });
    if (!target || target.role === 'PASSENGER') throw new NotFoundException('الموظف غير موجود');
    if (target.role === 'ADMIN') throw new BadRequestException('المدير العام يملك كل الصلاحيات');
    this.assertWithinOwnAccess(actor, permissionsOf(target));

    const rank = data.rankId && data.rankId !== target.rankId ? await this.assignableRank(actor, data.rankId) : target.rank;
    if (rank?.role === 'ADMIN') throw new BadRequestException('رتبة المدير العام لا تُسند من هنا');
    this.assertWithinOwnAccess(actor, data.extraPermissions);

    // Saving only what differs from the rank, so a later edit of the rank still reaches this employee.
    const fromRank = rank?.permissions ?? [];
    const extraPermissions = data.extraPermissions.filter((permission) => !fromRank.includes(permission));
    const revokedPermissions = data.revokedPermissions.filter((permission) => fromRank.includes(permission));
    const rankChanges = rank?.id !== target.rankId;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { extraPermissions, revokedPermissions, ...(rankChanges && rank && { rankId: rank.id, role: rank.role }) },
      select: { id: true, name: true, extraPermissions: true, revokedPermissions: true, rank: { select: { id: true, name: true, permissions: true } } },
    });
    if (rankChanges) await this.prisma.refreshToken.updateMany({ where: { userId }, data: { revoked: true } });
    return updated;
  }

  private assertCanManage(actor: UserActor, user: { role: string; rank: { permissions: string[] } | null }) {
    if (user.role === 'PASSENGER') {
      if (!actor.permissions.includes('customers.manage')) {
        throw new ForbiddenException('ليست لديك صلاحية لتعديل بيانات العملاء');
      }
      return;
    }
    if (!actor.permissions.includes('employees.manage')) {
      throw new ForbiddenException('ليست لديك صلاحية لإدارة الموظفين');
    }
    this.assertWithinOwnAccess(actor, permissionsOf(user));
  }

  async promoteToEmployee(actor: UserActor, userId: string, data: StaffIdentityInput & { rankId: string; email?: string; password?: string; iqamaNumber?: string; licenseExpiry?: string; hireDate?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId }, include: { rank: true, driverProfile: { select: { isActive: true } } } });
    if (!existing) throw new NotFoundException('User not found');
    if (actor.userId === userId) throw new BadRequestException('لا يمكنك تغيير رتبة حسابك بنفسك');
    if (existing.role === 'ADMIN') throw new BadRequestException('لا يمكن تغيير رتبة المدير العام من هنا');
    if (existing.role !== 'PASSENGER') this.assertCanManage(actor, existing);
    const rank = await this.assignableRank(actor, data.rankId);
    if (!existing.passwordHash && !data.password) {
      throw new BadRequestException('حسابات الموظفين تحتاج كلمة مرور لتتمكن من الدخول');
    }
    if (existing.driverProfile?.isActive === false) {
      throw new ConflictException('هذا السائق موقوف، أعد تفعيله من صفحة الحافلات والسائقين');
    }
    // What the customer already registered with counts; anything missing must be given now.
    const kept = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
    const givenId = data.idType || data.idNumber || data.iqamaNumber;
    const identity = staffIdentityData(
      {
        nationality: data.nationality ?? existing.nationality,
        gender: data.gender ?? existing.gender,
        birthDate: data.birthDate ?? kept(existing.birthDate),
        idIssueDate: data.idIssueDate ?? kept(existing.idIssueDate),
        idExpiryDate: data.idExpiryDate ?? kept(existing.idExpiryDate),
        ...(givenId ? (data.idType ? { idType: data.idType, idNumber: data.idNumber } : legacyIdentity(data.iqamaNumber)) : { idType: existing.idType, idNumber: existing.idNumber }),
      },
      { required: true },
    );
    const profile = rank.role === 'DRIVER' ? { ...driverProfileData(data), iqamaNumber: identity.driverNumber ?? undefined, nationality: identity.nationality ?? undefined } : null;
    const employment = this.employmentStart(data.hireDate);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...identity.user,
        ...(profile && { driverProfile: { upsert: { create: profile, update: profile } } }),
        ...(employment && { employeeProfile: { upsert: { create: employment, update: {} } } }),
        role: rank.role,
        rankId: rank.id,
        extraPermissions: [],
        revokedPermissions: [],
        isVerified: true,
        ...(data.email && { email: data.email.trim().toLowerCase() }),
        ...(data.password && { passwordHash: await argon2.hash(data.password) }),
      },
      select: { ...USER_SELECT, ...EMPLOYEE_SELECT },
    }).catch((err) => {
      throw uniqueConflict(err) ?? err;
    });
    // Customer sessions opened with a phone code must not carry over into a staff account.
    await this.prisma.refreshToken.updateMany({ where: { userId }, data: { revoked: true } });
    return updated;
  }

  /** An employment file opened with the account, so HR does not have to enter the hire date again. */
  private employmentStart(hireDate?: string) {
    if (!hireDate) return null;
    const date = new Date(`${hireDate}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== hireDate) throw new BadRequestException('تاريخ التعيين غير صحيح');
    if (date.getTime() > Date.now() + 120 * 86_400_000) throw new BadRequestException('تاريخ التعيين بعيد جدًا');
    return { hireDate: date };
  }

  /** Every new employee or driver is registered with their nationality, gender and identity document. */
  async createStaffUser(actor: UserActor, data: StaffIdentityInput & { name: string; phone: string; email?: string; rankId: string; password: string; branchId?: string; iqamaNumber?: string; licenseExpiry?: string; hireDate?: string }) {
    const rank = await this.assignableRank(actor, data.rankId);
    const identity = staffIdentityData({ ...data, ...(!data.idType && legacyIdentity(data.iqamaNumber)) }, { required: true });
    const profile = rank.role === 'DRIVER' ? { ...driverProfileData(data), iqamaNumber: identity.driverNumber ?? undefined, nationality: identity.nationality ?? undefined } : null;
    const employment = this.employmentStart(data.hireDate);
    if (data.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: data.branchId } });
      if (!branch?.isActive) throw new BadRequestException('الفرع غير موجود أو موقوف');
    }
    return this.prisma.user.create({
      select: { ...USER_SELECT, ...EMPLOYEE_SELECT },
      data: {
        ...identity.user,
        ...(profile && { driverProfile: { create: profile } }),
        ...(employment && { employeeProfile: { create: employment } }),
        name: data.name.trim(),
        phone: normalizeSaudiPhone(data.phone),
        email: data.email?.trim().toLowerCase() || null,
        role: rank.role,
        rankId: rank.id,
        branchId: data.branchId,
        passwordHash: await argon2.hash(data.password),
        isVerified: true,
      },
    }).catch((err) => {
      throw uniqueConflict(err) ?? err;
    });
  }

  async updateUserAdmin(actor: UserActor, userId: string, data: ProfileDetails & { birthDate?: string | null; idIssueDate?: string | null; idExpiryDate?: string | null; name?: string; phone?: string; email?: string | null; rankId?: string | null; branchId?: string | null; password?: string; messageLanguage?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId }, include: { rank: true } });
    if (!existing) throw new NotFoundException('User not found');
    this.assertCanManage(actor, existing);

    // Both of these turn a customer record into a staff login, so customer access alone is not enough.
    if ((data.rankId !== undefined || data.branchId !== undefined || data.password !== undefined) && !actor.permissions.includes('employees.manage')) {
      throw new ForbiddenException('ليست لديك صلاحية لإدارة الموظفين');
    }
    // Someone else changes your password and branch, so an open session alone cannot take over or move the account.
    if (actor.userId === userId && (data.password !== undefined || (data.branchId !== undefined && data.branchId !== existing.branchId))) {
      throw new ForbiddenException('لا يمكنك تغيير كلمة مرورك أو فرعك من هنا');
    }
    const nextPhone = data.phone !== undefined ? normalizeSaudiPhone(data.phone) : undefined;
    const phoneChanges = nextPhone !== undefined && nextPhone !== existing.phone;
    // A customer signs in with a code sent to this number, so whoever changes it could sign in as them.
    if (phoneChanges && existing.role === 'PASSENGER' && !actor.permissions.includes('employees.manage')) {
      throw new ForbiddenException('ليست لديك صلاحية لتغيير رقم جوال العميل');
    }

    if (data.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: data.branchId } });
      if (!branch?.isActive) throw new BadRequestException('الفرع غير موجود أو موقوف');
    }
    const nextRank = data.rankId ? await this.assignableRank(actor, data.rankId) : null;
    const rankChanges = data.rankId !== undefined && data.rankId !== existing.rankId;
    const nextRole = data.rankId === undefined ? existing.role : nextRank?.role ?? 'PASSENGER';
    if (rankChanges && actor.userId === userId) {
      throw new BadRequestException('لا يمكنك تغيير رتبة حسابك بنفسك');
    }
    if (existing.role === 'ADMIN' && nextRole !== 'ADMIN') {
      await this.assertNotLastChange(actor.userId, userId, 'تغيير صلاحية');
    }
    if (nextRole !== 'PASSENGER' && !existing.passwordHash && !data.password) {
      throw new BadRequestException('حسابات الموظفين تحتاج كلمة مرور لتتمكن من الدخول');
    }

    // Someone who moved or left no longer manages the branch they came from.
    if (data.branchId !== undefined && data.branchId !== existing.branchId) {
      await this.prisma.branch.updateMany({ where: { managerId: userId }, data: { managerId: null } });
    }

    const details = detailsWithIdentity(existing, data);
    // The document's expiry and the birth date are checked as when the employee was registered.
    const dates = staffIdentityData({ birthDate: data.birthDate, idIssueDate: data.idIssueDate, idExpiryDate: data.idExpiryDate }, { existing }).user;
    // The driver registry prints its own copy of the number, so it follows the identity.
    const driverNumber = 'idNumber' in details && existing.role === 'DRIVER' ? (details.idType === 'PASSPORT' ? null : details.idNumber) : undefined;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...dates,
        ...(driverNumber !== undefined && { driverProfile: { upsert: { create: { iqamaNumber: driverNumber }, update: { iqamaNumber: driverNumber } } } }),
        // Adjustments were made against the old rank, so they do not carry over to a new one.
        ...(rankChanges && { extraPermissions: [], revokedPermissions: [] }),
        ...(data.name !== undefined && { name: data.name.trim() }),
        ...details,
        // After the details, so a language staff chose outright is not overridden.
        ...(data.messageLanguage !== undefined && { messageLanguage: data.messageLanguage }),
        ...(nextPhone !== undefined && { phone: nextPhone }),
        ...(data.email !== undefined && { email: data.email?.trim().toLowerCase() || null }),
        ...(data.rankId !== undefined && { rankId: data.rankId, role: nextRole }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.password !== undefined && { passwordHash: await argon2.hash(data.password) }),
      },
      select: USER_SELECT,
    }).catch((err) => {
      throw uniqueConflict(err) ?? err;
    });

    // A changed password, rank or sign-in number must not leave older sessions usable.
    if (data.password !== undefined || rankChanges || phoneChanges) {
      await this.prisma.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
    }
    if (phoneChanges) {
      await this.prisma.appPresence.deleteMany({ where: { userId } });
      this.realtime.disconnectUser(userId);
    }
    return updated;
  }

  /** Credit here is spendable on bookings, so it is money: nobody adds to their own, and each employee has a daily limit unless granted more. */
  private async assertCanAdjustWallet(tx: Prisma.TransactionClient, actor: UserActor, userId: string, amount: number) {
    if (actor.userId === userId && !actor.permissions.includes('wallet.adjust_self')) {
      throw new ForbiddenException('لا يمكنك تعديل رصيد محفظتك بنفسك');
    }
    if (actor.permissions.includes('wallet.adjust_unlimited')) return;
    // Two simultaneous requests must not both read the same total and pass together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-adjust:${actor.userId}`}))`;
    const today = await tx.walletTransaction.findMany({
      where: { createdById: actor.userId, type: { in: ['CREDIT_ADDED', 'ADMIN_ADJUSTMENT', 'RESET_ZERO', 'PROMO_CREDIT'] }, createdAt: { gte: startOfRiyadhDay() } },
      select: { amount: true },
    });
    const used = today.reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
    const limit = await this.appSettings.number('walletAdjustDailyLimit');
    if (used + Math.abs(amount) > limit) {
      throw new ForbiddenException(`يتجاوز هذا التعديل حدك اليومي لتعديل المحافظ (${limit} ر.س، استخدمت منها ${used.toFixed(2)} ر.س)`);
    }
  }

  async adjustWalletBalance(actor: UserActor, userId: string, amount: number, description: string) {
    if (amount === 0) throw new BadRequestException('يجب أن يكون المبلغ أكبر من صفر');
    const admin = { id: actor.userId, name: actor.name };
    const descText = `${description.trim()} (بواسطة: ${admin.name || 'الإدارة'})`;

    return this.prisma.$transaction(async (tx) => {
      await this.assertCanAdjustWallet(tx, actor, userId, amount);
      const walletBalance = await this.wallet.apply(tx, {
        userId,
        amount,
        type: amount > 0 ? 'CREDIT_ADDED' : 'ADMIN_ADJUSTMENT',
        description: descText,
        createdById: admin.id,
      });
      await this.notifications.toUser(tx, amount > 0 ? 'WALLET_CREDITED' : 'WALLET_DEBITED', userId, {
        amount: formatSar(Math.abs(amount)),
        walletBalance: formatSar(walletBalance),
      });
      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
    });
  }

  async resetWalletBalance(actor: UserActor, userId: string) {
    const admin = { id: actor.userId, name: actor.name };
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      const balance = Number(user.walletBalance);
      if (balance > 0) {
        await this.assertCanAdjustWallet(tx, actor, userId, balance);
        await this.wallet.apply(tx, {
          userId,
          amount: -balance,
          type: 'RESET_ZERO',
          description: `تصفية رصيد المحفظة (بواسطة: ${admin.name || 'الإدارة'})`,
          createdById: admin.id,
        });
        await this.notifications.toUser(tx, 'WALLET_DEBITED', userId, { amount: formatSar(balance), walletBalance: formatSar(0) });
      }
      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
    });
  }

  async deleteUser(actor: UserActor, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { rank: true } });
    if (!user) throw new NotFoundException('User not found');
    await this.assertCanManage(actor, user);
    if (user.role === 'ADMIN') await this.assertNotLastChange(actor.userId, userId, 'حذف');

    const bookings = await this.prisma.booking.count({ where: { userId } });
    if (bookings > 0) {
      throw new ConflictException('لا يمكن حذف مستخدم لديه حجوزات');
    }
    // Salaries, leaves and advances must stay explainable, so an employee with a file leaves through a settlement.
    if (await this.prisma.employeeProfile.count({ where: { userId } })) {
      throw new ConflictException('للموظف ملف وظيفي، أنهِ خدمته بمخالصة نهاية الخدمة بدل حذفه');
    }
    await this.prisma.user.delete({ where: { id: userId } });
    return { success: true };
  }

  private async assertNotLastChange(actorId: string, userId: string, action: string) {
    if (actorId === userId) {
      throw new BadRequestException(`لا يمكنك ${action} حسابك بنفسك`);
    }
    const admins = await this.prisma.user.count({ where: { role: 'ADMIN' } });
    if (admins <= 1) {
      throw new BadRequestException(`لا يمكن ${action} آخر مدير في النظام`);
    }
  }
}

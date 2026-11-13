import { BadRequestException } from '@nestjs/common';
import { BookingKind, Prisma, PrismaClient } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const LIVE_BOOKING_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;
const PACKAGE_KINDS: BookingKind[] = ['PACKAGE_ROUND_STAY', 'PACKAGE_OUTBOUND_STAY', 'PACKAGE_STAY_RETURN', 'PACKAGE_ROUND_NO_STAY'];

export interface AudienceFilters {
  tripIds?: string[];
  thisWeekTrips?: boolean;
  destinations?: string[];
  origins?: string[];
  bookingTypes?: ('TRANSPORT' | 'TRANSPORT_STAY' | 'VISITS')[];
  nationalities?: string[];
  genders?: ('MALE' | 'FEMALE')[];
  /** At least this many days have passed since the customer's last trip departed. */
  lastTripMinDays?: number;
  /** ...and no more than this many, so a campaign can target a window such as 60–180 days. */
  lastTripMaxDays?: number;
  /** Leaves out whoever already has a trip coming, so a "we miss you" offer does not reach someone travelling next week. */
  noUpcomingTrip?: boolean;
  /** NEVER_BOOKED: registered but no live booking at all, unlike NEW which also covers a first trip still to come. */
  customerType?: 'NEW' | 'RETURNING' | 'NEVER_BOOKED';
  payment?: 'OWING' | 'PAID';
  housing?: 'SHARED' | 'PRIVATE';
  packagesOnly?: boolean;
  bookedWithinDays?: number;
  inactiveDays?: number;
  hasWallet?: boolean;
  /** The alert languages to reach; none or all three means everyone, each in their own language. */
  languages?: ('ar' | 'en' | 'ur')[];

  // ---- Profile ----
  /** The city the customer says they live in, not where their trips start. */
  cities?: string[];
  /** Age in whole years from the birth date; customers without one are left out once either bound is set. */
  ageMin?: number;
  ageMax?: number;
  idTypes?: ('NATIONAL_ID' | 'IQAMA' | 'PASSPORT')[];
  /** Their birthday falls in the current month, Saudi time. */
  birthdayThisMonth?: boolean;
  registeredWithinDays?: number;

  // ---- Value and loyalty ----
  /** Journeys already travelled; the two legs of one round trip count once. */
  minTrips?: number;
  maxTrips?: number;
  /** Riyals paid over all live bookings. */
  minSpent?: number;
  maxSpent?: number;
  minLoyaltyPoints?: number;
  hasReferrals?: boolean;

  // ---- Booking habits ----
  bookingSources?: ('APP' | 'BRANCH')[];
  branchIds?: string[];
  categories?: ('FAMILY' | 'SINGLES')[];
  usedCoupon?: boolean;
  hasCancelled?: boolean;

  // ---- App engagement ----
  activeWithinDays?: number;
  notActiveDays?: number;
  hasAppDevice?: boolean;
  excludeOpenComplaints?: boolean;
}

const SAUDI_OFFSET_MS = 3 * 60 * 60 * 1000;
const yearsAgo = (now: Date, years: number) => {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date;
};
const hasNumber = (value: number | undefined | null): value is number => typeof value === 'number' && Number.isFinite(value);

/** A window whose start is after its end matches nobody, which would look like an empty audience rather than a typo. */
export function assertAudienceFilters(filters: AudienceFilters) {
  if (filters.lastTripMinDays && filters.lastTripMaxDays && filters.lastTripMinDays > filters.lastTripMaxDays) {
    throw new BadRequestException('أقل مدة منذ آخر رحلة يجب ألا تتجاوز أقصى مدة');
  }
  const ranges: [number | undefined, number | undefined, string][] = [
    [filters.ageMin, filters.ageMax, 'أقل عمر يجب ألا يتجاوز أكبر عمر'],
    [filters.minTrips, filters.maxTrips, 'أقل عدد رحلات يجب ألا يتجاوز أكبرها'],
    [filters.minSpent, filters.maxSpent, 'أقل إنفاق يجب ألا يتجاوز أكبره'],
  ];
  for (const [min, max, message] of ranges) if (hasNumber(min) && hasNumber(max) && min > max) throw new BadRequestException(message);
  if (filters.activeWithinDays && filters.notActiveDays) throw new BadRequestException('اختر إما "نشط في التطبيق" أو "غير نشط"، لا الاثنين');
}

/**
 * Filters that need a count or a sum per customer, or a part of a date, which a Prisma where cannot say.
 * Each comes back as a list of ids that audienceWhere holds the audience to.
 */
export async function aggregateAudience(prisma: Pick<PrismaClient, '$queryRaw'>, filters: AudienceFilters, now = new Date()): Promise<Prisma.UserWhereInput[]> {
  const live = Prisma.join([...LIVE_BOOKING_STATUSES]);
  const out: Prisma.UserWhereInput[] = [];

  const minTrips = filters.minTrips ?? 0;
  if (minTrips > 0 || hasNumber(filters.maxTrips)) {
    const journeys = Prisma.sql`COUNT(DISTINCT COALESCE(b."groupReference", b."id"))`;
    const having = [...(minTrips > 0 ? [Prisma.sql`${journeys} >= ${minTrips}`] : []), ...(hasNumber(filters.maxTrips) ? [Prisma.sql`${journeys} <= ${filters.maxTrips}`] : [])];
    const rows = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT b."userId" FROM "Booking" b JOIN "Trip" t ON t."id" = b."tripId"
      WHERE b."status"::text IN (${live}) AND t."departureTime" < ${now}
      GROUP BY b."userId" HAVING ${Prisma.join(having, ' AND ')}`;
    const ids = rows.map((row) => row.userId);
    // "At most N" also covers whoever has not travelled yet, who has no row here.
    out.push(minTrips > 0 ? { id: { in: ids } } : { OR: [{ id: { in: ids } }, { bookings: { none: { status: { in: [...LIVE_BOOKING_STATUSES] }, trip: { departureTime: { lt: now } } } } }] });
  }

  const minSpent = filters.minSpent ?? 0;
  if (minSpent > 0 || hasNumber(filters.maxSpent)) {
    const having = [...(minSpent > 0 ? [Prisma.sql`SUM(b."totalPrice") >= ${minSpent}`] : []), ...(hasNumber(filters.maxSpent) ? [Prisma.sql`SUM(b."totalPrice") <= ${filters.maxSpent}`] : [])];
    const rows = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT b."userId" FROM "Booking" b WHERE b."status"::text IN (${live})
      GROUP BY b."userId" HAVING ${Prisma.join(having, ' AND ')}`;
    const ids = rows.map((row) => row.userId);
    out.push(minSpent > 0 ? { id: { in: ids } } : { OR: [{ id: { in: ids } }, { bookings: { none: { status: { in: [...LIVE_BOOKING_STATUSES] } } } }] });
  }

  if (filters.birthdayThisMonth) {
    const month = new Date(now.getTime() + SAUDI_OFFSET_MS).getUTCMonth() + 1;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "role"::text = 'PASSENGER' AND "birthDate" IS NOT NULL AND EXTRACT(MONTH FROM "birthDate") = ${month}`;
    out.push({ id: { in: rows.map((row) => row.id) } });
  }
  return out;
}

/** A message about trips the customer booked is service, so it reaches them whatever their offers switch says. */
export const isMarketingCampaign = (filters: AudienceFilters, couponId?: string | null) => !!couponId || !(filters.tripIds?.length || filters.thisWeekTrips);

const BOOKING_TYPE_WHERE: Record<NonNullable<AudienceFilters['bookingTypes']>[number], Prisma.BookingWhereInput> = {
  TRANSPORT: { stayHotelId: null, roomChoice: null, housingAmount: { equals: 0 } },
  TRANSPORT_STAY: { OR: [{ stayHotelId: { not: null } }, { roomChoice: { not: null } }, { housingAmount: { gt: 0 } }] },
  VISITS: { trip: { visits: { some: {} } } },
};

/**
 * Filters with several choices match any of them, and different filters must all hold: "جدة or ينبع, and to مكة".
 * Everything about a booking must hold on the same booking, so it describes one real trip rather than scattered ones.
 */
export function audienceWhere(filters: AudienceFilters, isMarketing: boolean, now = new Date(), aggregates: Prisma.UserWhereInput[] = []): Prisma.UserWhereInput {
  const and: Prisma.BookingWhereInput[] = [];
  const trip: Prisma.TripWhereInput = {};

  const tripChoices: Prisma.TripWhereInput[] = [
    ...(filters.tripIds?.length ? [{ id: { in: filters.tripIds } }] : []),
    ...(filters.thisWeekTrips ? [{ departureTime: { gte: now, lte: new Date(now.getTime() + WEEK_MS) } }] : []),
  ];
  if (tripChoices.length) trip.OR = tripChoices;
  if (filters.destinations?.length) trip.destination = { in: filters.destinations };
  if (filters.origins?.length) trip.origin = { in: filters.origins };

  if (filters.bookingTypes?.length) and.push({ OR: filters.bookingTypes.map((type) => BOOKING_TYPE_WHERE[type]) });
  if (filters.housing) and.push({ roomChoice: filters.housing });
  if (filters.packagesOnly) and.push({ OR: [{ kind: { in: PACKAGE_KINDS } }, { trip: { packageId: { not: null } } }] });
  if (filters.payment === 'PAID') and.push({ payment: { status: 'PAID' } });
  if (filters.payment === 'OWING') and.push({ payment: { status: { not: 'PAID' } } });
  if (filters.bookingSources?.length) and.push({ source: { in: filters.bookingSources } });
  if (filters.branchIds?.length) and.push({ branchId: { in: filters.branchIds } });
  if (filters.categories?.length) and.push({ category: { in: filters.categories } });
  if (filters.bookedWithinDays) and.push({ createdAt: { gte: new Date(now.getTime() - filters.bookedWithinDays * DAY_MS) } });

  const hasBookingFilter = Object.keys(trip).length > 0 || and.length > 0;
  const where: Prisma.UserWhereInput[] = [{ role: 'PASSENGER', blockedAt: null }];
  if (hasBookingFilter) where.push({ bookings: { some: { status: { in: [...LIVE_BOOKING_STATUSES] }, ...(Object.keys(trip).length > 0 && { trip }), ...(and.length > 0 && { AND: and }) } } });
  if (filters.nationalities?.length) where.push({ nationality: { in: filters.nationalities } });
  if (filters.genders?.length) where.push({ gender: { in: filters.genders } });
  // Whoever has already travelled with the company counts as returning, whatever they have booked since.
  const hasTravelled: Prisma.BookingWhereInput = { status: { in: [...LIVE_BOOKING_STATUSES] }, trip: { departureTime: { lt: now } } };
  const travelledWithin = (days: number): Prisma.BookingWhereInput => ({
    status: { in: [...LIVE_BOOKING_STATUSES] },
    trip: { departureTime: { gte: new Date(now.getTime() - days * DAY_MS), lt: now } },
  });
  // The last trip is the latest one that has departed: none since the minimum, and (with a maximum) one inside it.
  if (filters.lastTripMinDays) {
    where.push({ bookings: { some: hasTravelled } });
    where.push({ bookings: { none: travelledWithin(filters.lastTripMinDays) } });
  }
  if (filters.lastTripMaxDays) where.push({ bookings: { some: travelledWithin(filters.lastTripMaxDays) } });
  if (filters.noUpcomingTrip) where.push({ bookings: { none: { status: { in: [...LIVE_BOOKING_STATUSES] }, trip: { departureTime: { gte: now } } } } });
  if (filters.customerType === 'RETURNING') where.push({ bookings: { some: hasTravelled } });
  if (filters.customerType === 'NEW') where.push({ bookings: { none: hasTravelled } });
  if (filters.customerType === 'NEVER_BOOKED') where.push({ bookings: { none: { status: { in: [...LIVE_BOOKING_STATUSES] } } } });
  if (filters.inactiveDays) {
    // Both halves count the same real bookings: a booking cancelled last week is not activity, so it must not hide a lapsed customer.
    where.push({ bookings: { some: { status: { in: [...LIVE_BOOKING_STATUSES] } } } });
    where.push({ bookings: { none: { status: { in: [...LIVE_BOOKING_STATUSES] }, createdAt: { gte: new Date(now.getTime() - filters.inactiveDays * DAY_MS) } } } });
  }
  if (filters.hasWallet) where.push({ walletBalance: { gt: 0 } });
  if (filters.languages?.length && filters.languages.length < 3) where.push({ messageLanguage: { in: filters.languages } });
  if (filters.cities?.length) where.push({ city: { in: filters.cities } });
  // At least N years old: born on or before this day N years ago. At most M: born after this day M+1 years ago.
  if (hasNumber(filters.ageMin) && filters.ageMin > 0) where.push({ birthDate: { lte: yearsAgo(now, filters.ageMin) } });
  if (hasNumber(filters.ageMax)) where.push({ birthDate: { gt: yearsAgo(now, filters.ageMax + 1) } });
  if (filters.idTypes?.length) where.push({ idType: { in: filters.idTypes } });
  if (filters.registeredWithinDays) where.push({ createdAt: { gte: new Date(now.getTime() - filters.registeredWithinDays * DAY_MS) } });
  if (filters.minLoyaltyPoints) where.push({ loyaltyPoints: { gte: filters.minLoyaltyPoints } });
  if (filters.hasReferrals) where.push({ referrals: { some: {} } });
  if (filters.usedCoupon) where.push({ bookings: { some: { status: { in: [...LIVE_BOOKING_STATUSES] }, couponId: { not: null } } } });
  if (filters.hasCancelled) where.push({ bookings: { some: { status: 'CANCELLED' } } });
  if (filters.activeWithinDays) where.push({ lastLoginAt: { gte: new Date(now.getTime() - filters.activeWithinDays * DAY_MS) } });
  if (filters.notActiveDays) where.push({ OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: new Date(now.getTime() - filters.notActiveDays * DAY_MS) } }] });
  if (filters.hasAppDevice) where.push({ pushTokens: { some: {} } });
  if (filters.excludeOpenComplaints) where.push({ customerComplaints: { none: { status: 'OPEN' } } });
  where.push(...aggregates);
  if (isMarketing) where.push({ marketingOptOutAt: null });
  return { AND: where };
}

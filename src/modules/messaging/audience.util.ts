import { BadRequestException } from '@nestjs/common';
import { BookingKind, Prisma } from '@prisma/client';

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
  customerType?: 'NEW' | 'RETURNING';
  payment?: 'OWING' | 'PAID';
  housing?: 'SHARED' | 'PRIVATE';
  packagesOnly?: boolean;
  bookedWithinDays?: number;
  inactiveDays?: number;
  hasWallet?: boolean;
  /** The alert languages to reach; none or all three means everyone, each in their own language. */
  languages?: ('ar' | 'en' | 'ur')[];
}

/** A window whose start is after its end matches nobody, which would look like an empty audience rather than a typo. */
export function assertAudienceFilters(filters: AudienceFilters) {
  if (filters.lastTripMinDays && filters.lastTripMaxDays && filters.lastTripMinDays > filters.lastTripMaxDays) {
    throw new BadRequestException('أقل مدة منذ آخر رحلة يجب ألا تتجاوز أقصى مدة');
  }
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
export function audienceWhere(filters: AudienceFilters, isMarketing: boolean, now = new Date()): Prisma.UserWhereInput {
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
  if (filters.inactiveDays) {
    where.push({ bookings: { some: { status: { in: [...LIVE_BOOKING_STATUSES] } } } });
    where.push({ bookings: { none: { createdAt: { gte: new Date(now.getTime() - filters.inactiveDays * DAY_MS) } } } });
  }
  if (filters.hasWallet) where.push({ walletBalance: { gt: 0 } });
  if (filters.languages?.length && filters.languages.length < 3) where.push({ messageLanguage: { in: filters.languages } });
  if (isMarketing) where.push({ marketingOptOutAt: null });
  return { AND: where };
}

import { AppEventType, BookingSource } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Which date places a booking in the period: when it was made, when its trip leaves, or when money came in for it. */
export const DATE_BASES = ['booking', 'trip', 'payment'] as const;
export type DateBasis = (typeof DATE_BASES)[number];

export class ReportRangeQuery {
  @Matches(DATE_PATTERN)
  from!: string;

  @Matches(DATE_PATTERN)
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  branchId?: string;

  @IsOptional()
  @IsEnum(BookingSource)
  source?: BookingSource;

  /** The route is the trip's origin and destination; there is no route table. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  destination?: string;

  /** Left out, each report reads by its natural date: bookings by booking date, trips by departure, payments by payment date. */
  @IsOptional()
  @IsIn(DATE_BASES)
  basis?: DateBasis;

  /** Amounts are stored including VAT; "excl" shows them net of it. */
  @IsOptional()
  @IsIn(['incl', 'excl'])
  vat?: 'incl' | 'excl';

  /** Adds the same period a year earlier, for the comparison on the main figures. */
  @IsOptional()
  @IsIn(['1', 'true'])
  compare?: string;
}

export const RECORD_KINDS = ['bookings', 'trips', 'payments'] as const;

/** The records behind a figure of a report, with the report's own filters and the figure's narrowing. */
export class ReportRecordsQuery extends ReportRangeQuery {
  @IsIn(RECORD_KINDS)
  kind!: (typeof RECORD_KINDS)[number];

  /** bookings: all, live, cancelled or a BookingStatus. trips: all, running, completed, cancelled. payments: succeeded, simulated, failed, refunds, walletRefunds, originalRefunds, pendingRefunds. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  /** APP, or a branch id: a channel of the sources report. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  channel?: string;

  /** The customer's city, nationality, gender and age group; "none" is a customer without one. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nationality?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'none'])
  gender?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  ageGroup?: string;

  /** Bookings with housing; a hotel id narrows them to that hotel, "none" to those without a known hotel. */
  @IsOptional()
  @IsIn(['1', 'true'])
  housed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  hotelId?: string;

  @IsOptional()
  @IsIn(['TRANSPORT_ONLY', 'WITH_HOTEL', 'WITH_VISITS', 'WITH_HOTEL_VISITS'])
  bookingType?: string;
}

/**
 * The occupancy and route reliability reports read trips departing in the period, with the report filters: the route
 * (origin, destination), the booking type, and the branch, which here stands for the trips leaving from its city as on
 * the trips pages, since a trip's seats belong to no single branch. The source narrows the bookings of the reliability report.
 */
export class TripReportQuery extends ReportRangeQuery {
  @IsOptional()
  @IsIn(['TRANSPORT_ONLY', 'WITH_HOTEL', 'WITH_VISITS', 'WITH_HOTEL_VISITS'])
  bookingType?: string;
}

export const APP_STATS_PERIODS = [7, 14, 30, 90];

export class AppStatsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(APP_STATS_PERIODS)
  days?: number;
}

export class AppEventDto {
  @IsUUID()
  deviceId!: string;

  @IsEnum(AppEventType)
  type!: AppEventType;

  @IsIn(['ios', 'android'])
  platform!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  destination?: string;
}

import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { MESSAGE_LANGUAGES } from '../../common/notification-catalog';
import { AudienceFilters } from './audience.util';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const MAX_CHOICES = 100;

export class AudienceFiltersDto implements AudienceFilters {
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(60, { each: true }) tripIds?: string[];
  @IsOptional() @IsBoolean() thisWeekTrips?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(100, { each: true }) destinations?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(100, { each: true }) origins?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(['TRANSPORT', 'TRANSPORT_STAY', 'VISITS'], { each: true }) bookingTypes?: ('TRANSPORT' | 'TRANSPORT_STAY' | 'VISITS')[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(60, { each: true }) nationalities?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['MALE', 'FEMALE'], { each: true }) genders?: ('MALE' | 'FEMALE')[];
  @IsOptional() @IsInt() @Min(1) @Max(3650) lastTripMinDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) lastTripMaxDays?: number;
  @IsOptional() @IsBoolean() noUpcomingTrip?: boolean;
  @IsOptional() @IsIn(['NEW', 'RETURNING', 'NEVER_BOOKED']) customerType?: 'NEW' | 'RETURNING' | 'NEVER_BOOKED';
  @IsOptional() @IsIn(['OWING', 'PAID']) payment?: 'OWING' | 'PAID';
  @IsOptional() @IsIn(['SHARED', 'PRIVATE']) housing?: 'SHARED' | 'PRIVATE';
  @IsOptional() @IsBoolean() packagesOnly?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650) bookedWithinDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) inactiveDays?: number;
  @IsOptional() @IsBoolean() hasWallet?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(MESSAGE_LANGUAGES, { each: true }) languages?: ('ar' | 'en' | 'ur')[];

  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(60, { each: true }) cities?: string[];
  @IsOptional() @IsInt() @Min(0) @Max(120) ageMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(120) ageMax?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(['NATIONAL_ID', 'IQAMA', 'PASSPORT'], { each: true }) idTypes?: ('NATIONAL_ID' | 'IQAMA' | 'PASSPORT')[];
  @IsOptional() @IsBoolean() birthdayThisMonth?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650) registeredWithinDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) minTrips?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) maxTrips?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) minSpent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) maxSpent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) minLoyaltyPoints?: number;
  @IsOptional() @IsBoolean() hasReferrals?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['APP', 'BRANCH'], { each: true }) bookingSources?: ('APP' | 'BRANCH')[];
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CHOICES) @IsString({ each: true }) @MaxLength(60, { each: true }) branchIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['FAMILY', 'SINGLES'], { each: true }) categories?: ('FAMILY' | 'SINGLES')[];
  @IsOptional() @IsBoolean() usedCoupon?: boolean;
  @IsOptional() @IsBoolean() hasCancelled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650) activeWithinDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) notActiveDays?: number;
  @IsOptional() @IsBoolean() hasAppDevice?: boolean;
  @IsOptional() @IsBoolean() excludeOpenComplaints?: boolean;
}

export class AudienceQueryDto {
  @ValidateNested() @Type(() => AudienceFiltersDto) filters: AudienceFiltersDto;
  @IsOptional() @IsString() @MaxLength(60) couponId?: string | null;
}

export class CampaignDto {
  /** { ar: { title, body }, en: ..., ur: ... }: a wording for every language in filters.languages (all three when none is chosen). */
  @IsOptional() @IsObject() content?: Record<string, { title?: string; body?: string }>;
  /** The older single-language form: an Arabic wording that everyone receives. */
  @IsOptional() @trimmed() @IsString() title?: string;
  @IsOptional() @trimmed() @IsString() body?: string;
  @ValidateNested() @Type(() => AudienceFiltersDto) filters: AudienceFiltersDto;
  @IsBoolean() sendInApp: boolean;
  @IsBoolean() sendWhatsapp: boolean;
  @IsOptional() @IsString() @MaxLength(60) couponId?: string | null;
}

export class SendCampaignDto {
  @IsInt() @Min(1) @Max(10_000_000) confirmCount: number;
  /** Leave out to send now. */
  @IsOptional() @IsDateString() scheduledAt?: string;
}

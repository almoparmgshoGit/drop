import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { HousingPriceMode, HousingPricePeriod, PrivateRoomPriceBasis, TripCalendar, TripDirection, TripScheduleType, TripStatus, UnpaidBoardingPolicy } from '@prisma/client';
import { BOOKING_TYPES } from '../../common/utils/booking-types.util';
import { MAX_BOARDING_CLOSES_AFTER_MINUTES, MAX_BOARDING_OPENS_BEFORE_MINUTES, MAX_CREW_OPENS_BEFORE_MINUTES } from '../../common/utils/crew-window.util';


const ITINERARY_STOP_KINDS = ['STOP', 'REST', 'MIQAT'];

class BoardingPointDto {
  @IsString()
  @Length(1, 150)
  name: string;

  @IsString()
  @MaxLength(20)
  time: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}

class ItineraryStopDto {
  @IsString()
  @Length(1, 150)
  title: string;

  @IsString()
  @MaxLength(20)
  time: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  desc?: string;

  @IsOptional()
  @IsIn(ITINERARY_STOP_KINDS)
  kind?: string;
}

class VisitDto {
  @IsString()
  @Length(1, 150)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  desc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsDateString()
  visitDate?: string;

  @IsOptional()
  @IsString()
  expectedTime?: string;

  @IsOptional()
  @IsString()
  duration?: string;
}

class AccommodationDto {
  @IsString()
  @Length(1, 150)
  name: string;

  /** A contracted hotel, which customers then read about. On an edit, null means the trip no longer uses one. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  hotelId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  nights?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;

  @IsOptional()
  @IsDateString()
  checkInDate?: string;

  @IsOptional()
  @IsDateString()
  checkOutDate?: string;
}

class OccupancyTierDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  fromPercent: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(300)
  adjustPercent: number;
}

class EarlyBirdDto {
  @IsInt()
  @Min(1)
  @Max(365)
  minDays: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(300)
  adjustPercent: number;
}

class LastMinuteDto {
  @IsInt()
  @Min(1)
  @Max(720)
  withinHours: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(300)
  adjustPercent: number;
}

export class PricingRulesDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OccupancyTierDto)
  occupancyTiers?: OccupancyTierDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EarlyBirdDto)
  earlyBird?: EarlyBirdDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LastMinuteDto)
  lastMinute?: LastMinuteDto | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(300)
  weekdayAdjustPercent?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(300)
  weekendAdjustPercent?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekendDays?: number[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  minPrice?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1000000)
  maxPrice?: number | null;
}

export class CreateTripDto {
  /** Ignored: the system numbers trips per month (D001-11/2026). Still accepted so older dashboards keep working. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  tripCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsString()
  @Length(2, 100)
  origin: string;

  @IsString()
  @Length(2, 100)
  destination: string;

  /** On an edit, null removes it. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  departureStation?: string | null;

  @IsDateString()
  departureTime: string;

  @IsOptional()
  @IsDateString()
  arrivalTime?: string;

  /** When the bus reaches the destination. On an edit, null removes it. */
  @IsOptional()
  @IsDateString()
  estimatedArrivalAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  hijriDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  busType?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'سعر الرحلة يجب أن يكون أكبر من صفر' })
  @Max(1000000)
  price: number;

  /** Flexible pricing on the seat price; null clears it. Off unless enabled is true. */
  @IsOptional()
  @ValidateNested()
  @Type(() => PricingRulesDto)
  pricingRules?: PricingRulesDto | null;


  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxSeatsPerBooking?: number;


  @IsOptional()
  @IsString()
  @MaxLength(100)
  miqat?: string;

  @IsOptional()
  @IsEnum(TripStatus)
  tripStatus?: TripStatus;

  @IsOptional()
  @IsEnum(TripScheduleType)
  scheduleType?: TripScheduleType;

  /** Required for a fixed trip: the calendar whose day and month it repeats on. */
  @IsOptional()
  @IsEnum(TripCalendar)
  recurrenceCalendar?: TripCalendar | null;

  /**
   * Weekdays to repeat on, 0 for Sunday to 6 for Saturday. A fixed trip then repeats every week for a year ahead; a
   * temporary one until repeatUntil. The copies are saved as drafts for the office to publish.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  repeatWeekdays?: number[];

  /** The last day a temporary weekly trip runs. */
  @IsOptional()
  @IsDateString()
  repeatUntil?: string | null;

  /** No booking is taken before this moment, even once published. Null or left out opens booking on publish. */
  @IsOptional()
  @IsDateString()
  bookingOpensAt?: string | null;

  @IsOptional()
  @IsEnum(TripDirection)
  direction?: TripDirection;

  @IsOptional()
  @IsIn(BOOKING_TYPES)
  bookingType?: string;

  @IsOptional()
  @IsString()
  busId?: string | null;

  @IsOptional()
  @IsString()
  packageId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BoardingPointDto)
  boardingPoints?: BoardingPointDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItineraryStopDto)
  itineraryStops?: ItineraryStopDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => VisitDto)
  visits?: VisitDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AccommodationDto)
  accommodation?: AccommodationDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  driverIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supervisorIds?: string[];

  /** What the bus costs the company for this trip; never exposed publicly. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000000)
  busRentalPrice?: number;

  /** The bed price: charged per person when added to the base price, or its value inside it for reports. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  housingPrice?: number | null;

  /** When housing is included in the base price, this is the extra a private room costs. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  privateRoomPrice?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  privateRoomCapacity?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  sharedRoomCapacity?: number;

  /** How long before the miqat and each gathering point passengers are reminded. Null uses the company's rule. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  alertLeadMinutes?: number | null;

  /** How often the reminder repeats until the moment; 0 sends it once. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  alertRepeatMinutes?: number | null;

  @IsOptional()
  @IsEnum(HousingPriceMode)
  housingPriceMode?: HousingPriceMode;

  @IsOptional()
  @IsEnum(PrivateRoomPriceBasis)
  privateRoomPriceBasis?: PrivateRoomPriceBasis;

  @IsOptional()
  @IsEnum(HousingPricePeriod)
  housingPricePeriod?: HousingPricePeriod;

  @IsOptional()
  @IsBoolean()
  reverseEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  reverseOpenPercent?: number;

  @IsOptional()
  @IsDateString()
  reverseDepartureAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1000000)
  reversePrice?: number;

  @IsOptional()
  @IsBoolean()
  channelApp?: boolean;

  @IsOptional()
  @IsBoolean()
  channelBranch?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CREW_OPENS_BEFORE_MINUTES)
  crewOpensBeforeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BOARDING_OPENS_BEFORE_MINUTES)
  boardingOpensBeforeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BOARDING_CLOSES_AFTER_MINUTES)
  boardingClosesAfterMinutes?: number;

  /** BLOCK keeps a passenger who still owes money off the bus; WARN shows the crew the amount and leaves it to them. */
  @IsOptional()
  @IsEnum(UnpaidBoardingPolicy)
  unpaidBoarding?: UnpaidBoardingPolicy;
}

export class UpdateTripDto extends PartialType(CreateTripDto) {}

export class OpenReverseTripDto {
  /** A single gathering point by name, for callers that send only that; boardingPoints takes its place when given. */
  @IsOptional()
  @IsString()
  @Length(1, 150)
  boardingPointName?: string;

  /** Where passengers of the way back gather: one at least, here or as boardingPointName. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BoardingPointDto)
  boardingPoints?: BoardingPointDto[];

  /** The stops on the way back, in road order. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItineraryStopDto)
  itineraryStops?: ItineraryStopDto[];

  @IsOptional()
  @IsBoolean()
  channelApp?: boolean;

  @IsOptional()
  @IsBoolean()
  channelBranch?: boolean;
}

export class StopSeriesDto {
  /** Also removes the series' drafts that have not been published yet. */
  @IsOptional()
  @IsBoolean()
  deleteDrafts?: boolean;
}

export class ReverseTripsQuery {
  @IsOptional()
  /** Without a range, every upcoming trip: a reverse can be opened as soon as its outbound is published. */
  @IsIn(['week', 'month', 'all'])
  range?: 'week' | 'month' | 'all';
}

export class DuplicateTripDto {
  /** When the copy leaves; every other date in the trip moves with it. */
  @IsDateString()
  departureTime: string;
}

export class AdminTripsQuery {
  /**
   * now: trips leaving from this moment on (the trips page's default); currentMonth: from the 1st of this Riyadh month;
   * YYYY-MM-DD: from that Riyadh day. With from or to the list runs nearest departure first.
   * Left out with to, every trip newest first, as reports and pickers need.
   */
  @IsOptional()
  @Matches(/^(now|currentMonth|\d{4}-\d{2}-\d{2})$/, { message: 'from: now أو currentMonth أو تاريخ YYYY-MM-DD' })
  from?: string;

  /** The last Riyadh day included, as YYYY-MM-DD. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to: تاريخ YYYY-MM-DD' })
  to?: string;
}

export class AdminOccupancyQuery {
  /** The branch filter's city: trips leaving from it. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  destination?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  bookingType?: string;
}

export class SeriesMonthDto {
  /** A calendar month in Riyadh, as YYYY-MM. */
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'اختر الشهر بصيغة YYYY-MM' })
  month: string;
}

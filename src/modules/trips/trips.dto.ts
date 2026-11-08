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
  Matches,
  Max,
  MaxLength,
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

export class CreateTripDto {
  @IsString()
  @Matches(/^[A-Za-z0-9-]{2,30}$/, { message: 'رمز الرحلة غير صحيح' })
  tripCode: string;

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
  @IsString()
  @Length(1, 150)
  boardingPointName: string;

  @IsOptional()
  @IsBoolean()
  channelApp?: boolean;

  @IsOptional()
  @IsBoolean()
  channelBranch?: boolean;
}

export class ReverseTripsQuery {
  @IsOptional()
  @IsIn(['week', 'month'])
  range?: 'week' | 'month';
}

import { Transform } from 'class-transformer';
import { OmitType, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { HotelComplaintSource, HotelRateUnit, HotelRoomBlockType, HousingPriceMode, HousingPricePeriod, PrivateRoomPriceBasis, RoomType } from '@prisma/client';
import { GalleryImages } from '../../common/utils/gallery.util';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class CreateHotelDto {
  @trimmed()
  @IsString()
  @Length(2, 150)
  name: string;

  @trimmed()
  @IsString()
  @Length(2, 100)
  city: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  nightlyRate?: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** What the hotel offers, from the shared service list. Replaces the hotel's whole list when sent. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  serviceIds?: string[];

  /** Older clients send names instead: each becomes the service of that name, created when missing. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  features?: string[];

  /** The hotel's photos in order, the first being the cover. */
  @GalleryImages()
  images?: string[];

  @IsOptional()
  @IsBoolean()
  offersSharedRoom?: boolean;

  @IsOptional()
  @IsBoolean()
  offersPrivateRoom?: boolean;

  @IsOptional()
  @IsEnum(HotelRateUnit)
  rateUnit?: HotelRateUnit;

  /** Customer prices, copied to a trip when it picks this hotel. Null clears one. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  bedPrice?: number | null;

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
  @IsEnum(HousingPriceMode)
  housingPriceMode?: HousingPriceMode;

  @IsOptional()
  @IsEnum(PrivateRoomPriceBasis)
  privateRoomPriceBasis?: PrivateRoomPriceBasis;

  @IsOptional()
  @IsEnum(HousingPricePeriod)
  housingPricePeriod?: HousingPricePeriod;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class UpdateHotelDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(2, 150)
  name?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @Length(2, 100)
  city?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  nightlyRate?: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** What the hotel offers, from the shared service list. Replaces the hotel's whole list when sent. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  serviceIds?: string[];

  /** Older clients send names instead: each becomes the service of that name, created when missing. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  features?: string[];

  /** The hotel's photos in order, the first being the cover. Replaces the whole gallery when sent. */
  @GalleryImages()
  images?: string[];

  @IsOptional()
  @IsBoolean()
  offersSharedRoom?: boolean;

  @IsOptional()
  @IsBoolean()
  offersPrivateRoom?: boolean;

  @IsOptional()
  @IsEnum(HotelRateUnit)
  rateUnit?: HotelRateUnit;

  /** Customer prices, copied to a trip when it picks this hotel. Null clears one. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  bedPrice?: number | null;

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
  @IsEnum(HousingPriceMode)
  housingPriceMode?: HousingPriceMode;

  @IsOptional()
  @IsEnum(PrivateRoomPriceBasis)
  privateRoomPriceBasis?: PrivateRoomPriceBasis;

  @IsOptional()
  @IsEnum(HousingPricePeriod)
  housingPricePeriod?: HousingPricePeriod;
}

export class CreateHotelBookingDto {
  @IsString()
  @Length(1, 60)
  tripId: string;

  @IsString()
  @Length(1, 60)
  hotelId: string;

  @Matches(DATE_ONLY, { message: 'صيغة تاريخ الدخول غير صحيحة' })
  checkIn: string;

  @Matches(DATE_ONLY, { message: 'صيغة تاريخ الخروج غير صحيحة' })
  checkOut: string;

  /** Admin only; anyone else books at the hotel's contract rate. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  nightlyRate?: number;

  /** Admin only. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000000)
  extraCost?: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(60)
  supplierReference?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(60)
  mealPlan?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Every field may change alone; the trip and the hotel stay, so moving to another hotel is a cancel and a new booking. */
export class UpdateHotelBookingDto extends PartialType(OmitType(CreateHotelBookingDto, ['tripId', 'hotelId'] as const)) {}

export class CancelHotelBookingDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'سبب الإلغاء إلزامي' })
  reason: string;
}

class RoomFieldsDto {
  @trimmed()
  @IsString()
  @Length(1, 30, { message: 'أدخل رقم الغرفة' })
  roomNumber: string;

  @IsEnum(RoomType)
  roomType: RoomType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  /** Shown to the customer in the app. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  roomNote?: string;
}

export class AssignRoomDto extends RoomFieldsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  passengerIds: string[];
}

export class CrewAssignRoomDto {
  @trimmed()
  @IsString()
  @Length(1, 30, { message: 'أدخل رقم الغرفة' })
  roomNumber: string;

  /** A private booking's passengers share this room, instead of this passenger alone. */
  @IsOptional()
  @IsBoolean()
  wholeBooking?: boolean;
}

export class AssignBookingRoomDto extends RoomFieldsDto {
  @IsString()
  @Length(1, 60)
  bookingId: string;

  @IsString()
  @Length(1, 60)
  hotelId: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  passengerIds?: string[];
}

export class CreateHotelComplaintDto {
  @IsEnum(HotelComplaintSource)
  source: HotelComplaintSource;

  @trimmed()
  @IsString()
  @Length(3, 150, { message: 'أدخل موضوع الشكوى' })
  subject: string;

  @trimmed()
  @IsString()
  @Length(3, 2000, { message: 'أدخل تفاصيل الشكوى' })
  details: string;

  /** A traveler on one of this hotel's trips, whether or not they have a room now. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  passengerId?: string;

  /** For someone not found in the system; ignored when passengerId is sent. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(2, 150)
  travelerName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(30)
  roomNumber?: string;
}

export class ComplaintTravelersQuery {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class CreateTravelerComplaintDto {
  @IsString()
  @Length(1, 60)
  hotelBookingId: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  passengerId?: string;

  @trimmed()
  @IsString()
  @Length(3, 150, { message: 'اختر موضوع الشكوى' })
  subject: string;

  @trimmed()
  @IsString()
  @Length(3, 2000, { message: 'اكتب تفاصيل الشكوى' })
  details: string;
}

export class CreateRoomBlockDto {
  @trimmed()
  @IsString()
  @Length(1, 30, { message: 'أدخل رقم الغرفة' })
  roomNumber: string;

  @IsEnum(HotelRoomBlockType)
  type: HotelRoomBlockType;

  @Matches(DATE_ONLY, { message: 'صيغة تاريخ البداية غير صحيحة' })
  fromDate: string;

  /** The day it returns to service; left out, the room stays out until released. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'صيغة تاريخ العودة غير صحيحة' })
  untilDate?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class ResolveHotelComplaintDto {
  @trimmed()
  @IsString()
  @Length(3, 1000, { message: 'اكتب ما تم بخصوص الشكوى' })
  resolution: string;
}

export class HotelsOverviewQuery {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

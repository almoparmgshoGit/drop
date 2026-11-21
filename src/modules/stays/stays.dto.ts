import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { RoomType, StayBookingStatus } from '@prisma/client';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_MESSAGE = 'التاريخ بالشكل YYYY-MM-DD';

export const MAX_STAY_NIGHTS = 60;
export const MAX_STAY_GUESTS = 20;

/** What the customer searches with; without dates and guests the hotels are listed without a total. */
export class StayHotelsQuery {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  checkIn?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_STAY_NIGHTS)
  nights?: number;

  @IsOptional()
  @IsEnum(RoomType)
  roomChoice?: RoomType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_STAY_GUESTS)
  guests?: number;
}

export class StayQuoteDto {
  @IsString()
  @Length(1, 60)
  hotelId: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  checkIn: string;

  @IsInt()
  @Min(1)
  @Max(MAX_STAY_NIGHTS, { message: `عدد الليالي من 1 إلى ${MAX_STAY_NIGHTS}` })
  nights: number;

  @IsEnum(RoomType)
  roomChoice: RoomType;

  @IsInt()
  @Min(1)
  @Max(MAX_STAY_GUESTS, { message: `عدد النزلاء من 1 إلى ${MAX_STAY_GUESTS}` })
  guests: number;

  @IsOptional()
  @IsBoolean()
  useWallet?: boolean;
}

export class CreateStayDto extends StayQuoteDto {
  @IsIn(['mada', 'card', 'wallet'])
  paymentMethod: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STAY_GUESTS)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  guestNames?: string[];
}

export class RequestStayCancelDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RateStayDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class AdminStaysQuery {
  @IsOptional()
  @IsEnum(StayBookingStatus)
  status?: StayBookingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  hotelId?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  city?: string;

  /** Check-in days YYYY-MM-DD, both included. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to?: string;

  /** The reference, or the customer's name or phone. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class AdminCancelStayDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectStayCancelDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateHotelRatingDto {
  @IsBoolean()
  isHidden: boolean;
}

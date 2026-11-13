import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { BookingCategory, BookingStatus, Gender, RefundDestination, RoomType } from '@prisma/client';

const SEAT_NUMBER = /^\d{1,3}$/;
const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class BookingLegDto {
  @IsString()
  @Length(1, 60)
  tripId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Matches(SEAT_NUMBER, { each: true })
  seats: string[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  boardingPointId?: string;

  /** The room type the customer picked, from what this trip's hotel offers. */
  @IsOptional()
  @IsEnum(RoomType)
  roomChoice?: RoomType;

  /**
   * The customer leaves this trip's hotel out and books its seat alone. Only where the housing is charged on top of the
   * seat price; a package, or a trip whose price already includes the stay, has no price without it.
   */
  @IsOptional()
  @IsBoolean()
  withoutHousing?: boolean;
}

export class PassengerDto {
  @IsString()
  @Length(2, 100)
  fullName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /** Optional so an app installed before it was asked still books. */
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;
}

export class QuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => BookingLegDto)
  legs: BookingLegDto[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @IsOptional()
  @IsBoolean()
  useWallet?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  pointsToRedeem?: number;

  @IsOptional()
  @IsEnum(BookingCategory)
  category?: BookingCategory;

  /** The customer is booking the bus alone: a trip's hotel is left out and not charged. */
  @IsOptional()
  @IsBoolean()
  transportOnly?: boolean;

  /** A package the customer builds: legs are its outbound then its return, and the first leg's roomChoice is the stay's room. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  customPackageId?: string;
}

export class CreateBookingDto extends QuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PassengerDto)
  passengers: PassengerDto[];

  @IsOptional()
  @IsIn(['mada', 'card', 'wallet'])
  paymentMethod?: string;
}

export class HoldSeatsDto {
  @IsString()
  @Length(1, 60)
  tripId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Matches(SEAT_NUMBER, { each: true })
  seats: string[];

  @IsOptional()
  @IsEnum(BookingCategory)
  category?: BookingCategory;
}

export class ReleaseHoldDto {
  @IsString()
  @Length(1, 60)
  tripId: string;
}

export class RequestCancellationDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class AdminCancelDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount?: number;

  /** WALLET (the default) credits the wallet now; ORIGINAL splits it the way an approved cancellation request does. */
  @IsOptional()
  @IsEnum(RefundDestination, { message: 'طريقة الاسترداد غير صحيحة' })
  refundMethod?: RefundDestination;

  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'سبب الإلغاء إلزامي' })
  note: string;
}

export class ReviewCancellationDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount?: number;

  @IsOptional()
  @IsEnum(RefundDestination)
  refundDestination?: RefundDestination;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Every admin edit states why, and which version of the booking it was made against. */
class AdminEditDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'سبب التعديل إلزامي' })
  reason: string;

  @IsDateString()
  expectedUpdatedAt: string;
}

export class UpdatePassengerDto extends AdminEditDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(2, 100)
  fullName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @IsOptional()
  @trimmed()
  @Matches(/^[A-Za-z0-9]{0,20}$/, { message: 'رقم الهوية يقبل الأرقام والحروف اللاتينية فقط' })
  nationalId?: string | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string | null;
}

export class ChangeSeatDto extends AdminEditDto {
  @Matches(SEAT_NUMBER)
  seatNumber: string;
}

export class ChangeBoardingPointDto extends AdminEditDto {
  @IsString()
  @Length(1, 60)
  boardingPointId: string;
}

export class CompensateTicketDto {
  /** Left out, the amount the panel's percentage gives. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'أدخل مبلغًا صحيحًا' })
  @Min(0.01, { message: 'حدد مبلغ التعويض' })
  @Max(1_000_000)
  amount?: number;

  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب التعويض' })
  note: string;
}

export class BoardingOverrideDto extends AdminEditDto {
  /** The boarding is the passenger's ride back on the reverse, recorded apart from the outbound one. */
  @IsOptional()
  @IsBoolean()
  returning?: boolean;
}

export class AddNoteDto {
  @trimmed()
  @IsString()
  @Length(2, 1000, { message: 'نص الملاحظة مطلوب' })
  text: string;
}

export class QuickSearchQuery {
  @trimmed()
  @IsString()
  @Length(2, 100, { message: 'اكتب حرفين على الأقل' })
  q: string;
}

export class AdminBookingsQuery {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  tripId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  branchId?: string;

  @IsOptional()
  @IsIn(['PAID', 'PENDING', 'REFUNDED'])
  payment?: 'PAID' | 'PENDING' | 'REFUNDED';

  @IsOptional()
  @IsIn(['WAITING', 'PARTIAL', 'BOARDED'])
  boarding?: 'WAITING' | 'PARTIAL' | 'BOARDED';

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

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
  limit?: number;
}

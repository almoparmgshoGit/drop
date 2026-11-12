import { BookingKind, BookingLeg, CollectionMethod, Gender, IdType, RoomType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ALL_PERMISSIONS } from '../../common/permissions';
import { GENDERS, NATIONALITIES } from '../../common/profile-options';
import { ID_TYPES } from '../../common/utils/identity.util';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const SEAT_NUMBER = /^\d{1,3}$/;
const NATIONAL_ID = /^[A-Za-z0-9]{0,20}$/;
const MAX_AMOUNT = 1_000_000;

export class BranchPerformanceQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;
}

export class AssignEmployeeDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}

export class SetBranchManagerDto {
  // null leaves the branch without a manager.
  @ValidateIf((dto) => dto.userId !== null)
  @IsString()
  @IsNotEmpty()
  userId: string | null;
}

export class CreateBranchEmployeeDto {
  @trimmed()
  @IsString()
  @Length(2, 100)
  name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  @IsEmail({}, { message: 'البريد الإلكتروني غير صحيح' })
  @MaxLength(254)
  email?: string;

  @IsString()
  @IsNotEmpty()
  rankId: string;

  @IsString()
  @Length(10, 200, { message: 'كلمة المرور يجب ألا تقل عن 10 أحرف' })
  password: string;

  // Optional here so the service names the missing one; a new employee cannot be saved without them.
  @IsOptional()
  @IsString()
  @Length(2, 60)
  nationality?: string;

  @IsOptional()
  @IsIn(GENDERS, { message: 'اختر الجنس من القائمة' })
  gender?: Gender;

  @IsOptional()
  @IsIn(ID_TYPES, { message: 'اختر نوع الهوية: هوية وطنية أو إقامة أو جواز سفر' })
  idType?: IdType;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  idNumber?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ إصدار الهوية غير صحيحة' })
  idIssueDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ انتهاء الهوية غير صحيحة' })
  idExpiryDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ الميلاد غير صحيحة' })
  birthDate?: string;
}

export class UpdateAccessDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rankId?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  extraPermissions: string[];

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  revokedPermissions: string[];
}

export class TripSearchQuery {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(80)
  origin?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(80)
  destination?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class BranchQuery {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  branchId?: string;
}

export class CustomerLookupQuery {
  @IsString()
  @Length(9, 20)
  phone: string;
}

export class JourneyLegDto {
  @IsEnum(BookingLeg)
  leg: BookingLeg;

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
}

export class JourneyStayDto {
  @IsString()
  @Length(1, 60)
  hotelId: string;

  @IsEnum(RoomType)
  roomType: RoomType;

  @IsDateString()
  checkIn: string;

  @IsDateString()
  checkOut: string;
}

/** Everything the price depends on; the screen sends this and shows what comes back. */
export class JourneyQuoteDto {
  @IsEnum(BookingKind)
  kind: BookingKind;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => JourneyLegDto)
  legs: JourneyLegDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => JourneyStayDto)
  stay?: JourneyStayDto;

  /** The whole booking after any change by the employee. Leave it out to charge the listed price. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'السعر النهائي يجب أن يكون أكبر من صفر' })
  @Max(MAX_AMOUNT)
  finalTotal?: number;
}

export class CustomerDto {
  @trimmed()
  @IsString()
  @Length(2, 100, { message: 'اسم الراكب بين حرفين و100 حرف' })
  name: string;

  @IsString()
  @Length(9, 20, { message: 'رقم الجوال مطلوب' })
  phone: string;
}

export class JourneyPassengerDto {
  @trimmed()
  @IsString()
  @Length(2, 100, { message: 'اسم الراكب بين حرفين و100 حرف' })
  fullName: string;

  @IsOptional()
  @trimmed()
  @Matches(NATIONAL_ID, { message: 'رقم الهوية يقبل الأرقام والحروف اللاتينية فقط' })
  nationalId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsIn(NATIONALITIES, { message: 'اختر الجنسية من القائمة' })
  nationality?: string;
}

export class JourneyPaymentDto {
  @IsEnum(CollectionMethod)
  method: CollectionMethod;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'مبلغ الدفعة غير صحيح' })
  @Min(0.01)
  @Max(MAX_AMOUNT)
  amount: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(80)
  reference?: string;
}

export class CreateJourneyDto extends JourneyQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  branchId?: string;

  @ValidateNested()
  @Type(() => CustomerDto)
  customer: CustomerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => JourneyPassengerDto)
  passengers: JourneyPassengerDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => JourneyPaymentDto)
  payments?: JourneyPaymentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

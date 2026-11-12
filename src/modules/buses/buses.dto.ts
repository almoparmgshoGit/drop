import { BUS_SEAT_COUNT, MAX_SMALL_VEHICLE_SEATS, MIN_SMALL_VEHICLE_SEATS } from '../../common/utils/bus-layout.util';
import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BusStatus, VehicleKind } from '@prisma/client';
import { toEnglishDigits } from '../../common/utils/phone.util';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PAYMENT_METHODS = ['CASH', 'TRANSFER', 'CHEQUE'] as const;

export class CreateBusDto {
  @trimmed()
  @IsString()
  @Length(2, 30)
  plateNumber: string;

  @trimmed()
  @IsString()
  @Length(2, 100)
  model: string;


  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  /** A bus seats passengers on the fixed plan; a van or minibus on one drawn from seatCount. */
  @IsOptional()
  @IsEnum(VehicleKind, { message: 'اختر نوع المركبة: باص أو فان أو باص صغير' })
  kind?: VehicleKind;

  /** Required for a van or minibus; a bus always has the fixed plan's seats. */
  @IsOptional()
  @IsInt({ message: 'عدد المقاعد رقم صحيح' })
  @Min(MIN_SMALL_VEHICLE_SEATS, { message: `عدد المقاعد لا يقل عن ${MIN_SMALL_VEHICLE_SEATS}` })
  @Max(MAX_SMALL_VEHICLE_SEATS, { message: `عدد المقاعد لا يزيد عن ${MAX_SMALL_VEHICLE_SEATS}، وللأكثر اختر باص` })
  seatCount?: number;

  /** Where singles sit on this bus. Left out, it starts from the settings. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(BUS_SEAT_COUNT)
  singlesFromSeat?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(BUS_SEAT_COUNT)
  singlesToSeat?: number;

  /** Ignored once the bus belongs to an office: the company then follows the office's name. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  company?: string;

  /** What the bus provides; every trip it is assigned to offers these automatically. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  serviceIds?: string[];

  /** Null means a bus the company owns, so no office is owed for it. */
  @IsOptional()
  @IsString()
  officeId?: string | null;

  @IsOptional()
  @IsEnum(BusStatus)
  status?: BusStatus;
}

export class UpdateBusDto extends PartialType(CreateBusDto) {}

export class CreateDriverDto {
  @trimmed()
  @IsString()
  @Length(2, 100)
  name: string;

  @IsString()
  @MaxLength(30)
  phone: string;

  @IsString()
  @MinLength(10, { message: 'كلمة المرور 10 أحرف على الأقل' })
  @MaxLength(128)
  password: string;

  /** Older forms: a bare national ID or iqama number. New ones send idType and idNumber. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? toEnglishDigits(value.trim()) : value))
  @Matches(/^\d{5,20}$/, { message: 'رقم الهوية أو الإقامة أرقام فقط، من 5 إلى 20 رقمًا' })
  iqamaNumber?: string;

  @trimmed()
  @IsString()
  @Length(2, 60)
  nationality: string;

  @Matches(DATE_ONLY, { message: 'صيغة انتهاء الرخصة غير صحيحة' })
  licenseExpiry: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE'], { message: 'اختر الجنس من القائمة' })
  gender?: 'MALE' | 'FEMALE';

  @IsOptional()
  @IsIn(['NATIONAL_ID', 'IQAMA', 'PASSPORT'], { message: 'اختر نوع الهوية: هوية وطنية أو إقامة أو جواز سفر' })
  idType?: 'NATIONAL_ID' | 'IQAMA' | 'PASSPORT';

  @IsOptional()
  @IsString()
  @MaxLength(30)
  idNumber?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'صيغة تاريخ إصدار الهوية غير صحيحة' })
  idIssueDate?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'صيغة تاريخ انتهاء الهوية غير صحيحة' })
  idExpiryDate?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'صيغة تاريخ الميلاد غير صحيحة' })
  birthDate?: string;

  /** Opens the employment file with the account. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'صيغة تاريخ التعيين غير صحيحة' })
  hireDate?: string;
}

export class UpdateDriverDto extends PartialType(CreateDriverDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class RateDto {
  @trimmed()
  @IsString()
  @Length(2, 100)
  origin: string;

  @trimmed()
  @IsString()
  @Length(2, 100)
  destination: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  price: number;
}

export class CreateBusOfficeDto {
  @trimmed()
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(60)
  contractNumber?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RateDto)
  rates?: RateDto[];
}

export class UpdateBusOfficeDto extends PartialType(CreateBusOfficeDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class StatementQuery {
  @IsOptional()
  @Matches(MONTH)
  month?: string;
}

export class UpdateTripCostDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10000000)
  busRentalPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  driverExpense?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  delegationExpense?: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class CreateOfficePaymentDto {
  @Matches(MONTH, { message: 'صيغة الشهر غير صحيحة' })
  month: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(10000000)
  amount: number;

  @IsIn(PAYMENT_METHODS)
  method: string;

  @Matches(DATE_ONLY, { message: 'صيغة تاريخ السداد غير صحيحة' })
  paidAt: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(60)
  reference?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class VoidOfficePaymentDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'سبب الإلغاء إلزامي' })
  reason: string;
}

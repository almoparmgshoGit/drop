import { ClosingKind, ClosingPeriod, CollectionMethod, GeneralExpenseCategory } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
// A form with files sends every field as text.
const multipartNumber = () => Transform(({ value }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value));
const multipartBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));
const blankToUndefined = () => Transform(({ value }) => (value === '' || value === null ? undefined : value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** Which closing is asked for: its kind, and the trip or the period it covers. */
export class ClosingQuery {
  @IsEnum(ClosingKind, { message: 'نوع التقفيل غير صحيح' })
  kind: ClosingKind;

  @IsEnum(ClosingPeriod, { message: 'فترة التقفيل غير صحيحة' })
  period: ClosingPeriod;

  /** TRIP: either leg of the journey. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  tripId?: string;

  /** MONTH: YYYY-MM. */
  @IsOptional()
  @Matches(MONTH, { message: 'الشهر غير صحيح' })
  month?: string;

  /** QUARTER and YEAR. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year?: number;

  /** QUARTER: 1 to 4. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quarter?: number;

  /** CUSTOM: Riyadh days, both included. */
  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  to?: string;
}

export class ApproveClosingDto extends ClosingQuery {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class VoidClosingDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب إلغاء الاعتماد' })
  reason: string;
}

export class ClosingsListQuery {
  @IsOptional()
  @IsEnum(ClosingKind)
  kind?: ClosingKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class GeneralExpensesQuery {
  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  to?: string;

  @IsOptional()
  @IsEnum(GeneralExpenseCategory)
  category?: GeneralExpenseCategory;

  /** A branch id, or "none" for the head office. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  /** Only the expenses spent on this trip. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  tripId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class CreateGeneralExpenseDto {
  @IsEnum(GeneralExpenseCategory, { message: 'بند المصروف غير صحيح' })
  category: GeneralExpenseCategory;

  @IsOptional()
  @blankToUndefined()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  /** The trip it was spent on, so it shows on that trip's account. */
  @IsOptional()
  @blankToUndefined()
  @IsString()
  @Length(1, 60)
  tripId?: string;

  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  spentOn: string;

  @IsEnum(CollectionMethod, { message: 'طريقة الدفع غير صحيحة' })
  method: CollectionMethod;

  @multipartBoolean()
  @IsBoolean()
  hasTaxInvoice: boolean;

  @trimmed()
  @IsString()
  @Length(2, 200, { message: 'اكتب وصف المصروف' })
  description: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  supplierName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;

  /** Generated when the form opens, so a repeated submit cannot record the expense twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class VoidGeneralExpenseDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب الإلغاء' })
  reason: string;
}

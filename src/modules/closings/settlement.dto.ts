import { FixedExpenseCycle, FixedPaymentSource, GeneralExpenseCategory, RemittanceMethod, RemittanceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
// A form with files sends every field as text.
const multipartNumber = () => Transform(({ value }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value));
const multipartBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));
const multipartList = () => Transform(({ value }) => (typeof value === 'string' ? (value.startsWith('[') ? JSON.parse(value) : value.split(',').filter(Boolean)) : value));
const blankToUndefined = () => Transform(({ value }) => (value === '' || value === null ? undefined : value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

export class MonthQuery {
  @IsOptional()
  @Matches(MONTH, { message: 'الشهر غير صحيح' })
  month?: string;
}

export class PerformanceQuery extends MonthQuery {
  @IsOptional()
  @IsIn(['MONTH', 'QUARTER', 'YEAR'])
  period?: 'MONTH' | 'QUARTER' | 'YEAR';
}

export class ApproveSettlementDto {
  @Matches(MONTH, { message: 'الشهر غير صحيح' })
  month: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ───────────────────────────── remittances ─────────────────────────────

export class RemittancesQuery {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  @IsOptional()
  @IsEnum(RemittanceStatus)
  status?: RemittanceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class CreateRemittanceDto {
  @IsString()
  @Length(1, 60)
  branchId: string;

  @IsEnum(RemittanceMethod, { message: 'طريقة التوريد غير صحيحة' })
  method: RemittanceMethod;

  /** The closed drawers it carries; all of the branch's unremitted ones when left out. */
  @IsOptional()
  @multipartList()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(62)
  @IsString({ each: true })
  sessionIds?: string[];

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Generated when the form opens, so a repeated submit cannot remit twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class ConfirmRemittanceDto {
  /** What actually reached the owner; the declared amount when left out. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0)
  @Max(9_999_999)
  receivedAmount?: number;

  /** The WhatsApp code, when the code channel is set up. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'الرمز غير صحيح' })
  code?: string;
}

export class RejectRemittanceDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب ما حدث' })
  reason: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'الرمز غير صحيح' })
  code?: string;
}

export class MatchRemittanceDto {
  /** What the bank statement shows for the deposit. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0)
  @Max(9_999_999)
  bankAmount: number;
}

export class ReasonDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب السبب' })
  reason: string;
}

// ───────────────────────────── fixed expenses ─────────────────────────────

export class SaveFixedExpenseDto {
  @IsEnum(GeneralExpenseCategory, { message: 'نوع المصروف غير صحيح' })
  category: GeneralExpenseCategory;

  @trimmed()
  @IsString()
  @Length(2, 120, { message: 'اكتب اسم البند' })
  title: string;

  /** A branch id; empty for the head office or, with allBranches, every branch. */
  @IsOptional()
  @blankToUndefined()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  @IsOptional()
  @multipartBoolean()
  @IsBoolean()
  allBranches?: boolean;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  lessorName?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(30)
  lessorPhone?: string;

  /** What is paid each cycle; for a variable bill, the usual month's estimate. */
  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  @IsEnum(FixedExpenseCycle, { message: 'دورة الدفع غير صحيحة' })
  cycle: FixedExpenseCycle;

  @multipartNumber()
  @IsInt()
  @Min(1)
  @Max(28, { message: 'يوم الاستحقاق من 1 إلى 28' })
  dueDay: number;

  @Matches(DATE, { message: 'تاريخ البداية غير صحيح' })
  startDate: string;

  @IsOptional()
  @blankToUndefined()
  @Matches(DATE, { message: 'تاريخ النهاية غير صحيح' })
  endDate?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class StopFixedExpenseDto extends ReasonDto {
  /** The last day it runs; today when left out. */
  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  stopOn?: string;
}

export class RecordPaymentDto {
  @IsString()
  @Length(1, 60)
  expenseId: string;

  /** The due it pays, by the first month of its cycle. */
  @Matches(MONTH, { message: 'الفترة غير صحيحة' })
  period: string;

  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  @Matches(DATE, { message: 'تاريخ الدفع غير صحيح' })
  paidOn: string;

  @IsEnum(FixedPaymentSource, { message: 'مصدر الدفع غير صحيح' })
  source: FixedPaymentSource;

  /** The drawer's branch, for cash. */
  @IsOptional()
  @blankToUndefined()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class PaymentsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

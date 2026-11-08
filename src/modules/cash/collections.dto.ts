import { CollectionMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const COLLECTION_PERIODS = ['week', 'today', 'overdue', 'all'] as const;
export type CollectionPeriod = (typeof COLLECTION_PERIODS)[number];

export class CollectionsQuery {
  @IsOptional()
  @IsIn(COLLECTION_PERIODS)
  period?: CollectionPeriod;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  branchId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class CollectPaymentDto {
  @IsEnum(CollectionMethod, { message: 'طريقة الدفع غير صحيحة' })
  method: CollectionMethod;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  /** The drawer that receives the cash. */
  @ValidateIf((dto) => dto.method === 'CASH')
  @IsString({ message: 'اختر صندوق الفرع الذي يستلم النقد' })
  @Length(1, 60)
  branchId?: string;

  // A transfer cannot be matched against the bank statement later without its reference.
  @ValidateIf((dto) => dto.method === 'TRANSFER' || dto.reference !== undefined)
  @trimmed()
  @IsString({ message: 'أدخل مرجع التحويل' })
  @Length(2, 60, { message: 'أدخل مرجع التحويل' })
  reference?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(200)
  followUpNote?: string;

  /** Generated when the form opens, so a repeated submit cannot record the money twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class FollowUpNoteDto {
  @trimmed()
  @IsString()
  @MaxLength(200)
  note: string;
}

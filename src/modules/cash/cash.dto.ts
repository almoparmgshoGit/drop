import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const MAX_AMOUNT = 9_999_999;

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Multipart fields arrive as text, and a blank must fail validation rather than become a zero. */
const multipartNumber = () => Transform(({ value }) => (value === '' || value === null || value === undefined ? undefined : Number(value)));

const multipartBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));

/** Empty text clears a field, so a detail can be removed from a branch later. */
const blankToNull = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value));

class BranchDetailsDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() || null : value))
  @ValidateIf((dto) => dto.code !== null)
  @Matches(/^[A-Z0-9-]{2,12}$/, { message: 'رمز الفرع من حرفين إلى 12 حرفًا لاتينيًا أو رقمًا' })
  code?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(200)
  address?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(20)
  whatsapp?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(120)
  workingHours?: string | null;

  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class SaveBranchDto extends BranchDetailsDto {
  @trimmed()
  @IsString()
  @Length(2, 80, { message: 'اسم الفرع بين حرفين و80 حرفًا' })
  name: string;
}

export class UpdateBranchDto extends BranchDetailsDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(2, 80, { message: 'اسم الفرع بين حرفين و80 حرفًا' })
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class OpenSessionDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'الرصيد الافتتاحي غير صحيح' })
  @Min(0, { message: 'الرصيد الافتتاحي لا يكون سالبًا' })
  @Max(MAX_AMOUNT)
  openingBalance: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CloseSessionDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'النقد الفعلي غير صحيح' })
  @Min(0, { message: 'النقد الفعلي لا يكون سالبًا' })
  @Max(MAX_AMOUNT)
  countedCash: number;

  /** The balance the closer was looking at; the closing is refused if the drawer moved since. */
  @IsNumber({ maxDecimalPlaces: 2 })
  expectedBalance: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class IssueCustodyDto {
  @IsString()
  @Length(1, 60)
  recipientId: string;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(MAX_AMOUNT)
  amount: number;

  @trimmed()
  @IsString()
  @MinLength(3, { message: 'اكتب غرض العهدة' })
  @MaxLength(200)
  purpose: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  tripId?: string;

  /** Generated when the form opens, so a repeated submit cannot hand out the cash twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class CreateCustodyExpenseDto {
  @IsString()
  @Length(1, 60)
  categoryId: string;

  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(MAX_AMOUNT)
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ غير صحيح' })
  spentOn: string;

  @multipartBoolean()
  @IsBoolean({ message: 'حدد هل الفاتورة ضريبية' })
  hasTaxInvoice: boolean;

  @trimmed()
  @IsString({ message: 'اكتب اسم المورد' })
  @Length(2, 120, { message: 'اكتب اسم المورد' })
  supplierName: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  notes?: string;

  /** Generated when the form opens, so a retry on a bad signal cannot record the expense twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class VoidCustodyExpenseDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب الإلغاء' })
  reason: string;
}

export class SettleCustodyDto {
  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المصروف الفعلي غير صحيح' })
  @Min(0, { message: 'المصروف الفعلي لا يكون سالبًا' })
  @Max(MAX_AMOUNT)
  spentAmount: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

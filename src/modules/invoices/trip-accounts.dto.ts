import { AccountCategoryGroup, AccountParty, EntrySettlement } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
// A form with files sends every field as text.
const multipartNumber = () => Transform(({ value }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value));
const multipartBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ACCOUNT_VIEWS = ['trip', 'day', 'week', 'month'] as const;
export type AccountView = (typeof ACCOUNT_VIEWS)[number];

export class TripAccountsQuery {
  @IsOptional()
  @IsIn(ACCOUNT_VIEWS)
  view?: AccountView;

  /** Any day inside the period being viewed. */
  @IsOptional()
  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  destination?: string;

  /** Narrows the by-trip view by trip code. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(40)
  q?: string;
}

export class CreateEntryDto {
  @IsString()
  @Length(1, 60)
  categoryId: string;

  @multipartNumber()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'المبلغ غير صحيح' })
  @Min(0.01, { message: 'المبلغ يجب أن يكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  @Matches(DATE, { message: 'التاريخ غير صحيح' })
  spentOn: string;

  @multipartBoolean()
  @IsBoolean()
  hasTaxInvoice: boolean;

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

  /** Whose account the line goes on; the office's own cost when left out. */
  @IsOptional()
  @IsEnum(AccountParty, { message: 'الجهة غير صحيحة' })
  chargedTo?: AccountParty;

  /** Paid now, due at the month's end, or paid ahead to be offset. Paid when left out. */
  @IsOptional()
  @IsEnum(EntrySettlement, { message: 'حالة السداد غير صحيحة' })
  settlement?: EntrySettlement;

  /** Generated when the form opens, so a repeated submit cannot record the expense twice. */
  @IsString()
  @Length(8, 80)
  idempotencyKey: string;
}

export class VoidEntryDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب الإلغاء' })
  reason: string;
}

export class CreateCategoryDto {
  @trimmed()
  @IsString()
  @Length(2, 60, { message: 'اسم البند بين حرفين و60 حرفًا' })
  name: string;

  // Hotels and bus rent are worked out from the trip's own data.
  @IsIn([AccountCategoryGroup.DRIVER, AccountCategoryGroup.ADMIN, AccountCategoryGroup.OTHER, AccountCategoryGroup.INCOME], { message: 'نوع البند غير صحيح' })
  group: AccountCategoryGroup;
}

export class UpdateCategoryDto {
  @IsBoolean()
  isActive: boolean;
}

class HotelTaxFlagDto {
  @IsString()
  @Length(1, 60)
  id: string;

  @IsBoolean()
  hasTaxInvoice: boolean;
}

export class UpdateTaxFlagsDto {
  @IsOptional()
  @IsBoolean()
  rentHasTaxInvoice?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HotelTaxFlagDto)
  hotels?: HotelTaxFlagDto[];
}

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Min, ValidateIf } from 'class-validator';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class InvoicesQuery {
  @IsOptional()
  @Matches(MONTH, { message: 'الشهر غير صحيح' })
  month?: string;

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

export class TaxReportQuery {
  @ValidateIf((query) => !query.quarter || query.month !== undefined)
  @Matches(MONTH, { message: 'الشهر غير صحيح' })
  month?: string;

  @IsOptional()
  @Matches(/^\d{4}-Q[1-4]$/, { message: 'الربع غير صحيح' })
  quarter?: string;
}

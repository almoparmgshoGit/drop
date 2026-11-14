import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { ZatcaDocumentKind, ZatcaStatus } from '@prisma/client';
import { ZATCA_ENVIRONMENTS } from './zatca-api.client';

export class ZatcaAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(127)
  street?: string;

  @IsOptional()
  @Matches(/^(\d{4})?$/, { message: 'رقم المبنى 4 أرقام' })
  building?: string;

  @IsOptional()
  @Matches(/^(\d{4})?$/, { message: 'الرقم الإضافي 4 أرقام' })
  additionalNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  city?: string;

  @IsOptional()
  @Matches(/^(\d{5})?$/, { message: 'الرمز البريدي 5 أرقام' })
  postalCode?: string;
}

export class ZatcaCsrDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  commonName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;
}

export class ZatcaConfigDto {
  @IsOptional()
  @IsIn(Object.keys(ZATCA_ENVIRONMENTS), { message: 'البيئة غير معروفة' })
  environment?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZatcaAddressDto)
  address?: ZatcaAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ZatcaCsrDto)
  csr?: ZatcaCsrDto;
}

/** Named "code" so the operations log drops it like every other one-time code. */
export class ZatcaOtpDto {
  @Matches(/^\d{6}$/, { message: 'رمز OTP من بوابة فاتورة 6 أرقام' })
  code: string;
}

export class ZatcaEnabledDto {
  @IsBoolean()
  enabled: boolean;
}

export class ZatcaDocumentsQuery {
  @IsOptional()
  @IsIn(Object.keys(ZatcaStatus))
  status?: ZatcaStatus;

  @IsOptional()
  @IsIn(Object.keys(ZatcaDocumentKind))
  kind?: ZatcaDocumentKind;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

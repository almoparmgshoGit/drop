import { BusMaintenanceStatus, BusMaintenanceType } from '@prisma/client';
import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateMaintenanceDto {
  @IsOptional()
  @IsEnum(BusMaintenanceType)
  type?: BusMaintenanceType;

  @IsOptional()
  @IsEnum(BusMaintenanceStatus)
  status?: BusMaintenanceStatus;

  @trimmed()
  @IsString()
  @IsNotEmpty({ message: 'اكتب وصف الصيانة' })
  @MaxLength(2000)
  description: string;

  /** Null clears it on an edit. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost?: number | null;

  @IsOptional()
  @IsDateString()
  reportedAt?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  resolvedAt?: string | null;
}

export class UpdateMaintenanceDto extends PartialType(CreateMaintenanceDto) {}

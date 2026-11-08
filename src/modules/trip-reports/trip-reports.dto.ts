import { TripReportCategory, TripReportStatus, TripReportType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateReportDto {
  @IsOptional()
  @IsEnum(TripReportCategory)
  category?: TripReportCategory;

  @IsEnum(TripReportType)
  type: TripReportType;

  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  details: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;

  /** A distress call may be retried on a weak signal, and must not become two. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

export class CrewReportUpdateDto {
  @trimmed()
  @IsString()
  @IsNotEmpty({ message: 'اكتب نص التحديث' })
  @MaxLength(1000)
  note: string;
}

export class OfficeReportUpdateDto {
  @IsOptional()
  @IsEnum(TripReportStatus)
  status?: TripReportStatus;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ReportsQuery {
  @IsOptional()
  @IsEnum(TripReportStatus)
  status?: TripReportStatus;

  @IsOptional()
  @IsEnum(TripReportCategory)
  category?: TripReportCategory;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

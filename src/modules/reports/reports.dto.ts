import { AppEventType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ReportRangeQuery {
  @Matches(DATE_PATTERN)
  from!: string;

  @Matches(DATE_PATTERN)
  to!: string;
}

export const APP_STATS_PERIODS = [7, 14, 30, 90];

export class AppStatsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(APP_STATS_PERIODS)
  days?: number;
}

export class AppEventDto {
  @IsUUID()
  deviceId!: string;

  @IsEnum(AppEventType)
  type!: AppEventType;

  @IsIn(['ios', 'android'])
  platform!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  destination?: string;
}

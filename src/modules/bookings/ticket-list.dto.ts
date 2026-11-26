import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { TicketStatus } from '@prisma/client';

/** The tickets table: every passenger's ticket with its status (مؤكدة / ملغية). */
export class AdminTicketsQuery {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  /** A ticket number, a passenger's name, or a booking number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  tripId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  branchId?: string;

  /** Cancelled on or after this day (Riyadh), for the cancelled tickets of a period. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cancelledFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cancelledTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

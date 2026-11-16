import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CustomerComplaintCategory, CustomerComplaintStatus, HotelComplaintSource, HotelComplaintStatus, SupportTicketPriority } from '@prisma/client';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCustomerComplaintDto {
  @IsEnum(CustomerComplaintCategory, { message: 'اختر نوع الشكوى' })
  category: CustomerComplaintCategory;

  /** Required for a complaint about a trip, a supervisor or a bus: the booking it happened on. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  bookingId?: string;

  @trimmed()
  @IsString()
  @Length(3, 2000, { message: 'اكتب تفاصيل الشكوى' })
  details: string;
}

export class ResolveCustomerComplaintDto {
  @trimmed()
  @IsString()
  @Length(3, 1000, { message: 'اكتب الرد على الشكوى' })
  resolution: string;
}

export const TICKET_VIEWS = ['new', 'mine', 'all', 'closed'] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export class ListCustomerComplaintsQuery {
  /** new: open and nobody took it yet; mine: open and with me; all: every open one I may see; closed. */
  @IsOptional()
  @IsIn(TICKET_VIEWS)
  view?: TicketView;

  /** The older filter, still read when no view is given. */
  @IsOptional()
  @IsEnum(CustomerComplaintStatus)
  status?: CustomerComplaintStatus;

  @IsOptional()
  @IsEnum(SupportTicketPriority)
  priority?: SupportTicketPriority;

  /** An employee's id, or "none" for tickets nobody holds. Only a supervisor's filter. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assignee?: string;

  @IsOptional()
  @IsEnum(CustomerComplaintCategory)
  category?: CustomerComplaintCategory;

  /** The reference (C-12), the customer's name or phone, or the trip code. */
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Every hotel's complaints in one list, for the same screen as the app complaints. */
export class ListHotelComplaintsQuery {
  @IsOptional()
  @IsEnum(HotelComplaintStatus)
  status?: HotelComplaintStatus;

  @IsOptional()
  @IsEnum(HotelComplaintSource)
  source?: HotelComplaintSource;

  /** The reference (HC-12), the hotel, the subject, the traveler or the room. */
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

const booleanField = () => Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value));

/** Sent as multipart when images come with it, so every field arrives as text. */
export class ComplaintMessageDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  body?: string;

  /** A note only staff read; the customer is not told. */
  @IsOptional()
  @booleanField()
  @IsBoolean()
  internal?: boolean;
}

export class AssignComplaintDto {
  /** null returns the ticket to «جديدة» for anyone to take. */
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  assigneeId: string | null;
}

export class ComplaintPriorityDto {
  @IsEnum(SupportTicketPriority, { message: 'اختر الأولوية' })
  priority: SupportTicketPriority;
}

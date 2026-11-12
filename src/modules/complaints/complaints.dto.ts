import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { CustomerComplaintCategory, CustomerComplaintStatus, HotelComplaintSource, HotelComplaintStatus } from '@prisma/client';

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

export class ListCustomerComplaintsQuery {
  @IsOptional()
  @IsEnum(CustomerComplaintStatus)
  status?: CustomerComplaintStatus;

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

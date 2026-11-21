import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const RATING_LEGS = ['OUTBOUND', 'RETURN'] as const;
export type RatingLeg = (typeof RATING_LEGS)[number];

export class RateTripDto {
  /** Which trip of the booking: its own, or the reverse a round trip came back on. Older apps send none and rate the outbound. */
  @IsOptional() @IsIn(RATING_LEGS) leg?: RatingLeg;
  @IsInt({ message: 'اختر عدد النجوم' }) @Min(1, { message: 'اختر عدد النجوم' }) @Max(5) rating: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) busRating?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) supervisorRating?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) driverRating?: number;
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(1000, { message: 'التعليق لا يتجاوز 1000 حرف' }) comment?: string;
}

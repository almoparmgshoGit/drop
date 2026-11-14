import { IsDateString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class TripAvailabilityQuery {
  /** The trip's departure, as an ISO instant. */
  @IsDateString({}, { message: 'وقت البداية غير صحيح' })
  start: string;

  /** When the trip frees its bus and crew: the return, or the arrival of a one-way trip. */
  @IsDateString({}, { message: 'وقت النهاية غير صحيح' })
  end: string;

  /** The trip being edited, which never clashes with itself or with its reverse. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  excludeTripId?: string;
}

export class OperationsBoardQuery {
  /** The first Riyadh day shown, YYYY-MM-DD; today when left out. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ بصيغة YYYY-MM-DD' })
  from?: string;

  /** The last Riyadh day shown, included; the first day when left out. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ بصيغة YYYY-MM-DD' })
  to?: string;
}

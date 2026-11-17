import { Body, Controller, Get, Module, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TripStopReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { TRIP_STATUS_ACTIONS, TripStatusAction } from '../../common/utils/trip-status.util';
import { TicketsModule } from '../tickets/tickets.module';
import { TripsModule } from '../trips/trips.module';
import { TripStatusService } from './trip-status.service';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class ApplyTripStatusDto {
  @IsIn(TRIP_STATUS_ACTIONS)
  action: TripStatusAction;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  boardingPointId?: string;

  /** DELAY: minutes to move the departure by, up to a week either way. */
  @IsOptional()
  @IsInt()
  @Min(-7 * 24 * 60)
  @Max(7 * 24 * 60)
  minutes?: number;

  /** DELAY: the new departure, instead of minutes. */
  @IsOptional()
  @IsDateString()
  departureTime?: string;

  @IsOptional()
  @IsEnum(TripStopReason)
  stopReason?: TripStopReason;

  /** Why: the delay's reason, the stop's details, or the cancellation's reason. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsBoolean()
  acknowledgeReturning?: boolean;
}

class TripStatusListQuery {
  @IsOptional()
  @IsIn(['live', 'upcoming', 'recent'])
  scope?: 'live' | 'upcoming' | 'recent';
}

@ApiTags('Trip status')
@ApiBearerAuth()
@Controller('trip-status')
export class TripStatusController {
  constructor(private readonly service: TripStatusService) {}

  @Get()
  @RequirePermission('trips.start', 'trips.manage')
  @ApiOperation({ summary: 'Trips staff follow from the app, each with its status and the actions open to the caller' })
  list(@Req() req, @Query() query: TripStatusListQuery) {
    return this.service.list(req.user, query.scope);
  }

  @Get(':id')
  @RequirePermission('trips.start', 'trips.manage')
  @ApiOperation({ summary: "A trip's status, the actions open to the caller, its gathering points and its status history" })
  get(@Req() req, @Param('id') id: string) {
    return this.service.get(req.user, id);
  }

  @Post(':id')
  @RequirePermission('trips.start', 'trips.manage')
  @ApiOperation({ summary: "Change a trip's status; the system acts on the new status as it does whoever sets it" })
  apply(@Req() req, @Param('id') id: string, @Body() dto: ApplyTripStatusDto) {
    return this.service.apply(req.user, id, dto);
  }
}

@Module({
  imports: [TripsModule, TicketsModule],
  controllers: [TripStatusController],
  providers: [TripStatusService],
})
export class TripStatusModule {}

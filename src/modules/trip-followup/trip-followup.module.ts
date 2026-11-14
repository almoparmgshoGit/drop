import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { RateTripDto } from './trip-followup.dto';
import { TripFollowupService } from './trip-followup.service';
import { TripRemindersService } from './trip-reminders.service';

@ApiTags('Trip follow-up')
@Controller()
class TripFollowupController {
  constructor(private followup: TripFollowupService) {}

  @Post('tracking-links/bookings/:bookingId')
  @ApiBearerAuth()
  @SkipAudit()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'The owner\'s public tracking link for the trip behind a booking, to share with family' })
  shareLink(@Req() req, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.followup.shareLink(req.user.userId, bookingId);
  }

  @Public()
  @Get('public/tracking/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read-only live position of the bus behind a shared link. No sign-in; expires when the trip ends' })
  publicTracking(@Param('token') token: string) {
    return this.followup.publicTracking(token);
  }

  @Get('trip-ratings/bookings/:bookingId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether the customer can rate the trip of this booking, and their rating if given' })
  ratingOf(@Req() req, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.followup.ratingOf(req.user.userId, bookingId);
  }

  @Post('trip-ratings/bookings/:bookingId')
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The customer rates a trip they rode, once per booking' })
  rate(@Req() req, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Body() dto: RateTripDto) {
    return this.followup.rate(req.user.userId, bookingId, dto);
  }

  @Get('trip-ratings/trips/:tripId')
  @ApiBearerAuth()
  @RequirePermission('trips.view', 'trips.manage')
  @ApiOperation({ summary: 'Customer ratings of one trip with their averages, for the panel' })
  tripRatings(@Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.followup.tripRatings(tripId);
  }
}

@Module({
  controllers: [TripFollowupController],
  providers: [TripFollowupService, TripRemindersService],
  exports: [TripRemindersService],
})
export class TripFollowupModule {}

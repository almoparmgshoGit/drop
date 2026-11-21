import { Body, Controller, Get, Headers, HttpCode, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';
import {
  AdminCancelStayDto,
  AdminStaysQuery,
  CreateStayDto,
  RateStayDto,
  RejectStayCancelDto,
  RequestStayCancelDto,
  StayHotelsQuery,
  StayQuoteDto,
  UpdateHotelRatingDto,
} from './stays.dto';
import { StaysService } from './stays.service';

/** Hotel-only stays ("سكن فقط") the customer books from the app, with no trip. */
@ApiTags('Stays')
@Controller('stays')
@ApiBearerAuth()
class StaysController {
  constructor(private stays: StaysService) {}

  @Public()
  @Get('cities')
  @ApiOperation({ summary: 'Cities with at least one active hotel that has a customer price' })
  cities() {
    return this.stays.cities();
  }

  @Public()
  @Get('hotels')
  @ApiOperation({ summary: 'Active hotels in a city with the total for the given stay, cheapest first' })
  hotels(@Query() query: StayHotelsQuery) {
    return this.stays.hotels(query);
  }

  @Public()
  @Get('hotels/:id')
  @ApiOperation({ summary: 'A hotel as the customer reads it: photos, services, prices, ratings and recent reviews' })
  hotel(@Param('id') id: string) {
    return this.stays.hotelDetail(id);
  }

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Server-side price of a stay, with the wallet\'s ordinary balance and the cancellation policy' })
  quote(@Req() req, @Body() dto: StayQuoteDto) {
    return this.stays.quote(req.user.userId, dto);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Book and pay for a stay, with idempotency support' })
  create(@Req() req, @Body() dto: CreateStayDto, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.stays.create(req.user.userId, dto, idempotencyKey);
  }

  @Get('mine')
  @ApiOperation({ summary: 'The customer\'s stays, newest first' })
  mine(@Req() req) {
    return this.stays.mine(req.user.userId);
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'One of the customer\'s stays with its cancellation terms' })
  mineDetail(@Req() req, @Param('id') id: string) {
    return this.stays.mineDetail(req.user.userId, id);
  }

  @Post('mine/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer asks to cancel a stay before check-in; staff review it' })
  cancel(@Req() req, @Param('id') id: string, @Body() dto: RequestStayCancelDto) {
    return this.stays.requestCancel(req.user.userId, id, dto.reason);
  }

  @Post('mine/:id/rating')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer rates a stay once, after check-out' })
  rate(@Req() req, @Param('id') id: string, @Body() dto: RateStayDto) {
    return this.stays.rate(req.user.userId, id, dto);
  }
}

@ApiTags('Stays')
@Controller('admin/stays')
@ApiBearerAuth()
class AdminStaysController {
  constructor(private stays: StaysService) {}

  @Get()
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'Hotel-only stays booked from the app, filtered and paged' })
  list(@Query() query: AdminStaysQuery) {
    return this.stays.adminList(query);
  }

  @Get(':id')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'One stay with its customer and cancellation terms' })
  detail(@Param('id') id: string) {
    return this.stays.adminDetail(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Cancel a stay (approving the customer\'s request or on staff\'s decision) and refund to the wallet' })
  cancel(@Req() req, @Param('id') id: string, @Body() dto: AdminCancelStayDto) {
    return this.stays.adminCancel(req.user, id, dto);
  }

  @Post(':id/reject-cancel')
  @HttpCode(200)
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Refuse the customer\'s cancellation request; the stay stays confirmed' })
  rejectCancel(@Req() req, @Param('id') id: string, @Body() dto: RejectStayCancelDto) {
    return this.stays.rejectCancel(req.user, id, dto.note);
  }
}

@ApiTags('Stays')
@Controller('admin')
@ApiBearerAuth()
class AdminHotelRatingsController {
  constructor(private stays: StaysService) {}

  @Get('hotels/:id/ratings')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'Every customer rating of a hotel\'s stays, hidden ones included' })
  list(@Param('id') id: string) {
    return this.stays.hotelRatings(id);
  }

  @Patch('hotel-ratings/:id')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Hide or show a customer\'s rating comment' })
  update(@Param('id') id: string, @Body() dto: UpdateHotelRatingDto) {
    return this.stays.setRatingHidden(id, dto.isHidden);
  }
}

@Module({
  controllers: [StaysController, AdminStaysController, AdminHotelRatingsController],
  providers: [StaysService],
})
export class StaysModule {}

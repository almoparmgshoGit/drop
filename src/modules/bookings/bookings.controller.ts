import { Controller, Post, Get, Delete, Param, Body, Req, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import {
  AdminCancelDto,
  CreateBookingDto,
  HoldSeatsDto,
  QuoteDto,
  ReleaseHoldDto,
  RequestCancellationDto,
  ReviewCancellationDto,
} from './bookings.dto';

@ApiTags('Bookings')
@Controller('bookings')
@ApiBearerAuth()
export class BookingsController {
  constructor(private bookingsService: BookingsService) {}

  @Post('quote')
  @ApiOperation({ summary: 'Server-side price calculation for a booking' })
  async quote(@Req() req, @Body() dto: QuoteDto) {
    return this.bookingsService.quote(req.user.userId, dto);
  }

  @Get('seat-map/:tripId')
  @ApiOperation({ summary: 'Seat map of a trip from the current user point of view' })
  async getSeatMap(@Req() req, @Param('tripId') tripId: string) {
    return this.bookingsService.getSeatMap(req.user.userId, tripId);
  }

  @Post('holds')
  @ApiOperation({ summary: 'Temporarily reserve seats while the user completes the booking' })
  async holdSeats(@Req() req, @Body() dto: HoldSeatsDto) {
    return this.bookingsService.holdSeats(req.user.userId, dto);
  }

  @Delete('holds')
  @ApiOperation({ summary: 'Release seats held by the current user on a trip' })
  async releaseHolds(@Req() req, @Body() dto: ReleaseHoldDto) {
    return this.bookingsService.releaseHolds(req.user.userId, dto.tripId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a one-way or round-trip booking with idempotency support' })
  async createBooking(
    @Req() req,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bookingsService.createBooking(req.user.userId, dto, idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'List authenticated user bookings' })
  async getMyBookings(@Req() req) {
    return this.bookingsService.getMyBookings(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get booking details with IDOR protection' })
  async getBookingById(@Req() req, @Param('id') id: string) {
    return this.bookingsService.getBookingById(req.user.userId, id, req.user.permissions.includes('bookings.all_branches'), req.user.permissions.includes('bookings.view'));
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Customer requests a cancellation for review' })
  async requestCancellation(@Req() req, @Param('id') id: string, @Body() dto: RequestCancellationDto) {
    return this.bookingsService.requestCancellation(req.user.userId, id, dto.reason);
  }

  @Post(':id/cancellation/review')
  @RequirePermission('cancellations.review', 'cancellations.approve')
  @ApiOperation({ summary: 'Approve or reject a pending cancellation request' })
  async reviewCancellation(@Req() req, @Param('id') id: string, @Body() dto: ReviewCancellationDto) {
    return this.bookingsService.reviewCancellation(req.user, id, dto, req.ip);
  }

  @Post(':id/admin-cancel')
  @RequirePermission('bookings.cancel')
  @ApiOperation({ summary: 'Cancel a booking directly from the admin panel' })
  async adminCancel(@Req() req, @Param('id') id: string, @Body() dto: AdminCancelDto) {
    return this.bookingsService.adminCancel(req.user, id, dto, req.ip);
  }
}

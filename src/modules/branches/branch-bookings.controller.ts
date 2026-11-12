import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { BranchBookingsService } from './branch-bookings.service';
import { BranchQuery, CreateJourneyDto, CustomerLookupQuery, JourneyQuoteDto, TripSearchQuery } from './branches.dto';

@ApiTags('Branch bookings')
@Controller('branch-bookings')
@ApiBearerAuth()
export class BranchBookingsController {
  constructor(private bookings: BranchBookingsService) {}

  @Get('context')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Which branches the caller sells from and what they may do at the counter' })
  context(@Req() req) {
    return this.bookings.context(req.user);
  }

  @Get('trips')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Trips open for sale at branches' })
  trips(@Req() req, @Query() query: TripSearchQuery) {
    return this.bookings.searchTrips(query, req.user);
  }

  @Get('trips/:id/seats')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Seat map of a trip open for sale at branches' })
  seats(@Param('id') id: string) {
    return this.bookings.seatMap(id);
  }

  @Get('hotels')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Hotels with their customer prices; contract rates stay out' })
  hotels() {
    return this.bookings.hotels();
  }

  @Get('customer')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Fill the form from an earlier customer with this phone' })
  customer(@Query() query: CustomerLookupQuery) {
    return this.bookings.findCustomer(query.phone);
  }

  @Get('recent')
  @RequirePermission('bookings.create', 'bookings.view')
  @ApiOperation({ summary: 'The last ten branch bookings added or changed' })
  recent(@Req() req, @Query() query: BranchQuery) {
    return this.bookings.recent(req.user, query.branchId);
  }

  @Post('quote')
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Price a journey; the screen only shows this result' })
  quote(@Body() dto: JourneyQuoteDto) {
    return this.bookings.quote(dto);
  }

  @Post()
  @RequirePermission('bookings.create')
  @ApiOperation({ summary: 'Register a booking or package at a branch, with any payments taken' })
  create(@Req() req, @Body() dto: CreateJourneyDto) {
    return this.bookings.create(req.user, dto);
  }
}

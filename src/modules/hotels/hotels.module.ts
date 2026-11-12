import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import {
  AssignBookingRoomDto,
  AssignRoomDto,
  CancelHotelBookingDto,
  ComplaintTravelersQuery,
  CreateHotelBookingDto,
  UpdateHotelBookingDto,
  CreateHotelComplaintDto,
  CreateHotelDto,
  CreateRoomBlockDto,
  CreateTravelerComplaintDto,
  CrewAssignRoomDto,
  HotelsOverviewQuery,
  ResolveHotelComplaintDto,
  UpdateHotelDto,
} from './hotels.dto';
import { HotelsService } from './hotels.service';

@ApiTags('Hotels')
@Controller('hotels')
@ApiBearerAuth()
class HotelsController {
  constructor(private hotels: HotelsService) {}

  @Get()
  @RequirePermission('hotels.view', 'trips.manage')
  @ApiOperation({ summary: 'Contracted hotels; rates are visible to admins only' })
  list(@Req() req) {
    return this.hotels.listHotels(req.user);
  }

  @Post()
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Add a contracted hotel' })
  create(@Body() dto: CreateHotelDto) {
    return this.hotels.createHotel(dto);
  }

  @Get('registry')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'Every registered hotel with today\'s occupancy and open complaints' })
  registry(@Req() req) {
    return this.hotels.registry(req.user);
  }

  @Get('overview')
  @RequirePermission('hotels.rates')
  @ApiOperation({ summary: 'Monthly hotel bookings with cost, sales and profit (Admin only)' })
  overview(@Query() query: HotelsOverviewQuery) {
    return this.hotels.overview(query.month);
  }

  @Get('trips/:tripId')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'Passengers who need rooms on a trip, with its hotel bookings' })
  tripRooming(@Req() req, @Param('tripId') tripId: string) {
    return this.hotels.tripRooming(req.user, tripId);
  }

  @Post('bookings')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Book a hotel for a trip' })
  createBooking(@Req() req, @Body() dto: CreateHotelBookingDto) {
    return this.hotels.createBooking(req.user, dto);
  }

  @Patch('bookings/:id')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Edit a hotel booking: dates, supplier details, and its rates for whoever may set them' })
  updateBooking(@Req() req, @Param('id') id: string, @Body() dto: UpdateHotelBookingDto) {
    return this.hotels.updateBooking(req.user, id, dto);
  }

  @Post('bookings/:id/rooms')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Place passengers in a room of a hotel booking' })
  assignRoom(@Req() req, @Param('id') id: string, @Body() dto: AssignRoomDto) {
    return this.hotels.assignRoom(req.user, id, dto, req.ip);
  }

  @Post('bookings/:id/cancel')
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Cancel a hotel booking and release its passengers (Admin only)' })
  cancelBooking(@Req() req, @Param('id') id: string, @Body() dto: CancelHotelBookingDto) {
    return this.hotels.cancelBooking(req.user, id, dto.reason, req.ip);
  }

  @Post('assign-booking')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Book a room straight from a customer booking' })
  assignBooking(@Req() req, @Body() dto: AssignBookingRoomDto) {
    return this.hotels.assignBookingRoom(req.user, dto, req.ip);
  }

  @Delete('passengers/:passengerId/room')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Take a passenger out of their room' })
  unassign(@Req() req, @Param('passengerId') passengerId: string) {
    return this.hotels.unassign(req.user, passengerId, req.ip);
  }

  @Get(':id/complaint-travelers')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Search travelers on this hotel\'s trips, with or without a room now' })
  complaintTravelers(@Param('id') id: string, @Query() query: ComplaintTravelersQuery) {
    return this.hotels.complaintTravelers(id, query.q);
  }

  @Post(':id/room-blocks')
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Take a room out of service for a period' })
  createRoomBlock(@Req() req, @Param('id') id: string, @Body() dto: CreateRoomBlockDto) {
    return this.hotels.createRoomBlock(req.user, id, dto);
  }

  @Post(':id/room-blocks/:blockId/release')
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Return a room to service' })
  releaseRoomBlock(@Req() req, @Param('id') id: string, @Param('blockId') blockId: string) {
    return this.hotels.releaseRoomBlock(req.user, id, blockId);
  }

  @Post(':id/complaints')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Record a complaint from a traveler about the hotel, or from the hotel' })
  createComplaint(@Req() req, @Param('id') id: string, @Body() dto: CreateHotelComplaintDto) {
    return this.hotels.createComplaint(req.user, id, dto);
  }

  @Post(':id/complaints/:complaintId/resolve')
  // The complaints desk closes hotel complaints too, without being able to change hotels.
  @RequirePermission('hotels.manage', 'complaints.manage')
  @ApiOperation({ summary: 'Close a complaint with what was done about it' })
  resolveComplaint(@Req() req, @Param('id') id: string, @Param('complaintId') complaintId: string, @Body() dto: ResolveHotelComplaintDto) {
    return this.hotels.resolveComplaint(req.user, id, complaintId, dto.resolution);
  }

  @Post(':id/complaints/:complaintId/reopen')
  @RequirePermission('hotels.manage', 'complaints.manage')
  @ApiOperation({ summary: 'Reopen a closed complaint' })
  reopenComplaint(@Param('id') id: string, @Param('complaintId') complaintId: string) {
    return this.hotels.reopenComplaint(id, complaintId);
  }

  @Get(':id')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'A hotel with its bookings, room occupants and complaints' })
  detail(@Req() req, @Param('id') id: string) {
    return this.hotels.hotelDetail(req.user, id);
  }

  @Patch(':id')
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Edit a contracted hotel' })
  update(@Param('id') id: string, @Body() dto: UpdateHotelDto) {
    return this.hotels.updateHotel(id, dto);
  }
}

/** Open to any signed-in customer; the service limits each one to their own booking. */
@ApiTags('Hotels')
@Controller('bookings/:bookingId/hotel-complaints')
@ApiBearerAuth()
class TravelerComplaintsController {
  constructor(private hotels: HotelsService) {}

  @Get()
  @ApiOperation({ summary: 'The booking\'s hotels and the complaints its owner sent' })
  list(@Req() req, @Param('bookingId') bookingId: string) {
    return this.hotels.travelerComplaints(req.user.userId, bookingId);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Customer sends a complaint about their hotel' })
  create(@Req() req, @Param('bookingId') bookingId: string, @Body() dto: CreateTravelerComplaintDto) {
    return this.hotels.createTravelerComplaint(req.user.userId, bookingId, dto);
  }
}

@ApiTags('Hotels')
@Controller('crew/trips/:tripId/passengers/:passengerId/room')
@ApiBearerAuth()
class CrewRoomsController {
  constructor(private hotels: HotelsService) {}

  @Post()
  @RequirePermission('crew.housing')
  @ApiOperation({ summary: 'Supervisor places a passenger in a room, which tells the customer' })
  assign(@Req() req, @Param('tripId') tripId: string, @Param('passengerId') passengerId: string, @Body() dto: CrewAssignRoomDto) {
    return this.hotels.assignRoomByCrew(req.user, tripId, passengerId, dto, req.ip);
  }
}

@Module({
  controllers: [HotelsController, TravelerComplaintsController, CrewRoomsController],
  providers: [HotelsService],
})
export class HotelsModule {}

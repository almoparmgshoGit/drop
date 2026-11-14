import { Controller, ForbiddenException, Get, Header, Post, Put, Delete, Param, Query, Body, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PUBLIC_IMAGE_BYTES, MAX_PUBLIC_IMAGES_PER_UPLOAD, TripsService, UploadedImage } from './trips.service';
import { AdminOccupancyQuery, AdminTripsQuery, CreateTripDto, DuplicateTripDto, OpenReverseTripDto, ReverseTripsQuery, SeriesMonthDto, StopSeriesDto, UpdateTripDto } from './trips.dto';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';
import { OperationsBoardService } from './operations-board.service';
import { OperationsBoardQuery, TripAvailabilityQuery } from './operations-board.dto';

class TripSearchQuery {
  @IsOptional() @IsString() @MaxLength(100) origin?: string;
  @IsOptional() @IsString() @MaxLength(100) destination?: string;
  @IsOptional() @IsString() @MaxLength(20) date?: string;
  @IsOptional() @IsString() @MaxLength(40) busType?: string;
  @IsOptional() @IsString() @MaxLength(40) bookingType?: string;
  @IsOptional() @IsString() @MaxLength(60) packageId?: string;
}

class NextAvailableQuery extends TripSearchQuery {
  @IsOptional() @IsString() @MaxLength(20) after?: string;
}

class CancelTripDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** Needed to cancel a reverse that a round trip's passengers are riding back on: they have to be looked after by hand. */
  @IsOptional()
  @IsBoolean()
  acknowledgeReturning?: boolean;
}

@ApiTags('Trips')
@Controller('trips')
export class TripsController {
  constructor(
    private tripsService: TripsService,
    private operationsBoard: OperationsBoardService,
  ) {}

  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Search upcoming published trips' })
  async searchTrips(@Query() query: TripSearchQuery) {
    return this.tripsService.searchTrips(query);
  }

  @Public()
  @Get('search-options')
  @ApiOperation({ summary: 'Trip types, departure cities and routes currently on sale, for the app search' })
  async searchOptions() {
    return this.tripsService.searchOptions();
  }

  @Public()
  @Get('next-available')
  @ApiOperation({ summary: 'Next departure that still has seats for a route' })
  async getNextAvailable(@Query() query: NextAvailableQuery) {
    return this.tripsService.getNextAvailableDate(query);
  }

  @Get('admin/all')
  @RequirePermission('trips.view', 'trips.manage', 'bookings.view', 'manifests.view', 'hotels.view', 'loyalty.view')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all trips for admin management' })
  async getAllAdminTrips(@Req() req, @Query() query: AdminTripsQuery) {
    return this.tripsService.getAllAdminTrips(req.user, query);
  }

  @Get('admin/occupancy')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Occupancy of executed trips (last 30 days) and of the next 30 days, from the shared metrics' })
  async getAdminOccupancy(@Req() req, @Query() query: AdminOccupancyQuery) {
    return this.tripsService.getAdminOccupancy(req.user, query);
  }

  @Get('admin/reverse')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upcoming trips with a reverse trip on their remaining seats' })
  async getReverseTrips(@Req() req, @Query() query: ReverseTripsQuery) {
    return this.tripsService.getReverseTrips(query.range, req.user);
  }

  @Get('admin/availability')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Buses and crew already on another trip, or on approved leave, between start and end' })
  async getAvailability(@Query() query: TripAvailabilityQuery) {
    return this.operationsBoard.availability(query);
  }

  @Get('admin/board')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Operations board: trips of the given Riyadh days per bus, driver and supervisor, with their clashes' })
  async getOperationsBoard(@Req() req, @Query() query: OperationsBoardQuery) {
    return this.operationsBoard.board(req.user, query);
  }

  @Get('admin/branch-filter')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Branches the trips pages filter by: a branch shows the trips leaving from its city' })
  async getTripBranchFilter(@Req() req) {
    return this.tripsService.getTripBranchFilter(req.user);
  }

  @Get('series/month-plan')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: "How many drafts generating a month's weekly schedules would make, without making them" })
  async previewSeriesMonth(@Req() req, @Query() query: SeriesMonthDto) {
    return this.tripsService.generateSeriesMonth(query.month, req.user, true);
  }

  @Post('series/generate-month')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Draft every running weekly schedule on all its weekdays of a month, skipping days it already has' })
  async generateSeriesMonth(@Req() req, @Body() dto: SeriesMonthDto) {
    return this.tripsService.generateSeriesMonth(dto.month, req.user);
  }

  @Post('series/far-drafts/delete')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin only: delete unbooked weekly drafts beyond next month, left by the old year-ahead drafting' })
  async deleteFarFutureDrafts(@Req() req) {
    // Deleting trips in bulk is the admin's call alone, not every trip manager's.
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('هذا الإجراء لمدير النظام فقط');
    return this.tripsService.deleteFarFutureDrafts();
  }

  @Post('series/:seriesId/publish')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: "Publish a weekly schedule's upcoming drafts" })
  async publishSeries(@Req() req, @Param('seriesId') seriesId: string) {
    return this.tripsService.publishSeries(seriesId, req.user);
  }

  @Post('series/:seriesId/stop')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Stop drafting a weekly schedule, optionally removing its unpublished drafts' })
  async stopSeries(@Param('seriesId') seriesId: string, @Body() dto: StopSeriesDto) {
    return this.tripsService.stopSeries(seriesId, dto.deleteDrafts);
  }

  @Get('admin/:id')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get any trip with staff details' })
  async getAdminTripById(@Req() req, @Param('id') id: string) {
    return this.tripsService.getAdminTripById(req.user, id);
  }

  @Post('images')
  @RequirePermission('trips.manage', 'buses.manage', 'hotels.manage', 'offers.manage', 'loyalty.manage')
  @UseInterceptors(FilesInterceptor('images', MAX_PUBLIC_IMAGES_PER_UPLOAD, { limits: { fileSize: MAX_PUBLIC_IMAGE_BYTES } }))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Store photos for trips, buses and hotels; the returned URLs go on the trip, bus or hotel' })
  async uploadImages(@Req() req, @UploadedFiles() files?: UploadedImage[]) {
    return this.tripsService.saveImages(req.user.userId, files);
  }

  @Public()
  @Get('images/:id')
  // Helmet's default would stop the admin panel, on its own origin, from showing these.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @ApiOperation({ summary: 'Open a photo of a trip, bus or hotel' })
  async getImage(@Param('id') id: string) {
    const image = await this.tripsService.getImage(id);
    return new StreamableFile(Buffer.from(image.data), { type: image.mimeType, length: image.size });
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get published trip details' })
  async getTripById(@Param('id') id: string) {
    return this.tripsService.getTripById(id);
  }

  @Post()
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create new trip' })
  async createTrip(@Req() req, @Body() dto: CreateTripDto) {
    return this.tripsService.createTrip(dto, req.user);
  }

  @Put(':id')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update trip' })
  async updateTrip(@Req() req, @Param('id') id: string, @Body() dto: UpdateTripDto) {
    return this.tripsService.updateTrip(id, dto, req.user);
  }

  @Post(':id/duplicate')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Copy a trip to a new departure as a draft without bookings' })
  async duplicateTrip(@Req() req, @Param('id') id: string, @Body() dto: DuplicateTripDto) {
    return this.tripsService.duplicateTrip(id, dto.departureTime, req.user);
  }

  @Post(':id/open-reverse')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open the reverse trip on the remaining seats' })
  async openReverseTrip(@Req() req, @Param('id') id: string, @Body() dto: OpenReverseTripDto) {
    return this.tripsService.openReverseTrip(id, dto, req.user);
  }

  @Post(':id/boarding/open')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open boarding now, ahead of its usual time' })
  async openBoardingNow(@Param('id') id: string) {
    return this.tripsService.setManualBoarding(id, true);
  }

  @Post(':id/boarding/reset')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return boarding to its usual time' })
  async resetBoarding(@Param('id') id: string) {
    return this.tripsService.setManualBoarding(id, false);
  }

  @Post(':id/cancel')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel trip, free seats and refund its bookings to wallets' })
  async cancelTrip(@Req() req, @Param('id') id: string, @Body() dto: CancelTripDto) {
    return this.tripsService.cancelTrip(id, req.user.userId, dto.reason, dto.acknowledgeReturning);
  }

  @Delete(':id')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete trip without bookings' })
  async deleteTrip(@Param('id') id: string) {
    return this.tripsService.deleteTrip(id);
  }
}

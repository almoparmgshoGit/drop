import { Controller, Get, Header, Post, Put, Delete, Param, Query, Body, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_PUBLIC_IMAGE_BYTES, MAX_PUBLIC_IMAGES_PER_UPLOAD, TripsService, UploadedImage } from './trips.service';
import { CreateTripDto, OpenReverseTripDto, ReverseTripsQuery, UpdateTripDto } from './trips.dto';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';

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
  constructor(private tripsService: TripsService) {}

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
  async getAllAdminTrips(@Req() req) {
    return this.tripsService.getAllAdminTrips(req.user);
  }

  @Get('admin/reverse')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upcoming trips with a reverse trip on their remaining seats' })
  async getReverseTrips(@Query() query: ReverseTripsQuery) {
    return this.tripsService.getReverseTrips(query.range);
  }

  @Get('admin/:id')
  @RequirePermission('trips.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get any trip with staff details' })
  async getAdminTripById(@Req() req, @Param('id') id: string) {
    return this.tripsService.getAdminTripById(req.user, id);
  }

  @Post('images')
  @RequirePermission('trips.manage', 'buses.manage', 'offers.manage')
  @UseInterceptors(FilesInterceptor('images', MAX_PUBLIC_IMAGES_PER_UPLOAD, { limits: { fileSize: MAX_PUBLIC_IMAGE_BYTES } }))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Store photos for trips and buses; the returned URLs go on the trip or bus' })
  async uploadImages(@Req() req, @UploadedFiles() files?: UploadedImage[]) {
    return this.tripsService.saveImages(req.user.userId, files);
  }

  @Public()
  @Get('images/:id')
  // Helmet's default would stop the admin panel, on its own origin, from showing these.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @ApiOperation({ summary: 'Open a photo of a trip or bus' })
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

  @Post(':id/open-reverse')
  @RequirePermission('trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open the reverse trip on the remaining seats' })
  async openReverseTrip(@Req() req, @Param('id') id: string, @Body() dto: OpenReverseTripDto) {
    return this.tripsService.openReverseTrip(id, dto, req.user);
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

import { Controller, Get, Post, Param, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { TripLiveStatus } from '@prisma/client';
import { TicketsService } from './tickets.service';
import { CreateReportDto } from '../trip-reports/trip-reports.dto';
import { TripReportsService } from '../trip-reports/trip-reports.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';

class VerifyTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  signedToken: string;

  @IsString()
  @IsNotEmpty()
  tripId: string;

  /** Set once the crew has seen the wrong-point warning and decided to board the passenger anyway. */
  @IsOptional()
  @IsBoolean()
  allowOtherPoint?: boolean;

  /** Set once the crew has seen what a passenger still owes and boarded them anyway, on a trip whose creator allows it. */
  @IsOptional()
  @IsBoolean()
  allowUnpaid?: boolean;
}

class BoardFromPaperDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  code: string;

  @IsString()
  @IsNotEmpty()
  tripId: string;

  /** Set once the crew has seen the wrong-point warning and decided to board the passengers anyway. */
  @IsOptional()
  @IsBoolean()
  allowOtherPoint?: boolean;

  /** Set once the crew has seen what a passenger still owes and boarded them anyway, on a trip whose creator allows it. */
  @IsOptional()
  @IsBoolean()
  allowUnpaid?: boolean;
}

class BoardManuallyDto {
  @IsString()
  @IsNotEmpty()
  tripId: string;

  @IsOptional()
  @IsBoolean()
  allowOtherPoint?: boolean;

  /** Set once the crew has seen what a passenger still owes and boarded them anyway, on a trip whose creator allows it. */
  @IsOptional()
  @IsBoolean()
  allowUnpaid?: boolean;
}

class UpdateLiveStatusDto {
  @IsEnum(TripLiveStatus)
  status: TripLiveStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  boardingPointId?: string;
}

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class SendNoticeDto {
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message: string;
}

class SendTemplateNoticeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  event: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(120)
  value?: string;
}

@ApiTags('Tickets')
@Controller('tickets')
@ApiBearerAuth()
export class TicketsController {
  constructor(
    private ticketsService: TicketsService,
    private reports: TripReportsService,
  ) {}

  @Get('booking/:bookingId')
  @ApiOperation({ summary: 'Get tickets of a booking (owner or staff)' })
  async getTicketsForBooking(@Req() req, @Param('bookingId') bookingId: string) {
    return this.ticketsService.getTicketsForBooking(req.user, bookingId);
  }

  @Get('my-trips')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Trips assigned to the current driver or supervisor' })
  async getMyAssignedTrips(@Req() req) {
    return this.ticketsService.getMyAssignedTrips(req.user);
  }

  @Get('trips/:tripId/details')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Read-only details and crew of an assigned trip, open to its crew at any time' })
  async getTripDetails(@Req() req, @Param('tripId') tripId: string) {
    return this.ticketsService.getTripDetails(req.user, tripId);
  }

  @Post('trips/:tripId/notices')
  @RequirePermission('crew.notify')
  @ApiOperation({ summary: 'Crew posts a notice to the updates of every booking on an assigned trip' })
  async sendNotice(@Req() req, @Param('tripId') tripId: string, @Body() dto: SendNoticeDto) {
    return this.ticketsService.sendNotice(req.user, tripId, dto.message);
  }

  @Get('trips/:tripId/notice-templates')
  @RequirePermission('crew.notify')
  @ApiOperation({ summary: "The approved wording this trip's supervisor may send, filled with the trip's details" })
  async getNoticeTemplates(@Req() req, @Param('tripId') tripId: string) {
    return this.ticketsService.getNoticeTemplates(req.user, tripId);
  }

  @Post('trips/:tripId/template-notices')
  @RequirePermission('crew.notify')
  @ApiOperation({ summary: 'Supervisor sends one approved template to the passengers of their trip' })
  async sendTemplateNotice(@Req() req, @Param('tripId') tripId: string, @Body() dto: SendTemplateNoticeDto) {
    return this.ticketsService.sendTemplateNotice(req.user, tripId, dto.event, dto.value);
  }

  @Post('trips/:tripId/reports')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Crew reports an incident on an assigned trip' })
  async createReport(@Req() req, @Param('tripId') tripId: string, @Body() dto: CreateReportDto) {
    return this.reports.create(req.user, tripId, dto);
  }

  @Post('trips/:tripId/status')
  @RequirePermission('crew.status')
  @ApiOperation({ summary: 'Crew says where the bus is now, which tells the passengers and decides which tickets board without a warning' })
  async updateLiveStatus(@Req() req, @Param('tripId') tripId: string, @Body() dto: UpdateLiveStatusDto) {
    return this.ticketsService.updateLiveStatus(req.user, tripId, dto.status, dto.boardingPointId);
  }

  @Get('reports')
  @RequirePermission('manifests.view')
  @ApiOperation({ summary: 'Latest incidents reported by trip crews' })
  async getReports() {
    return this.ticketsService.getReports();
  }

  @Get('manifest/:tripId')
  @RequirePermission('crew.manifest')
  @ApiOperation({ summary: 'Passenger manifest of an assigned trip' })
  async getManifest(@Req() req, @Param('tripId') tripId: string) {
    return this.ticketsService.getManifest(req.user, tripId);
  }

  @Post('verify')
  @RequirePermission('crew.board')
  @ApiOperation({ summary: 'Verify a scanned ticket for a trip and mark the passenger boarded' })
  async verifyTicket(@Req() req, @Body() dto: VerifyTicketDto) {
    return this.ticketsService.verifyAndBoard(req.user, dto.signedToken, dto.tripId, dto);
  }

  @Post('verify-paper')
  @RequirePermission('crew.board')
  @ApiOperation({ summary: 'Board everyone on a printed branch ticket from its barcode' })
  async boardFromPaper(@Req() req, @Body() dto: BoardFromPaperDto) {
    return this.ticketsService.boardFromPaper(req.user, dto.code, dto.tripId, dto);
  }

  @Post(':ticketNumber/board')
  @RequirePermission('crew.board')
  @ApiOperation({ summary: 'Mark a passenger boarded from the manifest when scanning is not possible' })
  async boardManually(@Req() req, @Param('ticketNumber') ticketNumber: string, @Body() dto: BoardManuallyDto) {
    return this.ticketsService.boardManually(req.user, ticketNumber, dto.tripId, dto);
  }
}

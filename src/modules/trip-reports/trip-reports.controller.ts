import { Body, Controller, Get, Param, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CrewReportUpdateDto, OfficeReportUpdateDto, ReportsQuery } from './trip-reports.dto';
import { MAX_REPORT_FILES, MAX_REPORT_VIDEO_BYTES, TripReportsService, UploadedReportFile } from './trip-reports.service';

const toDownload = (file: { data: Uint8Array; mimeType: string; size: number; fileName: string }) =>
  new StreamableFile(Buffer.from(file.data), {
    type: file.mimeType,
    length: file.size,
    // Always a download, so a crafted file can never run inside the API's origin.
    disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  });

@ApiTags('Crew reports')
@Controller('crew')
@ApiBearerAuth()
export class CrewReportsController {
  constructor(private reports: TripReportsService) {}

  @Get('trips/:tripId/reports')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Reports filed on an assigned trip, with their state' })
  list(@Req() req, @Param('tripId') tripId: string) {
    return this.reports.listForTrip(req.user, tripId);
  }

  @Get('reports/attachments/:id')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Fetch a photo or video from a report on an assigned trip' })
  async attachment(@Req() req, @Param('id') id: string) {
    return toDownload(await this.reports.attachmentForCrew(req.user, id));
  }

  @Get('reports/:id')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'A report with its timeline and attachments' })
  details(@Req() req, @Param('id') id: string) {
    return this.reports.detailsForCrew(req.user, id);
  }

  @Post('reports/:id/updates')
  @RequirePermission('crew.trips')
  @ApiOperation({ summary: 'Crew adds a note to a report' })
  addUpdate(@Req() req, @Param('id') id: string, @Body() dto: CrewReportUpdateDto) {
    return this.reports.addCrewUpdate(req.user, id, dto);
  }

  // Sent after the report itself, so a video that fails on a weak signal cannot hold back the report.
  @Post('reports/:id/attachments')
  @RequirePermission('crew.trips')
  // Each request holds its files in memory, so a burst of them is refused before they are read.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('files', MAX_REPORT_FILES, { limits: { fileSize: MAX_REPORT_VIDEO_BYTES } }))
  @ApiOperation({ summary: 'Attach photos or videos to a report' })
  addAttachments(@Req() req, @Param('id') id: string, @UploadedFiles() files: UploadedReportFile[]) {
    return this.reports.addAttachments(req.user, id, files);
  }
}

@ApiTags('Trip reports')
@Controller('trip-reports')
@ApiBearerAuth()
export class OfficeReportsController {
  constructor(private reports: TripReportsService) {}

  @Get()
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'Every report from trip crews, what still needs someone first' })
  list(@Query() query: ReportsQuery) {
    return this.reports.list(query);
  }

  @Get('counts')
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'How many reports wait, for the menu badge' })
  counts() {
    return this.reports.openCount();
  }

  // Before ':id', so the path is not read as a report id.
  @Get('sos/active')
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'Open SOS calls, split by acknowledged or not, for the dashboard alarm' })
  activeSos() {
    return this.reports.activeSos();
  }

  @Get('attachments/:id')
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'Download a photo or video from a report' })
  async attachment(@Param('id') id: string) {
    return toDownload(await this.reports.attachmentForOffice(id));
  }

  @Get(':id')
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'A report with the reporter, the trip, its crew, position and latest updates' })
  details(@Param('id') id: string) {
    return this.reports.detailsForOffice(id);
  }

  @Post(':id/updates')
  @RequirePermission('reports.manage')
  @ApiOperation({ summary: 'Change the state of a report or reply to the crew' })
  addUpdate(@Req() req, @Param('id') id: string, @Body() dto: OfficeReportUpdateDto) {
    return this.reports.addOfficeUpdate(req.user, id, dto);
  }

  // Anyone who watches the reports may say an SOS was received; changing its state still needs reports.manage.
  @Post(':id/acknowledge')
  @RequirePermission('reports.view')
  @ApiOperation({ summary: 'Acknowledge receiving a report (an SOS): stops the alarm and the escalation, and tells the crew who took it' })
  acknowledge(@Req() req, @Param('id') id: string) {
    return this.reports.acknowledge(req.user, id);
  }
}

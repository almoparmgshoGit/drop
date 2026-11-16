import { Body, Controller, Get, Module, Param, Patch, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import {
  AssignComplaintDto,
  ComplaintMessageDto,
  ComplaintPriorityDto,
  CreateCustomerComplaintDto,
  ListCustomerComplaintsQuery,
  ListHotelComplaintsQuery,
  ResolveCustomerComplaintDto,
} from './complaints.dto';
import { ComplaintsService, MAX_COMPLAINT_FILES, MAX_COMPLAINT_IMAGE_BYTES, UploadedComplaintFile } from './complaints.service';

const imageUpload = () => UseInterceptors(FilesInterceptor('files', MAX_COMPLAINT_FILES, { limits: { fileSize: MAX_COMPLAINT_IMAGE_BYTES } }));

const toImage = (file: { data: Uint8Array; mimeType: string; size: number; fileName: string }) =>
  new StreamableFile(Buffer.from(file.data), {
    type: file.mimeType,
    length: file.size,
    // Shown inline as an image; the type was decided from the bytes, so it can only ever be a picture.
    disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  });

/**
 * Customer complaints work as support tickets: one waits in «جديدة» until an employee takes it or a supervisor assigns it,
 * then the customer and the employee write back and forth (with images) until it is closed. The customer side is open
 * to any signed-in user and only ever reaches their own complaints and bookings.
 */
@ApiTags('Complaints')
@Controller('complaints')
@ApiBearerAuth()
class ComplaintsController {
  constructor(private complaints: ComplaintsService) {}

  @Get('mine')
  @ApiOperation({ summary: 'My complaints, and the bookings a trip or supervisor complaint can name' })
  mine(@Req() req) {
    return this.complaints.mine(req.user.userId);
  }

  @Get('mine/attachments/:id')
  @ApiOperation({ summary: 'An image from one of my complaints' })
  async myAttachment(@Req() req, @Param('id') id: string) {
    return toImage(await this.complaints.customerAttachment(req.user.userId, id));
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'One of my complaints with its conversation; opening it marks the replies read' })
  myThread(@Req() req, @Param('id') id: string) {
    return this.complaints.customerThread(req.user.userId, id);
  }

  @Post('mine/:id/messages')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @imageUpload()
  @ApiOperation({ summary: 'Customer writes on their complaint (text and/or images); a closed one opens again' })
  myReply(@Req() req, @Param('id') id: string, @Body() dto: ComplaintMessageDto, @UploadedFiles() files: UploadedComplaintFile[]) {
    return this.complaints.customerReply(req.user.userId, id, dto.body, files);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @imageUpload()
  @ApiOperation({ summary: 'Customer complains about the app, a trip, a supervisor, a bus or anything else, optionally with images' })
  create(@Req() req, @Body() dto: CreateCustomerComplaintDto, @UploadedFiles() files: UploadedComplaintFile[]) {
    return this.complaints.create(req.user.userId, dto, files);
  }

  @Get()
  @RequirePermission('complaints.view')
  @ApiOperation({ summary: 'Support tickets by view (new, mine, all, closed) with each view\'s count' })
  list(@Req() req, @Query() query: ListCustomerComplaintsQuery) {
    return this.complaints.list(req.user, query);
  }

  /**
   * Whoever handles complaints sees the hotels' ones too, as do hotel staff. Replies and reopening stay on the hotel's own
   * endpoints, open to either, which also tell the traveler.
   */
  @Get('hotels')
  @RequirePermission('complaints.view', 'hotels.view')
  @ApiOperation({ summary: 'Every hotel\'s complaints in one list, open ones first' })
  hotels(@Query() query: ListHotelComplaintsQuery) {
    return this.complaints.listHotelComplaints(query);
  }

  @Get('staff')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Employees who can take tickets, with how many open ones each holds' })
  staff() {
    return this.complaints.supportStaff();
  }

  @Get('attachments/:id')
  @RequirePermission('complaints.view')
  @ApiOperation({ summary: 'An image from a ticket' })
  async attachment(@Req() req, @Param('id') id: string) {
    return toImage(await this.complaints.staffAttachment(req.user, id));
  }

  @Get(':id')
  @RequirePermission('complaints.view')
  @ApiOperation({ summary: 'A ticket with its whole thread: messages, internal notes, events and images' })
  detail(@Req() req, @Param('id') id: string) {
    return this.complaints.detail(req.user, id);
  }

  @Post(':id/claim')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Take a new ticket; 409 when a colleague took it first' })
  claim(@Req() req, @Param('id') id: string) {
    return this.complaints.claim(req.user, id);
  }

  @Post(':id/assign')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Hand the ticket to a colleague, or back to new with a null assignee' })
  assign(@Req() req, @Param('id') id: string, @Body() dto: AssignComplaintDto) {
    return this.complaints.assign(req.user, id, dto.assigneeId ?? null);
  }

  @Patch(':id/priority')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Change a ticket\'s priority' })
  priority(@Req() req, @Param('id') id: string, @Body() dto: ComplaintPriorityDto) {
    return this.complaints.setPriority(req.user, id, dto.priority);
  }

  @Post(':id/messages')
  @RequirePermission('complaints.manage')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @imageUpload()
  @ApiOperation({ summary: 'Reply to the customer, or add an internal note, with optional images' })
  message(@Req() req, @Param('id') id: string, @Body() dto: ComplaintMessageDto, @UploadedFiles() files: UploadedComplaintFile[]) {
    return this.complaints.addStaffMessage(req.user, id, dto.body, dto.internal === true, files);
  }

  @Post(':id/resolve')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Answer a complaint and close it; the customer is told' })
  resolve(@Req() req, @Param('id') id: string, @Body() dto: ResolveCustomerComplaintDto) {
    return this.complaints.resolve(req.user, id, dto.resolution);
  }

  @Post(':id/reopen')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Open a closed complaint again' })
  reopen(@Req() req, @Param('id') id: string) {
    return this.complaints.reopen(req.user, id);
  }
}

@Module({
  controllers: [ComplaintsController],
  providers: [ComplaintsService],
})
export class ComplaintsModule {}

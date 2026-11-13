import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { TicketCompensationService } from '../../common/services/ticket-compensation.service';
import { BookingsAdminService } from './bookings-admin.service';
import {
  AddNoteDto,
  AdminBookingsQuery,
  BoardingOverrideDto,
  ChangeBoardingPointDto,
  ChangeSeatDto,
  CompensateTicketDto,
  QuickSearchQuery,
  UpdatePassengerDto,
} from './bookings.dto';

@ApiTags('Bookings')
@Controller('bookings/admin')
@ApiBearerAuth()
export class BookingsAdminController {
  constructor(
    private admin: BookingsAdminService,
    private compensation: TicketCompensationService,
  ) {}

  @Get(':id/compensation')
  @RequirePermission('bookings.compensate')
  @ApiOperation({ summary: 'Whether a stopped ticket can be compensated, and for how much' })
  async compensationQuote(@Req() req, @Param('id') id: string) {
    await this.admin.assertVisible(req.user, id);
    return this.compensation.quote(id);
  }

  @Post(':id/compensation')
  @RequirePermission('bookings.compensate')
  @ApiOperation({ summary: 'Credit the wallet for a stopped ticket, once per booking' })
  async compensate(@Req() req, @Param('id') id: string, @Body() dto: CompensateTicketDto) {
    await this.admin.assertVisible(req.user, id);
    return this.compensation.compensate(req.user, id, dto, req.ip);
  }

  @Get('all')
  @RequirePermission('bookings.view')
  @ApiOperation({ summary: 'List and filter all bookings' })
  async list(@Req() req, @Query() query: AdminBookingsQuery) {
    return this.admin.list(req.user, query, req.ip);
  }

  @Get('search')
  @RequirePermission('bookings.view')
  @ApiOperation({ summary: 'Quick passenger search across bookings' })
  async search(@Req() req, @Query() query: QuickSearchQuery) {
    return this.admin.quickSearch(req.user, query.q, req.ip, query.fields);
  }

  @Get('search/export')
  @RequirePermission('bookings.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="quick-search.csv"')
  @ApiOperation({ summary: 'Export the quick search results as CSV (audited)' })
  async exportSearch(@Req() req, @Query() query: QuickSearchQuery) {
    return this.admin.exportQuickSearch(req.user, query.q, req.ip, query.fields);
  }

  @Get('export')
  @RequirePermission('bookings.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="bookings.csv"')
  @ApiOperation({ summary: 'Export filtered bookings as CSV (Admin only, audited)' })
  async exportCsv(@Req() req, @Query() query: AdminBookingsQuery) {
    return this.admin.exportCsv(req.user, query, req.ip);
  }

  @Get(':id')
  @RequirePermission('bookings.view')
  @ApiOperation({ summary: 'Full booking details with its history' })
  async details(@Req() req, @Param('id') id: string) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.details(id);
  }

  @Get(':id/seat-map')
  @RequirePermission('bookings.view')
  @ApiOperation({ summary: 'Seat map of the booking trip for changing a seat' })
  async seatMap(@Req() req, @Param('id') id: string) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.seatMap(id);
  }

  @Patch(':id/passengers/:passengerId')
  @RequirePermission('bookings.edit')
  @ApiOperation({ summary: 'Correct a passenger name or phone' })
  async updatePassenger(@Req() req, @Param('id') id: string, @Param('passengerId') passengerId: string, @Body() dto: UpdatePassengerDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.updatePassenger(req.user.userId, id, passengerId, dto, req.ip);
  }

  @Post(':id/passengers/:passengerId/seat')
  @RequirePermission('bookings.edit')
  @ApiOperation({ summary: 'Move a passenger to a free seat and reissue the ticket' })
  async changeSeat(@Req() req, @Param('id') id: string, @Param('passengerId') passengerId: string, @Body() dto: ChangeSeatDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.changeSeat(req.user.userId, id, passengerId, dto, req.ip);
  }

  @Post(':id/boarding-point')
  @RequirePermission('bookings.edit')
  @ApiOperation({ summary: 'Change the boarding point of a booking' })
  async changeBoardingPoint(@Req() req, @Param('id') id: string, @Body() dto: ChangeBoardingPointDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.changeBoardingPoint(req.user.userId, id, dto, req.ip);
  }

  @Post(':id/passengers/:passengerId/board')
  @RequirePermission('bookings.edit')
  @ApiOperation({ summary: 'Mark a passenger boarded from the panel' })
  async board(@Req() req, @Param('id') id: string, @Param('passengerId') passengerId: string, @Body() dto: BoardingOverrideDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.board(req.user.userId, id, passengerId, dto, req.ip);
  }

  @Post(':id/passengers/:passengerId/unboard')
  @RequirePermission('bookings.unboard')
  @ApiOperation({ summary: 'Undo a boarding record (Admin only)' })
  async unboard(@Req() req, @Param('id') id: string, @Param('passengerId') passengerId: string, @Body() dto: BoardingOverrideDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.unboard(req.user.userId, id, passengerId, dto, req.ip);
  }

  @Post(':id/notes')
  @RequirePermission('bookings.edit')
  @ApiOperation({ summary: 'Add an internal note to the booking history' })
  async addNote(@Req() req, @Param('id') id: string, @Body() dto: AddNoteDto) {
    await this.admin.assertVisible(req.user, id);
    return this.admin.addNote(req.user.userId, id, dto.text, req.ip);
  }
}

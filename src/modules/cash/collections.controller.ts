import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CollectionsQuery, CollectPaymentDto, FollowUpNoteDto } from './collections.dto';
import { CollectionsService } from './collections.service';

@ApiTags('Collections')
@Controller('collections')
@ApiBearerAuth()
export class CollectionsController {
  constructor(private collections: CollectionsService) {}

  @Get()
  @RequirePermission('collections.view')
  @ApiOperation({ summary: 'Bookings with money still owed, with collection figures for the period' })
  list(@Req() req, @Query() query: CollectionsQuery) {
    return this.collections.list(req.user, query);
  }

  @Post('bookings/:id')
  @RequirePermission('collections.collect')
  @ApiOperation({ summary: 'Record a payment against a booking; cash also enters the branch drawer' })
  collect(@Req() req, @Param('id') id: string, @Body() dto: CollectPaymentDto) {
    return this.collections.collect(req.user, id, dto);
  }

  @Patch('bookings/:id/note')
  @RequirePermission('collections.collect')
  @ApiOperation({ summary: 'Update the follow-up note shown beside an unpaid booking' })
  updateNote(@Req() req, @Param('id') id: string, @Body() dto: FollowUpNoteDto) {
    return this.collections.updateFollowUpNote(req.user, id, dto.note);
  }
}

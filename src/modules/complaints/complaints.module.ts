import { Body, Controller, Get, Module, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CreateCustomerComplaintDto, ListCustomerComplaintsQuery, ResolveCustomerComplaintDto } from './complaints.dto';
import { ComplaintsService } from './complaints.service';

/** The customer side is open to any signed-in user and only ever reaches their own complaints and bookings. */
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

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Customer complains about the app, a trip, a supervisor or anything else' })
  create(@Req() req, @Body() dto: CreateCustomerComplaintDto) {
    return this.complaints.create(req.user.userId, dto);
  }

  @Get()
  @RequirePermission('complaints.view')
  @ApiOperation({ summary: 'Complaints customers sent from the app, open ones first' })
  list(@Query() query: ListCustomerComplaintsQuery) {
    return this.complaints.list(query);
  }

  @Post(':id/resolve')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Answer a complaint and close it; the customer is told' })
  resolve(@Req() req, @Param('id') id: string, @Body() dto: ResolveCustomerComplaintDto) {
    return this.complaints.resolve(req.user.userId, id, dto.resolution);
  }

  @Post(':id/reopen')
  @RequirePermission('complaints.manage')
  @ApiOperation({ summary: 'Open a closed complaint again' })
  reopen(@Param('id') id: string) {
    return this.complaints.reopen(id);
  }
}

@Module({
  controllers: [ComplaintsController],
  providers: [ComplaintsService],
})
export class ComplaintsModule {}

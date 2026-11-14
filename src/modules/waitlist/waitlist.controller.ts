import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { WaitlistService } from '../../common/services/waitlist.service';

class JoinWaitlistDto {
  @IsString()
  @MaxLength(60)
  tripId: string;

  @IsInt()
  @Min(1)
  @Max(20)
  seats: number;
}

@ApiTags('Waitlist')
@Controller('waitlist')
@ApiBearerAuth()
export class WaitlistController {
  constructor(private waitlist: WaitlistService) {}

  @Post()
  @ApiOperation({ summary: 'Join the waiting list of a full trip' })
  join(@Req() req, @Body() dto: JoinWaitlistDto) {
    return this.waitlist.join(req.user.userId, dto.tripId, dto.seats);
  }

  @Get('mine')
  @ApiOperation({ summary: "The customer's waiting list entries, with their place in each queue" })
  mine(@Req() req) {
    return this.waitlist.mine(req.user.userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Leave a waiting list; seats offered to the customer pass to the next in line' })
  leave(@Req() req, @Param('id') id: string) {
    return this.waitlist.leave(req.user.userId, id);
  }

  @Get('admin/trip/:tripId')
  @RequirePermission('trips.view', 'trips.manage', 'bookings.view')
  @ApiOperation({ summary: "A trip's waiting list for staff" })
  listForTrip(@Param('tripId') tripId: string) {
    return this.waitlist.listForTrip(tripId);
  }

  @Post('admin/:id/offer')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Offer free seats to a waiting entry now' })
  offerNow(@Req() req, @Param('id') id: string) {
    return this.waitlist.offerNow(id, req.user.name ?? null);
  }

  @Delete('admin/:id')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Remove an entry from the waiting list' })
  remove(@Req() req, @Param('id') id: string) {
    return this.waitlist.remove(id, req.user.name ?? null);
  }
}

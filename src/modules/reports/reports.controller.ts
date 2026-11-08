import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';
import { AppEventDto, AppStatsQuery, ReportRangeQuery } from './reports.dto';
import { ReportsService } from './reports.service';

const DEFAULT_APP_PERIOD = 14;

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('revenue')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Sold value, refunds, routes, booking types and payment methods for bookings made in a period' })
  revenue(@Query() query: ReportRangeQuery) {
    return this.reports.revenue(query);
  }

  @Get('bookings')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Bookings made in a period, by day, status, source, category and branch' })
  bookings(@Query() query: ReportRangeQuery) {
    return this.reports.bookings(query);
  }

  @Get('sources')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Bookings and revenue by the app and each branch' })
  sources(@Query() query: ReportRangeQuery) {
    return this.reports.sources(query);
  }

  @Get('trips')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Trips departing in a period and their occupancy' })
  trips(@Query() query: ReportRangeQuery) {
    return this.reports.trips(query);
  }

  @Get('payments')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Online charges and refunds in a period' })
  payments(@Query() query: ReportRangeQuery) {
    return this.reports.payments(query);
  }

  @Get('app')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Mobile app installs, visits, the booking funnel and the most searched routes' })
  app(@Query() query: AppStatsQuery) {
    return this.reports.app(query.days ?? DEFAULT_APP_PERIOD);
  }
}

@ApiTags('Reports')
@Controller('app-events')
export class AppEventsController {
  constructor(private reports: ReportsService) {}

  @Public()
  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Records an anonymous step of the customer path. Guests use the app too, so it needs no sign-in' })
  record(@Body() dto: AppEventDto) {
    return this.reports.recordEvent(dto);
  }
}

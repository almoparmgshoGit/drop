import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';
import { AppEventDto, AppStatsQuery, ReportRangeQuery, ReportRecordsQuery, TripReportQuery } from './reports.dto';
import { ReportsService } from './reports.service';
import { TripPatternsService } from './trip-patterns.service';

const DEFAULT_APP_PERIOD = 14;

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private reports: ReportsService,
    private patterns: TripPatternsService,
  ) {}

  @Get('revenue')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Sold value, refunds, routes, booking types and payment methods for bookings made in a period' })
  revenue(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.revenue(q));
  }

  @Get('bookings')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Bookings made in a period, by day, status, source, category and branch' })
  bookings(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.bookings(q));
  }

  @Get('sources')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Bookings and revenue by the app and each branch' })
  sources(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.sources(q));
  }

  @Get('trips')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Trips departing in a period and their occupancy' })
  trips(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.trips(q));
  }

  @Get('occupancy')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Seats sold against seats offered by Riyadh weekday, by departure hour, and weekday by two-hour band' })
  occupancy(@Query() query: TripReportQuery) {
    return this.patterns.occupancyMatrix(query);
  }

  @Get('reliability')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Per route: cancellations by who cancelled, and no-shows on executed trips, worst first' })
  reliability(@Query() query: TripReportQuery) {
    return this.patterns.routeReliability(query);
  }

  @Get('payments')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Online charges and refunds in a period' })
  payments(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.payments(q));
  }

  @Get('customers')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Customers who booked in a period by city, nationality, and age group and gender' })
  customers(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.customers(q));
  }

  @Get('hotels')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'Hotel sales by week (Sunday to Saturday, split at each month edge) and by hotel' })
  hotels(@Query() query: ReportRangeQuery) {
    return this.reports.withComparison(query, (q) => this.reports.hotels(q));
  }

  @Get('filters')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'The branches and routes the report filters offer, and the VAT rate' })
  filters() {
    return this.reports.filterOptions();
  }

  @Get('records')
  @RequirePermission('analytics.view')
  @ApiOperation({ summary: 'The bookings, trips or payments behind a figure of a report, with its filters' })
  records(@Query() query: ReportRecordsQuery) {
    return this.reports.records(query);
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

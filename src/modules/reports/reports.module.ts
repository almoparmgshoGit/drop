import { Module } from '@nestjs/common';
import { AppEventsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { WeeklyReportService } from './weekly-report.service';
import { TripPatternsService } from './trip-patterns.service';
import { TripMetricsService } from '../../common/services/trip-metrics.service';

@Module({
  controllers: [ReportsController, AppEventsController],
  providers: [ReportsService, TripMetricsService, TripPatternsService, WeeklyReportService],
})
export class ReportsModule {}

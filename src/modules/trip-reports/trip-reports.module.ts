import { Module } from '@nestjs/common';
import { CrewReportsController, OfficeReportsController } from './trip-reports.controller';
import { TripReportsService } from './trip-reports.service';

@Module({
  controllers: [CrewReportsController, OfficeReportsController],
  providers: [TripReportsService],
  exports: [TripReportsService],
})
export class TripReportsModule {}

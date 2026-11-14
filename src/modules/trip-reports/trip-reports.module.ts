import { Module } from '@nestjs/common';
import { SosEscalationService } from './sos-escalation.service';
import { CrewReportsController, OfficeReportsController } from './trip-reports.controller';
import { TripReportsService } from './trip-reports.service';

@Module({
  controllers: [CrewReportsController, OfficeReportsController],
  providers: [TripReportsService, SosEscalationService],
  exports: [TripReportsService, SosEscalationService],
})
export class TripReportsModule {}

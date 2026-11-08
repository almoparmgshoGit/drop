import { Module } from '@nestjs/common';
import { AppEventsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController, AppEventsController],
  providers: [ReportsService],
})
export class ReportsModule {}

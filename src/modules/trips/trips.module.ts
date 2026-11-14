import { Module } from '@nestjs/common';
import { TripExecutionService } from './trip-execution.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { OperationsBoardService } from './operations-board.service';
import { TripMetricsService } from '../../common/services/trip-metrics.service';

@Module({
  controllers: [TripsController],
  providers: [TripsService, TripExecutionService, TripMetricsService, OperationsBoardService],
  exports: [TripsService, TripExecutionService],
})
export class TripsModule {}

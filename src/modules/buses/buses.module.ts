import { Module } from '@nestjs/common';
import { BusAccountsService } from './bus-accounts.service';
import { BusesController, BusOfficesController, DriversController } from './buses.controller';
import { BusesService } from './buses.service';
import { BusMaintenanceService } from './bus-maintenance.service';
import { DriversService } from './drivers.service';

@Module({
  controllers: [BusesController, DriversController, BusOfficesController],
  providers: [BusesService, DriversService, BusAccountsService, BusMaintenanceService],
  exports: [BusesService],
})
export class BusesModule {}

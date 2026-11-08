import { Module } from '@nestjs/common';
import { BusAccountsService } from './bus-accounts.service';
import { BusesController, BusOfficesController, DriversController } from './buses.controller';
import { BusesService } from './buses.service';
import { DriversService } from './drivers.service';

@Module({
  controllers: [BusesController, DriversController, BusOfficesController],
  providers: [BusesService, DriversService, BusAccountsService],
  exports: [BusesService],
})
export class BusesModule {}

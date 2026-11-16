import { Module } from '@nestjs/common';
import { BusAccountsService } from '../buses/bus-accounts.service';
import { TripAccountsService } from '../invoices/trip-accounts.service';
import { ClosingsController, GeneralExpensesController } from './closings.controller';
import { ClosingsService } from './closings.service';
import { GeneralExpensesService } from './general-expenses.service';

/** Closing the accounts for a trip or a period, and the register of company expenses outside the trips. */
@Module({
  controllers: [ClosingsController, GeneralExpensesController],
  // Both depend only on the shared services, so they are provided here rather than exported from their own modules.
  providers: [ClosingsService, GeneralExpensesService, TripAccountsService, BusAccountsService],
})
export class ClosingsModule {}

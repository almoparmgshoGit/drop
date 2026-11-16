import { Module } from '@nestjs/common';
import { BusAccountsService } from '../buses/bus-accounts.service';
import { CashModule } from '../cash/cash.module';
import { TripAccountsService } from '../invoices/trip-accounts.service';
import { ClosingsController, GeneralExpensesController } from './closings.controller';
import { ClosingsService } from './closings.service';
import { FixedExpensesService } from './fixed-expenses.service';
import { GeneralExpensesService } from './general-expenses.service';
import { RemittancesService } from './remittances.service';
import { FixedExpensesController, RemittancesController, SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

/**
 * Closing the accounts for a trip or a period, the register of company expenses outside the trips, and the monthly
 * settlement around them: cash remitted to the owner, rents and recurring expenses, and each branch's profit.
 */
@Module({
  imports: [CashModule],
  controllers: [ClosingsController, GeneralExpensesController, SettlementController, RemittancesController, FixedExpensesController],
  // Both depend only on the shared services, so they are provided here rather than exported from their own modules.
  providers: [ClosingsService, GeneralExpensesService, TripAccountsService, BusAccountsService, FixedExpensesService, RemittancesService, SettlementService],
})
export class ClosingsModule {}

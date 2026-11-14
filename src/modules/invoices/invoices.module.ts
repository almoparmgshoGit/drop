import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { ZatcaModule } from '../zatca/zatca.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { TripAccountsController } from './trip-accounts.controller';
import { TripAccountsService } from './trip-accounts.service';

@Module({
  imports: [CashModule, ZatcaModule],
  controllers: [InvoicesController, TripAccountsController],
  providers: [InvoicesService, TripAccountsService],
})
export class InvoicesModule {}

import { Module } from '@nestjs/common';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CrewCustodyController } from './crew-custody.controller';
import { CustodyExpensesService } from './custody-expenses.service';

@Module({
  controllers: [CashController, CollectionsController, CrewCustodyController],
  providers: [CashService, CollectionsService, CustodyExpensesService],
  exports: [CashService, CollectionsService],
})
export class CashModule {}

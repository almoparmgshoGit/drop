import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { CancellationsService } from './cancellations.service';
import { CancellationsController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [CashModule],
  controllers: [PaymentsController, CancellationsController],
  providers: [PaymentsService, CancellationsService],
})
export class PaymentsModule {}

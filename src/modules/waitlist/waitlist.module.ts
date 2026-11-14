import { Module } from '@nestjs/common';
import { WaitlistController } from './waitlist.controller';
import { WaitlistWorkerService } from './waitlist-worker.service';

@Module({
  controllers: [WaitlistController],
  providers: [WaitlistWorkerService],
})
export class WaitlistModule {}

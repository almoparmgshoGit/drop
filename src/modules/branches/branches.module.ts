import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CashModule } from '../cash/cash.module';
import { UsersModule } from '../users/users.module';
import { BranchBookingsController } from './branch-bookings.controller';
import { BranchBookingsService } from './branch-bookings.service';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [BookingsModule, CashModule, UsersModule],
  controllers: [BranchesController, BranchBookingsController],
  providers: [BranchesService, BranchBookingsService],
})
export class BranchesModule {}

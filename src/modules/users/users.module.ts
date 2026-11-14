import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { StaffAchievementsService } from './staff-achievements.service';
import { CustomerMergeService } from './customer-merge.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, StaffAchievementsService, CustomerMergeService],
  exports: [UsersService],
})
export class UsersModule {}

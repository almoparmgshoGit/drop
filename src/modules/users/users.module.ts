import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { StaffAchievementsService } from './staff-achievements.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, StaffAchievementsService],
  exports: [UsersService],
})
export class UsersModule {}

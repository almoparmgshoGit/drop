import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingsAdminController } from './bookings-admin.controller';
import { BookingsAdminService } from './bookings-admin.service';
import { RoomCardsModule } from '../room-cards/room-cards.module';

@Module({
  imports: [RoomCardsModule],
  controllers: [BookingsController, BookingsAdminController],
  providers: [BookingsService, BookingsAdminService],
  exports: [BookingsService],
})
export class BookingsModule {}

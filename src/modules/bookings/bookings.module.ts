import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingsAdminController } from './bookings-admin.controller';
import { BookingsAdminService } from './bookings-admin.service';
import { RoomCardsModule } from '../room-cards/room-cards.module';
import { TicketListService } from './ticket-list.service';

@Module({
  imports: [RoomCardsModule],
  controllers: [BookingsController, BookingsAdminController],
  providers: [BookingsService, BookingsAdminService, TicketListService],
  exports: [BookingsService],
})
export class BookingsModule {}

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './services/prisma.service';
import { RedisService } from './services/redis.service';
import { WalletService } from './services/wallet.service';
import { BookingCancellationService } from './services/booking-cancellation.service';
import { BookingEventsService } from './services/booking-events.service';
import { LoyaltyService } from './services/loyalty.service';
import { NotificationsService } from './services/notifications.service';
import { RealtimeService } from './services/realtime.service';
import { RoomAllocationService } from './services/room-allocation.service';
import { InvoiceLedgerService } from './services/invoice-ledger.service';
import { PaymentLedgerService } from './services/payment-ledger.service';
import { AppSettingsService } from './services/app-settings.service';
import { IntegrationsService } from './services/integrations.service';
import { RoutingService } from './services/routing.service';
import { WhatsAppService } from './services/whatsapp.service';
import { StationAlertsService } from './services/station-alerts.service';
import { TicketAlertsService } from './services/ticket-alerts.service';
import { TicketCompensationService } from './services/ticket-compensation.service';
import { CustomerLookupService } from './services/customer-lookup.service';
import { PushService } from './services/push.service';

const SHARED_SERVICES = [PrismaService, RealtimeService, RedisService, WalletService, BookingCancellationService, BookingEventsService, LoyaltyService, NotificationsService, RoomAllocationService, InvoiceLedgerService, PaymentLedgerService, AppSettingsService, IntegrationsService, RoutingService, WhatsAppService, StationAlertsService, TicketAlertsService, TicketCompensationService, CustomerLookupService, PushService];

@Global()
@Module({
  providers: SHARED_SERVICES,
  exports: SHARED_SERVICES,
})
export class CommonModule {}

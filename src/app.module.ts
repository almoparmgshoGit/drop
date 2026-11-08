import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { RedisService } from './common/services/redis.service';
import { RedisThrottlerStorage } from './common/services/redis-throttler.storage';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { TripsModule } from './modules/trips/trips.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { UsersModule } from './modules/users/users.module';
import { BusesModule } from './modules/buses/buses.module';
import { PackagesModule } from './modules/packages/packages.module';
import { ServicesModule } from './modules/services/services.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { OffersModule } from './modules/offers/offers.module';
import { SettingsModule } from './modules/settings/settings.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ManifestsModule } from './modules/manifests/manifests.module';
import { HotelsModule } from './modules/hotels/hotels.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { RanksModule } from './modules/ranks/ranks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CashModule } from './modules/cash/cash.module';
import { BranchesModule } from './modules/branches/branches.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TripReportsModule } from './modules/trip-reports/trip-reports.module';
import { ReportsModule } from './modules/reports/reports.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { ChatModule } from './modules/chat/chat.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SupervisorsModule } from './modules/supervisors/supervisors.module';
import { CrewRequestsModule } from './modules/crew-requests/crew-requests.module';
import { HrModule } from './modules/hr/hr.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Counted in Redis when it is configured, so running more instances does not multiply the allowance.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        skipIf: () => process.env.THROTTLE_DISABLED === 'true',
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    CommonModule,
    AuthModule,
    TripsModule,
    BookingsModule,
    TicketsModule,
    UsersModule,
    BusesModule,
    PackagesModule,
    ServicesModule,
    CouponsModule,
    OffersModule,
    SettingsModule,
    DashboardModule,
    ManifestsModule,
    HotelsModule,
    TrackingModule,
    LoyaltyModule,
    RanksModule,
    NotificationsModule,
    CashModule,
    BranchesModule,
    InvoicesModule,
    PaymentsModule,
    TripReportsModule,
    ReportsModule,
    MessagingModule,
    ChatModule,
    RealtimeModule,
    SupervisorsModule,
    CrewRequestsModule,
    HrModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}

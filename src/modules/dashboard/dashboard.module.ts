import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { PAID_PAYMENT_STATUSES } from '../../common/utils/payment.util';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AUDIT_SECTIONS, HIDDEN_AUDIT_ACTIONS, auditActionsInSection, describeAuditAction, summarizeAuditDetails } from '../../common/audit-events';
import { PrismaService } from '../../common/services/prisma.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { addDays, formatRiyadhTime, riyadhDate, startOfRiyadhDay, startOfRiyadhMonth } from '../../common/utils/time.util';

class AuditQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @IsIn(AUDIT_SECTIONS)
  section?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

const TREND_WEEKS = [4, 8, 12, 26];
const WEEK_SECONDS = 7 * 24 * 60 * 60;

class TrendQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn(TREND_WEEKS)
  weeks?: number;
}

@Injectable()
class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Weeks run Sunday to Saturday in Riyadh, the last one still in progress. Money falls in the week it arrived, so every
   * collection counts on its own day and the rest of a paid booking on the day its payment was made. Over all time this
   * adds up to the collected figure in getStats, without simulated payments.
   */
  async getTrend(weeks = 12) {
    const today = startOfRiyadhDay();
    const weekday = new Date(riyadhDate(today)).getUTCDay();
    const firstWeek = addDays(today, -weekday - (weeks - 1) * 7);
    // Timestamps are stored in UTC without a zone, so their epoch does not depend on the database session's time zone.
    const from = firstWeek.getTime() / 1000;

    const [money, bookings] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: number; amount: unknown }[]>`
        SELECT FLOOR((EXTRACT(EPOCH FROM received."at") - ${from}::double precision) / ${WEEK_SECONDS}::double precision)::int AS bucket,
               SUM(received.amount) AS amount
        FROM (
          SELECT c."createdAt" AS "at", c.amount
          FROM "BookingCollection" c
          JOIN "Booking" b ON b.id = c."bookingId"
          JOIN "Payment" p ON p."bookingId" = b.id
          WHERE b.status <> 'CANCELLED' AND p.status <> 'SIMULATED'
          UNION ALL
          SELECT p."createdAt", p.amount - COALESCE((SELECT SUM(c.amount) FROM "BookingCollection" c WHERE c."bookingId" = p."bookingId"), 0)
          FROM "Payment" p
          JOIN "Booking" b ON b.id = p."bookingId"
          WHERE b.status <> 'CANCELLED' AND p.status = 'COMPLETED'
        ) received
        WHERE EXTRACT(EPOCH FROM received."at") >= ${from}::double precision
        GROUP BY bucket`,
      this.prisma.$queryRaw<{ bucket: number; count: bigint }[]>`
        SELECT FLOOR((EXTRACT(EPOCH FROM b."createdAt") - ${from}::double precision) / ${WEEK_SECONDS}::double precision)::int AS bucket,
               COUNT(*) AS count
        FROM "Booking" b
        WHERE b.status <> 'CANCELLED' AND EXTRACT(EPOCH FROM b."createdAt") >= ${from}::double precision
        GROUP BY bucket`,
    ]);

    const revenueByWeek = new Map(money.map((row) => [row.bucket, Number(row.amount)]));
    const bookingsByWeek = new Map(bookings.map((row) => [row.bucket, Number(row.count)]));
    return {
      weeks: Array.from({ length: weeks }, (_, index) => ({
        start: riyadhDate(addDays(firstWeek, index * 7)),
        revenue: Math.round((revenueByWeek.get(index) ?? 0) * 100) / 100,
        bookings: bookingsByWeek.get(index) ?? 0,
      })),
    };
  }

  async getStats() {
    const now = new Date();
    const todayStart = startOfRiyadhDay(now);
    const tomorrow = addDays(todayStart, 1);
    const weekEnd = addDays(todayStart, 7);
    const monthStart = startOfRiyadhMonth(now);

    const upcoming = { tripStatus: 'PUBLISHED' as const, departureTime: { gt: now } };

    const [
      usersTotal,
      newThisMonth,
      upcomingTotal,
      upcomingToday,
      upcomingWeek,
      unsupervised,
      bookingStatus,
      pendingCancellations,
      payments,
      tripsToday,
      bookingsByType,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'PASSENGER' } }),
      this.prisma.user.count({ where: { role: 'PASSENGER', createdAt: { gte: monthStart } } }),
      this.prisma.trip.count({ where: upcoming }),
      this.prisma.trip.count({ where: { ...upcoming, departureTime: { gt: now, lt: tomorrow } } }),
      this.prisma.trip.count({ where: { ...upcoming, departureTime: { gt: now, lt: weekEnd } } }),
      this.prisma.trip.count({ where: { ...upcoming, supervisors: { none: {} } } }),
      this.prisma.booking.groupBy({ by: ['status'], _count: true }),
      this.prisma.booking.count({ where: { status: 'PENDING_CANCELLATION_REVIEW' } }),
      this.prisma.payment.groupBy({
        by: ['method', 'status'],
        // Until a payment is marked paid its amount is only what is owed.
        where: { status: { in: PAID_PAYMENT_STATUSES }, booking: { status: { not: 'CANCELLED' } } },
        _sum: { amount: true, walletAmount: true },
      }),
      this.prisma.trip.findMany({
        where: { tripStatus: 'PUBLISHED', departureTime: { gte: todayStart, lt: tomorrow } },
        orderBy: { departureTime: 'asc' },
        include: { supervisors: { include: { user: { select: { name: true } } } } },
      }),
      this.prisma.$queryRaw<{ bookingType: string; count: bigint }[]>`
        SELECT t."bookingType", COUNT(*) AS count
        FROM "Booking" b JOIN "Trip" t ON t.id = b."tripId"
        WHERE b.status <> 'CANCELLED'
        GROUP BY t."bookingType"`,
    ]);

    const statusCount = (status: string) => bookingStatus.find((row) => row.status === status)?._count ?? 0;
    const partial = await this.prisma.bookingCollection.groupBy({
      by: ['method'],
      where: { booking: { status: { not: 'CANCELLED' }, payment: { status: { notIn: PAID_PAYMENT_STATUSES } } } },
      _sum: { amount: true },
    });
    const collected = payments.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0) + partial.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0);
    const walletUsed = payments.reduce((sum, row) => sum + Number(row._sum.walletAmount ?? 0), 0);
    const simulated = payments
      .filter((row) => row.status === 'SIMULATED')
      .reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0);
    const byMethod = new Map<string, number>();
    for (const row of payments) {
      byMethod.set(row.method ?? 'other', (byMethod.get(row.method ?? 'other') ?? 0) + Number(row._sum.amount ?? 0));
    }

    for (const row of partial) {
      const method = row.method.toLowerCase();
      byMethod.set(method, (byMethod.get(method) ?? 0) + Number(row._sum.amount ?? 0));
    }

    const typeRows = bookingsByType.map((row) => ({ type: row.bookingType, count: Number(row.count) }));
    const typeTotal = typeRows.reduce((sum, row) => sum + row.count, 0);

    return {
      pendingCancellations,
      registeredUsers: { total: usersTotal, newThisMonth },
      upcomingTrips: { total: upcomingTotal, today: upcomingToday, thisWeek: upcomingWeek, unsupervised },
      revenue: {
        collected,
        simulated,
        walletUsed,
        byMethod: Array.from(byMethod, ([method, amount]) => ({ method, amount })),
      },
      bookings: {
        total: bookingStatus.reduce((sum, row) => sum + row._count, 0),
        confirmed: statusCount('CONFIRMED'),
        boarded: statusCount('BOARDED'),
        pending: statusCount('PENDING'),
        cancelled: statusCount('CANCELLED'),
      },
      bookingTypes: typeRows.map((row) => ({
        type: BOOKING_TYPE_LABELS[row.type] ?? row.type,
        count: row.count,
        percentage: typeTotal ? Math.round((row.count / typeTotal) * 100) : 0,
      })),
      tripsToday: tripsToday.map((trip) => ({
        id: trip.id,
        route: `${trip.origin} ← ${trip.destination}`,
        tripCode: trip.tripCode,
        supervisor: trip.supervisors[0]?.user?.name ?? 'بلا مشرف',
        seatsOccupied: trip.totalSeats - trip.availableSeats,
        totalSeats: trip.totalSeats,
        status: trip.supervisors.length === 0 ? 'needs_supervisor' : 'open',
        time: formatRiyadhTime(trip.departureTime),
      })),
    };
  }

  async getAuditLog({ limit = 100, skip = 0, section, search }: AuditQuery) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: section ? { in: auditActionsInSection(section) } : { notIn: HIDDEN_AUDIT_ACTIONS },
        ...(search ? { user: { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search } }] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { user: { select: { name: true, phone: true } } },
    });
    const targets = await this.auditTargets(rows.flatMap((row) => (row.entityId ? [row.entityId] : [])));
    return rows.map(({ details, ...row }) => ({
      ...row,
      ...describeAuditAction(row.action),
      target: row.entityId ? targets.get(row.entityId) ?? null : null,
      summary: summarizeAuditDetails(row.action, details),
    }));
  }

  /** Names the record a row acted on. Ids are unique across tables, so the entity need not be read to find which one. */
  private async auditTargets(ids: string[]) {
    const unique = [...new Set(ids)];
    const [bookings, trips, users] = await Promise.all([
      this.prisma.booking.findMany({ where: { id: { in: unique } }, select: { id: true, bookingReference: true } }),
      this.prisma.trip.findMany({ where: { id: { in: unique } }, select: { id: true, tripCode: true } }),
      this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, phone: true } }),
    ]);
    return new Map<string, string>([
      ...bookings.map((row): [string, string] => [row.id, `حجز ${row.bookingReference}`]),
      ...trips.map((row): [string, string] => [row.id, `رحلة ${row.tripCode}`]),
      ...users.map((row): [string, string] => [row.id, row.name || row.phone]),
    ]);
  }
}

@ApiTags('Dashboard')
@Controller('dashboard')
@ApiBearerAuth()
class DashboardController {
  constructor(private dashboard: DashboardService) {}

  @Get('stats')
  @RequirePermission('dashboard.view')
  @ApiOperation({ summary: 'Live operational statistics' })
  getStats() {
    return this.dashboard.getStats();
  }

  @Get('trend')
  @RequirePermission('dashboard.view')
  @ApiOperation({ summary: 'Collected revenue and new bookings for each recent week' })
  getTrend(@Query() query: TrendQuery) {
    return this.dashboard.getTrend(query.weeks);
  }

  @Get('audit-log')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Latest administrative actions, each described in words' })
  getAuditLog(@Query() query: AuditQuery) {
    return this.dashboard.getAuditLog(query);
  }

  @Get('audit-log/sections')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Sections the audit log can be filtered by' })
  getAuditSections() {
    return AUDIT_SECTIONS;
  }
}

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

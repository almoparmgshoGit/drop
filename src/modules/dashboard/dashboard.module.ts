import { Controller, Get, Injectable, Module, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { cityTripWhere } from '../../common/utils/branch-city.util';
import { BOOKING_TYPE_LABELS } from '../../common/booking-type-labels';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AUDIT_SECTIONS, HIDDEN_AUDIT_ACTIONS, auditActionsInSection, describeAuditAction, summarizeAuditDetails } from '../../common/audit-events';
import { AUDIT_RECORD_TYPES, presentAuditChanges } from '../../common/audit-snapshots';
import { PrismaService } from '../../common/services/prisma.service';
import { TripMetricsService } from '../../common/services/trip-metrics.service';
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

  /** Only writes that compared values on this kind of record. */
  @IsOptional()
  @IsIn(Object.keys(AUDIT_RECORD_TYPES))
  recordType?: string;

  /** One record's history: its id, or a booking number, trip code, coupon code or employee phone. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  record?: string;
}

const TREND_WEEKS = [4, 8, 12, 26];
const WEEK_SECONDS = 7 * 24 * 60 * 60;

class TrendQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn(TREND_WEEKS)
  weeks?: number;
}

type DashboardActor = { userId: string; permissions?: string[] };

/** What one employee's dashboard may count. `all` is true only for someone who sees every branch's bookings. */
type DashboardScope = {
  all: boolean;
  bookings: Prisma.BookingWhereInput;
  trips: Prisma.TripWhereInput;
  /** The same booking limit for raw SQL, over a booking aliased b joined to its trip aliased t. */
  sql: Prisma.Sql;
};

@Injectable()
class DashboardService {
  constructor(
    private prisma: PrismaService,
    private metrics: TripMetricsService,
  ) {}

  /**
   * The dashboard follows the bookings page's rule, read from the database on every request: someone without
   * bookings.all_branches counts only their branch's bookings and the trips of their branch's city. An employee with
   * no branch counts nothing, rather than every branch.
   */
  async scope(actor: DashboardActor): Promise<DashboardScope> {
    if (actor.permissions?.includes('bookings.all_branches')) return { all: true, bookings: {}, trips: {}, sql: Prisma.sql`TRUE` };
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true, branch: { select: { city: true } } } });
    if (!me?.branchId) return { all: false, bookings: { id: { in: [] } }, trips: { id: { in: [] } }, sql: Prisma.sql`FALSE` };
    const city = me.branch?.city?.trim();
    if (!city) {
      return {
        all: false,
        bookings: { branchId: me.branchId },
        trips: { bookings: { some: { branchId: me.branchId } } },
        sql: Prisma.sql`b."branchId" = ${me.branchId}`,
      };
    }
    const like = `%${city}%`;
    return {
      all: false,
      bookings: { AND: [{ OR: [{ branchId: me.branchId }, { trip: cityTripWhere(city) }] }] },
      trips: cityTripWhere(city),
      sql: Prisma.sql`(b."branchId" = ${me.branchId} OR t.origin ILIKE ${like} OR t.destination ILIKE ${like})`,
    };
  }

  /**
   * Weeks run Sunday to Saturday in Riyadh, the last one still in progress. Money falls in the week it arrived, so every
   * collection counts on its own day and the rest of a paid booking on the day its payment was made. Over all time this
   * adds up to the collected figure in getStats, without simulated payments.
   */
  async getTrend(actor: DashboardActor, weeks = 12) {
    const scope = await this.scope(actor);
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
          JOIN "Trip" t ON t.id = b."tripId"
          JOIN "Payment" p ON p."bookingId" = b.id
          WHERE b.status <> 'CANCELLED' AND p.status <> 'SIMULATED' AND ${scope.sql}
          UNION ALL
          SELECT p."createdAt", p.amount - COALESCE((SELECT SUM(c.amount) FROM "BookingCollection" c WHERE c."bookingId" = p."bookingId"), 0)
          FROM "Payment" p
          JOIN "Booking" b ON b.id = p."bookingId"
          JOIN "Trip" t ON t.id = b."tripId"
          WHERE b.status <> 'CANCELLED' AND p.status = 'COMPLETED' AND ${scope.sql}
        ) received
        WHERE EXTRACT(EPOCH FROM received."at") >= ${from}::double precision
        GROUP BY bucket`,
      this.prisma.$queryRaw<{ bucket: number; count: bigint }[]>`
        SELECT FLOOR((EXTRACT(EPOCH FROM b."createdAt") - ${from}::double precision) / ${WEEK_SECONDS}::double precision)::int AS bucket,
               COUNT(*) AS count
        FROM "Booking" b
        JOIN "Trip" t ON t.id = b."tripId"
        WHERE b.status <> 'CANCELLED' AND ${scope.sql} AND EXTRACT(EPOCH FROM b."createdAt") >= ${from}::double precision
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

  async getStats(actor: DashboardActor) {
    const scope = await this.scope(actor);
    const now = new Date();
    const todayStart = startOfRiyadhDay(now);
    const tomorrow = addDays(todayStart, 1);
    const weekEnd = addDays(todayStart, 7);
    const monthStart = startOfRiyadhMonth(now);

    const upcoming = { tripStatus: 'PUBLISHED' as const, departureTime: { gt: now }, AND: [scope.trips] };
    // A branch counts the customers who booked with it; every branch counts every registered customer.
    const customers: Prisma.UserWhereInput = scope.all ? { role: 'PASSENGER' } : { role: 'PASSENGER', bookings: { some: scope.bookings } };

    const [
      usersTotal,
      newThisMonth,
      upcomingTotal,
      upcomingToday,
      upcomingWeek,
      unsupervised,
      bookingStatus,
      pendingCancellations,
      revenue,
      occupancy,
      tripsToday,
      bookingsByType,
    ] = await Promise.all([
      this.prisma.user.count({ where: customers }),
      this.prisma.user.count({ where: { ...customers, createdAt: { gte: monthStart } } }),
      this.prisma.trip.count({ where: upcoming }),
      this.prisma.trip.count({ where: { ...upcoming, departureTime: { gt: now, lt: tomorrow } } }),
      this.prisma.trip.count({ where: { ...upcoming, departureTime: { gt: now, lt: weekEnd } } }),
      this.prisma.trip.count({ where: { ...upcoming, supervisors: { none: {} } } }),
      this.prisma.booking.groupBy({ by: ['status'], where: scope.bookings, _count: true }),
      this.prisma.booking.count({ where: { AND: [scope.bookings, { status: 'PENDING_CANCELLATION_REVIEW' }] } }),
      // Collected money and occupancy come from the shared metrics, the same functions the trips page and reports read.
      this.metrics.collected(scope.bookings),
      this.metrics.occupancy(scope.trips, undefined, now),
      this.prisma.trip.findMany({
        where: { tripStatus: 'PUBLISHED', departureTime: { gte: todayStart, lt: tomorrow }, AND: [scope.trips] },
        orderBy: { departureTime: 'asc' },
        include: { supervisors: { include: { user: { select: { name: true } } } } },
      }),
      // What each booking bought, stored on the booking: the trip only says what it offers.
      this.prisma.$queryRaw<{ bookingType: string; count: bigint }[]>`
        SELECT b."serviceType"::text AS "bookingType", COUNT(*) AS count
        FROM "Booking" b JOIN "Trip" t ON t.id = b."tripId"
        WHERE b.status <> 'CANCELLED' AND ${scope.sql}
        GROUP BY b."serviceType"`,
    ]);

    const statusCount = (status: string) => bookingStatus.find((row) => row.status === status)?._count ?? 0;

    const typeRows = bookingsByType.map((row) => ({ type: row.bookingType, count: Number(row.count) }));
    const typeTotal = typeRows.reduce((sum, row) => sum + row.count, 0);

    return {
      pendingCancellations,
      registeredUsers: { total: usersTotal, newThisMonth },
      upcomingTrips: { total: upcomingTotal, today: upcomingToday, thisWeek: upcomingWeek, unsupervised },
      revenue,
      occupancy,
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

  async getAuditLog({ limit = 100, skip = 0, section, search, recordType, record }: AuditQuery) {
    const recordIds = record ? await this.auditRecordIds(record.trim()) : null;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: section ? { in: auditActionsInSection(section) } : { notIn: HIDDEN_AUDIT_ACTIONS },
        ...(search ? { user: { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search } }] } } : {}),
        ...(recordType ? { recordType } : {}),
        ...(recordIds ? { OR: [{ recordId: { in: recordIds } }, { entityId: { in: recordIds } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { user: { select: { name: true, phone: true } } },
    });
    const targets = await this.auditTargets(rows.flatMap((row) => [row.entityId, row.recordId].filter((id): id is string => !!id)));
    return rows.map(({ details, changes, recordType: type, recordId, ...row }) => {
      const presented = presentAuditChanges(type, recordId, changes);
      return {
        ...row,
        ...describeAuditAction(row.action),
        target: (recordId && targets.get(recordId)) || (row.entityId && targets.get(row.entityId)) || presented?.label || null,
        summary: summarizeAuditDetails(row.action, details),
        recordType: type,
        recordId,
        changes: presented,
      };
    });
  }

  /** What a typed record reference means: the id itself, plus whatever booking, trip, coupon or person it names. */
  private async auditRecordIds(typed: string) {
    const [bookings, trips, coupons, users] = await Promise.all([
      this.prisma.booking.findMany({ where: { bookingReference: { equals: typed, mode: 'insensitive' } }, select: { id: true }, take: 5 }),
      this.prisma.trip.findMany({ where: { tripCode: { equals: typed, mode: 'insensitive' } }, select: { id: true }, take: 5 }),
      this.prisma.coupon.findMany({ where: { code: { equals: typed, mode: 'insensitive' } }, select: { id: true }, take: 5 }),
      this.prisma.user.findMany({ where: { phone: typed }, select: { id: true }, take: 5 }),
    ]);
    return [typed, ...[...bookings, ...trips, ...coupons, ...users].map((row) => row.id)];
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
  getStats(@Req() req) {
    return this.dashboard.getStats(req.user);
  }

  @Get('trend')
  @RequirePermission('dashboard.view')
  @ApiOperation({ summary: 'Collected revenue and new bookings for each recent week' })
  getTrend(@Req() req, @Query() query: TrendQuery) {
    return this.dashboard.getTrend(req.user, query.weeks);
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

  @Get('audit-log/record-types')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Kinds of records whose before and after values the audit log keeps' })
  getAuditRecordTypes() {
    return Object.entries(AUDIT_RECORD_TYPES).map(([key, label]) => ({ key, label }));
  }
}

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, TripMetricsService],
})
export class DashboardModule {}

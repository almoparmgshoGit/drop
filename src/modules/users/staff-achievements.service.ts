import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HIDDEN_AUDIT_ACTIONS, auditActionsInSection, describeAuditAction, summarizeAuditDetails } from '../../common/audit-events';
import { PrismaService } from '../../common/services/prisma.service';
import { riyadhDayRange } from '../../common/utils/time.util';

export type AchievementRange = { from?: string; to?: string };

/** What one employee got done in a period. An order is a booking group: a round trip or a package is one order however many legs it has. */
export type AchievementFigures = {
  /** Orders the employee registered at a branch. */
  ordersRegistered: number;
  /** Of those, the ones since cancelled, by anyone. */
  ordersCancelled: number;
  /** Of those, the ones that are a package. */
  packagesBooked: number;
  /** What the employee's orders still standing are worth. */
  ordersValue: number;
  /** Cancellations the employee carried out or approved, on anyone's orders. */
  cancellationsDone: number;
  customerComplaintsResolved: number;
  hotelComplaintsResolved: number;
  tripReportsResolved: number;
  /** Customer complaints, hotel complaints and crew reports the employee closed. */
  problemsSolved: number;
  /** Every recorded action of theirs in the panel, sign-ins aside. */
  actions: number;
};

const EMPTY: AchievementFigures = {
  ordersRegistered: 0,
  ordersCancelled: 0,
  packagesBooked: 0,
  ordersValue: 0,
  cancellationsDone: 0,
  customerComplaintsResolved: 0,
  hotelComplaintsResolved: 0,
  tripReportsResolved: 0,
  problemsSolved: 0,
  actions: 0,
};

/** Sign-ins and session refreshes are not work done, so they stay out of the record. */
const NOT_ACHIEVEMENTS = [...HIDDEN_AUDIT_ACTIONS, ...auditActionsInSection('الدخول والحساب')];

@Injectable()
export class StaffAchievementsService {
  constructor(private prisma: PrismaService) {}

  /** Days are Riyadh calendar days, both ends included. Without either end the period is open on that side. */
  private period({ from, to }: AchievementRange) {
    const start = from ? riyadhDayRange(from)?.start : undefined;
    const end = to ? riyadhDayRange(to)?.end : undefined;
    if ((from && !start) || (to && !end)) throw new BadRequestException('صيغة التاريخ غير صحيحة');
    if (start && end && start >= end) throw new BadRequestException('بداية الفترة بعد نهايتها');
    return { start: start ?? new Date(0), end: end ?? new Date(8.64e15) };
  }

  async figures(range: AchievementRange, userIds?: string[]): Promise<Map<string, AchievementFigures>> {
    const { start, end } = this.period(range);
    const onlyUsers = (column: Prisma.Sql) => (userIds ? Prisma.sql`AND ${column} IN (${Prisma.join(userIds.length ? userIds : [''])})` : Prisma.empty);
    const span = { gte: start, lt: end };
    const forUsers = userIds ? { in: userIds } : { not: null };

    const [orders, cancellations, complaints, hotelComplaints, reports, actions] = await Promise.all([
      this.prisma.$queryRaw<{ userId: string; orders: bigint; cancelled: bigint; packages: bigint; value: Prisma.Decimal | null }[]>`
        SELECT "createdById" AS "userId",
          COUNT(DISTINCT COALESCE("groupReference", "id")) AS "orders",
          COUNT(DISTINCT CASE WHEN "status" = 'CANCELLED' THEN COALESCE("groupReference", "id") END) AS "cancelled",
          COUNT(DISTINCT CASE WHEN "kind"::text LIKE 'PACKAGE%' THEN COALESCE("groupReference", "id") END) AS "packages",
          SUM(CASE WHEN "status" <> 'CANCELLED' THEN "totalPrice" ELSE 0 END) AS "value"
        FROM "Booking"
        WHERE "createdById" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end} ${onlyUsers(Prisma.sql`"createdById"`)}
        GROUP BY "createdById"`,
      this.prisma.$queryRaw<{ userId: string; count: bigint }[]>`
        SELECT "cancelReviewedById" AS "userId", COUNT(DISTINCT COALESCE("groupReference", "id")) AS "count"
        FROM "Booking"
        WHERE "status" = 'CANCELLED' AND "cancelReviewedById" IS NOT NULL AND "cancelReviewedAt" >= ${start} AND "cancelReviewedAt" < ${end}
          ${onlyUsers(Prisma.sql`"cancelReviewedById"`)}
        GROUP BY "cancelReviewedById"`,
      this.prisma.customerComplaint.groupBy({ by: ['resolvedById'], where: { status: 'RESOLVED', resolvedById: forUsers, resolvedAt: span }, _count: { _all: true } }),
      this.prisma.hotelComplaint.groupBy({ by: ['resolvedById'], where: { status: 'RESOLVED', resolvedById: forUsers, resolvedAt: span }, _count: { _all: true } }),
      // A report closed twice after being reopened still counts once for whoever closed it.
      this.prisma.$queryRaw<{ userId: string; count: bigint }[]>`
        SELECT "actorId" AS "userId", COUNT(DISTINCT "reportId") AS "count"
        FROM "TripReportUpdate"
        WHERE "status" = 'RESOLVED' AND "createdAt" >= ${start} AND "createdAt" < ${end} ${onlyUsers(Prisma.sql`"actorId"`)}
        GROUP BY "actorId"`,
      this.prisma.auditLog.groupBy({ by: ['userId'], where: { userId: forUsers, action: { notIn: NOT_ACHIEVEMENTS }, createdAt: span }, _count: { _all: true } }),
    ]);

    const result = new Map<string, AchievementFigures>();
    const entry = (userId: string | null) => {
      if (!userId) return { ...EMPTY };
      if (!result.has(userId)) result.set(userId, { ...EMPTY });
      return result.get(userId)!;
    };
    for (const row of orders) {
      const figures = entry(row.userId);
      figures.ordersRegistered = Number(row.orders);
      figures.ordersCancelled = Number(row.cancelled);
      figures.packagesBooked = Number(row.packages);
      figures.ordersValue = Number(row.value ?? 0);
    }
    for (const row of cancellations) entry(row.userId).cancellationsDone = Number(row.count);
    for (const row of complaints) entry(row.resolvedById).customerComplaintsResolved = row._count._all;
    for (const row of hotelComplaints) entry(row.resolvedById).hotelComplaintsResolved = row._count._all;
    for (const row of reports) entry(row.userId).tripReportsResolved = Number(row.count);
    for (const row of actions) entry(row.userId).actions = row._count._all;
    for (const figures of result.values()) {
      figures.problemsSolved = figures.customerComplaintsResolved + figures.hotelComplaintsResolved + figures.tripReportsResolved;
    }
    return result;
  }

  /** Every employee beside what they got done, the most productive first. */
  async leaderboard(range: AchievementRange, search?: string) {
    const staff = await this.prisma.user.findMany({
      where: {
        role: { not: 'PASSENGER' },
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search } }] } : {}),
      },
      select: { id: true, name: true, phone: true, blockedAt: true, branch: { select: { name: true } }, rank: { select: { name: true, job: { select: { name: true } } } } },
    });
    const figures = await this.figures(range, staff.map((user) => user.id));
    const rows = staff.map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      isBlocked: !!user.blockedAt,
      branchName: user.branch?.name ?? null,
      rankName: user.rank?.name ?? null,
      jobName: user.rank?.job?.name ?? null,
      ...(figures.get(user.id) ?? EMPTY),
    }));
    rows.sort((a, b) => b.ordersRegistered - a.ordersRegistered || b.problemsSolved - a.problemsSolved || b.actions - a.actions || (a.name ?? '').localeCompare(b.name ?? '', 'ar'));
    const totals = rows.reduce(
      (sum, row) => Object.fromEntries(Object.keys(EMPTY).map((key) => [key, sum[key as keyof AchievementFigures] + row[key as keyof AchievementFigures]])) as AchievementFigures,
      { ...EMPTY },
    );
    return { items: rows, totals };
  }

  /** One employee's figures and the record of each thing they did, newest first. */
  async forEmployee(userId: string, range: AchievementRange & { skip?: number; limit?: number }) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, role: { not: 'PASSENGER' } },
      select: { id: true, name: true, phone: true, branch: { select: { name: true } }, rank: { select: { name: true, job: { select: { name: true } } } } },
    });
    if (!user) throw new NotFoundException('الموظف غير موجود');
    const { start, end } = this.period(range);
    const where = { userId, action: { notIn: NOT_ACHIEVEMENTS }, createdAt: { gte: start, lt: end } };
    const [figures, rows, total] = await Promise.all([
      this.figures(range, [userId]),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: range.skip ?? 0, take: range.limit ?? 50 }),
      this.prisma.auditLog.count({ where }),
    ]);
    const targets = await this.targets(rows.flatMap((row) => (row.entityId ? [row.entityId] : [])));
    return {
      user: { id: user.id, name: user.name, phone: user.phone, branchName: user.branch?.name ?? null, rankName: user.rank?.name ?? null, jobName: user.rank?.job?.name ?? null },
      figures: figures.get(userId) ?? { ...EMPTY },
      log: {
        total,
        items: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          ...describeAuditAction(row.action),
          target: row.entityId ? targets.get(row.entityId) ?? null : null,
          summary: summarizeAuditDetails(row.action, row.details),
        })),
      },
    };
  }

  /** Names the record a row acted on. Ids are unique across tables, so the entity need not be read to find which one. */
  private async targets(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
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

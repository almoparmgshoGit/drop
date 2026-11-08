import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { PrismaService } from '../../common/services/prisma.service';
import { Day, daysBetween, fromDbDate, halalas, maxDay, Month, monthEnd, monthOf, monthsFrom, toDbDate, today, Wage, wageOf } from './hr.util';

export type Db = Prisma.TransactionClient | PrismaService;

export interface HrActor {
  userId: string;
  role: string;
  name?: string | null;
  permissions: string[];
}

const RIYADH_OFFSET_MS = 3 * 3_600_000;

/** The start of a calendar day in Riyadh, as an instant. */
export const riyadhInstant = (day: Day) => new Date(toDbDate(day).getTime() - RIYADH_OFFSET_MS);

export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

@Injectable()
export class HrCoreService {
  constructor(
    private prisma: PrismaService,
    private settings: AppSettingsService,
  ) {}

  get db() {
    return this.prisma;
  }

  numbers = this.settings.numbers.bind(this.settings);

  // ---------------------------------------------------------------- who may see whom

  can = (actor: HrActor, ...permissions: string[]) => permissions.some((permission) => actor.permissions.includes(permission));

  /**
   * Without hr.all_branches an employee handles only the staff of their own branch; someone with no branch
   * then handles nobody, rather than everybody.
   */
  async scopeWhere(actor: HrActor): Promise<Prisma.UserWhereInput> {
    if (this.can(actor, 'hr.all_branches')) return {};
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    return { branchId: me?.branchId ?? '__none__' };
  }

  /** A staff account in the caller's reach, with its employment record when there is one. */
  async employee(actor: HrActor, userId: string, db: Db = this.prisma) {
    const user = await db.user.findFirst({
      where: { id: userId, role: { not: 'PASSENGER' }, ...(await this.scopeWhere(actor)) },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        gender: true,
        birthDate: true,
        idType: true,
        idNumber: true,
        idIssueDate: true,
        idExpiryDate: true,
        driverProfile: { select: { licenseExpiry: true, isActive: true } },
        nationality: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
        rank: { select: { name: true, tripAllowance: true, job: { select: { name: true, tripRole: true } } } },
        employeeProfile: true,
      },
    });
    if (!user) throw new NotFoundException('الموظف غير موجود أو خارج فرعك');
    return user;
  }

  /** The same, with the employment record required and still running. */
  async activeEmployee(actor: HrActor, userId: string, db: Db = this.prisma) {
    const user = await this.employee(actor, userId, db);
    if (!user.employeeProfile) throw new ConflictException(`لم يُنشأ الملف الوظيفي لـ ${user.name ?? user.phone} بعد`);
    if (user.employeeProfile.status === 'TERMINATED') throw new ConflictException('انتهت خدمة هذا الموظف');
    return { ...user, employeeProfile: user.employeeProfile };
  }

  /** The person themself, for the self-service screens. */
  async self(userId: string, db: Db = this.prisma) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, role: true, gender: true, nationality: true, branchId: true, rank: { select: { name: true } }, employeeProfile: true },
    });
    if (!user || user.role === 'PASSENGER') throw new ForbiddenException('هذه الخدمة للموظفين فقط');
    return user;
  }

  assertNotSelf(actor: HrActor, userId: string, action: string) {
    if (actor.userId === userId) throw new ForbiddenException(`لا يمكنك ${action} لنفسك، يتولاه موظف آخر`);
  }

  // ---------------------------------------------------------------- salaries

  /** Every salary row in force at some point of [from, to], with the days it covers. */
  async wageSegments(userId: string, from: Day, to: Day, db: Db = this.prisma): Promise<{ from: Day; to: Day; wage: Wage }[]> {
    const rows = await db.salaryStructure.findMany({ where: { userId, effectiveFrom: { lte: toDbDate(to) } }, orderBy: { effectiveFrom: 'asc' } });
    const segments: { from: Day; to: Day; wage: Wage }[] = [];
    rows.forEach((row, index) => {
      const start = maxDay(fromDbDate(row.effectiveFrom), from);
      const next = rows[index + 1];
      const end = next ? fromDbDate(new Date(next.effectiveFrom.getTime() - 86_400_000)) : to;
      if (start <= end && end >= from) segments.push({ from: start, to: end < to ? end : to, wage: wageOf(row) });
    });
    return segments;
  }

  async wageOn(userId: string, day: Day, db: Db = this.prisma): Promise<Wage | null> {
    const row = await db.salaryStructure.findFirst({ where: { userId, effectiveFrom: { lte: toDbDate(day) } }, orderBy: { effectiveFrom: 'desc' } });
    return row && wageOf(row);
  }

  // ---------------------------------------------------------------- annual leave

  /**
   * Earned day by day: the yearly entitlement divided over 365 days, rising after five years of service.
   * Nothing is stored, so the balance can always be explained from the hire date, adjustments and leaves taken.
   */
  async annualBalance(userId: string, asOf: Day = today(), db: Db = this.prisma) {
    const profile = await db.employeeProfile.findUnique({ where: { userId }, select: { hireDate: true, terminationDate: true } });
    if (!profile) return null;
    const { annualLeaveDays, annualLeaveDaysAfterFiveYears } = await this.settings.numbers('annualLeaveDays', 'annualLeaveDaysAfterFiveYears');
    const hire = fromDbDate(profile.hireDate);
    const end = profile.terminationDate && fromDbDate(profile.terminationDate) < asOf ? fromDbDate(profile.terminationDate) : asOf;
    const service = end < hire ? 0 : daysBetween(hire, end);
    const firstYears = Math.min(service, 5 * 365);
    const earned = (firstYears * annualLeaveDays) / 365 + (Math.max(service - 5 * 365, 0) * annualLeaveDaysAfterFiveYears) / 365;

    const annual = { type: { kind: 'ANNUAL' as const } };
    const [adjusted, taken, pending] = await Promise.all([
      db.leaveAdjustment.aggregate({ where: { userId, ...annual }, _sum: { days: true } }),
      db.leaveRequest.aggregate({ where: { userId, status: 'APPROVED', ...annual }, _sum: { days: true } }),
      db.leaveRequest.aggregate({ where: { userId, status: 'PENDING', ...annual }, _sum: { days: true } }),
    ]);
    const round = (value: number) => Math.round(value * 100) / 100;
    const adjustments = Number(adjusted._sum.days ?? 0);
    const used = taken._sum.days ?? 0;
    const waiting = pending._sum.days ?? 0;
    return {
      earned: round(earned),
      adjustments: round(adjustments),
      taken: used,
      pending: waiting,
      balance: round(earned + adjustments - used),
      available: round(earned + adjustments - used - waiting),
      entitlement: service >= 5 * 365 ? annualLeaveDaysAfterFiveYears : annualLeaveDays,
    };
  }

  // ---------------------------------------------------------------- payroll months

  /** A month whose payroll is approved is closed: nothing that changes its pay may be recorded in it any more. */
  async assertMonthsOpen(months: Month[], db: Db = this.prisma) {
    if (months.length === 0) return;
    const closed = await db.payrollRun.findFirst({ where: { month: { in: months }, status: { not: 'DRAFT' } }, select: { month: true } });
    if (closed) throw new ConflictException(`رواتب شهر ${closed.month} معتمدة، ولا يمكن تسجيل ما يغيّرها`);
  }

  async assertRangeOpen(from: Day, to: Day, db: Db = this.prisma) {
    await this.assertMonthsOpen(monthsFrom(monthOf(from), monthOf(to)), db);
  }

  /** A draft payroll worked out before this change has to be worked out again before anyone approves it. */
  async markStale(months: Month[], db: Db = this.prisma) {
    if (months.length === 0) return;
    await db.payrollRun.updateMany({ where: { month: { in: [...new Set(months)] }, status: 'DRAFT' }, data: { stale: true } });
  }

  async markStaleFrom(month: Month, db: Db = this.prisma) {
    await db.payrollRun.updateMany({ where: { month: { gte: month }, status: 'DRAFT' }, data: { stale: true } });
  }

  async markRangeStale(from: Day, to: Day, db: Db = this.prisma) {
    await this.markStale(monthsFrom(monthOf(from), monthOf(to)), db);
  }

  // ---------------------------------------------------------------- trips

  /** Trips the person crews that run during these days, so leave and crewing never quietly overlap. */
  async crewTripsBetween(userId: string, from: Day, to: Day, db: Db = this.prisma) {
    return db.trip.findMany({
      where: {
        tripStatus: { in: ['DRAFT', 'PUBLISHED'] },
        departureTime: { lt: riyadhInstant(addDay(to)) },
        arrivalTime: { gt: riyadhInstant(from) },
        OR: [{ drivers: { some: { userId } } }, { supervisors: { some: { userId } } }],
      },
      select: { id: true, tripCode: true, departureTime: true, origin: true, destination: true },
      orderBy: { departureTime: 'asc' },
    });
  }

  /** Locks one employee's HR records for the rest of the transaction, so two requests cannot both pass a balance check. */
  async lockEmployee(tx: Prisma.TransactionClient, userId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr:${userId}`}))`;
  }

  async lockPayroll(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hr:payroll'))`;
  }

  money = (value: Prisma.Decimal | number | null | undefined) => halalas(value);

  assertPositive(value: number, message: string) {
    if (!(value > 0)) throw new BadRequestException(message);
  }

  monthEnd = monthEnd;
}

const addDay = (day: Day) => fromDbDate(new Date(toDbDate(day).getTime() + 86_400_000));

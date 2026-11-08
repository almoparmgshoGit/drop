import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { permissionsOf } from '../../common/permissions';
import { halalas, netBookingFigures } from '../../common/utils/payment.util';
import { addDays, riyadhDate, riyadhMonth, riyadhMonthRange, startOfRiyadhDay } from '../../common/utils/time.util';
import { CashActor, CashService } from '../cash/cash.service';
import { SaveBranchDto, UpdateBranchDto } from '../cash/cash.dto';
import { UsersService } from '../users/users.service';
import { CreateBranchEmployeeDto, UpdateAccessDto } from './branches.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const sar = (value: number) => Math.round(value) / 100;

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  branchId: true,
  extraPermissions: true,
  revokedPermissions: true,
  createdAt: true,
  rank: { select: { id: true, name: true, permissions: true, job: { select: { id: true, name: true } } } },
} satisfies Prisma.UserSelect;

type EmployeeRow = Prisma.UserGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

const toEmployee = (employee: EmployeeRow, managerId: string | null) => ({
  ...employee,
  isManager: employee.id === managerId,
  permissionCount: permissionsOf(employee).length,
});

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
    private users: UsersService,
    private notifications: NotificationsService,
  ) {}

  private seesEveryBranch = (actor: CashActor) => actor.permissions.includes('branches.all') || actor.permissions.includes('branches.manage');

  private async ownBranchId(actor: CashActor) {
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    return me?.branchId ?? null;
  }

  private async assertVisible(actor: CashActor, branchId: string) {
    if (this.seesEveryBranch(actor)) return;
    if ((await this.ownBranchId(actor)) !== branchId) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
  }

  /** Company-wide employee managers can staff any branch; a branch manager only their own. */
  private async assertCanStaff(actor: CashActor, branchId: string) {
    if (actor.permissions.includes('branches.manage') || actor.permissions.includes('employees.manage')) return;
    if (!actor.permissions.includes('branches.staff') || (await this.ownBranchId(actor)) !== branchId) {
      throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    }
  }

  /** The headline figures of several branches at once, a fixed number of queries however many branches there are. */
  private async figures(branchIds: string[]) {
    const today = startOfRiyadhDay();
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const month = riyadhMonthRange(riyadhMonth(new Date()));
    const live = { branchId: { in: branchIds }, status: { not: 'CANCELLED' as const } };

    const [todaySales, monthSales, todayCollections, owing, sessions, openCustodies] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['branchId'], where: { ...live, createdAt: { gte: today, lt: tomorrow } }, _count: true, _sum: { totalPrice: true } }),
      this.prisma.booking.groupBy({ by: ['branchId'], where: { ...live, createdAt: month }, _count: true, _sum: { totalPrice: true } }),
      this.prisma.bookingCollection.groupBy({ by: ['branchId', 'method'], where: { branchId: { in: branchIds }, createdAt: { gte: today, lt: tomorrow } }, _sum: { amount: true } }),
      this.prisma.booking.findMany({
        where: { ...live, payment: { status: 'PENDING' } },
        select: {
          branchId: true,
          status: true,
          refundAmount: true,
          externalRefunded: true,
          payment: { select: { amount: true, walletAmount: true, status: true } },
          collections: { select: { amount: true } },
          cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } },
        },
      }),
      // The latest drawer of each branch, read through the (branchId, openedAt) index.
      this.prisma.$queryRaw<{ branchId: string; status: string; businessDate: Date; openedByName: string | null }[]>`
        SELECT DISTINCT ON ("branchId") "branchId", "status"::text AS "status", "businessDate", "openedByName" FROM "CashSession"
        WHERE "branchId" IN (${Prisma.join(branchIds)}) ORDER BY "branchId", "openedAt" DESC`,
      this.prisma.custody.groupBy({ by: ['branchId'], where: { branchId: { in: branchIds }, status: 'OPEN' }, _count: true, _sum: { amount: true } }),
    ]);

    return new Map(
      branchIds.map((branchId) => {
        const todayRow = todaySales.find((row) => row.branchId === branchId);
        const monthRow = monthSales.find((row) => row.branchId === branchId);
        const collected = (method: string) => Number(todayCollections.find((row) => row.branchId === branchId && row.method === method)?._sum.amount ?? 0);
        const remainders = owing.filter((booking) => booking.branchId === branchId).map((booking) => netBookingFigures(booking).remaining);
        const session = sessions.find((row) => row.branchId === branchId);
        const custodies = openCustodies.find((row) => row.branchId === branchId);
        return [
          branchId,
          {
            today: {
              bookings: todayRow?._count ?? 0,
              sales: Number(todayRow?._sum.totalPrice ?? 0),
              cash: collected('CASH'),
              network: collected('NETWORK'),
              transfer: collected('TRANSFER'),
            },
            month: { bookings: monthRow?._count ?? 0, sales: Number(monthRow?._sum.totalPrice ?? 0) },
            remaining: sar(remainders.reduce((sum, value) => sum + value, 0)),
            unpaidBookings: remainders.filter((value) => value > 0).length,
            drawer: session ? { isOpen: session.status === 'OPEN', businessDate: session.businessDate, openedByName: session.openedByName } : null,
            openCustodies: { count: custodies?._count ?? 0, amount: Number(custodies?._sum.amount ?? 0) },
          },
        ] as const;
      }),
    );
  }

  async list(actor: CashActor) {
    const own = this.seesEveryBranch(actor) ? null : await this.ownBranchId(actor);
    if (!this.seesEveryBranch(actor) && !own) return [];
    const branches = await this.prisma.branch.findMany({
      where: own ? { id: own } : {},
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { manager: { select: { id: true, name: true } }, _count: { select: { users: true } } },
    });
    if (branches.length === 0) return [];
    const figures = await this.figures(branches.map((branch) => branch.id));
    return branches.map(({ _count, ...branch }) => ({ ...branch, employeeCount: _count.users, figures: figures.get(branch.id) }));
  }

  async detail(actor: CashActor, id: string) {
    await this.assertVisible(actor, id);
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        manager: { select: { id: true, name: true, phone: true } },
        users: { select: EMPLOYEE_SELECT, orderBy: { name: 'asc' } },
      },
    });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    const { users, ...profile } = branch;
    return {
      ...profile,
      figures: (await this.figures([id])).get(id),
      employees: users.map((employee) => toEmployee(employee, branch.managerId)),
    };
  }

  /** What this branch sold lately, by day, employee and route. A booking is counted as the rows it created, as in the branch figures. */
  async performance(actor: CashActor, id: string, days: number) {
    await this.assertVisible(actor, id);
    const since = addDays(startOfRiyadhDay(), -(days - 1));
    const [bookings, collections] = await Promise.all([
      this.prisma.booking.findMany({
        where: { branchId: id, status: { not: 'CANCELLED' }, createdAt: { gte: since } },
        select: {
          createdAt: true,
          totalPrice: true,
          createdByName: true,
          trip: { select: { origin: true, destination: true } },
          _count: { select: { passengers: true } },
        },
      }),
      this.prisma.bookingCollection.groupBy({ by: ['method'], where: { branchId: id, createdAt: { gte: since } }, _sum: { amount: true } }),
    ]);

    const buckets = new Map<string, number>();
    for (let index = 0; index < days; index += 1) buckets.set(riyadhDate(addDays(since, index)), 0);
    const group = () => new Map<string, { bookings: number; passengers: number; sales: number }>();
    const employees = group();
    const routes = group();
    const add = (map: ReturnType<typeof group>, key: string, passengers: number, sales: number) => {
      const row = map.get(key) ?? { bookings: 0, passengers: 0, sales: 0 };
      map.set(key, { bookings: row.bookings + 1, passengers: row.passengers + passengers, sales: row.sales + sales });
    };
    let sales = 0;
    let passengers = 0;
    for (const booking of bookings) {
      const amount = halalas(booking.totalPrice);
      const count = booking._count.passengers;
      sales += amount;
      passengers += count;
      const day = riyadhDate(booking.createdAt);
      buckets.set(day, (buckets.get(day) ?? 0) + amount);
      add(employees, booking.createdByName ?? 'غير محدد', count, amount);
      add(routes, `${booking.trip.origin} ← ${booking.trip.destination}`, count, amount);
    }
    const ranked = <K extends string>(map: ReturnType<typeof group>, key: K) =>
      [...map]
        .map(([label, row]) => ({ [key]: label, bookings: row.bookings, passengers: row.passengers, sales: sar(row.sales) }) as { [P in K]: string } & { bookings: number; passengers: number; sales: number })
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 10);
    const collected = (method: string) => Number(collections.find((row) => row.method === method)?._sum.amount ?? 0);

    return {
      days,
      bookings: bookings.length,
      passengers,
      sales: sar(sales),
      collected: { cash: collected('CASH'), network: collected('NETWORK'), transfer: collected('TRANSFER') },
      series: [...buckets].map(([key, value]) => ({ key, value: sar(value) })),
      employees: ranked(employees, 'name'),
      routes: ranked(routes, 'label'),
    };
  }

  create(dto: SaveBranchDto) {
    return this.cash.createBranch(dto);
  }

  update(id: string, dto: UpdateBranchDto) {
    return this.cash.updateBranch(id, dto);
  }

  /** Staff who can join this branch. Someone working in another branch is only offered to company-wide managers, who can move them. */
  async candidates(actor: CashActor, branchId: string, search?: string) {
    await this.assertCanStaff(actor, branchId);
    const companyWide = actor.permissions.includes('branches.manage') || actor.permissions.includes('employees.manage');
    const term = search?.trim();
    const phone = term && /^0\d+$/.test(term) ? term.slice(1) : term;
    const staff = await this.prisma.user.findMany({
      where: {
        role: { in: ['STAFF', 'DRIVER'] },
        OR: companyWide ? [{ branchId: null }, { branchId: { not: branchId } }] : [{ branchId: null }],
        ...(term && { AND: [{ OR: [{ name: { contains: term, mode: 'insensitive' as const } }, { phone: { contains: phone } }, { email: { contains: term, mode: 'insensitive' as const } }] }] }),
      },
      select: { ...EMPLOYEE_SELECT, branch: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: 50,
    });
    // A manager is not offered anyone they could not manage anyway.
    return staff
      .filter((employee) => permissionsOf(employee).every((permission) => actor.permissions.includes(permission)))
      .map(({ branch, ...employee }) => ({ id: employee.id, name: employee.name, phone: employee.phone, rank: employee.rank?.name ?? null, job: employee.rank?.job.name ?? null, branchName: branch?.name ?? null }));
  }

  private async managedTarget(actor: CashActor, userId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: EMPLOYEE_SELECT });
    if (!target || target.role === 'PASSENGER') throw new NotFoundException('الموظف غير موجود');
    if (!permissionsOf(target).every((permission) => actor.permissions.includes(permission))) {
      throw new ForbiddenException('لا يمكنك إدارة موظف تتجاوز صلاحياته صلاحياتك');
    }
    return target;
  }

  async assign(actor: CashActor, branchId: string, userId: string) {
    await this.assertCanStaff(actor, branchId);
    const target = await this.managedTarget(actor, userId);
    if (target.branchId === branchId) throw new ConflictException('هذا الموظف في الفرع بالفعل');
    const companyWide = actor.permissions.includes('branches.manage') || actor.permissions.includes('employees.manage');
    if (target.branchId && !companyWide) throw new ForbiddenException('هذا الموظف يعمل في فرع آخر، يطلب نقله من الإدارة');
    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: branchId } });
      if (!branch?.isActive) throw new BadRequestException('الفرع غير موجود أو موقوف');
      // Whoever managed their previous branch stops doing so when they move.
      await tx.branch.updateMany({ where: { managerId: userId }, data: { managerId: null } });
      await tx.user.update({ where: { id: userId }, data: { branchId } });
      await this.notifications.toUser(tx, 'BRANCH_ASSIGNED', userId, { branchName: branch.name });
      return { success: true };
    });
  }

  async removeEmployee(actor: CashActor, branchId: string, userId: string) {
    await this.assertCanStaff(actor, branchId);
    if (userId === actor.userId) throw new BadRequestException('لا يمكنك إخراج نفسك من الفرع');
    const target = await this.managedTarget(actor, userId);
    if (target.branchId !== branchId) throw new NotFoundException('هذا الموظف ليس في هذا الفرع');
    return this.prisma.$transaction(async (tx) => {
      await tx.branch.updateMany({ where: { managerId: userId }, data: { managerId: null } });
      await tx.user.update({ where: { id: userId }, data: { branchId: null } });
      return { success: true };
    });
  }

  async setManager(actor: CashActor, branchId: string, userId: string | null) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    if (userId) {
      if (!branch.isActive) throw new ConflictException('هذا الفرع موقوف');
      await this.managedTarget(actor, userId);
    }
    return this.prisma.$transaction(async (tx) => {
      if (userId) {
        // One person, one branch: appointing them moves them here, and their old branch loses its manager.
        await tx.branch.updateMany({ where: { managerId: userId, id: { not: branchId } }, data: { managerId: null } });
        await tx.user.update({ where: { id: userId }, data: { branchId } });
        if (userId !== actor.userId) await this.notifications.toUser(tx, 'BRANCH_ASSIGNED', userId, { branchName: branch.name });
      }
      return tx.branch.update({ where: { id: branchId }, data: { managerId: userId } });
    });
  }

  async createEmployee(actor: CashActor, branchId: string, dto: CreateBranchEmployeeDto) {
    await this.assertCanStaff(actor, branchId);
    return this.users.createStaffUser(actor, { ...dto, branchId });
  }

  async updateAccess(actor: CashActor, branchId: string, userId: string, dto: UpdateAccessDto) {
    await this.assertCanStaff(actor, branchId);
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { branchId: true } });
    if (target?.branchId !== branchId) throw new NotFoundException('هذا الموظف ليس في هذا الفرع');
    return this.users.updateAccess(actor, userId, dto);
  }
}

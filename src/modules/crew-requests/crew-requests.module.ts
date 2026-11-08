import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CrewReleaseStatus, Prisma, StaffPenaltyType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { AdjustmentsService } from '../hr/adjustments.service';
import { HrModule } from '../hr/hr.module';
import { TripsModule } from '../trips/trips.module';
import { TripsService } from '../trips/trips.service';

const ROLE_LABELS: Record<string, string> = { SUPERVISOR: 'مشرف', DRIVER: 'سائق' };
export const PENALTY_LABELS: Record<StaffPenaltyType, string> = { NOTICE: 'تنبيه', WARNING: 'إنذار', DEDUCTION: 'خصم من الراتب', SANCTION: 'جزاء' };
const LIST_LIMIT = 200;
const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

type Actor = { userId: string; name?: string | null; permissions: string[] };

class ReleaseRequestDto {
  @trimmed() @IsString() @Length(10, 500, { message: 'اكتب سبب طلب التخلي بوضوح (10 أحرف على الأقل)' }) reason: string;
}

class PenaltyDto {
  @IsEnum(StaffPenaltyType, { message: 'نوع الجزاء غير معروف' }) type: StaffPenaltyType;
  /** Only for a salary deduction, in riyals. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100000) amount?: number;
  @trimmed() @IsString() @Length(3, 500, { message: 'اكتب سبب الجزاء' }) reason: string;
}

class DecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  /** Reaches the crew member with the decision. Required when refusing. */
  @IsOptional() @trimmed() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @ValidateNested() @Type(() => PenaltyDto) penalty?: PenaltyDto;
}

class CreatePenaltyDto extends PenaltyDto {
  @IsString() @MaxLength(64) userId: string;
  @IsOptional() @IsString() @MaxLength(64) tripId?: string;
}

class RequestsQuery {
  @IsOptional() @IsEnum(CrewReleaseStatus) status?: CrewReleaseStatus;
}

class PenaltiesQuery {
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(60) search?: string;
}

const PENALTY_SELECT = { id: true, number: true, type: true, amount: true, reason: true, createdAt: true, issuedBy: { select: { name: true } } } as const;

const penaltyOut = <T extends { amount: Prisma.Decimal | null; type: StaffPenaltyType }>(penalty: T) => ({
  ...penalty,
  amount: penalty.amount === null ? null : Number(penalty.amount),
  typeLabel: PENALTY_LABELS[penalty.type],
});

/** What the employee reads: the kind, the amount when there is one, and why. */
const penaltyDetails = (penalty: { type: StaffPenaltyType; amount?: number | null; reason: string }) =>
  `${PENALTY_LABELS[penalty.type]}${penalty.type === 'DEDUCTION' && penalty.amount ? ` بمبلغ ${penalty.amount} ر.س` : ''}. السبب: ${penalty.reason}`;

@Injectable()
export class CrewRequestsService {
  constructor(
    private prisma: PrismaService,
    private trips: TripsService,
    private notifications: NotificationsService,
    private adjustments: AdjustmentsService,
  ) {}

  // ---- The crew member, from the app ----

  /** Their latest request on this trip, so the app shows whether one is waiting and how it ended. */
  async mine(actor: Actor, tripId: string) {
    const request = await this.prisma.crewReleaseRequest.findFirst({
      where: { tripId, userId: actor.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, reason: true, reviewNote: true, createdAt: true, reviewedAt: true, penalty: { select: PENALTY_SELECT } },
    });
    return request && { ...request, penalty: request.penalty && penaltyOut(request.penalty) };
  }

  async create(actor: Actor, tripId: string, reason: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { tripStatus: true, departureTime: true, drivers: { select: { userId: true } }, supervisors: { select: { userId: true } } },
    });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const role = trip.supervisors.some((row) => row.userId === actor.userId) ? 'SUPERVISOR' : trip.drivers.some((row) => row.userId === actor.userId) ? 'DRIVER' : null;
    if (!role) throw new ForbiddenException('هذه الرحلة غير مسندة إليك');
    // Once the bus has left, leaving it is no longer a request the office can arrange around.
    if (trip.tripStatus === 'CANCELLED' || trip.tripStatus === 'COMPLETED' || trip.departureTime <= new Date()) {
      throw new ConflictException('لا يمكن طلب التخلي عن رحلة انطلقت أو انتهت. تواصل مع الإدارة مباشرة.');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.crewReleaseRequest.create({ data: { tripId, userId: actor.userId, role, reason }, select: { id: true, status: true, reason: true, createdAt: true } });
        const employee = await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
        await this.notifications.toStaff(
          tx,
          'STAFF_CREW_RELEASE_REQUEST',
          ['employees.discipline'],
          { employeeName: employee?.name ?? '—', crewRole: ROLE_LABELS[role], releaseReason: reason },
          { tripId, exceptUserId: actor.userId },
        );
        return request;
      });
    } catch (err) {
      // One open request per person and trip, kept by a unique index on pending rows.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('لديك طلب تخلٍ قائم على هذه الرحلة بانتظار الرد');
      throw err;
    }
  }

  async withdraw(actor: Actor, tripId: string) {
    const { count } = await this.prisma.crewReleaseRequest.updateMany({ where: { tripId, userId: actor.userId, status: 'PENDING' }, data: { status: 'WITHDRAWN' } });
    if (count === 0) throw new NotFoundException('لا يوجد طلب قائم لسحبه');
    return { success: true };
  }

  // ---- The office ----

  async list(query: RequestsQuery) {
    const rows = await this.prisma.crewReleaseRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: [{ createdAt: 'desc' }],
      take: LIST_LIMIT,
      select: {
        id: true,
        number: true,
        role: true,
        reason: true,
        status: true,
        reviewNote: true,
        reviewedAt: true,
        createdAt: true,
        user: { select: { id: true, name: true, phone: true } },
        reviewedBy: { select: { name: true } },
        penalty: { select: PENALTY_SELECT },
        trip: {
          select: {
            id: true,
            tripCode: true,
            origin: true,
            destination: true,
            departureTime: true,
            tripStatus: true,
            supervisors: { select: { userId: true } },
            drivers: { select: { userId: true } },
          },
        },
      },
    });
    const userIds = [...new Set(rows.map((row) => row.user.id))];
    // How often each person has asked before, and what they already carry, so the decision weighs the history.
    const [history, penalties] = await Promise.all([
      this.prisma.crewReleaseRequest.groupBy({ by: ['userId'], where: { userId: { in: userIds }, status: { in: ['APPROVED', 'REJECTED', 'PENDING'] } }, _count: { _all: true } }),
      this.prisma.staffPenalty.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } }),
    ]);
    const asked = new Map(history.map((row) => [row.userId, row._count._all]));
    const carried = new Map(penalties.map((row) => [row.userId, row._count._all]));
    return rows.map(({ trip, penalty, ...row }) => {
      const sameRole = row.role === 'SUPERVISOR' ? trip.supervisors : trip.drivers;
      const stillAssigned = sameRole.some((member) => member.userId === row.user.id);
      const { supervisors: _s, drivers: _d, ...tripInfo } = trip;
      return {
        ...row,
        roleLabel: ROLE_LABELS[row.role] ?? row.role,
        trip: tripInfo,
        stillAssigned,
        // Approving would leave the trip with nobody in this role.
        leavesRoleEmpty: stillAssigned && sameRole.length === 1,
        requestsCount: asked.get(row.user.id) ?? 0,
        penaltiesCount: carried.get(row.user.id) ?? 0,
        penalty: penalty && penaltyOut(penalty),
      };
    });
  }

  async pendingCount() {
    return { pending: await this.prisma.crewReleaseRequest.count({ where: { status: 'PENDING' } }) };
  }

  private assertPenalty(penalty?: PenaltyDto) {
    if (penalty?.type === 'DEDUCTION' && !penalty.amount) throw new BadRequestException('حدد مبلغ الخصم من الراتب');
  }

  async decide(actor: Actor, id: string, dto: DecisionDto) {
    if (dto.decision === 'REJECT' && !dto.note) throw new BadRequestException('اكتب سبب الرفض ليصل إلى الموظف');
    this.assertPenalty(dto.penalty);
    const request = await this.prisma.crewReleaseRequest.findUnique({ where: { id }, select: { id: true, tripId: true, userId: true, role: true, status: true } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (dto.penalty?.type === 'DEDUCTION' && dto.penalty.amount) await this.adjustments.assertPenaltyWithinCap(request.userId, dto.penalty.amount);

    // Claimed with the condition, so two employees deciding together cannot both act on it.
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const claimed = await this.prisma.crewReleaseRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: dto.note || null },
    });
    if (claimed.count === 0) throw new ConflictException('تم البت في هذا الطلب أو سحبه صاحبه');

    if (status === 'APPROVED') {
      try {
        await this.removeFromTrip(request, actor);
      } catch (err) {
        // The trip refused the change, so the request goes back to waiting rather than claiming a removal that did not happen.
        await this.prisma.crewReleaseRequest.update({ where: { id }, data: { status: 'PENDING', reviewedById: null, reviewedAt: null, reviewNote: null } });
        throw err;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await this.notifications.toTripCrew(tx, status === 'APPROVED' ? 'CREW_RELEASE_APPROVED' : 'CREW_RELEASE_REJECTED', request.tripId, {
        userIds: [request.userId],
        extra: { decisionNote: dto.note ?? '' },
      });
      if (dto.penalty) await this.issue(tx, actor, { ...dto.penalty, userId: request.userId, tripId: request.tripId, requestId: request.id });
    });
    return { success: true, status };
  }

  /** Through updateTrip, so the trip's own rules and the crew's "no longer assigned" notice apply. */
  private async removeFromTrip(request: { tripId: string; userId: string; role: string }, actor: Actor) {
    const trip = await this.prisma.trip.findUnique({ where: { id: request.tripId }, select: { supervisors: { select: { userId: true } }, drivers: { select: { userId: true } } } });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    const field = request.role === 'SUPERVISOR' ? 'supervisorIds' : 'driverIds';
    const current = (request.role === 'SUPERVISOR' ? trip.supervisors : trip.drivers).map((row) => row.userId);
    // Already taken off by hand: approving only records the decision.
    if (!current.includes(request.userId)) return;
    await this.trips.updateTrip(request.tripId, { [field]: current.filter((userId) => userId !== request.userId) } as { supervisorIds?: string[]; driverIds?: string[] }, actor, 'موافقة على طلب التخلي');
  }

  private async issue(
    db: Prisma.TransactionClient,
    actor: Actor,
    penalty: PenaltyDto & { userId: string; tripId?: string | null; requestId?: string },
  ) {
    const created = await db.staffPenalty.create({
      data: {
        userId: penalty.userId,
        type: penalty.type,
        amount: penalty.type === 'DEDUCTION' ? penalty.amount : null,
        reason: penalty.reason,
        tripId: penalty.tripId ?? null,
        requestId: penalty.requestId ?? null,
        issuedById: actor.userId,
      },
      select: { id: true, number: true },
    });
    // A salary deduction is taken by the payroll, so it is recorded there in the same step and cannot be forgotten.
    if (penalty.type === 'DEDUCTION' && penalty.amount) {
      await this.adjustments.fromPenalty(db, { id: created.id, userId: penalty.userId, amount: penalty.amount, reason: `جزاء رقم ${created.number}: ${penalty.reason}` }, { userId: actor.userId, name: actor.name });
    }
    await this.notifications.toUser(db, 'STAFF_PENALTY_ISSUED', penalty.userId, { penaltyType: PENALTY_LABELS[penalty.type], penaltyDetails: penaltyDetails(penalty) });
    return created;
  }

  async createPenalty(actor: Actor, dto: CreatePenaltyDto) {
    this.assertPenalty(dto);
    const employee = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { role: true } });
    if (!employee || employee.role === 'PASSENGER') throw new NotFoundException('الموظف غير موجود');
    if (dto.userId === actor.userId) throw new ForbiddenException('لا يمكنك تسجيل جزاء على نفسك');
    if (dto.tripId && !(await this.prisma.trip.findUnique({ where: { id: dto.tripId }, select: { id: true } }))) throw new NotFoundException('الرحلة غير موجودة');
    if (dto.type === 'DEDUCTION' && dto.amount) await this.adjustments.assertPenaltyWithinCap(dto.userId, dto.amount);
    return this.prisma.$transaction((tx) => this.issue(tx, actor, dto));
  }

  async penalties(query: PenaltiesQuery) {
    const search = query.search?.trim();
    const rows = await this.prisma.staffPenalty.findMany({
      where: {
        ...(query.userId && { userId: query.userId }),
        ...(search && { user: { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search } }] } }),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: { ...PENALTY_SELECT, user: { select: { id: true, name: true, phone: true } }, trip: { select: { id: true, tripCode: true } }, request: { select: { number: true } } },
    });
    return rows.map(penaltyOut);
  }

  /** Staff a penalty can be given to, for the panel's picker. */
  async employees() {
    return this.prisma.user.findMany({
      where: { role: { not: 'PASSENGER' } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true, rank: { select: { name: true } } },
    });
  }
}

@ApiTags('Crew requests')
@Controller('crew/trips/:tripId/release-request')
@ApiBearerAuth()
@RequirePermission('crew.trips')
class CrewReleaseController {
  constructor(private requests: CrewRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'My latest request to leave this trip' })
  mine(@Req() req, @Param('tripId') tripId: string) {
    return this.requests.mine(req.user, tripId);
  }

  @Post()
  @ApiOperation({ summary: 'Ask the office to take me off this trip, with a reason' })
  create(@Req() req, @Param('tripId') tripId: string, @Body() dto: ReleaseRequestDto) {
    return this.requests.create(req.user, tripId, dto.reason);
  }

  @Delete()
  @ApiOperation({ summary: 'Take back my pending request' })
  withdraw(@Req() req, @Param('tripId') tripId: string) {
    return this.requests.withdraw(req.user, tripId);
  }
}

@ApiTags('Crew requests')
@Controller('crew-requests')
@ApiBearerAuth()
@RequirePermission('employees.discipline')
class CrewRequestsController {
  constructor(private requests: CrewRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Requests from drivers and supervisors to leave trips' })
  list(@Query() query: RequestsQuery) {
    return this.requests.list(query);
  }

  @Get('counts')
  @ApiOperation({ summary: 'How many requests wait for a decision' })
  counts() {
    return this.requests.pendingCount();
  }

  @Post(':id/decision')
  @ApiOperation({ summary: 'Approve or refuse a request, optionally recording a penalty' })
  decide(@Req() req, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.requests.decide(req.user, id, dto);
  }
}

@ApiTags('Staff penalties')
@Controller('staff-penalties')
@ApiBearerAuth()
@RequirePermission('employees.discipline')
class StaffPenaltiesController {
  constructor(private requests: CrewRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Notices, warnings, deductions and sanctions recorded on employees' })
  list(@Query() query: PenaltiesQuery) {
    return this.requests.penalties(query);
  }

  @Get('employees')
  @ApiOperation({ summary: 'Employees a penalty can be recorded on' })
  employees() {
    return this.requests.employees();
  }

  @Post()
  @ApiOperation({ summary: 'Record a penalty on an employee' })
  create(@Req() req, @Body() dto: CreatePenaltyDto) {
    return this.requests.createPenalty(req.user, dto);
  }
}

@Module({
  imports: [TripsModule, HrModule],
  controllers: [CrewReleaseController, CrewRequestsController, StaffPenaltiesController],
  providers: [CrewRequestsService],
})
export class CrewRequestsModule {}

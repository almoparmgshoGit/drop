import { Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../common/services/prisma.service';
import { CashModule } from '../cash/cash.module';
import { CashService } from '../cash/cash.service';
import { TripsModule } from '../trips/trips.module';
import { CrewActor, TripsService } from '../trips/trips.service';

const LIVE_TRIP = { tripStatus: { in: ['DRAFT', 'PUBLISHED'] } } satisfies Prisma.TripWhereInput;
const ASSIGNABLE_LIMIT = 60;

const TRIP_SELECT = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  tripStatus: true,
  bus: { select: { plateNumber: true } },
} satisfies Prisma.TripSelect;

class ListSupervisorsQuery {
  @IsOptional() @IsString() @MaxLength(60) search?: string;
}

@Injectable()
class SupervisorsService {
  constructor(
    private prisma: PrismaService,
    private trips: TripsService,
  ) {}

  async list(query: ListSupervisorsQuery) {
    const search = query.search?.trim();
    const now = new Date();
    const people = await this.prisma.user.findMany({
      where: {
        rank: { job: { tripRole: 'SUPERVISOR' } },
        ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: /^0\d+$/.test(search) ? search.slice(1) : search } }] }),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        blockedAt: true,
        blockedReason: true,
        passwordHash: true,
        rank: { select: { name: true, permissions: true } },
        refreshTokens: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        tripSupervisors: {
          where: { trip: { ...LIVE_TRIP, arrivalTime: { gte: now } } },
          orderBy: { trip: { departureTime: 'asc' } },
          select: { trip: { select: TRIP_SELECT } },
        },
      },
    });
    return people.map(({ refreshTokens, tripSupervisors, passwordHash, rank, ...person }) => ({
      ...person,
      rankName: rank?.name ?? null,
      hasPassword: !!passwordHash,
      // A rank without this cannot open trips in the app, so a trip given to them would go unseen.
      canWorkTrips: !!rank?.permissions.includes('crew.trips'),
      lastLoginAt: refreshTokens[0]?.createdAt ?? null,
      trips: tripSupervisors.map((row) => row.trip),
    }));
  }

  /** Upcoming trips this person is not on, each marked when it overlaps a trip they already have. */
  async assignable(supervisorId: string) {
    const now = new Date();
    const own = await this.prisma.tripSupervisor.findMany({
      where: { userId: supervisorId, trip: { ...LIVE_TRIP, arrivalTime: { gte: now } } },
      select: { trip: { select: { id: true, tripCode: true, departureTime: true, arrivalTime: true, reverseOfTripId: true, reverseTrip: { select: { id: true } } } } },
    });
    const trips = await this.prisma.trip.findMany({
      where: { ...LIVE_TRIP, departureTime: { gte: now }, supervisors: { none: { userId: supervisorId } } },
      orderBy: { departureTime: 'asc' },
      take: ASSIGNABLE_LIMIT,
      select: { ...TRIP_SELECT, supervisors: { select: { user: { select: { name: true } } } } },
    });
    return trips.map(({ supervisors, ...trip }) => {
      const clash = own.find(({ trip: mine }) => mine.reverseOfTripId !== trip.id && mine.reverseTrip?.id !== trip.id && mine.departureTime < trip.arrivalTime && mine.arrivalTime > trip.departureTime);
      return { ...trip, currentSupervisors: supervisors.map((row) => row.user.name), clashWith: clash?.trip.tripCode ?? null };
    });
  }

  private async currentIds(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { supervisors: { select: { userId: true } } } });
    if (!trip) throw new NotFoundException('الرحلة غير موجودة');
    return trip.supervisors.map((row) => row.userId);
  }

  // Through updateTrip, so the rules of the trip form apply here too: schedule clashes, eligible ranks, the linked reverse trip,
  // the crew's notifications and the assignment history.
  async assign(actor: CrewActor, supervisorId: string, tripId: string) {
    const ids = await this.currentIds(tripId);
    if (!ids.includes(supervisorId)) await this.trips.updateTrip(tripId, { supervisorIds: [...ids, supervisorId] }, actor, 'من صفحة المشرفين');
    return { success: true };
  }

  async unassign(actor: CrewActor, supervisorId: string, tripId: string) {
    const ids = await this.currentIds(tripId);
    if (ids.includes(supervisorId)) await this.trips.updateTrip(tripId, { supervisorIds: ids.filter((id) => id !== supervisorId) }, actor, 'من صفحة المشرفين');
    return { success: true };
  }

  /**
   * Everything that happened to this supervisor's trips: each time they were put on or taken off a trip and by whom,
   * the trips they worked, and the release requests they made with how each ended.
   */
  async history(supervisorId: string) {
    const person = await this.prisma.user.findUnique({ where: { id: supervisorId }, select: { id: true } });
    if (!person) throw new NotFoundException('المشرف غير موجود');
    const now = new Date();
    const trip = { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, tripStatus: true } } as const;
    const worked = { userId: supervisorId, trip: { tripStatus: { not: 'CANCELLED' as const }, departureTime: { lt: now } } };
    const [log, past, workedCount, upcomingCount, requests, removedCount] = await Promise.all([
      this.prisma.crewAssignmentLog.findMany({ where: { userId: supervisorId, role: 'SUPERVISOR' }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, action: true, reason: true, byName: true, createdAt: true, trip } }),
      this.prisma.tripSupervisor.findMany({ where: worked, orderBy: { trip: { departureTime: 'desc' } }, take: 50, select: { trip } }),
      this.prisma.tripSupervisor.count({ where: worked }),
      this.prisma.tripSupervisor.count({ where: { userId: supervisorId, trip: { ...LIVE_TRIP, departureTime: { gte: now } } } }),
      this.prisma.crewReleaseRequest.findMany({
        where: { userId: supervisorId, role: 'SUPERVISOR' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, number: true, status: true, reason: true, reviewNote: true, reviewedAt: true, createdAt: true, reviewedBy: { select: { name: true } }, trip, penalty: { select: { type: true, amount: true } } },
      }),
      this.prisma.crewAssignmentLog.count({ where: { userId: supervisorId, role: 'SUPERVISOR', action: 'UNASSIGNED' } }),
    ]);
    return {
      summary: { worked: workedCount, upcoming: upcomingCount, removed: removedCount, releaseRequests: requests.length, releasesApproved: requests.filter((row) => row.status === 'APPROVED').length },
      log,
      pastTrips: past.map((row) => row.trip),
      releaseRequests: requests.map((row) => ({ ...row, penalty: row.penalty && { ...row.penalty, amount: row.penalty.amount && Number(row.penalty.amount) } })),
    };
  }
}

@ApiTags('Supervisors')
@Controller('supervisors')
@ApiBearerAuth()
class SupervisorsController {
  constructor(
    private supervisors: SupervisorsService,
    private cash: CashService,
  ) {}

  @Get(':id/history')
  @RequirePermission('employees.view', 'trips.manage')
  @ApiOperation({ summary: 'Assignment history, trips worked and release requests of a supervisor' })
  history(@Param('id') id: string) {
    return this.supervisors.history(id);
  }

  @Get(':id/custodies')
  @RequirePermission('cash.view', 'custody.issue', 'custody.settle')
  @ApiOperation({ summary: 'Custodies handed to this supervisor, with what is still in their hands' })
  custodies(@Req() req, @Param('id') id: string) {
    return this.cash.custodiesOf(req.user, id);
  }

  @Get()
  @RequirePermission('employees.view', 'trips.manage')
  @ApiOperation({ summary: 'Trip supervisors with their upcoming trips' })
  list(@Query() query: ListSupervisorsQuery) {
    return this.supervisors.list(query);
  }

  @Get(':id/assignable-trips')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Upcoming trips that can be given to this supervisor' })
  assignable(@Param('id') id: string) {
    return this.supervisors.assignable(id);
  }

  @Post(':id/trips/:tripId')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Add a supervisor to a trip' })
  assign(@Req() req, @Param('id') id: string, @Param('tripId') tripId: string) {
    return this.supervisors.assign(req.user, id, tripId);
  }

  @Delete(':id/trips/:tripId')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Take a supervisor off a trip' })
  unassign(@Req() req, @Param('id') id: string, @Param('tripId') tripId: string) {
    return this.supervisors.unassign(req.user, id, tripId);
  }
}

@Module({
  imports: [TripsModule, CashModule],
  controllers: [SupervisorsController],
  providers: [SupervisorsService],
})
export class SupervisorsModule {}

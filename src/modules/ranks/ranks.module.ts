import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { JobTripRole, Role } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, permissionsOf } from '../../common/permissions';

class CreateRankDto {
  @IsString()
  @Length(2, 60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsString()
  @IsNotEmpty()
  jobId: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions: string[];

  /** Paid for each trip crewed in a month; empty for none. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  tripAllowance?: number | null;
}

class UpdateRankDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  jobId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000)
  tripAllowance?: number | null;
}

class CreateJobTypeDto {
  @IsString()
  @Length(2, 60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsEnum(JobTripRole)
  tripRole?: JobTripRole;
}

class UpdateJobTypeDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsEnum(JobTripRole)
  tripRole?: JobTripRole;
}

interface RankActor {
  permissions: string[];
}

/** The account type behind a job: only drivers differ, every other job is a staff account. */
const accountRoleOf = (tripRole: JobTripRole): Role => (tripRole === 'DRIVER' ? 'DRIVER' : 'STAFF');

@Injectable()
class RanksService {
  constructor(private prisma: PrismaService) {}

  list() {
    return this.prisma.rank.findMany({
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      include: { job: { select: { id: true, name: true, tripRole: true } }, _count: { select: { users: true } } },
    });
  }

  private assertWithinOwnAccess(actor: RankActor, permissions: string[]) {
    if (!permissions.every((permission) => actor.permissions.includes(permission))) {
      throw new ForbiddenException('لا يمكنك إدارة رتبة تتجاوز صلاحياتك');
    }
  }

  private async editable(actor: RankActor, id: string) {
    const rank = await this.prisma.rank.findUnique({ where: { id } });
    if (!rank) throw new NotFoundException('الرتبة غير موجودة');
    if (rank.isSystem) throw new BadRequestException('لا يمكن تعديل أو حذف رتبة المدير العام');
    this.assertWithinOwnAccess(actor, permissionsOf({ role: rank.role, rank }));
    return rank;
  }

  private async assignableJob(jobId: string) {
    const job = await this.prisma.jobType.findUnique({ where: { id: jobId } });
    if (!job) throw new BadRequestException('الوظيفة غير موجودة');
    if (job.isSystem) throw new BadRequestException('وظيفة الإدارة العليا مخصصة لرتبة المدير العام');
    return job;
  }

  /** The allowance is pay, so setting it belongs to whoever manages employment files. */
  private assertCanSetAllowance(actor: RankActor, value: number | null | undefined, current: unknown = null) {
    if (value === undefined || Number(value ?? 0) === Number(current ?? 0)) return;
    if (!actor.permissions.includes('hr.manage')) throw new ForbiddenException('بدل الرحلة يُعدّله من يملك إدارة الملفات الوظيفية');
  }

  async create(actor: RankActor, dto: CreateRankDto) {
    this.assertWithinOwnAccess(actor, dto.permissions);
    this.assertCanSetAllowance(actor, dto.tripAllowance);
    const job = await this.assignableJob(dto.jobId);
    return this.prisma.rank.create({ data: { ...dto, name: dto.name.trim(), role: accountRoleOf(job.tripRole) } });
  }

  async update(actor: RankActor, id: string, dto: UpdateRankDto) {
    const existing = await this.editable(actor, id);
    if (dto.permissions) this.assertWithinOwnAccess(actor, dto.permissions);
    this.assertCanSetAllowance(actor, dto.tripAllowance, existing.tripAllowance);
    const job = dto.jobId ? await this.assignableJob(dto.jobId) : null;
    const role = job ? accountRoleOf(job.tripRole) : undefined;

    return this.prisma.$transaction(async (tx) => {
      // Moving a rank to another job can change the account type of everyone holding it.
      if (role) await tx.user.updateMany({ where: { rankId: id }, data: { role } });
      // A draft payroll priced trips at the old allowance.
      if (dto.tripAllowance !== undefined) await tx.payrollRun.updateMany({ where: { status: 'DRAFT' }, data: { stale: true } });
      return tx.rank.update({
        where: { id },
        data: { ...dto, ...(role && { role }), ...(dto.name !== undefined && { name: dto.name.trim() }) },
      });
    });
  }

  async remove(actor: RankActor, id: string) {
    await this.editable(actor, id);
    const users = await this.prisma.user.count({ where: { rankId: id } });
    if (users > 0) throw new ConflictException('انقل موظفي هذه الرتبة إلى رتبة أخرى قبل حذفها');
    await this.prisma.rank.delete({ where: { id } });
    return { success: true };
  }

  listJobs() {
    return this.prisma.jobType.findMany({
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { ranks: true } } },
    });
  }

  createJob(dto: CreateJobTypeDto) {
    return this.prisma.jobType.create({ data: { ...dto, name: dto.name.trim() } });
  }

  private async editableJob(id: string) {
    const job = await this.prisma.jobType.findUnique({ where: { id }, include: { _count: { select: { ranks: true } } } });
    if (!job) throw new NotFoundException('الوظيفة غير موجودة');
    if (job.isSystem) throw new BadRequestException('لا يمكن تعديل أو حذف وظيفة الإدارة العليا');
    return job;
  }

  async updateJob(id: string, dto: UpdateJobTypeDto) {
    const job = await this.editableJob(id);
    // The role decides the account type and who appears on trips, so it is settled before ranks depend on it.
    if (dto.tripRole && dto.tripRole !== job.tripRole && job._count.ranks > 0) {
      throw new ConflictException('انقل رتب هذه الوظيفة إلى وظيفة أخرى قبل تغيير دورها في الرحلات');
    }
    return this.prisma.jobType.update({
      where: { id },
      data: { ...dto, ...(dto.name !== undefined && { name: dto.name.trim() }) },
    });
  }

  async removeJob(id: string) {
    const job = await this.editableJob(id);
    if (job._count.ranks > 0) throw new ConflictException('انقل رتب هذه الوظيفة إلى وظيفة أخرى قبل حذفها');
    await this.prisma.jobType.delete({ where: { id } });
    return { success: true };
  }
}

@ApiTags('Ranks')
@Controller('ranks')
@ApiBearerAuth()
class RanksController {
  constructor(private ranks: RanksService) {}

  @Get()
  @RequirePermission('employees.view', 'employees.manage', 'branches.staff')
  @ApiOperation({ summary: 'List ranks with their permissions and employee counts' })
  list() {
    return this.ranks.list();
  }

  @Get('permissions')
  @RequirePermission('employees.view', 'branches.staff')
  @ApiOperation({ summary: 'Every permission a rank can be granted, grouped for display' })
  permissions() {
    return PERMISSION_GROUPS;
  }

  @Post()
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Create a rank' })
  create(@Req() req, @Body() dto: CreateRankDto) {
    return this.ranks.create(req.user, dto);
  }

  @Put(':id')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Update a rank; permission changes apply to its employees immediately' })
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateRankDto) {
    return this.ranks.update(req.user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Delete a rank that no employee holds' })
  remove(@Req() req, @Param('id') id: string) {
    return this.ranks.remove(req.user, id);
  }
}

@ApiTags('Job types')
@Controller('job-types')
@ApiBearerAuth()
class JobTypesController {
  constructor(private ranks: RanksService) {}

  @Get()
  @RequirePermission('employees.view')
  @ApiOperation({ summary: 'List job types with how many ranks each has' })
  list() {
    return this.ranks.listJobs();
  }

  @Post()
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Create a job type' })
  create(@Body() dto: CreateJobTypeDto) {
    return this.ranks.createJob(dto);
  }

  @Put(':id')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Update a job type' })
  update(@Param('id') id: string, @Body() dto: UpdateJobTypeDto) {
    return this.ranks.updateJob(id, dto);
  }

  @Delete(':id')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Delete a job type that no rank uses' })
  remove(@Param('id') id: string) {
    return this.ranks.removeJob(id);
  }
}

@Module({
  controllers: [RanksController, JobTypesController],
  providers: [RanksService],
})
export class RanksModule {}

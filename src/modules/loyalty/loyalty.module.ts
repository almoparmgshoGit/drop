import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, PartialType } from '@nestjs/swagger';
import { LoyaltyRuleType, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { startOfRiyadhDay } from '../../common/utils/time.util';
import { LoyaltyService } from '../../common/services/loyalty.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

class ReferralSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) referrerPoints?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) refereePoints?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxPerUser?: number;
}

class TierSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1000) silverTrips?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(10) silverMultiplier?: number;
  @IsOptional() @IsInt() @Min(2) @Max(1000) goldTrips?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(10) goldMultiplier?: number;
}

class ChallengeSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1000) trips?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) points?: number;
}

class UpdateProgramDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) pointsPerRiyal?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100000) redeemPoints?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100000) redeemValue?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000000) minRedeemPoints?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) maxRedeemPercent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(120) expiryMonths?: number;
  @IsOptional() @ValidateNested() @Type(() => ReferralSettingsDto) referral?: ReferralSettingsDto;
  @IsOptional() @ValidateNested() @Type(() => TierSettingsDto) tiers?: TierSettingsDto;
  @IsOptional() @ValidateNested() @Type(() => ChallengeSettingsDto) challenge?: ChallengeSettingsDto;
}

class CreateRuleDto {
  @trimmed() @IsString() @Length(2, 100) name: string;
  @IsEnum(LoyaltyRuleType) type: LoyaltyRuleType;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100000) value: number;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays?: number[];
  @IsOptional() @IsString() @MaxLength(60) tripId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) minDaysBefore?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) minSeats?: number | null;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateRuleDto extends PartialType(CreateRuleDto) {}

class CreateVoucherDto {
  @trimmed() @IsString() @Length(2, 100) name: string;
  @IsInt() @Min(1) @Max(1000000) pointsCost: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(100000) value: number;
  @IsOptional() @IsInt() @Min(1) @Max(730) validDays?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateVoucherDto extends PartialType(CreateVoucherDto) {}

class AdjustPointsDto {
  @IsInt() @Min(-1000000) @Max(1000000) points: number;
  @trimmed() @IsString() @Length(3, 300, { message: 'سبب التعديل إلزامي' }) reason: string;
}

class CustomersQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

@Injectable()
class LoyaltyAdminService {
  constructor(
    private prisma: PrismaService,
    private loyalty: LoyaltyService,
    private notifications: NotificationsService,
    private appSettings: AppSettingsService,
  ) {}

  private assertRuleIsSane(rule: { type?: LoyaltyRuleType; value?: number; startsAt?: string | null; endsAt?: string | null }) {
    if (rule.type === 'MULTIPLIER' && rule.value !== undefined && (rule.value <= 1 || rule.value > 10)) {
      throw new BadRequestException('معامل المضاعفة يكون أكبر من 1 وحتى 10');
    }
    if (rule.type === 'BONUS_PERCENT' && rule.value !== undefined && rule.value > 500) {
      throw new BadRequestException('النسبة الإضافية لا تتجاوز 500%');
    }
    if (rule.startsAt && rule.endsAt && new Date(rule.endsAt) <= new Date(rule.startsAt)) {
      throw new BadRequestException('تاريخ نهاية القاعدة يجب أن يكون بعد بدايتها');
    }
  }

  listRules() {
    return this.prisma.loyaltyRule.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: { trip: { select: { tripCode: true } } } });
  }

  async createRule(dto: CreateRuleDto) {
    this.assertRuleIsSane(dto);
    return this.prisma.loyaltyRule.create({
      data: {
        ...dto,
        weekdays: dto.weekdays ?? [],
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      },
    });
  }

  async updateRule(id: string, dto: UpdateRuleDto) {
    const existing = await this.prisma.loyaltyRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('القاعدة غير موجودة');
    this.assertRuleIsSane({
      type: dto.type ?? existing.type,
      value: dto.value ?? Number(existing.value),
      startsAt: dto.startsAt === undefined ? existing.startsAt?.toISOString() : dto.startsAt,
      endsAt: dto.endsAt === undefined ? existing.endsAt?.toISOString() : dto.endsAt,
    });
    return this.prisma.loyaltyRule.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt === undefined ? undefined : dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt === undefined ? undefined : dto.endsAt ? new Date(dto.endsAt) : null,
      },
    });
  }

  async removeRule(id: string) {
    const { count } = await this.prisma.loyaltyRule.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('القاعدة غير موجودة');
    return { success: true };
  }

  listVouchers() {
    return this.prisma.loyaltyVoucher.findMany({ orderBy: [{ isActive: 'desc' }, { pointsCost: 'asc' }] });
  }

  createVoucher(dto: CreateVoucherDto) {
    return this.prisma.loyaltyVoucher.create({ data: dto });
  }

  async updateVoucher(id: string, dto: UpdateVoucherDto) {
    const exists = await this.prisma.loyaltyVoucher.count({ where: { id } });
    if (exists === 0) throw new NotFoundException('القسيمة غير موجودة');
    return this.prisma.loyaltyVoucher.update({ where: { id }, data: dto });
  }

  async customers(search?: string) {
    const term = search?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        role: 'PASSENGER',
        ...(term
          ? { OR: [{ name: { contains: term, mode: 'insensitive' as const } }, { phone: { contains: term } }, { referralCode: { equals: term.toUpperCase() } }] }
          : { loyaltyPoints: { gt: 0 } }),
      },
      orderBy: { loyaltyPoints: 'desc' },
      take: 50,
      select: { id: true, name: true, phone: true, loyaltyPoints: true, loyaltyActivityAt: true, referralCode: true },
    });
    return users;
  }

  async customerLedger(userId: string) {
    const exists = await this.prisma.user.count({ where: { id: userId } });
    if (exists === 0) throw new NotFoundException('العميل غير موجود');
    return this.prisma.loyaltyTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, points: true, balanceAfter: true, description: true, createdAt: true, createdByName: true },
    });
  }

  async adjust({ userId: actorId, permissions }: { userId: string; permissions: string[] }, userId: string, dto: AdjustPointsDto) {
    if (dto.points === 0) throw new BadRequestException('أدخل عدد النقاط');
    // Points buy discounts and vouchers, so they carry the same limits as wallet credit.
    if (actorId === userId && !permissions.includes('loyalty.adjust_self')) {
      throw new ForbiddenException('لا يمكنك تعديل نقاطك بنفسك');
    }
    return this.prisma.$transaction(async (tx) => {
      if (!permissions.includes('loyalty.adjust_unlimited')) {
        // Two simultaneous requests must not both read the same total and pass together.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`loyalty-adjust:${actorId}`}))`;
        const today = await tx.loyaltyTransaction.findMany({
          where: { createdById: actorId, type: 'ADJUSTED', createdAt: { gte: startOfRiyadhDay() } },
          select: { points: true },
        });
        const used = today.reduce((sum, row) => sum + Math.abs(row.points), 0);
        const limit = await this.appSettings.number('loyaltyAdjustDailyLimit');
        if (used + Math.abs(dto.points) > limit) {
          throw new ForbiddenException(`يتجاوز هذا التعديل حدك اليومي لتعديل النقاط (${limit} نقطة، استخدمت منها ${used})`);
        }
      }
      const [target, actor] = await Promise.all([
        tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
        tx.user.findUnique({ where: { id: actorId }, select: { name: true } }),
      ]);
      if (!target) throw new NotFoundException('العميل غير موجود');
      const entry = { userId, type: 'ADJUSTED' as const, description: dto.reason };
      const row = dto.points > 0
        ? await this.loyalty.grant(tx, { ...entry, points: dto.points })
        : await this.loyalty.spend(tx, { ...entry, points: -dto.points }).catch(() => {
            throw new ConflictException('لا يمكن أن يصبح رصيد العميل أقل من صفر');
          });
      await tx.loyaltyTransaction.update({ where: { id: row.id }, data: { createdByName: actor?.name ?? null, createdById: actorId } });
      await this.notifications.toUser(tx, 'POINTS_ADJUSTED', userId, {
        pointsChange: dto.points > 0 ? `+${dto.points}` : String(dto.points),
        pointsBalance: row.balanceAfter,
      });
      return { balance: row.balanceAfter };
    });
  }

  async report() {
    const program = await this.loyalty.getProgram();
    const [byType, outstanding, members, referrals, plans] = await Promise.all([
      this.prisma.loyaltyTransaction.groupBy({ by: ['type'], _sum: { points: true }, _count: true }),
      this.prisma.user.aggregate({ _sum: { loyaltyPoints: true } }),
      this.prisma.user.count({ where: { loyaltyPoints: { gt: 0 } } }),
      this.prisma.user.count({ where: { referredById: { not: null } } }),
      this.prisma.booking.findMany({
        where: { loyaltyPlan: { not: Prisma.DbNull }, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { loyaltyPlan: true },
      }),
    ]);
    const sum = (types: string[]) => byType.filter((row) => types.includes(row.type)).reduce((total, row) => total + (row._sum.points ?? 0), 0);
    const points = outstanding._sum.loyaltyPoints ?? 0;
    const usage = new Map<string, number>();
    for (const { loyaltyPlan } of plans) {
      for (const rule of (loyaltyPlan as { rules?: string[] }).rules ?? []) usage.set(rule, (usage.get(rule) ?? 0) + 1);
    }
    return {
      outstandingPoints: points,
      // What the company owes if every point were spent at the current rate.
      outstandingValue: Math.round(((points / program.redeemPoints) * program.redeemValue) * 100) / 100,
      members,
      referrals,
      issued: sum(['EARNED', 'BONUS', 'REFERRAL']),
      redeemed: -sum(['REDEEMED', 'VOUCHER']),
      returned: sum(['REFUNDED']),
      expired: -sum(['EXPIRED']),
      adjusted: sum(['ADJUSTED']),
      ruleUsage: [...usage.entries()].map(([name, bookings]) => ({ name, bookings })).sort((a, b) => b.bookings - a.bookings),
    };
  }
}

@ApiTags('Loyalty')
@Controller('loyalty')
@ApiBearerAuth()
class LoyaltyController {
  constructor(
    private admin: LoyaltyAdminService,
    private loyalty: LoyaltyService,
  ) {}

  @Get('program')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Loyalty program settings' })
  getProgram() {
    return this.loyalty.getProgram();
  }

  @Put('program')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Update loyalty program settings' })
  saveProgram(@Body() dto: UpdateProgramDto) {
    return this.loyalty.saveProgram(dto as never);
  }

  @Get('rules')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Earning rules' })
  listRules() {
    return this.admin.listRules();
  }

  @Post('rules')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Create an earning rule' })
  createRule(@Body() dto: CreateRuleDto) {
    return this.admin.createRule(dto);
  }

  @Patch('rules/:id')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Update an earning rule' })
  updateRule(@Param('id') id: string, @Body() dto: UpdateRuleDto) {
    return this.admin.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Delete an earning rule; bookings keep the terms they were made under' })
  removeRule(@Param('id') id: string) {
    return this.admin.removeRule(id);
  }

  @Get('vouchers')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Voucher catalogue' })
  listVouchers() {
    return this.admin.listVouchers();
  }

  @Post('vouchers')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Add a voucher to the catalogue' })
  createVoucher(@Body() dto: CreateVoucherDto) {
    return this.admin.createVoucher(dto);
  }

  @Patch('vouchers/:id')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Edit a catalogue voucher' })
  updateVoucher(@Param('id') id: string, @Body() dto: UpdateVoucherDto) {
    return this.admin.updateVoucher(id, dto);
  }

  @Get('customers')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Customer point balances' })
  customers(@Query() query: CustomersQuery) {
    return this.admin.customers(query.search);
  }

  @Get('customers/:id/transactions')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'A customer point history' })
  ledger(@Param('id') id: string) {
    return this.admin.customerLedger(id);
  }

  @Post('customers/:id/adjust')
  @RequirePermission('loyalty.adjust')
  @ApiOperation({ summary: 'Add or remove points by hand, with a required reason' })
  adjust(@Req() req, @Param('id') id: string, @Body() dto: AdjustPointsDto) {
    return this.admin.adjust(req.user, id, dto);
  }

  @Get('report')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Program totals, including the outstanding liability' })
  report() {
    return this.admin.report();
  }
}

@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyAdminService],
})
export class LoyaltyModule {}

import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CouponType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';

const RIYADH_OFFSET_MS = 3 * 3_600_000;

/** A percentage above 100 would make the discount larger than the price. */
function assertValueFitsType(type: CouponType, value: number) {
  if (type === 'PERCENT' && value > 100) throw new BadRequestException('نسبة الخصم لا تتجاوز 100%');
}

class CreateCouponDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,30}$/, { message: 'رمز الكوبون يجب أن يكون أحرفًا إنجليزية وأرقامًا فقط' })
  code: string;

  @IsEnum(CouponType)
  type: CouponType;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  value: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  perUserLimit?: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateCouponDto extends PartialType(CreateCouponDto) {}

@Injectable()
class CouponsService {
  constructor(private prisma: PrismaService) {}

  getAll() {
    // Personal vouchers bought with points are not part of the marketing coupon list.
    return this.prisma.coupon.findMany({ where: { ownerUserId: null }, orderBy: { createdAt: 'desc' } });
  }

  /** Personal vouchers bought with points are excluded, as in the list. Discounts follow the date the booking was made. */
  async summary() {
    const now = new Date();
    const riyadh = new Date(now.getTime() + RIYADH_OFFSET_MS);
    const monthStart = new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), 1) - RIYADH_OFFSET_MS);
    const live = { status: { not: 'CANCELLED' }, createdAt: { gte: monthStart } } satisfies Prisma.BookingWhereInput;
    const withCoupon = { ...live, couponId: { not: null }, coupon: { ownerUserId: null } } satisfies Prisma.BookingWhereInput;
    const [coupons, used, total] = await Promise.all([
      this.prisma.coupon.findMany({ where: { ownerUserId: null, isActive: true }, select: { maxUses: true, usedCount: true, validFrom: true, validUntil: true } }),
      this.prisma.booking.aggregate({ where: withCoupon, _count: true, _sum: { discountAmount: true } }),
      this.prisma.booking.count({ where: live }),
    ]);
    const active = coupons.filter((coupon) => (!coupon.validFrom || coupon.validFrom <= now) && (!coupon.validUntil || coupon.validUntil >= now) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses));
    return {
      active: active.length,
      usesThisMonth: used._count,
      discountThisMonth: Number(used._sum.discountAmount ?? 0),
      couponShare: total ? Math.round((used._count / total) * 100) : 0,
    };
  }

  create(dto: CreateCouponDto) {
    assertValueFitsType(dto.type, dto.value);
    return this.prisma.coupon.create({
      data: {
        ...dto,
        code: dto.code.toUpperCase(),
        validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      },
    });
  }

  async update(id: string, dto: UpdateCouponDto) {
    const coupon = await this.findMarketing(id);
    // Either field may change alone, so the pair is checked as it will be saved.
    assertValueFitsType(dto.type ?? coupon.type, dto.value ?? Number(coupon.value));
    return this.prisma.coupon.update({
      where: { id },
      data: {
        ...dto,
        code: dto.code?.toUpperCase(),
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      },
    });
  }

  async remove(id: string) {
    await this.findMarketing(id);
    await this.prisma.coupon.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Only marketing coupons are managed here. A voucher a customer bought with points is theirs:
   * deleting or editing it from the panel would take away what they paid for.
   */
  private async findMarketing(id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('الكوبون غير موجود');
    if (coupon.ownerUserId) throw new BadRequestException('هذه قسيمة اشتراها عميل بنقاطه، ولا يمكن تعديلها أو حذفها');
    return coupon;
  }
}

@ApiTags('Coupons')
@Controller('coupons')
@ApiBearerAuth()
@RequirePermission('coupons.manage')
class CouponsController {
  constructor(private coupons: CouponsService) {}

  @Get()
  @ApiOperation({ summary: 'List coupons' })
  getAll() {
    return this.coupons.getAll();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Active coupons and what they gave away this month' })
  summary() {
    return this.coupons.summary();
  }

  @Post()
  @ApiOperation({ summary: 'Create coupon' })
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update coupon' })
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete coupon' })
  remove(@Param('id') id: string) {
    return this.coupons.remove(id);
  }
}

@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
})
export class CouponsModule {}

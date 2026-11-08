import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, PartialType } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Prisma, PromoAction, PromoFrequency } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';

const LABEL_MAX = 40;
const TITLE_MAX = 80;
const BODY_MAX = 300;
const CTA_MAX = 30;

class OfferWordingDto {
  @IsOptional() @IsString() @MaxLength(LABEL_MAX) label?: string;
  @IsOptional() @IsString() @MaxLength(TITLE_MAX) title?: string;
  @IsOptional() @IsString() @MaxLength(BODY_MAX) body?: string;
  @IsOptional() @IsString() @MaxLength(CTA_MAX) ctaLabel?: string;
}

class OfferTranslationsDto {
  @IsOptional() @ValidateNested() @Type(() => OfferWordingDto) en?: OfferWordingDto;
  @IsOptional() @ValidateNested() @Type(() => OfferWordingDto) ur?: OfferWordingDto;
}

class CreateOfferDto {
  @IsOptional() @IsString() @MaxLength(LABEL_MAX) label?: string;
  @IsString() @MaxLength(TITLE_MAX) title: string;
  @IsOptional() @IsString() @MaxLength(BODY_MAX) body?: string;
  @IsOptional() @IsString() @MaxLength(CTA_MAX) ctaLabel?: string;
  @IsOptional() @ValidateNested() @Type(() => OfferTranslationsDto) translations?: OfferTranslationsDto;

  /** A path from the image upload, or nothing. */
  @IsOptional() @IsString() @Matches(/^\/trips\/images\/[0-9a-f-]{36}$/, { message: 'الصورة غير صالحة' }) imageUrl?: string | null;
  @IsOptional() @IsUUID() couponId?: string | null;
  @IsEnum(PromoAction) action: PromoAction;
  @IsOptional() @IsString() @Matches(/^https:\/\/\S+$/, { message: 'الرابط يجب أن يبدأ بـ https://' }) @MaxLength(500) actionUrl?: string | null;
  @IsEnum(PromoFrequency) frequency: PromoFrequency;
  @IsOptional() @IsInt() @Min(0) @Max(100) priority?: number;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateOfferDto extends PartialType(CreateOfferDto) {}

const EVENT_FIELDS = { VIEW: 'viewCount', CLICK: 'clickCount', COPY: 'copyCount', DISMISS: 'dismissCount' } as const;

class OfferEventDto {
  @IsIn(Object.keys(EVENT_FIELDS)) type: keyof typeof EVENT_FIELDS;
}

const COUPON_FIELDS = { id: true, code: true, type: true, value: true, perUserLimit: true, validUntil: true, isActive: true, maxUses: true, usedCount: true } as const;

const trimmed = (text?: string | null) => (text?.trim() ? text.trim() : null);

/** Keeps only languages that have some wording, trimmed, so an empty tab in the panel stores nothing. */
function cleanTranslations(input?: OfferTranslationsDto | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const out: Record<string, Record<string, string>> = {};
  for (const language of ['en', 'ur'] as const) {
    const wording = input?.[language];
    if (!wording) continue;
    const kept = Object.fromEntries(Object.entries(wording).map(([key, value]) => [key, trimmed(value as string)]).filter(([, value]) => value));
    if (Object.keys(kept).length) out[language] = kept as Record<string, string>;
  }
  return Object.keys(out).length ? out : Prisma.DbNull;
}

@Injectable()
class OffersService {
  constructor(private prisma: PrismaService) {}

  getAll() {
    return this.prisma.promoOffer.findMany({ include: { coupon: { select: COUPON_FIELDS } }, orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { createdAt: 'desc' }] });
  }

  /**
   * What the app may show right now, best first. An offer tied to a coupon that no longer works is held back,
   * so nobody is handed a code that the payment screen will then refuse.
   */
  async active() {
    const now = new Date();
    const offers = await this.prisma.promoOffer.findMany({
      where: {
        isActive: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      include: { coupon: { select: COUPON_FIELDS } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    return offers
      .filter(({ coupon }) => !coupon || (coupon.isActive && (!coupon.validUntil || coupon.validUntil >= now) && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses)))
      .map((offer) => ({
        id: offer.id,
        label: offer.label,
        title: offer.title,
        body: offer.body,
        ctaLabel: offer.ctaLabel,
        translations: offer.translations,
        imageUrl: offer.imageUrl,
        action: offer.action,
        actionUrl: offer.actionUrl,
        frequency: offer.frequency,
        // The offer's own end date wins; otherwise the customer is told when the code stops working.
        validUntil: offer.endsAt ?? offer.coupon?.validUntil ?? null,
        coupon: offer.coupon && { code: offer.coupon.code, perUserLimit: offer.coupon.perUserLimit },
        updatedAt: offer.updatedAt,
      }));
  }

  /** Customers' own point vouchers are private and never offered to everyone. */
  coupons() {
    return this.prisma.coupon.findMany({ where: { ownerUserId: null }, select: COUPON_FIELDS, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
  }

  async create(dto: CreateOfferDto) {
    await this.check(dto);
    return this.prisma.promoOffer.create({ data: this.toData(dto) as Prisma.PromoOfferUncheckedCreateInput });
  }

  async update(id: string, dto: UpdateOfferDto) {
    const offer = await this.find(id);
    await this.check({ ...dto, action: dto.action ?? offer.action, actionUrl: dto.actionUrl !== undefined ? dto.actionUrl : offer.actionUrl, startsAt: dto.startsAt !== undefined ? dto.startsAt : offer.startsAt?.toISOString(), endsAt: dto.endsAt !== undefined ? dto.endsAt : offer.endsAt?.toISOString() });
    return this.prisma.promoOffer.update({ where: { id }, data: this.toData(dto) });
  }

  async remove(id: string) {
    await this.find(id);
    await this.prisma.promoOffer.delete({ where: { id } });
    return { success: true };
  }

  /** Counters only; a missing offer (deleted while the popup was open) is ignored. */
  async record(id: string, type: keyof typeof EVENT_FIELDS) {
    await this.prisma.promoOffer.updateMany({ where: { id }, data: { [EVENT_FIELDS[type]]: { increment: 1 } } });
    return { success: true };
  }

  private async find(id: string) {
    const offer = await this.prisma.promoOffer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundException('العرض غير موجود');
    return offer;
  }

  private async check(dto: Partial<CreateOfferDto>) {
    if (dto.action === 'URL' && !dto.actionUrl) throw new BadRequestException('أدخل الرابط الذي يفتحه زر العرض');
    if (dto.startsAt && dto.endsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new BadRequestException('تاريخ انتهاء العرض يجب أن يكون بعد بدايته');
    if (dto.couponId) {
      const coupon = await this.prisma.coupon.findUnique({ where: { id: dto.couponId }, select: { ownerUserId: true } });
      if (!coupon || coupon.ownerUserId) throw new BadRequestException('الكوبون المختار غير موجود');
    }
  }

  private toData(dto: Partial<CreateOfferDto>): Prisma.PromoOfferUncheckedUpdateInput {
    const date = (value?: string | null) => (value === undefined ? undefined : value ? new Date(value) : null);
    const text = (value?: string | null) => (value === undefined ? undefined : trimmed(value));
    return {
      label: text(dto.label),
      title: dto.title?.trim(),
      body: text(dto.body),
      ctaLabel: text(dto.ctaLabel),
      translations: dto.translations === undefined ? undefined : cleanTranslations(dto.translations),
      imageUrl: dto.imageUrl === undefined ? undefined : dto.imageUrl || null,
      couponId: dto.couponId === undefined ? undefined : dto.couponId || null,
      action: dto.action,
      // A link is kept only for the button that opens it.
      actionUrl: dto.action !== undefined && dto.action !== 'URL' ? null : dto.actionUrl === undefined ? undefined : dto.actionUrl || null,
      frequency: dto.frequency,
      priority: dto.priority,
      startsAt: date(dto.startsAt),
      endsAt: date(dto.endsAt),
      isActive: dto.isActive,
    };
  }
}

@ApiTags('Offers')
@Controller('offers')
@ApiBearerAuth()
class OffersController {
  constructor(private offers: OffersService) {}

  @Get('active')
  @ApiOperation({ summary: 'Offers the app may pop up now, best first' })
  active() {
    return this.offers.active();
  }

  @Post(':id/events')
  @HttpCode(200)
  @SkipAudit()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Count a view, click, code copy or dismissal of an offer' })
  record(@Param('id') id: string, @Body() dto: OfferEventDto) {
    return this.offers.record(id, dto.type);
  }

  @Get()
  @RequirePermission('offers.manage')
  @ApiOperation({ summary: 'List promo offers with their figures' })
  getAll() {
    return this.offers.getAll();
  }

  @Get('coupons')
  @RequirePermission('offers.manage')
  @ApiOperation({ summary: 'Marketing coupons an offer can hand out' })
  coupons() {
    return this.offers.coupons();
  }

  @Post()
  @RequirePermission('offers.manage')
  @ApiOperation({ summary: 'Create promo offer' })
  create(@Body() dto: CreateOfferDto) {
    return this.offers.create(dto);
  }

  @Put(':id')
  @RequirePermission('offers.manage')
  @ApiOperation({ summary: 'Update promo offer' })
  update(@Param('id') id: string, @Body() dto: UpdateOfferDto) {
    return this.offers.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('offers.manage')
  @ApiOperation({ summary: 'Delete promo offer' })
  remove(@Param('id') id: string) {
    return this.offers.remove(id);
  }
}

@Module({
  controllers: [OffersController],
  providers: [OffersService],
})
export class OffersModule {}

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags, PartialType } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import * as crypto from 'crypto';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { LoyaltyService } from '../../common/services/loyalty.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { WalletService } from '../../common/services/wallet.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
/** What the QR holds: a prefix so the app knows it is a top-up card, then the code. */
export const QR_PREFIX = 'DUROB-TOPUP:';
/** No 0/O or 1/I, so a code read off a printed card is never mistyped. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HEX = /^#[0-9a-fA-F]{6}$/;

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const DEFAULT_DESIGN = { x: 0.78, y: 0.72, size: 0.26, color: '#0F2A5C', background: '#FFFFFF', showCode: true, codeColor: '#FFFFFF' };

class VoucherDesignDto {
  /** Centre of the QR across the image, 0 (left) to 1 (right). */
  @IsNumber() @Min(0) @Max(1) x: number;
  /** Centre of the QR down the image, 0 (top) to 1 (bottom). */
  @IsNumber() @Min(0) @Max(1) y: number;
  /** Width of the QR as a share of the image's width. */
  @IsNumber() @Min(0.08) @Max(0.9) size: number;
  @IsString() @Matches(HEX) color: string;
  /** A colour behind the QR, or "transparent". */
  @IsString() @Matches(/^(#[0-9a-fA-F]{6}|transparent)$/) background: string;
  @IsOptional() @IsBoolean() showCode?: boolean;
  @IsOptional() @IsString() @Matches(HEX) codeColor?: string;
}

class CreateVoucherDto {
  @trimmed() @IsString() @Length(2, 100) name: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000000) pointsCost?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(100000) price?: number | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) value: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) bonusPoints?: number;
  @IsOptional() @IsBoolean() creditTransportOnly?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1825) validDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) stockTotal?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxPerPurchase?: number;
  @IsOptional() @IsString() @MaxLength(300) imageUrl?: string | null;
  @IsOptional() @ValidateNested() @Type(() => VoucherDesignDto) design?: VoucherDesignDto | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateVoucherDto extends PartialType(CreateVoucherDto) {}

class PurchaseVoucherDto {
  @IsInt() @Min(1) @Max(100) quantity: number;
  @IsIn(['MONEY', 'POINTS']) method: 'MONEY' | 'POINTS';
  @IsOptional() @IsIn(['mada', 'card', 'wallet']) paymentMethod?: string;
}

class RedeemCardDto {
  @IsString() @Length(4, 80) code: string;
}

class CardsQuery {
  @IsOptional() @IsIn(['AVAILABLE', 'REDEEMED', 'EXPIRED']) status?: string;
  @IsOptional() @IsString() @MaxLength(60) search?: string;
}

/** The code as people read it, in groups of four. */
const formatCode = (code: string) => code.match(/.{1,4}/g)!.join('-');
/** Accepts the code typed with or without dashes and spaces, or the whole text of a scanned QR. */
const normalizeCode = (raw: string) => raw.trim().toUpperCase().replace(QR_PREFIX, '').replace(/[^A-Z0-9]/g, '');

function newCode() {
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const cardStatus = (card: { redeemedAt: Date | null; expiresAt: Date }, now = new Date()) =>
  card.redeemedAt ? 'REDEEMED' : card.expiresAt <= now ? 'EXPIRED' : 'AVAILABLE';

type VoucherRow = Prisma.LoyaltyVoucherGetPayload<object>;

@Injectable()
export class VouchersService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private loyalty: LoyaltyService,
    private wallet: WalletService,
    private notifications: NotificationsService,
  ) {}

  private assertSellable(dto: { pointsCost?: number | null; price?: number | Prisma.Decimal | null; value?: number | Prisma.Decimal; bonusPoints?: number }) {
    if (!dto.pointsCost && !(Number(dto.price ?? 0) > 0)) throw new BadRequestException('حدد سعر القسيمة بالمال أو بالنقاط أو الاثنين');
    if (!(Number(dto.value ?? 0) > 0) && !((dto.bonusPoints ?? 0) > 0)) throw new BadRequestException('القسيمة يجب أن تضيف رصيدًا أو نقاطًا');
  }

  private toAdmin(v: VoucherRow, redeemed = 0) {
    return {
      ...v,
      price: v.price === null ? null : Number(v.price),
      value: Number(v.value),
      design: v.design ?? DEFAULT_DESIGN,
      remaining: v.stockTotal === null ? null : Math.max(0, v.stockTotal - v.soldCount),
      redeemedCount: redeemed,
    };
  }

  // ---- Staff ----

  async list() {
    const [vouchers, redeemed] = await Promise.all([
      this.prisma.loyaltyVoucher.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.voucherCard.groupBy({ by: ['voucherId'], where: { redeemedAt: { not: null } }, _count: { _all: true } }),
    ]);
    const counts = new Map(redeemed.map((row) => [row.voucherId, row._count._all]));
    return vouchers.map((v) => this.toAdmin(v, counts.get(v.id) ?? 0));
  }

  async create(dto: CreateVoucherDto) {
    this.assertSellable(dto);
    const created = await this.prisma.loyaltyVoucher.create({
      data: { ...dto, design: (dto.design ?? DEFAULT_DESIGN) as unknown as Prisma.InputJsonValue },
    });
    return this.toAdmin(created);
  }

  async update(id: string, dto: UpdateVoucherDto) {
    const existing = await this.prisma.loyaltyVoucher.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('القسيمة غير موجودة');
    this.assertSellable({
      pointsCost: dto.pointsCost === undefined ? existing.pointsCost : dto.pointsCost,
      price: dto.price === undefined ? existing.price : dto.price,
      value: dto.value ?? existing.value,
      bonusPoints: dto.bonusPoints ?? existing.bonusPoints,
    });
    if (dto.stockTotal !== undefined && dto.stockTotal !== null && dto.stockTotal < existing.soldCount) {
      throw new BadRequestException(`بيع منها ${existing.soldCount} بالفعل، فلا تكون الكمية الكلية أقل من ذلك`);
    }
    const { design, ...rest } = dto;
    const updated = await this.prisma.loyaltyVoucher.update({
      where: { id },
      data: { ...rest, ...(design !== undefined && { design: design === null ? Prisma.DbNull : (design as unknown as Prisma.InputJsonValue) }) },
    });
    return this.toAdmin(updated);
  }

  async cards(voucherId: string, query: CardsQuery) {
    const now = new Date();
    const where: Prisma.VoucherCardWhereInput = { voucherId };
    if (query.status === 'REDEEMED') where.redeemedAt = { not: null };
    if (query.status === 'AVAILABLE') Object.assign(where, { redeemedAt: null, expiresAt: { gt: now } });
    if (query.status === 'EXPIRED') Object.assign(where, { redeemedAt: null, expiresAt: { lte: now } });
    const search = query.search?.trim();
    if (search) {
      const code = normalizeCode(search);
      where.OR = [
        ...(code ? [{ code: { contains: code } }] : []),
        { purchase: { reference: { contains: search.toUpperCase() } } },
        { purchase: { buyer: { phone: { contains: search } } } },
        { purchase: { buyer: { name: { contains: search, mode: 'insensitive' as const } } } },
      ];
    }
    const rows = await this.prisma.voucherCard.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: {
        purchase: { select: { reference: true, method: true, amount: true, points: true, quantity: true, buyer: { select: { id: true, name: true, phone: true } } } },
        redeemedBy: { select: { id: true, name: true, phone: true } },
      },
    });
    return rows.map((card) => ({
      id: card.id,
      code: formatCode(card.code),
      status: cardStatus(card, now),
      value: Number(card.value),
      bonusPoints: card.bonusPoints,
      expiresAt: card.expiresAt,
      createdAt: card.createdAt,
      redeemedAt: card.redeemedAt,
      purchase: { ...card.purchase, amount: Number(card.purchase.amount) },
      redeemedBy: card.redeemedBy,
    }));
  }

  // ---- Customers ----

  async catalog() {
    const program = await this.loyalty.getProgram();
    const vouchers = await this.prisma.loyaltyVoucher.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
    return vouchers
      .map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        price: v.price === null ? null : Number(v.price),
        // Points can only be spent while the points program runs.
        pointsCost: program.enabled ? v.pointsCost : null,
        value: Number(v.value),
        bonusPoints: v.bonusPoints,
        transportOnly: v.creditTransportOnly,
        validDays: v.validDays,
        maxPerPurchase: v.maxPerPurchase,
        remaining: v.stockTotal === null ? null : Math.max(0, v.stockTotal - v.soldCount),
        imageUrl: v.imageUrl,
        design: v.design ?? DEFAULT_DESIGN,
      }))
      .filter((v) => v.price !== null || v.pointsCost !== null);
  }

  async purchase(userId: string, voucherId: string, dto: PurchaseVoucherDto) {
    const buyer = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, blockedAt: true } });
    if (!buyer || buyer.role !== 'PASSENGER') throw new ForbiddenException('شراء القسائم متاح لحسابات العملاء');
    if (buyer.blockedAt) throw new ForbiddenException('حسابك موقوف');
    const program = await this.loyalty.getProgram();

    const result = await this.prisma.$transaction(async (tx) => {
      // Locked so two buyers of the last cards cannot both get them.
      await tx.$queryRaw`SELECT id FROM "LoyaltyVoucher" WHERE id = ${voucherId} FOR UPDATE`;
      const voucher = await tx.loyaltyVoucher.findUnique({ where: { id: voucherId } });
      if (!voucher || !voucher.isActive) throw new NotFoundException('القسيمة غير متاحة');
      if (dto.quantity > voucher.maxPerPurchase) throw new BadRequestException(`أقصى كمية في الطلب الواحد ${voucher.maxPerPurchase}`);
      if (voucher.stockTotal !== null && voucher.soldCount + dto.quantity > voucher.stockTotal) {
        const left = Math.max(0, voucher.stockTotal - voucher.soldCount);
        throw new ConflictException(left > 0 ? `المتبقي من هذه القسيمة ${left} فقط` : 'نفدت كمية هذه القسيمة');
      }

      let amount = 0;
      let points = 0;
      let paymentStatus = 'COMPLETED';
      if (dto.method === 'POINTS') {
        if (!voucher.pointsCost || !program.enabled) throw new BadRequestException('هذه القسيمة لا تُشترى بالنقاط');
        points = voucher.pointsCost * dto.quantity;
        await this.loyalty.spend(tx, { userId, points, type: 'VOUCHER', description: `شراء ${dto.quantity} × قسيمة ${voucher.name}` });
      } else {
        if (voucher.price === null) throw new BadRequestException('هذه القسيمة لا تُشترى بالمال');
        // Until the gateway ships, money can only go through in explicit simulated mode, like bookings.
        if (this.config.get('PAYMENT_MODE') !== 'simulated') throw new ServiceUnavailableException('الدفع الإلكتروني غير متاح حاليًا');
        amount = Math.round(Number(voucher.price) * dto.quantity * 100) / 100;
        paymentStatus = 'SIMULATED';
      }

      await tx.loyaltyVoucher.update({ where: { id: voucher.id }, data: { soldCount: { increment: dto.quantity } } });
      const purchase = await tx.voucherPurchase.create({
        data: {
          reference: `VP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          voucherId: voucher.id,
          buyerId: userId,
          quantity: dto.quantity,
          method: dto.method,
          amount,
          points,
          paymentMethod: dto.method === 'MONEY' ? dto.paymentMethod ?? 'mada' : null,
          paymentStatus,
        },
      });
      const expiresAt = new Date(Date.now() + voucher.validDays * DAY_MS);
      await tx.voucherCard.createMany({
        data: Array.from({ length: dto.quantity }, () => ({
          code: newCode(),
          voucherId: voucher.id,
          purchaseId: purchase.id,
          buyerId: userId,
          value: voucher.value,
          bonusPoints: voucher.bonusPoints,
          transportOnly: voucher.creditTransportOnly,
          name: voucher.name,
          imageUrl: voucher.imageUrl,
          design: (voucher.design ?? DEFAULT_DESIGN) as Prisma.InputJsonValue,
          expiresAt,
        })),
      });
      return purchase;
    }, TX_OPTIONS);

    return { reference: result.reference, quantity: result.quantity, amount: Number(result.amount), points: result.points, cards: await this.mine(userId, result.id) };
  }

  /** Cards the customer bought, newest first, with their code and QR text. */
  async mine(userId: string, purchaseId?: string) {
    const now = new Date();
    const cards = await this.prisma.voucherCard.findMany({
      where: { buyerId: userId, ...(purchaseId && { purchaseId }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { purchase: { select: { reference: true } }, redeemedBy: { select: { id: true } } },
    });
    return cards.map((card) => ({
      id: card.id,
      name: card.name,
      code: formatCode(card.code),
      qr: `${QR_PREFIX}${card.code}`,
      status: cardStatus(card, now),
      value: Number(card.value),
      bonusPoints: card.bonusPoints,
      transportOnly: card.transportOnly,
      imageUrl: card.imageUrl,
      design: card.design ?? DEFAULT_DESIGN,
      expiresAt: card.expiresAt,
      redeemedAt: card.redeemedAt,
      redeemedByMe: card.redeemedBy?.id === userId,
      purchaseReference: card.purchase.reference,
      createdAt: card.createdAt,
    }));
  }

  /** Whoever enters or scans the code first gets its balance and points. */
  async redeem(userId: string, rawCode: string) {
    const code = normalizeCode(rawCode);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, blockedAt: true } });
    if (!user || user.role !== 'PASSENGER') throw new ForbiddenException('الشحن متاح لحسابات العملاء');
    if (user.blockedAt) throw new ForbiddenException('حسابك موقوف');

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.voucherCard.findUnique({ where: { code } });
      if (!card) throw new NotFoundException('رقم الشحن غير صحيح');
      if (card.redeemedAt) throw new ConflictException('استُخدمت هذه القسيمة من قبل');
      if (card.expiresAt <= new Date()) throw new ConflictException('انتهت صلاحية هذه القسيمة');
      // Claimed first, so the same card scanned on two phones at once is credited once.
      const claimed = await tx.voucherCard.updateMany({ where: { id: card.id, redeemedAt: null }, data: { redeemedAt: new Date(), redeemedById: userId } });
      if (claimed.count === 0) throw new ConflictException('استُخدمت هذه القسيمة من قبل');

      const value = Number(card.value);
      let walletBalance: Prisma.Decimal | null = null;
      if (value > 0) {
        walletBalance = await this.wallet.apply(tx, {
          userId,
          amount: value,
          type: 'VOUCHER_TOPUP',
          description: `شحن قسيمة ${card.name} (${formatCode(card.code).slice(-4)})${card.transportOnly ? ' • للنقل فقط' : ''}`,
          transportAmount: card.transportOnly ? value : 0,
        });
        await this.notifications.toUser(tx, 'WALLET_CREDITED', userId, { amount: formatSar(value), walletBalance: formatSar(walletBalance) });
      }
      if (card.bonusPoints > 0) {
        await this.loyalty.grant(tx, { userId, points: card.bonusPoints, type: 'VOUCHER_BONUS', description: `نقاط قسيمة ${card.name}`, uniqueKey: `voucher:${card.id}` });
      }
      const after = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { walletBalance: true, loyaltyPoints: true } });
      return {
        name: card.name,
        value,
        bonusPoints: card.bonusPoints,
        transportOnly: card.transportOnly,
        walletBalance: Number(after.walletBalance),
        loyaltyPoints: after.loyaltyPoints,
      };
    }, TX_OPTIONS);
  }
}

@ApiTags('Vouchers')
@ApiBearerAuth()
@Controller('loyalty/vouchers')
export class VouchersAdminController {
  constructor(private vouchers: VouchersService) {}

  @Get()
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Top-up voucher catalogue with sales' })
  list() {
    return this.vouchers.list();
  }

  @Post()
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Add a top-up voucher' })
  create(@Body() dto: CreateVoucherDto) {
    return this.vouchers.create(dto);
  }

  @Patch(':id')
  @RequirePermission('loyalty.manage')
  @ApiOperation({ summary: 'Edit a top-up voucher; cards already sold keep what they give' })
  update(@Param('id') id: string, @Body() dto: UpdateVoucherDto) {
    return this.vouchers.update(id, dto);
  }

  @Get(':id/cards')
  @RequirePermission('loyalty.view')
  @ApiOperation({ summary: 'Cards sold of a voucher, with who bought and who redeemed each' })
  cards(@Param('id') id: string, @Query() query: CardsQuery) {
    return this.vouchers.cards(id, query);
  }
}

@ApiTags('Vouchers')
@ApiBearerAuth()
@Controller('vouchers')
export class VouchersController {
  constructor(private vouchers: VouchersService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Top-up vouchers on sale' })
  catalog() {
    return this.vouchers.catalog();
  }

  @Post(':id/purchase')
  @ApiOperation({ summary: 'Buy one or more cards of a voucher, with money or points' })
  purchase(@Req() req, @Param('id') id: string, @Body() dto: PurchaseVoucherDto) {
    return this.vouchers.purchase(req.user.userId, id, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Cards the customer bought, with their code and QR' })
  mine(@Req() req) {
    return this.vouchers.mine(req.user.userId);
  }

  @Post('redeem')
  // Codes are worth money, so guessing them is slowed down.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Top up the wallet and points with a card code or its scanned QR' })
  redeem(@Req() req, @Body() dto: RedeemCardDto) {
    return this.vouchers.redeem(req.user.userId, dto.code);
  }
}

@Module({
  controllers: [VouchersAdminController, VouchersController],
  providers: [VouchersService],
})
export class VouchersModule {}

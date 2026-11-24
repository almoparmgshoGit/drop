import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../common/services/prisma.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { seatLabel } from '../../common/utils/seat-label.util';

/**
 * What a room card can show. The trip number is left out on purpose: customers never see it (STAFF_ONLY_VARIABLES).
 * The examples fill the panel's preview.
 */
export const ROOM_CARD_VARIABLES = {
  passengerName: { label: 'اسم المسافر', example: 'محمد عبدالله الأحمد' },
  roomNumber: { label: 'رقم الغرفة', example: '305' },
  hotelName: { label: 'اسم الفندق', example: 'فندق النور' },
  hotelCity: { label: 'مدينة الفندق', example: 'مكة المكرمة' },
  roomType: { label: 'نوع الغرفة', example: 'غرفة مشتركة' },
  checkIn: { label: 'تاريخ الدخول', example: '12 ديسمبر 2026' },
  checkOut: { label: 'تاريخ الخروج', example: '15 ديسمبر 2026' },
  nights: { label: 'عدد الليالي', example: '3' },
  mealPlan: { label: 'الوجبات', example: 'إفطار' },
  bookingReference: { label: 'رقم الحجز', example: 'DH-48213' },
  seatNumber: { label: 'رقم المقعد', example: '14' },
  supervisorName: { label: 'اسم المشرف', example: 'سالم المشرف' },
  supervisorPhone: { label: 'جوال المشرف', example: '+966551234567' },
  roommates: { label: 'شركاء الغرفة', example: 'أحمد علي، خالد سعيد' },
} as const;
export type RoomCardVariable = keyof typeof ROOM_CARD_VARIABLES;
const VARIABLE_KEYS = Object.keys(ROOM_CARD_VARIABLES) as RoomCardVariable[];

const MAX_ELEMENTS = 60;
const COLOR = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|transparent)$/;
const ELEMENT_TYPES = ['text', 'qr', 'image', 'shape'] as const;
const FONTS = ['kufi', 'plex'];
const ALIGNS = ['left', 'center', 'right'];
const FITS = ['contain', 'cover'];

const num = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const color = (value: unknown, fallback: string) => (typeof value === 'string' && COLOR.test(value) ? value : fallback);
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
/** Only the panel's own uploads, or an https address. */
const imageUrl = (value: unknown) => (typeof value === 'string' && /^(\/trips\/images\/[\w-]+|https:\/\/\S+)$/.test(value) && value.length <= 300 ? value : null);

/** Keeps only known keys with values in range, so a card saved from a bad request can never break the app that draws it. */
export function cleanElements(raw: unknown) {
  if (!Array.isArray(raw)) throw new BadRequestException('طبقات الكارت غير صالحة');
  if (raw.length > MAX_ELEMENTS) throw new BadRequestException(`الحد الأقصى ${MAX_ELEMENTS} طبقة في الكارت`);
  return raw.map((item: any, index) => {
    const type = oneOf(item?.type, ELEMENT_TYPES, 'text');
    const base = {
      id: typeof item?.id === 'string' && /^[\w-]{1,40}$/.test(item.id) ? item.id : `el-${index}`,
      type,
      name: text(item?.name, 60) || undefined,
      x: num(item?.x, -1, 2, 0.1),
      y: num(item?.y, -1, 2, 0.1),
      w: num(item?.w, 0.01, 3, 0.5),
      h: num(item?.h, 0.005, 3, 0.1),
      rotation: num(item?.rotation, -360, 360, 0),
      opacity: num(item?.opacity, 0, 1, 1),
      hidden: item?.hidden === true || undefined,
      locked: item?.locked === true || undefined,
    };
    if (type === 'text') {
      return {
        ...base,
        text: text(item?.text, 500),
        fontSize: num(item?.fontSize, 0.01, 0.4, 0.05),
        color: color(item?.color, '#FFFFFF'),
        fontWeight: item?.fontWeight === 'bold' ? 'bold' : 'normal',
        align: oneOf(item?.align, ALIGNS, 'center'),
        font: oneOf(item?.font, FONTS, 'kufi'),
        lineHeight: num(item?.lineHeight, 0.8, 3, 1.4),
        background: color(item?.background, 'transparent'),
        radius: num(item?.radius, 0, 0.5, 0),
      };
    }
    if (type === 'qr') {
      return {
        ...base,
        field: oneOf(item?.field, VARIABLE_KEYS, 'bookingReference'),
        color: color(item?.color, '#0F2A5C'),
        background: color(item?.background, '#FFFFFF'),
      };
    }
    if (type === 'image') {
      return { ...base, src: imageUrl(item?.src), fit: oneOf(item?.fit, FITS, 'contain'), radius: num(item?.radius, 0, 0.5, 0) };
    }
    return {
      ...base,
      fill: color(item?.fill, '#FFFFFF'),
      radius: num(item?.radius, 0, 0.5, 0),
      borderColor: color(item?.borderColor, 'transparent'),
      borderWidth: num(item?.borderWidth, 0, 0.05, 0),
    };
  });
}

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

class CreateRoomCardDto {
  @trimmed() @IsString() @Length(2, 80) name: string;
  /** null or missing: the general design. */
  @IsOptional() @IsString() hotelId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsNumber() @Min(0.3) @Max(3) ratio?: number;
  @IsOptional() @IsString() @Matches(COLOR) background?: string;
  @IsOptional() @IsString() @MaxLength(300) backgroundImage?: string | null;
  @IsOptional() @IsArray() elements?: unknown[];
}

class UpdateRoomCardDto extends PartialType(CreateRoomCardDto) {}

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  hotelId: true,
  isActive: true,
  ratio: true,
  background: true,
  backgroundImage: true,
  elements: true,
  updatedByName: true,
  updatedAt: true,
  hotel: { select: { id: true, name: true } },
} satisfies Prisma.RoomCardTemplateSelect;

/** What the app needs to draw a card. */
const PUBLIC_TEMPLATE_SELECT = { id: true, ratio: true, background: true, backgroundImage: true, elements: true } satisfies Prisma.RoomCardTemplateSelect;

const ACTIVE_STATUSES = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'];
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A stay's date as the hotel wrote it, read as a calendar day. */
const formatDay = (date: Date) =>
  new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);

@Injectable()
export class RoomCardsService {
  constructor(private prisma: PrismaService, private appSettings: AppSettingsService) {}

  variables() {
    return VARIABLE_KEYS.map((key) => ({ key, ...ROOM_CARD_VARIABLES[key] }));
  }

  list() {
    return this.prisma.roomCardTemplate.findMany({ orderBy: [{ hotelId: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }], select: TEMPLATE_SELECT });
  }

  async get(id: string) {
    const template = await this.prisma.roomCardTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
    if (!template) throw new NotFoundException('التصميم غير موجود');
    return template;
  }

  private async authorName(userId: string) {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? null;
  }

  private async assertHotel(hotelId: string | null | undefined) {
    if (!hotelId) return;
    if (!(await this.prisma.hotel.findUnique({ where: { id: hotelId }, select: { id: true } }))) throw new BadRequestException('الفندق غير موجود');
  }

  private data(dto: UpdateRoomCardDto) {
    return {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.ratio !== undefined && { ratio: dto.ratio }),
      ...(dto.background !== undefined && { background: dto.background }),
      ...(dto.backgroundImage !== undefined && { backgroundImage: imageUrl(dto.backgroundImage) }),
      ...(dto.elements !== undefined && { elements: cleanElements(dto.elements) as Prisma.InputJsonValue }),
    };
  }

  /** Turning a design on turns off the other one for the same hotel (or the other general one). */
  private async deactivateOthers(tx: Prisma.TransactionClient, hotelId: string | null, exceptId: string) {
    await tx.roomCardTemplate.updateMany({ where: { hotelId, isActive: true, id: { not: exceptId } }, data: { isActive: false } });
  }

  async create(actor: { userId: string }, dto: CreateRoomCardDto) {
    await this.assertHotel(dto.hotelId);
    const updatedByName = await this.authorName(actor.userId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.roomCardTemplate.create({
        data: { ...this.data(dto), name: dto.name, hotelId: dto.hotelId || null, isActive: !!dto.isActive, elements: cleanElements(dto.elements ?? []) as Prisma.InputJsonValue, updatedByName },
        select: { id: true },
      });
      if (dto.isActive) await this.deactivateOthers(tx, dto.hotelId || null, row.id);
      return tx.roomCardTemplate.findUniqueOrThrow({ where: { id: row.id }, select: TEMPLATE_SELECT });
    });
  }

  async update(actor: { userId: string }, id: string, dto: UpdateRoomCardDto) {
    const current = await this.get(id);
    if (dto.hotelId !== undefined) await this.assertHotel(dto.hotelId);
    const hotelId = dto.hotelId !== undefined ? dto.hotelId || null : current.hotelId;
    const isActive = dto.isActive ?? current.isActive;
    const updatedByName = await this.authorName(actor.userId);
    return this.prisma.$transaction(async (tx) => {
      await tx.roomCardTemplate.update({ where: { id }, data: { ...this.data(dto), hotelId, isActive, updatedByName } });
      if (isActive) await this.deactivateOthers(tx, hotelId, id);
      return tx.roomCardTemplate.findUniqueOrThrow({ where: { id }, select: TEMPLATE_SELECT });
    });
  }

  async duplicate(actor: { userId: string }, id: string) {
    const source = await this.get(id);
    return this.prisma.roomCardTemplate.create({
      data: {
        name: `${source.name} (نسخة)`.slice(0, 80),
        hotelId: source.hotelId,
        isActive: false,
        ratio: source.ratio,
        background: source.background,
        backgroundImage: source.backgroundImage,
        elements: source.elements as Prisma.InputJsonValue,
        updatedByName: await this.authorName(actor.userId),
      },
      select: TEMPLATE_SELECT,
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.roomCardTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * The cards of a booking's housed passengers: each with the design of its hotel (its own active one, else the
   * general one) and the values filled in. A hotel with neither shows no card.
   */
  async forBooking(booking: {
    status: string;
    bookingReference: string;
    trip: { id: string; departureTime: Date };
    passengers: {
      id: string;
      fullName: string;
      seatNumber: string | null;
      roommates?: string[];
      hotelRoom: { number: string; type: string; hotelBooking: { checkIn: Date; checkOut: Date; mealPlan: string | null; hotel: { id?: string; name: string; city: string } } } | null;
    }[];
  }) {
    if (!ACTIVE_STATUSES.includes(booking.status)) return { templates: {}, cards: [] };
    const housed = booking.passengers.filter((p) => p.hotelRoom?.hotelBooking.hotel.id);
    if (housed.length === 0) return { templates: {}, cards: [] };
    const hotelIds = [...new Set(housed.map((p) => p.hotelRoom!.hotelBooking.hotel.id!))];
    const designs = await this.prisma.roomCardTemplate.findMany({
      where: { isActive: true, OR: [{ hotelId: null }, { hotelId: { in: hotelIds } }] },
      select: { ...PUBLIC_TEMPLATE_SELECT, hotelId: true },
    });
    const general = designs.find((d) => d.hotelId === null) ?? null;
    const designOf = (hotelId: string) => designs.find((d) => d.hotelId === hotelId) ?? general;
    if (!hotelIds.some((id) => designOf(id))) return { templates: {}, cards: [] };

    // The trip's supervisor, the primary one first; the phone only once the trip's contact window has opened.
    const supervisors = await this.prisma.tripSupervisor.findMany({
      where: { tripId: booking.trip.id },
      orderBy: { isPrimary: 'desc' },
      select: { user: { select: { name: true, phone: true } } },
    });
    const supervisor = supervisors.find((row) => row.user.phone)?.user ?? supervisors[0]?.user ?? null;
    const opensBeforeHours = await this.appSettings.number('supervisorContactOpensBeforeHours');
    const showPhone = booking.trip.departureTime.getTime() - Date.now() <= opensBeforeHours * HOUR_MS;

    const templates: Record<string, { id: string; ratio: number; background: string; backgroundImage: string | null; elements: Prisma.JsonValue }> = {};
    const cards = housed.flatMap((p) => {
      const room = p.hotelRoom!;
      const stay = room.hotelBooking;
      const design = designOf(stay.hotel.id!);
      if (!design) return [];
      const { hotelId: _hotel, ...publicDesign } = design;
      templates[design.id] = publicDesign;
      const values: Record<RoomCardVariable, string> = {
        passengerName: p.fullName,
        roomNumber: room.number,
        hotelName: stay.hotel.name,
        hotelCity: stay.hotel.city,
        roomType: room.type === 'PRIVATE' ? 'غرفة خاصة' : 'غرفة مشتركة',
        checkIn: formatDay(stay.checkIn),
        checkOut: formatDay(stay.checkOut),
        nights: String(Math.max(0, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / DAY_MS))),
        mealPlan: stay.mealPlan ?? '',
        bookingReference: booking.bookingReference,
        seatNumber: p.seatNumber ? seatLabel(p.seatNumber) : '',
        supervisorName: supervisor?.name ?? '',
        supervisorPhone: showPhone ? supervisor?.phone ?? '' : '',
        roommates: (p.roommates ?? []).join('، '),
      };
      return [{ passengerId: p.id, templateId: design.id, values }];
    });
    return { templates, cards };
  }
}

@ApiTags('Room cards')
@Controller('room-cards')
@ApiBearerAuth()
class RoomCardsController {
  constructor(private cards: RoomCardsService) {}

  @Get('variables')
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'What a room card can show, with an example of each' })
  variables() {
    return this.cards.variables();
  }

  @Get()
  @RequirePermission('hotels.view')
  @ApiOperation({ summary: 'Every room card design, the general ones first' })
  list() {
    return this.cards.list();
  }

  @Get(':id')
  @RequirePermission('hotels.view')
  get(@Param('id') id: string) {
    return this.cards.get(id);
  }

  @Post()
  @RequirePermission('hotels.manage')
  @ApiOperation({ summary: 'Add a room card design, general or for one hotel' })
  create(@Req() req, @Body() dto: CreateRoomCardDto) {
    return this.cards.create(req.user, dto);
  }

  @Patch(':id')
  @RequirePermission('hotels.manage')
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateRoomCardDto) {
    return this.cards.update(req.user, id, dto);
  }

  @Post(':id/duplicate')
  @RequirePermission('hotels.manage')
  duplicate(@Req() req, @Param('id') id: string) {
    return this.cards.duplicate(req.user, id);
  }

  @Delete(':id')
  @RequirePermission('hotels.manage')
  remove(@Param('id') id: string) {
    return this.cards.remove(id);
  }
}

@Module({
  controllers: [RoomCardsController],
  providers: [RoomCardsService],
  exports: [RoomCardsService],
})
export class RoomCardsModule {}

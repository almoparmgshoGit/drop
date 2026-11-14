import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { VehicleKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PrismaService } from '../../common/services/prisma.service';
import { AppSettingsService, BOOKING_OPENS_MODES, FLAG_SETTINGS, NUMBER_SETTINGS, SCHEDULE_TEXT_DEFAULTS } from '../../common/services/app-settings.service';
import { BUS_SEAT_COUNT, MAX_BUS_SEATS, MIN_SMALL_VEHICLE_SEATS, seatLimitsFor } from '../../common/utils/bus-layout.util';
import { assertSinglesFitRange, assertValidSinglesRange } from '../../common/utils/singles-seats.util';
import { openTripsWhere } from '../buses/buses.service';
import { IntegrationsService } from '../../common/services/integrations.service';
import { RoutingService } from '../../common/services/routing.service';
import { parseCancellationRules } from '../../common/utils/cancellation-policy.util';
import { INVOICE_SETTING_DEFAULTS } from '../../common/utils/invoice.util';
import { Public, RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';

/** Anyone can read these through GET /settings, so nothing internal belongs here. */
const PUBLIC_DEFAULTS: Record<string, string> = {
  systemName: 'دروب الهجرة — Durob Al Hijra',
  vatRate: '15',
  cancellationPolicy: '',
  cancellationRules: '[]',
  termsAndConditions: '',
  privacyPolicy: '',
  supportPhone: '',
  supportWhatsapp: '',
  ...INVOICE_SETTING_DEFAULTS,
};

const APP_TEXT_DEFAULTS: Record<string, string> = {
  maintenanceMessage: 'نعمل على تحسين الخدمة، وسنعود قريبًا بإذن الله.',
  minAppVersion: '',
  androidStoreUrl: '',
  iosStoreUrl: '',
  announcementTitle: '',
  announcementBody: '',
};

/**
 * Google's OAuth client ids for quick sign-in. Not secrets: Google puts them in every sign-in request, and the app needs them
 * before anyone signs in. The web id is also the audience the server checks each ID token against; empty turns the button off.
 */
export const GOOGLE_SIGN_IN_DEFAULTS: Record<string, string> = {
  googleWebClientId: '',
  googleIosClientId: '',
};
const GOOGLE_CLIENT_ID = /^(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)?$/;
const GOOGLE_CLIENT_ID_MESSAGE = 'معرّف العميل بالشكل 1234567890-xxxx.apps.googleusercontent.com';

const PANEL_DEFAULTS: Record<string, string> = {
  panelTitle: 'دروب الهجرة',
  panelSubtitle: 'لوحة الإدارة',
  panelNotice: '',
};

const STORE_URL = /^(https:\/\/\S+)?$/;
const STORE_URL_MESSAGE = 'رابط المتجر يبدأ بـ https';

class CancellationRuleDto {
  @IsInt()
  @Min(0)
  @Max(3650)
  minDays: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  percent: number;
}

class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  systemName?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  vatRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  cancellationPolicy?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CancellationRuleDto)
  cancellationRules?: CancellationRuleDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  termsAndConditions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  privacyPolicy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  supportPhone?: string;

  @IsOptional()
  @Matches(/^(\+?\d{8,15})?$/, { message: 'واتساب الدعم أرقام فقط مع رمز الدولة' })
  supportWhatsapp?: string;

  // The QR on an invoice allows 255 bytes per field, and an Arabic letter takes two.
  @IsOptional()
  @IsString()
  @Length(2, 100)
  sellerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sellerTagline?: string;

  @IsOptional()
  @Matches(/^(3\d{13}3)?$/, { message: 'الرقم الضريبي 15 رقمًا يبدأ وينتهي بـ 3' })
  vatNumber?: string;

  @IsOptional()
  @Matches(/^\d{0,20}$/, { message: 'السجل التجاري أرقام فقط' })
  crNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  sellerCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  invoiceContacts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  invoiceTripNotice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  invoiceFooter?: string;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  maintenanceMessage?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  ticketCompensationPercent?: number;

  @IsOptional()
  @IsBoolean()
  ticketCompensationAutomatic?: boolean;

  @IsOptional()
  @IsBoolean()
  bookingsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  registrationEnabled?: boolean;

  @IsOptional()
  @Matches(/^(\d+\.\d+\.\d+)?$/, { message: 'الإصدار بالشكل 1.0.0' })
  minAppVersion?: string;

  @IsOptional()
  @Matches(STORE_URL, { message: STORE_URL_MESSAGE })
  @MaxLength(500)
  androidStoreUrl?: string;

  @IsOptional()
  @Matches(STORE_URL, { message: STORE_URL_MESSAGE })
  @MaxLength(500)
  iosStoreUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  announcementTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  announcementBody?: string;

  @IsOptional()
  @Matches(GOOGLE_CLIENT_ID, { message: GOOGLE_CLIENT_ID_MESSAGE })
  @MaxLength(200)
  googleWebClientId?: string;

  @IsOptional()
  @Matches(GOOGLE_CLIENT_ID, { message: GOOGLE_CLIENT_ID_MESSAGE })
  @MaxLength(200)
  googleIosClientId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  panelTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  panelSubtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  panelNotice?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  holdMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  waitlistOfferMinutes?: number;

  @IsOptional()
  @IsBoolean()
  waitlistEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  boardingOpensBeforeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(48)
  trackingOpensBeforeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(48)
  trackingClosesAfterHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  supervisorContactOpensBeforeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(5000)
  arrivalRadiusMeters?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(720)
  supervisorAppCheckBeforeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(240)
  trackingSilentAlertMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  gpsDeviceStaleMinutes?: number;

  // Same ceilings as a trip's own fields on its form.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080)
  defaultCrewOpensBeforeMinutes?: number;

  /** Where singles sit on a trip with no bus yet. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(BUS_SEAT_COUNT)
  defaultSinglesFromSeat?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(BUS_SEAT_COUNT)
  defaultSinglesToSeat?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  defaultBoardingOpensBeforeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  defaultBoardingClosesAfterMinutes?: number;

  // The floors keep a mistyped value from locking everyone out or leaving a code open to guessing.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  otpTtlMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  otpMaxAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  otpResendCooldownSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  otpMaxSendsPerHour?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(20)
  loginMaxFailures?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  loginLockMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  otpMaxFailuresPerDay?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  walletAdjustDailyLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  loyaltyAdjustDailyLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  campaignMaxRecipients?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  customerLookupDailyLimit?: number;

  // ---- Fixed weekly trips, drafted a month at a time. 28 keeps every value inside the shortest month.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  scheduleGenerateDaysBefore?: number;

  @IsOptional()
  @IsIn(BOOKING_OPENS_MODES, { message: 'اختر موعد فتح الحجز: عند النشر أو أول الشهر أو قبله بأيام' })
  scheduleBookingOpens?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  scheduleOpenDaysBefore?: number;

  // ---- Human resources
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) gosiSaudiEmployeePercent?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) gosiSaudiEmployerPercent?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) gosiNonSaudiEmployeePercent?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) gosiNonSaudiEmployerPercent?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(1_000_000) gosiMaxWage?: number;
  @IsOptional() @IsInt() @Min(10) @Max(100) payrollMaxDeductionPercent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(30) penaltyMaxDaysPerMonth?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60) annualLeaveDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60) annualLeaveDaysAfterFiveYears?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60) annualLeaveMaxNegativeDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) sickFullPayDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) sickPartialPayDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) sickPartialPayPercent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) sickUnpaidDays?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(24) advanceMaxSalaryMonths?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) advanceMaxInstallments?: number;
  @IsOptional() @IsInt() @Min(0) @Max(120) advanceMinServiceMonths?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) advanceMaxInstallmentPercent?: number;
}

/**
 * The vehicle types the fleet is made of, e.g. "حافلة 49 راكب" or "فان 13 راكب". Choosing one on the vehicle form fills
 * its kind and seat count, which stay editable: the type is only a starting point, and a vehicle keeps its own count, so
 * editing or removing a type here changes no vehicle and no trip. Kept as one JSON setting, read whole and saved whole.
 */
const VEHICLE_TYPES_KEY = 'vehicleTypes';
const MAX_VEHICLE_TYPES = 30;

type VehicleType = { id: string; name: string; kind: VehicleKind; seatCount: number };

/** What the client listed, until the settings page saves its own list. */
const DEFAULT_VEHICLE_TYPES: VehicleType[] = [
  { id: 'bus-49', name: 'حافلة 49 راكب', kind: 'BUS', seatCount: 49 },
  { id: 'bus-50', name: 'حافلة 50 راكب', kind: 'BUS', seatCount: 50 },
  { id: 'coaster-28', name: 'كوستر 28 راكب', kind: 'MINIBUS', seatCount: 28 },
  { id: 'van-13', name: 'فان 13 راكب', kind: 'VAN', seatCount: 13 },
];

const isVehicleType = (row: any): row is VehicleType =>
  !!row && typeof row.id === 'string' && typeof row.name === 'string' && Object.values(VehicleKind).includes(row.kind) && Number.isInteger(row.seatCount);

class VehicleTypeDto {
  /** Left out for a new type; kept for an existing one so the forms can tell which type a choice was. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9-]{1,40}$/)
  id?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 60, { message: 'اسم نوع المركبة بين حرفين و60 حرفًا' })
  name: string;

  @IsEnum(VehicleKind, { message: 'اختر فئة المركبة: باص أو فان أو باص صغير' })
  kind: VehicleKind;

  @IsInt({ message: 'عدد المقاعد رقم صحيح' })
  @Min(MIN_SMALL_VEHICLE_SEATS)
  @Max(MAX_BUS_SEATS)
  seatCount: number;
}

class UpdateVehicleTypesDto {
  @IsArray()
  @ArrayMaxSize(MAX_VEHICLE_TYPES, { message: `الحد الأقصى ${MAX_VEHICLE_TYPES} نوعًا` })
  @ValidateNested({ each: true })
  @Type(() => VehicleTypeDto)
  types: VehicleTypeDto[];
}

class UpdateIntegrationsDto {
  @IsObject()
  values: Record<string, unknown>;
}

/** Each daily limit and the permission that lifts it; settings.manage alone must not be a way around the permission. */
const LIMIT_SETTING_PERMISSIONS: Record<string, string> = {
  walletAdjustDailyLimit: 'wallet.adjust_unlimited',
  loyaltyAdjustDailyLimit: 'loyalty.adjust_unlimited',
  campaignMaxRecipients: 'notifications.campaigns_unlimited',
  customerLookupDailyLimit: 'customers.list',
  // Salary rules move money on every payroll, so they belong to whoever approves payrolls.
  ...Object.fromEntries(
    [
      'gosiSaudiEmployeePercent', 'gosiSaudiEmployerPercent', 'gosiNonSaudiEmployeePercent', 'gosiNonSaudiEmployerPercent', 'gosiMaxWage',
      'payrollMaxDeductionPercent', 'penaltyMaxDaysPerMonth', 'annualLeaveDays', 'annualLeaveDaysAfterFiveYears', 'annualLeaveMaxNegativeDays',
      'sickFullPayDays', 'sickPartialPayDays', 'sickPartialPayPercent', 'sickUnpaidDays',
      'advanceMaxSalaryMonths', 'advanceMaxInstallments', 'advanceMinServiceMonths', 'advanceMaxInstallmentPercent',
    ].map((key) => [key, 'payroll.approve']),
  ),
};

const stored = (value: unknown) => (typeof value === 'object' ? JSON.stringify(value) : String(value));

@Injectable()
class SettingsService {
  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private integrations: IntegrationsService,
  ) {}

  private async textValues(defaults: Record<string, string>) {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: Object.keys(defaults) } } });
    return { ...defaults, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
  }

  private async numberValues() {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: Object.keys(NUMBER_SETTINGS) } } });
    return { ...NUMBER_SETTINGS, ...Object.fromEntries(rows.map((row) => [row.key, Number(row.value)])) };
  }

  private async flagValues() {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: Object.keys(FLAG_SETTINGS) } } });
    return { ...FLAG_SETTINGS, ...Object.fromEntries(rows.map((row) => [row.key, row.value === 'true'])) };
  }

  async getAll() {
    const settings = await this.textValues(PUBLIC_DEFAULTS);
    return { ...settings, vatRate: Number(settings.vatRate), cancellationRules: parseCancellationRules(settings.cancellationRules) };
  }

  /** Everything the settings page edits, except integration keys, which have their own permission. */
  async getAdmin() {
    const [general, appText, google, panel, numbers, flags, schedule] = await Promise.all([
      this.getAll(),
      this.textValues(APP_TEXT_DEFAULTS),
      this.textValues(GOOGLE_SIGN_IN_DEFAULTS),
      this.textValues(PANEL_DEFAULTS),
      this.numberValues(),
      this.flagValues(),
      this.textValues(SCHEDULE_TEXT_DEFAULTS),
    ]);
    return { ...general, ...appText, ...google, ...panel, ...numbers, ...flags, ...schedule };
  }

  /** What each copy of the app asks for on opening, before anyone signs in. */
  async getAppConfig() {
    const [appText, contact, google, flags, map] = await Promise.all([
      this.textValues(APP_TEXT_DEFAULTS),
      this.textValues({ supportPhone: '', supportWhatsapp: '' }),
      this.textValues(GOOGLE_SIGN_IN_DEFAULTS),
      this.flagValues(),
      this.integrations.mapConfig(),
    ]);
    return { ...appText, ...contact, ...google, ...flags, mapTilesUrl: map.tilesUrl, mapAttribution: map.attribution };
  }

  async getPanelConfig() {
    const [panel, numbers, map] = await Promise.all([this.textValues(PANEL_DEFAULTS), this.numberValues(), this.integrations.mapConfig()]);
    return {
      ...panel,
      map,
      tripDefaults: {
        crewOpensBeforeMinutes: numbers.defaultCrewOpensBeforeMinutes,
        boardingOpensBeforeMinutes: numbers.defaultBoardingOpensBeforeMinutes,
        boardingClosesAfterMinutes: numbers.defaultBoardingClosesAfterMinutes,
      },
    };
  }

  async update(actor: { permissions: string[] }, dto: UpdateSettingsDto) {
    // Raising one of these limits grants what its unlimited permission grants, so only a holder of that permission may change it.
    const guarded = Object.entries(LIMIT_SETTING_PERMISSIONS).filter(([key]) => dto[key as keyof UpdateSettingsDto] !== undefined);
    if (guarded.length) {
      const current = await this.numberValues();
      for (const [key, permission] of guarded) {
        if (Number(dto[key as keyof UpdateSettingsDto]) !== Number(current[key]) && !actor.permissions.includes(permission)) {
          throw new ForbiddenException('ليست لديك صلاحية لتعديل هذا الحد');
        }
      }
    }
    if (dto.cancellationRules && new Set(dto.cancellationRules.map((rule) => rule.minDays)).size !== dto.cancellationRules.length) {
      throw new BadRequestException('يوجد أكثر من بند لنفس عدد الأيام في سياسة الإلغاء');
    }
    if (dto.defaultSinglesFromSeat !== undefined || dto.defaultSinglesToSeat !== undefined) {
      const current = await this.appSettings.singlesRange(null);
      const range = { from: dto.defaultSinglesFromSeat ?? current.from, to: dto.defaultSinglesToSeat ?? current.to };
      assertValidSinglesRange(range);
      await assertSinglesFitRange(this.prisma, { busId: null, ...openTripsWhere() }, range);
    }
    await this.prisma.$transaction(
      Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) =>
          this.prisma.setting.upsert({
            where: { key },
            create: { key, value: stored(value) },
            update: { value: stored(value) },
          }),
        ),
    );
    return this.getAdmin();
  }

  /** The saved list, or the defaults until one is saved. A row damaged by hand is skipped rather than breaking the forms. */
  private async storedVehicleTypes(): Promise<VehicleType[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: VEHICLE_TYPES_KEY } });
    if (!row) return DEFAULT_VEHICLE_TYPES;
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed.filter(isVehicleType) : DEFAULT_VEHICLE_TYPES;
    } catch {
      return DEFAULT_VEHICLE_TYPES;
    }
  }

  /** The types, plus what the vehicle form needs to fill a new vehicle from one: the limits per kind and the singles settings. */
  async getVehicleTypes() {
    const [types, singles] = await Promise.all([this.storedVehicleTypes(), this.appSettings.singlesRange(null)]);
    return {
      types,
      limits: Object.fromEntries(Object.values(VehicleKind).map((kind) => [kind, seatLimitsFor(kind)])),
      singlesDefaults: singles,
    };
  }

  async updateVehicleTypes(dto: UpdateVehicleTypesDto) {
    const seen = new Set<string>();
    const types = dto.types.map((type) => {
      const limits = seatLimitsFor(type.kind);
      if (type.seatCount < limits.min || type.seatCount > limits.max) {
        throw new BadRequestException(`«${type.name}»: المقاعد من ${limits.min} إلى ${limits.max} لهذه الفئة`);
      }
      const key = type.name.replace(/s+/g, ' ').toLowerCase();
      if (seen.has(key)) throw new BadRequestException(`نوع المركبة «${type.name}» مكرر`);
      seen.add(key);
      return { id: type.id || randomUUID().slice(0, 8), name: type.name, kind: type.kind, seatCount: type.seatCount };
    });
    if (new Set(types.map((type) => type.id)).size !== types.length) throw new BadRequestException('يوجد نوعان بنفس المعرّف');
    const value = JSON.stringify(types);
    await this.prisma.setting.upsert({ where: { key: VEHICLE_TYPES_KEY }, create: { key: VEHICLE_TYPES_KEY, value }, update: { value } });
    return this.getVehicleTypes();
  }

  async updateIntegrations(actor: { userId: string }, dto: UpdateIntegrationsDto, ip?: string) {
    const changed = await this.integrations.update(dto.values);
    // Written by hand because the audit interceptor would copy the request body, secrets included.
    await this.prisma.auditLog.create({ data: { userId: actor.userId, action: 'PUT /settings/integrations', entity: 'Settings', ip, details: { changed } } });
    return this.integrations.status();
  }
}

@ApiTags('Settings')
@Controller('settings')
class SettingsController {
  constructor(
    private settings: SettingsService,
    private integrations: IntegrationsService,
    private routing: RoutingService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Public system settings: policies, VAT rate, support phone' })
  getAll() {
    return this.settings.getAll();
  }

  @Public()
  @Get('app-config')
  @ApiOperation({ summary: 'Maintenance state, required version, announcement and contact details for the mobile app' })
  getAppConfig() {
    return this.settings.getAppConfig();
  }

  @Get('panel')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sidebar wording, staff notice and new-trip defaults for anyone working in the panel' })
  getPanelConfig(@Req() req) {
    if (req.user.role === 'PASSENGER') throw new ForbiddenException();
    return this.settings.getPanelConfig();
  }

  @Get('admin')
  @RequirePermission('settings.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Every setting the settings page edits, including internal limits' })
  getAdmin() {
    return this.settings.getAdmin();
  }

  @Put()
  @RequirePermission('settings.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update system settings; send only the fields being changed' })
  update(@Req() req, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(req.user, dto);
  }

  @Get('vehicle-types')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Vehicle types with their kind and seat count, offered when a vehicle is added' })
  getVehicleTypes(@Req() req) {
    // Whoever adds a vehicle reads it, not only whoever edits the settings.
    if (req.user.role === 'PASSENGER') throw new ForbiddenException();
    return this.settings.getVehicleTypes();
  }

  @Put('vehicle-types')
  @RequirePermission('settings.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replace the list of vehicle types; vehicles already saved keep their own seats' })
  updateVehicleTypes(@Body() dto: UpdateVehicleTypesDto) {
    return this.settings.updateVehicleTypes(dto);
  }

  @Get('integrations')
  @RequirePermission('integrations.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'External service keys; secrets appear only as set or not set' })
  getIntegrations() {
    return this.integrations.status();
  }

  @Put('integrations')
  @SkipAudit()
  @RequirePermission('integrations.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Save or remove external service keys' })
  updateIntegrations(@Req() req, @Body() dto: UpdateIntegrationsDto) {
    return this.settings.updateIntegrations(req.user, dto, req.ip);
  }

  @Post('integrations/routing/test')
  @HttpCode(200)
  @RequirePermission('integrations.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Try the saved routing platform with one real request; counts toward its usage' })
  testRouting() {
    return this.routing.test();
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}

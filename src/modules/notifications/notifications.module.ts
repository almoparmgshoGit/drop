import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { customerValues, customerWording, describeEntry, describeVariables, findMissingRequired, findTemplateProblem, isNotificationEvent, MESSAGE_LANGUAGES, MessageLanguage, NOTIFICATION_CATALOG, NotificationEvent, NotificationValues, renderTemplate, toWhatsAppParam } from '../../common/notification-catalog';
import { Prisma } from '@prisma/client';
import { isEveryLanguage, LANGUAGE_NAMES, LanguageWordings, normalizeLanguages, readWordings, typedWordings, Wording } from '../../common/message-languages';
import { NOTIFICATION_SECTIONS, permissionsOf } from '../../common/permissions';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { EXPO_TOKEN_PATTERN, PushService } from '../../common/services/push.service';
import { approvedWhatsAppTemplates, templateWording } from '../../common/services/notifications.service';
import { WhatsAppError, WhatsAppService } from '../../common/services/whatsapp.service';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { randomUUID } from 'crypto';

const DEFAULT_PAGE_SIZE = 30;
const STAFF_MESSAGE_EVENT = 'STAFF_MESSAGE';
/** Its own event, so a test never counts as, or opens the screen of, the action it imitates. */
const TEMPLATE_TEST_EVENT = 'TEMPLATE_TEST';
const TEST_LABEL = '[تجريبي]';
const TEST_NAME = 'عميل تجريبي';
/** Clearly made-up values on top of each variable's own example, so nobody mistakes a test for a real trip or booking. */
const TEST_VALUES: NotificationValues = {
  userName: TEST_NAME,
  customerName: TEST_NAME,
  passengerName: TEST_NAME,
  customerPhone: '+966500000000',
  tripCode: 'R000',
  bookingReference: 'TEST-0000',
};
const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const NOTIFICATION_SELECT = { id: true, event: true, title: true, body: true, bookingId: true, tripId: true, reportId: true, readAt: true, createdAt: true } as const;

class ListNotificationsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  /** The createdAt of the last item already shown; new arrivals cannot shift this the way page numbers would. */
  @IsOptional() @IsDateString() before?: string;
}

class UpdateTemplateDto {
  @trimmed() @IsString() @Length(1, 120, { message: 'العنوان مطلوب ولا يتجاوز 120 حرفًا' }) title: string;
  @trimmed() @IsString() @Length(1, 1000, { message: 'النص مطلوب ولا يتجاوز 1000 حرف' }) body: string;
  @IsBoolean() isActive: boolean;
  /** { en: { title, body }, ur: { title, body } }. A language left empty goes back to the default translation. */
  @IsOptional() @IsObject() translations?: Record<string, { title?: string; body?: string }>;
}

class SendStaffNotificationDto {
  @IsString() @MaxLength(100) section: string;
  /** Leave out to reach everyone in the section. */
  @IsOptional() @IsArray() @ArrayNotEmpty({ message: 'اختر موظفًا واحدًا على الأقل' }) @ArrayMaxSize(500) @IsString({ each: true }) userIds?: string[];
  /** The languages whose staff receive it; leave out for all. Each one needs its own wording in content. */
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(MESSAGE_LANGUAGES, { each: true }) languages?: string[];
  @IsOptional() @IsObject() content?: Record<string, { title?: string; body?: string }>;
  /** The older single-language form: an Arabic wording that everyone receives. */
  @IsOptional() @trimmed() @IsString() title?: string;
  @IsOptional() @trimmed() @IsString() body?: string;
}

class TestTemplateDto {
  /** ME is the signed-in staff member; PHONE is any Saudi mobile, reaching its account in the app if it has one. */
  @IsOptional() @IsIn(['ME', 'PHONE']) recipient?: 'ME' | 'PHONE';
  @ValidateIf((dto) => dto.recipient === 'PHONE') @IsString({ message: 'أدخل رقم الجوال' }) @MaxLength(20) phone?: string;
  @IsOptional() @IsIn(MESSAGE_LANGUAGES) language?: MessageLanguage;
  /** The editor's unsaved wording for this language; leave both out to test the saved one. */
  @IsOptional() @trimmed() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(1000) body?: string;
}

type TestChannel = 'IN_APP' | 'PUSH' | 'WHATSAPP';
type TestResult = { channel: TestChannel; status: 'SENT' | 'SKIPPED' | 'FAILED'; detail: string };

class PushTokenDto {
  @IsString() @MaxLength(200) @Matches(EXPO_TOKEN_PATTERN, { message: 'رمز الإشعارات غير صالح' }) token: string;
}

class RegisterPushTokenDto extends PushTokenDto {
  @IsIn(['android', 'ios']) platform: string;
}

interface Sender {
  userId: string;
  permissions: string[];
}

const catalogTranslations = (event: NotificationEvent): Partial<Record<'en' | 'ur', Wording>> =>
  (NOTIFICATION_CATALOG[event] as { translations?: Partial<Record<'en' | 'ur', Wording>> }).translations ?? {};

@Injectable()
class NotificationsCenterService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private push: PushService,
    private whatsapp: WhatsAppService,
    private config: ConfigService,
  ) {}

  private get isClientTrial() {
    return this.config.get<string>('CLIENT_TRIAL_MODE') === 'true';
  }

  private unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async list(userId: string, query: ListNotificationsQuery) {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, ...(query.before && { createdAt: { lt: new Date(query.before) } }) },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        select: NOTIFICATION_SELECT,
      }),
      this.unreadCount(userId),
    ]);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit, unreadCount };
  }

  /** What the clients poll: small enough to ask for every few seconds. */
  async summary(userId: string) {
    const [unreadCount, latestUnread] = await Promise.all([
      this.unreadCount(userId),
      this.prisma.notification.findFirst({ where: { userId, readAt: null }, orderBy: { createdAt: 'desc' }, select: NOTIFICATION_SELECT }),
    ]);
    return { unreadCount, latestUnread };
  }

  async markRead(userId: string, id: string) {
    // Scoped to the owner, so another user's id simply does not exist.
    const exists = await this.prisma.notification.count({ where: { id, userId } });
    if (exists === 0) throw new NotFoundException('الإشعار غير موجود');
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    return { unreadCount: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { unreadCount: 0 };
  }

  /** The sections this sender works in, each with the other active staff who also hold a permission there. */
  async sendableSections(sender: Sender) {
    const staff = await this.prisma.user.findMany({
      where: { role: { not: 'PASSENGER' }, id: { not: sender.userId }, NOT: { driverProfile: { is: { isActive: false } } } },
      select: { id: true, name: true, role: true, extraPermissions: true, revokedPermissions: true, rank: { select: { name: true, permissions: true } } },
      orderBy: { name: 'asc' },
    });
    const withPermissions = staff.map((user) => ({ user, held: permissionsOf(user) }));
    return NOTIFICATION_SECTIONS.filter((section) => section.permissions.some((key) => sender.permissions.includes(key))).map((section) => ({
      title: section.title,
      members: withPermissions
        .filter(({ held }) => section.permissions.some((key) => held.includes(key)))
        .map(({ user }) => ({ id: user.id, name: user.name, rank: user.rank?.name ?? null })),
    }));
  }

  async sendToStaff(sender: Sender, dto: SendStaffNotificationDto) {
    const section = (await this.sendableSections(sender)).find((row) => row.title === dto.section);
    if (!section) throw new ForbiddenException('لا تملك صلاحية في هذا القسم');

    const memberIds = section.members.map((member) => member.id);
    if (dto.userIds?.some((id) => !memberIds.includes(id))) throw new BadRequestException('أحد الموظفين المختارين ليس من هذا القسم');
    const languages = normalizeLanguages(dto.languages);
    const content = typedWordings(languages, dto, { title: 120, body: 1000 });
    const chosen = dto.userIds ? [...new Set(dto.userIds)] : memberIds;
    if (chosen.length === 0) throw new ConflictException('لا يوجد موظفون آخرون في هذا القسم');
    const people = await this.prisma.user.findMany({ where: { id: { in: chosen } }, select: { id: true, messageLanguage: true } });
    // With every language chosen, each person gets their own; otherwise only those who read one of the chosen languages.
    const recipients = isEveryLanguage(languages) ? people : people.filter((person) => (languages as string[]).includes(person.messageLanguage));
    if (recipients.length === 0) throw new ConflictException(`لا يوجد من المختارين من لغته ${languages.map((language) => LANGUAGE_NAMES[language]).join(' أو ')}`);

    const author = await this.prisma.user.findUnique({ where: { id: sender.userId }, select: { name: true } });
    const wordingFor = (language: string): Wording => content[language as keyof LanguageWordings] ?? content.ar ?? content[languages[0]]!;
    const rows = recipients.map(({ id, messageLanguage }) => {
      const wording = wordingFor(messageLanguage);
      // The text is sent as typed, and the signature tells the recipient who to answer.
      return { id: randomUUID(), userId: id, event: STAFF_MESSAGE_EVENT, title: wording.title, body: `${wording.body}\n\n— ${author?.name || 'الإدارة'} • ${section.title}` };
    });
    await this.prisma.notification.createMany({ data: rows });
    this.realtime.notificationsCreated(rows.map((row) => row.userId));
    this.push.notificationsCreated(rows);
    return { recipients: recipients.length };
  }

  private describe(event: NotificationEvent, custom?: { title: string; body: string; isActive: boolean; whatsappEnabled: boolean; crewCanSend: boolean; translations?: Prisma.JsonValue } | null) {
    const { audience, group, label, trigger, title, body } = NOTIFICATION_CATALOG[event];
    const defaults = catalogTranslations(event);
    const own = readWordings(custom?.translations);
    const defaultTranslations = { en: defaults.en ?? null, ur: defaults.ur ?? null };
    const translations = { en: own.en ?? defaultTranslations.en, ur: own.ur ?? defaultTranslations.ur };
    const { crewManual, campaign, requires } = describeEntry(event);
    return {
      event,
      audience,
      group,
      label,
      trigger,
      title: custom?.title ?? title,
      body: custom?.body ?? body,
      isActive: custom?.isActive ?? true,
      whatsappEnabled: custom?.whatsappEnabled ?? false,
      crewCanSend: custom?.crewCanSend ?? true,
      crewManual,
      campaign,
      requires,
      // A row can exist only to hold a switch, so wording decides what counts as edited.
      isCustomized: !!custom && (custom.title !== title || custom.body !== body || !!own.en || !!own.ur),
      defaultTitle: title,
      defaultBody: body,
      /** What English and Urdu readers receive now; null where no translation exists, so they get the Arabic. */
      translations,
      defaultTranslations,
      variables: describeVariables(event),
    };
  }

  async listTemplates() {
    const custom = new Map((await this.prisma.notificationTemplate.findMany()).map((row) => [row.event, row]));
    return (Object.keys(NOTIFICATION_CATALOG) as NotificationEvent[]).map((event) => this.describe(event, custom.get(event)));
  }

  private assertEvent(event: string): asserts event is NotificationEvent {
    if (!isNotificationEvent(event)) throw new NotFoundException('هذا الإشعار غير موجود');
  }

  async updateTemplate(event: string, dto: UpdateTemplateDto) {
    this.assertEvent(event);
    const problem = findTemplateProblem(event, dto.title) ?? findTemplateProblem(event, dto.body) ?? findMissingRequired(event, dto.body);
    if (problem) throw new BadRequestException(problem);
    const translations = dto.translations === undefined ? undefined : this.checkTranslations(event, dto.translations);
    const saved = await this.prisma.notificationTemplate.upsert({
      where: { event },
      create: { event, title: dto.title, body: dto.body, isActive: dto.isActive, ...(translations !== undefined && { translations }) },
      update: { title: dto.title, body: dto.body, isActive: dto.isActive, ...(translations !== undefined && { translations }) },
    });
    return this.describe(event, saved);
  }

  /** Keeps only the languages whose wording differs from the default, so a later improvement of the default still reaches the others. */
  private checkTranslations(event: NotificationEvent, typed: Record<string, { title?: string; body?: string }>): Prisma.InputJsonValue | typeof Prisma.DbNull {
    const defaults = catalogTranslations(event);
    const kept: Record<string, Wording> = {};
    for (const language of ['en', 'ur'] as const) {
      const title = typeof typed[language]?.title === 'string' ? typed[language]!.title!.trim() : '';
      const body = typeof typed[language]?.body === 'string' ? typed[language]!.body!.trim() : '';
      if (!title && !body) continue;
      const name = LANGUAGE_NAMES[language];
      if (!title || !body) throw new BadRequestException(`اكتب العنوان والنص باللغة ${name}، أو اتركهما فارغين لاستخدام الترجمة الأصلية`);
      if (title.length > 120 || body.length > 1000) throw new BadRequestException(`النص باللغة ${name} أطول من المسموح`);
      const problem = findTemplateProblem(event, title) ?? findTemplateProblem(event, body) ?? findMissingRequired(event, body);
      if (problem) throw new BadRequestException(`${name}: ${problem}`);
      if (defaults[language]?.title === title && defaults[language]?.body === body) continue;
      kept[language] = { title, body };
    }
    return Object.keys(kept).length ? kept : Prisma.DbNull;
  }

  /**
   * One message of this template, with made-up values, to the sender or a chosen number. It is never queued or logged as a
   * delivery, so the WhatsApp counts and send log keep real sends only, and it goes only through channels the template has on.
   */
  async sendTest(senderId: string, event: string, dto: TestTemplateDto) {
    this.assertEvent(event);
    const entry = NOTIFICATION_CATALOG[event];
    const language: MessageLanguage = dto.language ?? 'ar';
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });

    let wording: Wording;
    if (dto.title || dto.body) {
      if (!dto.title || !dto.body) throw new BadRequestException('اكتب العنوان والنص قبل الإرسال التجريبي');
      const problem = findTemplateProblem(event, dto.title) ?? findTemplateProblem(event, dto.body) ?? findMissingRequired(event, dto.body);
      if (problem) throw new BadRequestException(problem);
      wording = { title: customerWording(event, dto.title), body: customerWording(event, dto.body) };
    } else {
      wording = templateWording(entry, custom, event)(language);
    }

    let recipient: { id: string | null; phone: string };
    if (dto.recipient === 'PHONE') {
      const phone = normalizeSaudiPhone(dto.phone ?? '');
      recipient = (await this.prisma.user.findUnique({ where: { phone }, select: { id: true, phone: true } })) ?? { id: null, phone };
    } else {
      recipient = await this.prisma.user.findUniqueOrThrow({ where: { id: senderId }, select: { id: true, phone: true } });
    }

    const examples = Object.fromEntries(describeVariables(event).map(({ key, example }) => [key, example])) as NotificationValues;
    const values = customerValues(event, { ...examples, ...TEST_VALUES });
    const title = `${TEST_LABEL} ${renderTemplate(wording.title, values)}`;
    const body = renderTemplate(wording.body, values);
    const results: TestResult[] = [];

    if (!(custom?.isActive ?? true) || describeEntry(event).campaign) results.push({ channel: 'IN_APP', status: 'SKIPPED', detail: 'إشعار التطبيق متوقف لهذا القالب' });
    else if (!recipient.id) results.push({ channel: 'IN_APP', status: 'SKIPPED', detail: 'لا يوجد حساب في التطبيق بهذا الرقم' });
    else {
      const row = { id: randomUUID(), userId: recipient.id, event: TEMPLATE_TEST_EVENT, title, body };
      await this.prisma.notification.create({ data: row });
      this.realtime.notificationsCreated([row.userId]);
      this.push.notificationsCreated([row]);
      results.push({ channel: 'IN_APP', status: 'SENT', detail: 'أُضيف إلى إشعارات الحساب في التطبيق' });
      const devices = await this.prisma.pushToken.count({ where: { userId: recipient.id } });
      results.push(
        devices > 0
          ? { channel: 'PUSH', status: 'SENT', detail: `أُرسل تنبيه إلى ${devices === 1 ? 'جهاز واحد' : `${devices} أجهزة`}` }
          : { channel: 'PUSH', status: 'SKIPPED', detail: 'لا يوجد جهاز مسجل لهذا الحساب لاستقبال التنبيهات' },
      );
    }

    if (entry.audience === 'PASSENGER') results.push(await this.testWhatsApp(event, language, wording, values, recipient.phone, !!custom?.whatsappEnabled));

    return { language, title, body, clientTrial: this.isClientTrial, results };
  }

  /** Sent straight to Meta instead of through the queue, so it shows at once and stays out of the delivery counts. */
  private async testWhatsApp(event: NotificationEvent, language: MessageLanguage, wording: Wording, values: NotificationValues, phone: string, enabled: boolean): Promise<TestResult> {
    const skip = (detail: string): TestResult => ({ channel: 'WHATSAPP', status: 'SKIPPED', detail });
    if (!enabled) return skip('واتساب غير مفعّل لهذا القالب');
    if (this.isClientTrial) return skip('النسخة التجريبية لا ترسل عبر واتساب');
    if (!(await this.whatsapp.isConfigured())) return skip('واتساب غير مربوط بعد');
    // Only an approved copy of exactly this text can go out, so unsaved or unapproved wording is tested in the app only.
    const template = (await approvedWhatsAppTemplates(this.prisma, event, () => wording.body)).get(language);
    if (!template) return skip(`هذا النص باللغة ${LANGUAGE_NAMES[language]} غير معتمد من Meta بعد`);
    try {
      await this.whatsapp.sendTemplate(phone, template.name, template.language, template.paramOrder.map((key) => toWhatsAppParam(values[key as keyof NotificationValues])));
      return { channel: 'WHATSAPP', status: 'SENT', detail: 'استلمته Meta للإرسال' };
    } catch (err) {
      return { channel: 'WHATSAPP', status: 'FAILED', detail: err instanceof WhatsAppError ? err.message : 'تعذر الإرسال عبر واتساب' };
    }
  }

  async resetTemplate(event: string) {
    this.assertEvent(event);
    const { title, body } = NOTIFICATION_CATALOG[event];
    // Only the wording returns to its original; the channels were chosen separately.
    const existing = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    if (!existing?.whatsappEnabled && existing?.crewCanSend !== false) {
      await this.prisma.notificationTemplate.deleteMany({ where: { event } });
      return this.describe(event);
    }
    return this.describe(event, await this.prisma.notificationTemplate.update({ where: { event }, data: { title, body, isActive: true, translations: Prisma.DbNull } }));
  }
}

@ApiTags('Notifications')
@Controller('notifications')
@ApiBearerAuth()
class NotificationsController {
  constructor(
    private center: NotificationsCenterService,
    private push: PushService,
  ) {}

  @Put('mine/push-token')
  @SkipAudit()
  @ApiOperation({ summary: "Receive this account's notifications on this phone while the app is closed" })
  async registerPushToken(@Req() req, @Body() dto: RegisterPushTokenDto) {
    await this.push.register(req.user.userId, dto.token, dto.platform);
    return { ok: true };
  }

  @Delete('mine/push-token')
  @SkipAudit()
  @ApiOperation({ summary: 'Stop sending to this phone, on sign-out' })
  async removePushToken(@Req() req, @Body() dto: PushTokenDto) {
    await this.push.unregister(req.user.userId, dto.token);
    return { ok: true };
  }

  @Get('mine')
  @ApiOperation({ summary: "The current user's notifications, newest first" })
  list(@Req() req, @Query() query: ListNotificationsQuery) {
    return this.center.list(req.user.userId, query);
  }

  @Get('mine/summary')
  @ApiOperation({ summary: 'Unread count and the newest unread notification' })
  summary(@Req() req) {
    return this.center.summary(req.user.userId);
  }

  @Post('mine/read-all')
  @SkipAudit()
  @ApiOperation({ summary: 'Mark all of the current user notifications as read' })
  markAllRead(@Req() req) {
    return this.center.markAllRead(req.user.userId);
  }

  @Post('mine/:id/read')
  @SkipAudit()
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(@Req() req, @Param('id') id: string) {
    return this.center.markRead(req.user.userId, id);
  }

  @Get('staff-sections')
  @RequirePermission('notifications.send')
  @ApiOperation({ summary: "The sections the sender holds a permission in, with each section's staff" })
  sendableSections(@Req() req) {
    return this.center.sendableSections(req.user);
  }

  @Post('staff-messages')
  @RequirePermission('notifications.send')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Send a typed notification to a section's staff or chosen members of it" })
  sendToStaff(@Req() req, @Body() dto: SendStaffNotificationDto) {
    return this.center.sendToStaff(req.user, dto);
  }

  @Get('templates')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: 'Every action that notifies, with its wording and available variables' })
  listTemplates() {
    return this.center.listTemplates();
  }

  @Put('templates/:event')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: 'Change the title, body or on/off state of one action notification' })
  updateTemplate(@Param('event') event: string, @Body() dto: UpdateTemplateDto) {
    return this.center.updateTemplate(event, dto);
  }

  @Post('templates/:event/test')
  @HttpCode(200)
  @RequirePermission('notifications.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send one test of a template, with made-up values, to the sender or a chosen number' })
  sendTest(@Req() req, @Param('event') event: string, @Body() dto: TestTemplateDto) {
    return this.center.sendTest(req.user.userId, event, dto);
  }

  @Delete('templates/:event')
  @RequirePermission('notifications.manage')
  @ApiOperation({ summary: 'Return one action notification to its original wording' })
  resetTemplate(@Param('event') event: string) {
    return this.center.resetTemplate(event);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsCenterService],
})
export class NotificationsModule {}

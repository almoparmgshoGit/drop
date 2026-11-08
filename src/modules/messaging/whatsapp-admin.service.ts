import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MessageDeliveryStatus, Prisma, WhatsAppTemplateStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { readWordings } from '../../common/message-languages';
import {
  describeEntry,
  findMissingRequired,
  findWhatsAppProblem,
  isNotificationEvent,
  MESSAGE_LANGUAGES,
  MessageLanguage,
  NOTIFICATION_CATALOG,
  NotificationEvent,
  NotificationVariable,
  toWhatsAppBody,
  variableExample,
} from '../../common/notification-catalog';
import { IntegrationsService } from '../../common/services/integrations.service';
import { PrismaService } from '../../common/services/prisma.service';
import { WhatsAppError, WhatsAppService } from '../../common/services/whatsapp.service';

const LAST_CHECK_KEY = 'whatsappLastCheck';
const DAY_MS = 24 * 60 * 60_000;
const STATS_DAYS = 30;
const DEFAULT_LOG_SIZE = 50;
/** Meta's status for a template, reduced to what decides whether it can be sent. */
const META_STATUS: Record<string, WhatsAppTemplateStatus> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  FLAGGED: 'PAUSED',
  DISABLED: 'DISABLED',
  PENDING_DELETION: 'DISABLED',
  DELETED: 'DISABLED',
};
/** A receipt can arrive late or twice, and must not walk a message backwards. */
const STATUS_ALLOWED_FROM: Record<'SENT' | 'DELIVERED' | 'READ', MessageDeliveryStatus[]> = {
  SENT: ['SENDING', 'PENDING'],
  DELIVERED: ['SENDING', 'PENDING', 'SENT'],
  READ: ['SENDING', 'PENDING', 'SENT', 'DELIVERED'],
};
const RECIPIENT_FAILURE_CODES = new Set(['131026', '131021', '131050', '131008', '131009', '130472']);

const maskPhone = (phone: string) => (phone.length > 7 ? `${phone.slice(0, 5)}•••••${phone.slice(-3)}` : '•••');

const translationsOf = (event: NotificationEvent) => describeEntry(event).translations as Partial<Record<Exclude<MessageLanguage, 'ar'>, { title: string; body: string }>>;

@Injectable()
export class WhatsAppAdminService {
  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private integrations: IntegrationsService,
  ) {}

  private assertEvent(event: string): asserts event is NotificationEvent {
    if (!isNotificationEvent(event)) throw new NotFoundException('هذا الإشعار غير موجود');
  }

  /** What each action currently says in this language; the panel and the send compare it with the approved copy. */
  private currentBody(event: NotificationEvent, language: MessageLanguage, custom?: { body: string; translations?: Prisma.JsonValue } | null): string | null {
    if (language === 'ar') return custom?.body ?? NOTIFICATION_CATALOG[event].body;
    return readWordings(custom?.translations)[language]?.body ?? translationsOf(event)[language]?.body ?? null;
  }

  /** Each action's WhatsApp state and its 30-day delivery counts, for the templates page. */
  async overview() {
    const since = new Date(Date.now() - STATS_DAYS * DAY_MS);
    const [templates, customs, counts] = await Promise.all([
      this.prisma.whatsAppTemplate.findMany(),
      this.prisma.notificationTemplate.findMany({ select: { event: true, body: true, translations: true } }),
      this.prisma.messageDelivery.groupBy({ by: ['event', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const bodies = new Map(customs.map((row) => [row.event, row]));
    const notAvailable = new Map(counts.filter((row) => row.status === 'FAILED').map((row) => [row.event, 0]));
    const failedRows = await this.prisma.messageDelivery.groupBy({ by: ['event', 'errorCode'], where: { createdAt: { gte: since }, status: 'FAILED' }, _count: { _all: true } });
    failedRows.forEach((row) => {
      if (row.errorCode && RECIPIENT_FAILURE_CODES.has(row.errorCode)) notAvailable.set(row.event, (notAvailable.get(row.event) ?? 0) + row._count._all);
    });

    return (Object.keys(NOTIFICATION_CATALOG) as NotificationEvent[])
      .filter((event) => NOTIFICATION_CATALOG[event].audience === 'PASSENGER')
      .map((event) => {
        const ofEvent = counts.filter((row) => row.event === event);
        const count = (...statuses: MessageDeliveryStatus[]) => ofEvent.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
        const languages = MESSAGE_LANGUAGES.flatMap((language) => {
          const body = this.currentBody(event, language, bodies.get(event));
          if (!body) return [];
          const template = templates.find((row) => row.event === event && row.language === language);
          return [{
            language,
            name: template?.name ?? null,
            status: template?.status ?? null,
            rejectedReason: template?.rejectedReason ?? null,
            // An approved copy of older wording cannot be sent; the text must go back to Meta.
            isCurrent: !!template && template.bodySnapshot === body,
          }];
        });
        return {
          event,
          languages,
          stats: {
            sent: count('SENT', 'DELIVERED', 'READ', 'FAILED'),
            delivered: count('DELIVERED', 'READ'),
            read: count('READ'),
            failed: count('FAILED'),
            expired: count('EXPIRED'),
            notAvailable: notAvailable.get(event) ?? 0,
          },
        };
      });
  }

  async setChannels(event: string, dto: { inApp?: boolean; whatsapp?: boolean; crewCanSend?: boolean }) {
    this.assertEvent(event);
    const entry = NOTIFICATION_CATALOG[event];
    const { crewManual } = describeEntry(event);
    if (dto.whatsapp !== undefined && entry.audience !== 'PASSENGER') throw new BadRequestException('واتساب متاح لإشعارات العملاء فقط');
    if (dto.crewCanSend !== undefined && !crewManual) throw new BadRequestException('هذا الإشعار تلقائي، ولا يرسله المشرف');
    const changes = {
      ...(dto.inApp !== undefined && { isActive: dto.inApp }),
      ...(dto.whatsapp !== undefined && { whatsappEnabled: dto.whatsapp }),
      ...(dto.crewCanSend !== undefined && { crewCanSend: dto.crewCanSend }),
    };
    await this.prisma.notificationTemplate.upsert({ where: { event }, create: { event, title: entry.title, body: entry.body, ...changes }, update: changes });
    return { success: true };
  }

  async submit(event: string, language: MessageLanguage) {
    this.assertEvent(event);
    const entry = NOTIFICATION_CATALOG[event];
    if (entry.audience !== 'PASSENGER') throw new BadRequestException('واتساب متاح لإشعارات العملاء فقط');
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    const text = this.currentBody(event, language, custom);
    if (!text) throw new BadRequestException('لا يوجد نص لهذا الإشعار بهذه اللغة');
    const problem = findWhatsAppProblem(text) ?? findMissingRequired(event, text);
    if (problem) throw new BadRequestException(problem);

    const existing = await this.prisma.whatsAppTemplate.findUnique({ where: { event_language: { event, language } } });
    if (existing?.bodySnapshot === text && (existing.status === 'APPROVED' || existing.status === 'PENDING')) throw new ConflictException('هذا النص معتمد أو قيد الاعتماد');

    // Meta keeps a name once it has been used, so changed wording goes under a new one.
    const version = existing ? existing.version + 1 : 1;
    const name = `durob_${event.toLowerCase()}_${language}${version > 1 ? `_v${version}` : ''}`;
    const category = describeEntry(event).campaign ? 'MARKETING' : 'UTILITY';
    const { body, order } = toWhatsAppBody(text);
    let result: Awaited<ReturnType<WhatsAppService['submitTemplate']>>;
    try {
      result = await this.whatsapp.submitTemplate({ name, language, category, body, examples: order.map((key: NotificationVariable) => variableExample(key)) });
    } catch (err) {
      throw new ConflictException(err instanceof WhatsAppError ? err.message : 'تعذر إرسال القالب للاعتماد');
    }
    const status = META_STATUS[result.status] ?? 'PENDING';
    const data = { name, category, status, bodySnapshot: text, paramOrder: order as string[], metaId: result.metaId, rejectedReason: null, version, submittedAt: new Date(), approvedAt: status === 'APPROVED' ? new Date() : null };
    return this.prisma.whatsAppTemplate.upsert({ where: { event_language: { event, language } }, create: { event, language, ...data }, update: data });
  }

  /** Asks Meta for the state of every template, for when a webhook was missed or was not set up yet. */
  async sync() {
    let remote: Awaited<ReturnType<WhatsAppService['listTemplates']>>;
    try {
      remote = await this.whatsapp.listTemplates();
    } catch (err) {
      throw new ConflictException(err instanceof WhatsAppError ? err.message : 'تعذرت المزامنة');
    }
    const ours = await this.prisma.whatsAppTemplate.findMany();
    let changed = 0;
    for (const row of ours) {
      const match = remote.find((item) => item.name === row.name && item.language === row.language);
      const status = match?.status ? META_STATUS[match.status] : undefined;
      if (!status || status === row.status) continue;
      await this.prisma.whatsAppTemplate.update({
        where: { id: row.id },
        data: { status, metaId: match?.id ?? row.metaId, rejectedReason: status === 'REJECTED' ? (match?.rejected_reason ?? null) : null, ...(status === 'APPROVED' && { approvedAt: new Date() }) },
      });
      changed++;
    }
    return { checked: ours.length, changed };
  }

  async status(webhookUrl: string) {
    const [phoneId, businessId, token, appSecret, verifyToken, lastCheck] = await Promise.all([
      this.integrations.value('whatsappPhoneId'),
      this.integrations.value('whatsappBusinessAccountId'),
      this.integrations.value('whatsappToken'),
      this.integrations.value('whatsappAppSecret'),
      this.integrations.value('whatsappWebhookVerifyToken'),
      this.prisma.setting.findUnique({ where: { key: LAST_CHECK_KEY } }),
    ]);
    const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [monthSent, approved] = await Promise.all([
      this.prisma.messageDelivery.count({ where: { createdAt: { gte: startOfMonth }, status: { in: ['SENT', 'DELIVERED', 'READ'] } } }),
      this.prisma.whatsAppTemplate.count({ where: { status: 'APPROVED' } }),
    ]);
    return {
      steps: { phoneId: !!phoneId, businessId: !!businessId, token: !!token, appSecret: !!appSecret, verifyToken: !!verifyToken },
      isReady: !!phoneId && !!token,
      lastCheck: lastCheck ? (JSON.parse(lastCheck.value) as object) : null,
      webhookUrl,
      monthSent,
      approvedTemplates: approved,
    };
  }

  async test() {
    const at = new Date().toISOString();
    let check: object;
    try {
      check = { ok: true, at, ...(await this.whatsapp.test()) };
    } catch (err) {
      check = { ok: false, at, message: err instanceof WhatsAppError ? err.message : 'تعذر الاختبار' };
    }
    const value = JSON.stringify(check);
    await this.prisma.setting.upsert({ where: { key: LAST_CHECK_KEY }, create: { key: LAST_CHECK_KEY, value }, update: { value } });
    return check;
  }

  /** The send log. Phones are masked: finding a customer's number is the customers page's job, under its own permission. */
  async log(query: { status?: MessageDeliveryStatus; event?: string; before?: string; limit?: number }) {
    const limit = query.limit ?? DEFAULT_LOG_SIZE;
    const where: Prisma.MessageDeliveryWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.event && { event: query.event }),
      ...(query.before && { createdAt: { lt: new Date(query.before) } }),
    };
    const rows = await this.prisma.messageDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: { id: true, event: true, language: true, templateName: true, status: true, attempts: true, errorMessage: true, createdAt: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true, tripId: true, campaign: { select: { title: true } }, user: { select: { name: true, phone: true } } },
    });
    return {
      hasMore: rows.length > limit,
      items: rows.slice(0, limit).map(({ user, ...row }) => ({
        ...row,
        label: isNotificationEvent(row.event) ? NOTIFICATION_CATALOG[row.event].label : row.event,
        customerName: user.name,
        phone: maskPhone(user.phone),
      })),
    };
  }

  /** Meta signs the exact bytes it sent. Comparing in constant time keeps the signature from being guessed byte by byte. */
  async isSignatureValid(rawBody: Buffer | undefined, header: unknown) {
    const secret = await this.integrations.value('whatsappAppSecret');
    if (!secret || !rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const given = Buffer.from(header.slice('sha256='.length), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async isVerifyTokenValid(token: unknown) {
    const expected = await this.integrations.value('whatsappWebhookVerifyToken');
    if (!expected || typeof token !== 'string') return false;
    const hash = (value: string) => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(hash(token), hash(expected));
  }

  /** Reads only what it knows from a payload whose shape is Meta's to change. */
  async applyWebhook(payload: any) {
    const changes = (Array.isArray(payload?.entry) ? payload.entry : []).flatMap((entry: any) => (Array.isArray(entry?.changes) ? entry.changes : []));
    for (const change of changes) {
      if (change?.field === 'message_template_status_update') {
        await this.applyTemplateStatus(change.value);
        continue;
      }
      const statuses = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
      for (const status of statuses) await this.applyDeliveryStatus(status);
    }
  }

  private async applyTemplateStatus(value: any) {
    const status = typeof value?.event === 'string' ? META_STATUS[value.event] : undefined;
    const metaId = value?.message_template_id === undefined ? undefined : String(value.message_template_id);
    const name = typeof value?.message_template_name === 'string' ? value.message_template_name : undefined;
    if (!status || (!metaId && !name)) return;
    await this.prisma.whatsAppTemplate.updateMany({
      where: { OR: [...(metaId ? [{ metaId }] : []), ...(name ? [{ name }] : [])] },
      data: { status, rejectedReason: status === 'REJECTED' && typeof value?.reason === 'string' ? value.reason.slice(0, 300) : null, ...(status === 'APPROVED' && { approvedAt: new Date() }) },
    });
  }

  private async applyDeliveryStatus(status: any) {
    const providerMessageId = typeof status?.id === 'string' ? status.id : null;
    if (!providerMessageId) return;
    const now = new Date();
    const where = { providerMessageId };
    if (status.status === 'sent') await this.prisma.messageDelivery.updateMany({ where: { ...where, status: { in: STATUS_ALLOWED_FROM.SENT } }, data: { status: 'SENT' } });
    else if (status.status === 'delivered') await this.prisma.messageDelivery.updateMany({ where: { ...where, status: { in: STATUS_ALLOWED_FROM.DELIVERED } }, data: { status: 'DELIVERED', deliveredAt: now } });
    else if (status.status === 'read') await this.prisma.messageDelivery.updateMany({ where: { ...where, status: { in: STATUS_ALLOWED_FROM.READ } }, data: { status: 'READ', readAt: now } });
    else if (status.status === 'failed') {
      const code = status.errors?.[0]?.code === undefined ? null : String(status.errors[0].code);
      // Meta's own error text stays out of the panel, because it can repeat what was sent.
      const errorMessage = code && RECIPIENT_FAILURE_CODES.has(code) ? 'الرقم غير متاح على واتساب' : 'لم تسلّم Meta الرسالة';
      await this.prisma.messageDelivery.updateMany({ where: { ...where, status: { notIn: ['READ', 'DELIVERED'] } }, data: { status: 'FAILED', failedAt: now, errorCode: code, errorMessage } });
    }
  }
}

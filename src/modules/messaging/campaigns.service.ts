import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NOTIFICATION_CATALOG } from '../../common/notification-catalog';
import { permissionsOf } from '../../common/permissions';
import { NATIONALITIES } from '../../common/profile-options';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { approvedWhatsAppTemplates, CatalogView, templateWording, whatsappDelivery } from '../../common/services/notifications.service';
import { LanguageWordings, normalizeLanguages, readWordings, typedWordings, Wording } from '../../common/message-languages';
import { PrismaService } from '../../common/services/prisma.service';
import { PushService } from '../../common/services/push.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { randomUUID } from 'crypto';
import { assertAudienceFilters, AudienceFilters, audienceWhere, isMarketingCampaign } from './audience.util';
import { CampaignDto, SendCampaignDto } from './campaigns.dto';

const CAMPAIGN_EVENT = 'CUSTOMER_CAMPAIGN';
const CHUNK_SIZE = 500;
const LOCK_MS = 2 * 60_000;
const MAX_SCHEDULE_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
/** A scheduled audience is expected to move a little between approval and sending, not to double. */
const GROWTH_ALLOWED = 1.1;
const GROWTH_FLOOR = 5;
const FALLBACK_NAME = 'عميلنا العزيز';
const OPTION_TRIPS = 30;
const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
/** Filters that belong together are counted as one targeting choice. */
const TARGETING_GROUPS: (keyof AudienceFilters)[][] = [
  ['tripIds', 'thisWeekTrips'],
  ['destinations'],
  ['origins'],
  ['bookingTypes'],
  ['nationalities'],
  ['genders'],
  ['lastTripMinDays', 'lastTripMaxDays', 'noUpcomingTrip'],
  ['customerType'],
  ['payment'],
  ['housing'],
  ['packagesOnly'],
  ['bookedWithinDays'],
  ['inactiveDays'],
  ['hasWallet'],
  ['languages'],
];
/** Each value of a many-choice filter gets its own count, up to this many, so a long list does not flood the database. */
const MAX_TARGET_VALUES = 15;

export interface CampaignActor {
  userId: string;
  permissions: string[];
}

const COUPON_LABEL: Record<string, string> = { ar: 'كوبونك', en: 'Your coupon', ur: 'آپ کا کوپن' };
const couponLine = (code: string, language: string) => `\n\n${COUPON_LABEL[language] ?? COUPON_LABEL.ar}: ${code}`;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private prisma: PrismaService,
    private appSettings: AppSettingsService,
    private realtime: RealtimeService,
    private push: PushService,
  ) {}

  private usableCoupon = (now = new Date()): Prisma.CouponWhereInput => ({
    isActive: true,
    // A voucher bought with points belongs to one customer and must not be handed to a crowd.
    ownerUserId: null,
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
  });

  /** The approved WhatsApp template per language; a language without its own uses the Arabic one. */
  private async campaignWhatsApp(couponId?: string | null) {
    const event = couponId ? 'CAMPAIGN_OFFER' : 'CAMPAIGN_ANNOUNCEMENT';
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { event } });
    if (!custom?.whatsappEnabled) return { event, template: null, forLanguage: () => null };
    const wording = templateWording(NOTIFICATION_CATALOG[event] as CatalogView, custom);
    const approved = await approvedWhatsAppTemplates(this.prisma, event, (language) => wording(language).body);
    const template = approved.get('ar') ?? approved.values().next().value ?? null;
    return { event, template, forLanguage: (language: string) => approved.get(language) ?? approved.get('ar') ?? null };
  }

  async options() {
    const now = new Date();
    const [trips, places, nationalities, coupons, plain, offer] = await Promise.all([
      this.prisma.trip.findMany({
        where: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] }, departureTime: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
        orderBy: { departureTime: 'asc' },
        take: 300,
        select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true },
      }),
      this.prisma.trip.findMany({ where: { tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } }, distinct: ['origin', 'destination'], select: { origin: true, destination: true }, take: 200 }),
      this.prisma.user.findMany({ where: { nationality: { not: null } }, distinct: ['nationality'], select: { nationality: true }, take: 100 }),
      this.prisma.coupon.findMany({ where: this.usableCoupon(now), orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, code: true, type: true, value: true, validUntil: true } }),
      this.campaignWhatsApp(null),
      this.campaignWhatsApp('offer'),
    ]);
    const upcoming = trips.filter((trip) => trip.departureTime >= now);
    return {
      // The next trips come first, because a message is usually about them.
      trips: [...upcoming, ...trips.filter((trip) => trip.departureTime < now).reverse()],
      upcomingCount: Math.min(upcoming.length, OPTION_TRIPS),
      destinations: [...new Set(places.map((row) => row.destination))].sort(),
      origins: [...new Set(places.map((row) => row.origin))].sort(),
      nationalities: [...new Set([...NATIONALITIES, ...nationalities.flatMap((row) => (row.nationality ? [row.nationality] : []))])],
      coupons,
      whatsappReady: { plain: !!plain.template, offer: !!offer.template },
    };
  }

  async audience(filters: AudienceFilters, couponId?: string | null) {
    assertAudienceFilters(filters);
    const isMarketing = isMarketingCampaign(filters, couponId);
    const where = audienceWhere(filters, isMarketing);
    const [count, withoutOptOut, nationalities, genders, languages] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: audienceWhere(filters, false) }),
      this.prisma.user.groupBy({ by: ['nationality'], where, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['gender'], where, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['messageLanguage'], where, _count: { _all: true } }),
    ]);
    const byLanguage: Record<string, number> = { ar: 0, en: 0, ur: 0 };
    for (const row of languages) byLanguage[row.messageLanguage] = (byLanguage[row.messageLanguage] ?? 0) + row._count._all;
    // Who the message will reach, so the sender can see the mix before choosing the words and the language.
    const byNationality = nationalities
      .map((row) => ({ nationality: row.nationality, count: row._count._all }))
      .sort((a, b) => b.count - a.count || (a.nationality === null ? 1 : b.nationality === null ? -1 : 0));
    const byGender = { MALE: 0, FEMALE: 0, UNKNOWN: 0 };
    for (const row of genders) byGender[row.gender ?? 'UNKNOWN'] += row._count._all;
    return { count, optedOut: withoutOptOut - count, isMarketing, byNationality, byGender, byLanguage };
  }

  list() {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        status: true,
        isMarketing: true,
        sendInApp: true,
        sendWhatsapp: true,
        scheduledAt: true,
        startedAt: true,
        finishedAt: true,
        recipients: true,
        whatsappQueued: true,
        confirmedCount: true,
        failureReason: true,
        createdByName: true,
        sentByName: true,
        createdAt: true,
        coupon: { select: { code: true } },
      },
    });
  }

  async get(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, include: { coupon: { select: { id: true, code: true } } } });
    if (!campaign) throw new NotFoundException('الرسالة غير موجودة');
    return campaign;
  }

  /**
   * The campaign with its targeting taken apart: each chosen filter, and each value inside it, counted on its own,
   * next to the combined audience it will reach now and what it reached on each channel.
   */
  async report(id: string) {
    const campaign = await this.get(id);
    const filters = (campaign.filters ?? {}) as unknown as AudienceFilters;
    const count = (subset: AudienceFilters) => this.prisma.user.count({ where: audienceWhere(subset, campaign.isMarketing) });
    const chosen = (keys: (keyof AudienceFilters)[]) => {
      const subset = Object.fromEntries(
        keys.flatMap((key) => {
          const value = filters[key];
          return (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== false) ? [[key, value]] : [];
        }),
      ) as AudienceFilters;
      return Object.keys(subset).length ? subset : null;
    };

    const targeting = await Promise.all(
      TARGETING_GROUPS.flatMap((keys) => {
        const subset = chosen(keys);
        // All three languages is everyone, so it is not a choice that narrows anything.
        if (!subset || (keys[0] === 'languages' && (subset.languages?.length ?? 0) >= 3)) return [];
        const [first] = keys;
        const values = Array.isArray(subset[first]) && (subset[first] as unknown[]).length > 1 ? (subset[first] as string[]).slice(0, MAX_TARGET_VALUES) : [];
        return [
          (async () => ({
            filters: subset,
            count: await count(subset),
            values: await Promise.all(values.map(async (value) => ({ filters: { [first]: [value] } as AudienceFilters, count: await count({ [first]: [value] } as AudienceFilters) }))),
          }))(),
        ];
      }),
    );

    const [audienceNow, everyone, whatsappRows] = await Promise.all([
      count(filters),
      count({}),
      this.prisma.messageDelivery.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
    ]);
    const whatsapp: Record<string, number> = {};
    for (const row of whatsappRows) whatsapp[row.status] = row._count._all;
    return { campaign, targeting, audienceNow, everyone, whatsapp };
  }

  private async assertCoupon(couponId?: string | null) {
    if (!couponId) return;
    const coupon = await this.prisma.coupon.findFirst({ where: { id: couponId, ...this.usableCoupon() } });
    if (!coupon) throw new BadRequestException('الكوبون غير متاح: قد يكون موقوفًا أو منتهيًا');
  }

  private assertChannels(dto: Pick<CampaignDto, 'sendInApp' | 'sendWhatsapp'>) {
    if (!dto.sendInApp && !dto.sendWhatsapp) throw new BadRequestException('اختر قناة إرسال واحدة على الأقل');
  }

  private toData(dto: CampaignDto) {
    assertAudienceFilters(dto.filters);
    const languages = normalizeLanguages(dto.filters.languages);
    const content = typedWordings(languages, dto, { title: 120, body: 500 });
    const first = content[languages[0]] ?? content.ar!;
    // Stored as all three or a narrower choice, never empty, so the record says plainly who it was for.
    const filters = { ...dto.filters, languages };
    return {
      title: first.title,
      body: first.body,
      content: content as Prisma.InputJsonValue,
      filters: filters as unknown as Prisma.InputJsonValue,
      sendInApp: dto.sendInApp,
      sendWhatsapp: dto.sendWhatsapp,
      couponId: dto.couponId ?? null,
      isMarketing: isMarketingCampaign(dto.filters, dto.couponId),
    };
  }

  async create(actor: CampaignActor, dto: CampaignDto) {
    this.assertChannels(dto);
    await this.assertCoupon(dto.couponId);
    const author = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    return this.prisma.campaign.create({ data: { ...this.toData(dto), createdById: actor.userId, createdByName: author?.name } });
  }

  async update(id: string, dto: CampaignDto) {
    this.assertChannels(dto);
    await this.assertCoupon(dto.couponId);
    // Editing takes a scheduled message back to a draft, because the approval was for the old words and the old audience.
    const updated = await this.prisma.campaign.updateMany({ where: { id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data: { ...this.toData(dto), status: 'DRAFT', scheduledAt: null, confirmedCount: null } });
    if (updated.count === 0) throw new ConflictException('لا يمكن تعديل رسالة أُرسلت');
    return this.get(id);
  }

  async remove(id: string) {
    const removed = await this.prisma.campaign.deleteMany({ where: { id, status: 'DRAFT' } });
    if (removed.count === 0) throw new ConflictException('تُحذف المسودات فقط');
    return { success: true };
  }

  async cancel(id: string) {
    const cancelled = await this.prisma.campaign.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    if (cancelled.count === 0) throw new ConflictException('تُلغى الرسائل المجدولة فقط');
    return this.get(id);
  }

  /** The sender states the count they saw, so a change of audience stops the send rather than surprising them. */
  async send(actor: CampaignActor, id: string, dto: SendCampaignDto) {
    const campaign = await this.get(id);
    if (campaign.status !== 'DRAFT') throw new ConflictException('هذه الرسالة أُرسلت أو جُدولت من قبل');
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt) {
      const lead = scheduledAt.getTime() - Date.now();
      if (lead <= 0) throw new BadRequestException('موعد الإرسال يجب أن يكون في المستقبل');
      if (lead > MAX_SCHEDULE_DAYS * DAY_MS) throw new BadRequestException(`لا يمكن الجدولة لأكثر من ${MAX_SCHEDULE_DAYS} يومًا`);
    }

    await this.assertCoupon(campaign.couponId);
    const filters = campaign.filters as unknown as AudienceFilters;
    const count = await this.prisma.user.count({ where: audienceWhere(filters, campaign.isMarketing) });
    if (count === 0) throw new ConflictException('لا يوجد عملاء يطابقون هذه الفلاتر');
    if (count !== dto.confirmCount) throw new ConflictException(`تغير عدد الجمهور إلى ${count}، راجعه ثم أرسل من جديد`);
    if (!actor.permissions.includes('notifications.campaigns_unlimited')) {
      const limit = await this.appSettings.number('campaignMaxRecipients');
      if (count > limit) throw new ForbiddenException(`الحد الأقصى للرسالة الواحدة ${limit} عميل، ويتجاوزه من يملك صلاحية الإرسال فوق الحد`);
    }
    if (campaign.sendWhatsapp && !(await this.campaignWhatsApp(campaign.couponId)).template) {
      throw new ConflictException('لا يوجد قالب واتساب معتمد ومفعل لهذه الرسالة. فعّله من صفحة القوالب أو أرسل عبر التطبيق فقط');
    }

    const sender = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const claimed = await this.prisma.campaign.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: scheduledAt ? 'SCHEDULED' : 'SENDING', scheduledAt, confirmedCount: count, sentById: actor.userId, sentByName: sender?.name, ...(scheduledAt ? {} : { startedAt: new Date() }) },
    });
    if (claimed.count === 0) throw new ConflictException('هذه الرسالة أُرسلت أو جُدولت من قبل');
    return this.get(id);
  }

  /** Called on a timer. Claiming through lockedUntil keeps a second server from sending the same chunk, and the cursor lets a restart continue. */
  async sweep() {
    const now = new Date();
    const due = await this.prisma.campaign.findMany({
      where: { OR: [{ status: 'SCHEDULED', scheduledAt: { lte: now } }, { status: 'SENDING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }] },
      select: { id: true },
      take: 10,
    });
    for (const { id } of due) {
      try {
        await this.dispatch(id);
      } catch (err) {
        this.logger.error(`Campaign ${id} failed: ${(err as Error).message}`);
      }
    }
  }

  private stop(id: string, reason: string) {
    return this.prisma.campaign.update({ where: { id }, data: { status: 'CANCELLED', failureReason: reason, lockedUntil: null, finishedAt: new Date() } });
  }

  async dispatch(id: string) {
    const now = new Date();
    const claimed = await this.prisma.campaign.updateMany({
      where: { id, OR: [{ status: 'SCHEDULED', scheduledAt: { lte: now } }, { status: 'SENDING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }] },
      data: { status: 'SENDING', lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
    if (claimed.count === 0) return;
    const campaign = await this.get(id);
    const filters = campaign.filters as unknown as AudienceFilters;
    const where = audienceWhere(filters, campaign.isMarketing);

    // Hours can pass after scheduling, and what held then may not hold now.
    if (!campaign.startedAt) {
      const sender = campaign.sentById
        ? await this.prisma.user.findUnique({ where: { id: campaign.sentById }, select: { role: true, extraPermissions: true, revokedPermissions: true, rank: { select: { permissions: true } } } })
        : null;
      if (!sender || !permissionsOf(sender).includes('notifications.campaigns')) return this.stop(id, 'لم يعد المرسل يملك صلاحية إرسال الرسائل للعملاء');
      if (campaign.couponId && (await this.prisma.coupon.count({ where: { id: campaign.couponId, ...this.usableCoupon() } })) === 0) return this.stop(id, 'الكوبون المرفق لم يعد متاحًا');
      const count = await this.prisma.user.count({ where });
      const approved = campaign.confirmedCount ?? 0;
      if (count > Math.ceil(approved * GROWTH_ALLOWED) + GROWTH_FLOOR) return this.stop(id, `كبر الجمهور من ${approved} إلى ${count} منذ الجدولة، فأُوقف الإرسال لمراجعته`);
      await this.prisma.campaign.update({ where: { id }, data: { startedAt: new Date() } });
    }

    const whatsapp = campaign.sendWhatsapp ? await this.campaignWhatsApp(campaign.couponId) : null;
    if (campaign.sendWhatsapp && !whatsapp?.template) {
      await this.prisma.campaign.update({ where: { id }, data: { failureReason: 'سُحب اعتماد قالب واتساب، فأُرسلت عبر التطبيق فقط' } });
      if (!campaign.sendInApp) return this.stop(id, 'سُحب اعتماد قالب واتساب، ولا توجد قناة أخرى لهذه الرسالة');
    }
    const code = campaign.coupon?.code;
    // Older messages have no content and go to everyone in Arabic, as they always did.
    const content: LanguageWordings = campaign.content ? readWordings(campaign.content) : { ar: { title: campaign.title, body: campaign.body } };
    const fallback: Wording = content.ar ?? Object.values(content)[0] ?? { title: campaign.title, body: campaign.body };
    const wordingFor = (language: string) => content[language as keyof LanguageWordings] ?? fallback;
    const languageOf = (language: string) => (content[language as keyof LanguageWordings] ? language : content.ar ? 'ar' : language);
    const expiresMinutes = whatsapp ? (NOTIFICATION_CATALOG[whatsapp.event as 'CAMPAIGN_OFFER'].expiresMinutes as number) : undefined;

    let cursor = campaign.cursor;
    for (;;) {
      const finished = await this.prisma.$transaction(async (tx) => {
        // Taking the lock here means a chunk commits with the cursor that says it is done, whatever happens next.
        const current = await tx.campaign.findUnique({ where: { id }, select: { status: true, cursor: true } });
        if (current?.status !== 'SENDING' || current.cursor !== cursor) return true;
        const users = await tx.user.findMany({
          where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
          orderBy: { id: 'asc' },
          take: CHUNK_SIZE,
          select: { id: true, name: true, messageLanguage: true },
        });
        if (users.length === 0) {
          await tx.campaign.update({ where: { id }, data: { status: 'SENT', finishedAt: new Date(), lockedUntil: null } });
          return true;
        }
        if (campaign.sendInApp) {
          const rows = users.map((user) => {
            const wording = wordingFor(user.messageLanguage);
            return { id: randomUUID(), userId: user.id, event: CAMPAIGN_EVENT, title: wording.title, body: code ? `${wording.body}${couponLine(code, languageOf(user.messageLanguage))}` : wording.body };
          });
          await tx.notification.createMany({ data: rows });
          this.realtime.notificationsCreated(rows.map((row) => row.userId));
          this.push.notificationsCreated(rows);
        }
        const template = whatsapp?.template;
        let queued = 0;
        if (template) {
          const data = users.flatMap((user) => {
            const chosen = whatsapp!.forLanguage(user.messageLanguage);
            if (!chosen) return [];
            return [whatsappDelivery(user.id, whatsapp!.event, chosen, { userName: user.name || FALLBACK_NAME, message: wordingFor(user.messageLanguage).body, couponCode: code }, undefined, expiresMinutes, id)];
          });
          queued = data.length;
          await tx.messageDelivery.createMany({ data });
        }
        cursor = users[users.length - 1].id;
        await tx.campaign.update({
          where: { id },
          data: { cursor, recipients: { increment: users.length }, whatsappQueued: { increment: queued }, lockedUntil: new Date(Date.now() + LOCK_MS) },
        });
        return false;
      }, TX_OPTIONS);
      if (finished) return;
    }
  }
}

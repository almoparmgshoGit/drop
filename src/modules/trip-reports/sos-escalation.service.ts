import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { RedisService } from '../../common/services/redis.service';
import { reportCode } from './trip-reports.service';

/** An SOS nobody acknowledged within this long goes up to the managers. */
export const SOS_ESCALATE_AFTER_MS = 2 * 60_000;
/** Often enough that an escalation is at most this late past the two minutes. */
const SWEEP_MS = 20_000;
const LOCK_KEY = 'lock:sos-escalation';
const LOCK_TTL_SECONDS = 18;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const TYPE_LABELS = { DELAY: 'تأخير', BREAKDOWN: 'عطل في الحافلة', ACCIDENT: 'حادث', PASSENGER: 'مشكلة مع مسافر', OTHER: 'أخرى' } as const;

/**
 * Escalates an SOS that nobody in the office acknowledged in two minutes: the managers (admins and whoever may manage
 * reports) get an in-app notification and a push, and open dashboards hear it at once. escalatedAt is the claim, so it
 * happens once per SOS even if this runs twice or on two servers.
 */
@Injectable()
export class SosEscalationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SosEscalationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  onModuleInit() {
    // Tests run the sweep themselves.
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.tick(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      if (!locked) return;
      await this.sweep();
    } catch (err) {
      this.logger.error(`SOS escalation sweep failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }

  /** Escalates every SOS that waited too long; returns the reports it escalated. */
  async sweep(now = new Date()) {
    const due = await this.prisma.tripReport.findMany({
      where: { category: 'SOS', status: { not: 'RESOLVED' }, acknowledgedAt: null, escalatedAt: null, createdAt: { lte: new Date(now.getTime() - SOS_ESCALATE_AFTER_MS) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    const escalated: string[] = [];
    for (const { id } of due) {
      try {
        if (await this.escalate(id, now)) escalated.push(id);
      } catch (err) {
        this.logger.error(`Could not escalate SOS ${id}: ${(err as Error).message}`);
      }
    }
    return escalated;
  }

  async escalate(reportId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      // The claim: an acknowledgement that landed meanwhile wins, and a second sweep finds nothing to do.
      const claimed = await tx.tripReport.updateMany({ where: { id: reportId, acknowledgedAt: null, escalatedAt: null, status: { not: 'RESOLVED' } }, data: { escalatedAt: now } });
      if (claimed.count === 0) return false;
      const report = await tx.tripReport.findUniqueOrThrow({ where: { id: reportId }, select: { id: true, number: true, tripId: true, type: true, details: true, createdByName: true } });
      await tx.tripReportUpdate.create({ data: { reportId, note: 'لم يُقرّ أحد باستلام الاستغاثة خلال دقيقتين، فصُعّدت إلى المدراء', actorId: 'system', actorName: 'النظام', fromOffice: true } });
      await this.notifications.toStaff(
        tx,
        'STAFF_SOS_ESCALATED',
        ['reports.manage'],
        { reporterName: report.createdByName, reportType: TYPE_LABELS[report.type], reportDetails: report.details, reportCode: reportCode(report.number), reportCategory: 'استغاثة' },
        { tripId: report.tripId, reportId },
      );
      this.realtime.sosChanged(reportId, 'escalated');
      return true;
    }, TX_OPTIONS);
  }
}

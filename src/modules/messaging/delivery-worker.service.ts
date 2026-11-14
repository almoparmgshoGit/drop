import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { StationAlertsService } from '../../common/services/station-alerts.service';
import { WhatsAppError, WhatsAppService } from '../../common/services/whatsapp.service';
import { CampaignsService } from './campaigns.service';

const DELIVERY_SWEEP_MS = 15_000;
const STATION_SWEEP_MS = 30_000;
const SLOW_SWEEP_MS = 5 * 60_000;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const ACCOUNT_WAIT_MS = 5 * 60_000;
const BASE_RETRY_MS = 60_000;
/** A server that died mid-send leaves its rows claimed; after this long another may take them. */
const STALE_CLAIM_MS = 5 * 60_000;

type Claimed = { id: string; templateName: string; language: string; params: Prisma.JsonValue; attempts: number; user: { phone: string } };

/** Everything that happens later than the request: WhatsApp's queue, scheduled messages and station alerts. */
@Injectable()
export class DeliveryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorkerService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private campaigns: CampaignsService,
    private stations: StationAlertsService,
  ) {}

  onModuleInit() {
    this.every(DELIVERY_SWEEP_MS, 'deliveries', () => this.sweepDeliveries());
    this.every(DELIVERY_SWEEP_MS, 'campaigns', () => this.campaigns.sweep());
    this.every(STATION_SWEEP_MS, 'stations', () => this.stations.sweep());
    this.every(STATION_SWEEP_MS, 'passenger-reminders', () => this.stations.sweepPassengerReminders());
    // The day-before reminder is now sent per booking, with the 2-hour one, by TripRemindersService (trip-followup).
    this.every(SLOW_SWEEP_MS, 'reminders', () => this.stations.sweepExpiredHolds());
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** A slow run is skipped over, not stacked on top of itself. */
  private every(ms: number, name: string, run: () => Promise<unknown>) {
    const timer = setInterval(() => {
      if (this.running.has(name)) return;
      this.running.add(name);
      run()
        .catch((err) => this.logger.error(`${name} sweep failed: ${err.message}`))
        .finally(() => this.running.delete(name));
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private async finish(id: string, data: Prisma.MessageDeliveryUpdateInput) {
    // The values may hold a name and a booking number, and are no use once the message has left or given up.
    await this.prisma.messageDelivery.updateMany({ where: { id }, data: { ...(data as Prisma.MessageDeliveryUpdateManyMutationInput), params: Prisma.DbNull, claimedAt: null } });
  }

  async sweepDeliveries() {
    const now = new Date();
    await this.prisma.messageDelivery.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED', params: Prisma.DbNull, failedAt: now, errorMessage: 'انتهت مدة صلاحية الرسالة قبل إرسالها' },
    });
    await this.prisma.messageDelivery.updateMany({ where: { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }, data: { status: 'PENDING', claimedAt: null } });

    // Waiting is cheap, and messages queued before the keys are saved still have their expiry to protect them.
    const waiting = await this.prisma.messageDelivery.count({ where: { status: 'PENDING', nextAttemptAt: { lte: now } } });
    if (waiting === 0 || !(await this.whatsapp.isConfigured())) return;

    // SKIP LOCKED lets a second server take the next rows instead of the same ones.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "MessageDelivery" SET "status" = 'SENDING', "claimedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "MessageDelivery"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    if (rows.length === 0) return;
    const claimed: Claimed[] = await this.prisma.messageDelivery.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      select: { id: true, templateName: true, language: true, params: true, attempts: true, user: { select: { phone: true } } },
    });

    for (let index = 0; index < claimed.length; index++) {
      const paused = await this.deliver(claimed[index]);
      if (paused) {
        // Every other message would fail the same way, and each failure counts against the account.
        await this.prisma.messageDelivery.updateMany({
          where: { id: { in: claimed.slice(index + 1).map((row) => row.id) } },
          data: { status: 'PENDING', claimedAt: null, nextAttemptAt: new Date(Date.now() + ACCOUNT_WAIT_MS) },
        });
        return;
      }
    }
  }

  /** Returns true when the whole queue should wait. */
  private async deliver(row: Claimed) {
    const params = Array.isArray(row.params) ? row.params.map(String) : [];
    try {
      const messageId = await this.whatsapp.sendTemplate(row.user.phone, row.templateName, row.language, params);
      await this.finish(row.id, { status: 'SENT', sentAt: new Date(), providerMessageId: messageId, attempts: { increment: 1 }, errorCode: null, errorMessage: null });
      return false;
    } catch (err) {
      const failure = err instanceof WhatsAppError ? err : new WhatsAppError('تعذر الإرسال مؤقتًا', 'TEMPORARY');
      const errorCode = failure.code === undefined ? null : String(failure.code);
      if (failure.kind === 'ACCOUNT') {
        await this.prisma.messageDelivery.update({ where: { id: row.id }, data: { status: 'PENDING', claimedAt: null, nextAttemptAt: new Date(Date.now() + ACCOUNT_WAIT_MS), errorCode, errorMessage: failure.message } });
        this.logger.warn(`WhatsApp queue paused: ${failure.message}`);
        return true;
      }
      const attempts = row.attempts + 1;
      if (failure.kind === 'TEMPORARY' && attempts < MAX_ATTEMPTS) {
        await this.prisma.messageDelivery.update({ where: { id: row.id }, data: { status: 'PENDING', claimedAt: null, attempts, nextAttemptAt: new Date(Date.now() + BASE_RETRY_MS * 2 ** attempts), errorCode, errorMessage: failure.message } });
        return false;
      }
      await this.finish(row.id, { status: 'FAILED', failedAt: new Date(), attempts, errorCode, errorMessage: failure.message });
      return false;
    }
  }
}

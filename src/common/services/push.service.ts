import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { PrismaService } from './prisma.service';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo's own limits per request. */
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;
/** Expo asks for receipts to be read no sooner than this; by then Firebase and Apple have answered. */
const RECEIPT_DELAY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Shared with the app, which creates this Android channel (with the app's own sound) before asking for the token.
 * An app build older than the channel shows the message on Expo's fallback channel instead.
 */
const ANDROID_CHANNEL_ID = 'durob_alerts';
const BODY_LIMIT = 500;

export const EXPO_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[\w-]+\]$/;

/** One stored notification, as the phone should show it. */
export interface PushMessage {
  id: string;
  userId: string;
  event: string;
  title: string;
  body: string;
  bookingId?: string | null;
  tripId?: string | null;
  reportId?: string | null;
}

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };
type Receipt = { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } };

/**
 * Shows notifications on phones whose app is closed. The database stays the record: a push that never
 * arrives only means the person reads it when they open the app, so nothing here can fail the action.
 */
@Injectable()
export class PushService implements OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
  ) {}

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
  }

  /** Call right after the rows are written; it waits for the surrounding transaction to commit. */
  notificationsCreated(messages: PushMessage[]) {
    if (messages.length === 0) return;
    this.prisma.afterCommit(() => {
      this.deliver(messages).catch((err) => this.logger.warn(`Push failed: ${(err as Error).message}`));
    });
  }

  async register(userId: string, token: string, platform: string) {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { token, userId, platform },
      update: { userId, platform },
    });
  }

  /** Scoped to the owner, so a token that already moved to another account stays with it. */
  async unregister(userId: string, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { token, userId } });
  }

  private async deliver(messages: PushMessage[]) {
    const rows = await this.prisma.pushToken.findMany({ where: { userId: { in: [...new Set(messages.map((message) => message.userId))] } }, select: { token: true, userId: true } });
    if (rows.length === 0) return;
    const tokensOf = new Map<string, string[]>();
    rows.forEach((row) => tokensOf.set(row.userId, [...(tokensOf.get(row.userId) ?? []), row.token]));

    const outgoing = messages.flatMap((message) =>
      (tokensOf.get(message.userId) ?? []).map((to) => ({
        to,
        title: message.title,
        body: message.body.length > BODY_LIMIT ? `${message.body.slice(0, BODY_LIMIT - 1)}…` : message.body,
        // What the app needs to open the right screen and mark this one read.
        data: { notificationId: message.id, event: message.event, bookingId: message.bookingId ?? null, tripId: message.tripId ?? null, reportId: message.reportId ?? null },
        sound: 'default',
        priority: 'high',
        channelId: ANDROID_CHANNEL_ID,
      })),
    );

    const headers = await this.headers();
    const sent: { ticketId: string; token: string }[] = [];
    const gone: string[] = [];
    for (let start = 0; start < outgoing.length; start += SEND_CHUNK) {
      const chunk = outgoing.slice(start, start + SEND_CHUNK);
      const tickets = await this.post<Ticket[]>(SEND_URL, chunk, headers);
      if (!tickets) continue;
      tickets.forEach((ticket, index) => {
        const token = chunk[index].to;
        if (ticket.status === 'ok') sent.push({ ticketId: ticket.id, token });
        else if (ticket.details?.error === 'DeviceNotRegistered') gone.push(token);
        else this.logger.warn(`Push refused: ${ticket.message}`);
      });
    }
    await this.forget(gone);
    if (sent.length > 0) this.later(() => this.checkReceipts(sent, headers));
  }

  /** Firebase and Apple report an uninstalled app only here, after the send itself looked fine. */
  private async checkReceipts(sent: { ticketId: string; token: string }[], headers: Record<string, string>) {
    const gone: string[] = [];
    for (let start = 0; start < sent.length; start += RECEIPT_CHUNK) {
      const chunk = sent.slice(start, start + RECEIPT_CHUNK);
      const receipts = await this.post<Record<string, Receipt>>(RECEIPTS_URL, { ids: chunk.map((row) => row.ticketId) }, headers);
      if (!receipts) continue;
      chunk.forEach(({ ticketId, token }) => {
        const receipt = receipts[ticketId];
        if (receipt?.status !== 'error') return;
        if (receipt.details?.error === 'DeviceNotRegistered') gone.push(token);
        // A wrong Firebase key or Apple credential shows up here, once per message, until it is fixed in EAS.
        else this.logger.warn(`Push not delivered: ${receipt.details?.error ?? ''} ${receipt.message}`);
      });
    }
    await this.forget(gone);
  }

  private async forget(tokens: string[]) {
    if (tokens.length > 0) await this.prisma.pushToken.deleteMany({ where: { token: { in: tokens } } });
  }

  /** Lost on a restart, which only leaves a dead token until its next failed send. */
  private later(run: () => Promise<void>) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run().catch((err) => this.logger.warn(`Push receipts failed: ${(err as Error).message}`));
    }, RECEIPT_DELAY_MS);
    timer.unref();
    this.timers.add(timer);
  }

  private async headers() {
    // Needed only when "Enhanced security for push notifications" is on in the Expo project.
    const accessToken = await this.integrations.value('expoAccessToken');
    return {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    };
  }

  private async post<T>(url: string, payload: unknown, headers: Record<string, string>): Promise<T | null> {
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const json = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
      if (!response.ok || !json?.data) {
        this.logger.warn(`Expo push answered ${response.status}: ${json?.errors?.map((error) => error.message).join('; ') ?? 'no body'}`);
        return null;
      }
      return json.data;
    } catch (err) {
      this.logger.warn(`Expo push unreachable: ${(err as Error).message}`);
      return null;
    }
  }
}

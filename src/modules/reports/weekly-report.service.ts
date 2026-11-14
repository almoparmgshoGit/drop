import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { addDays, RIYADH_OFFSET_MS } from '../../common/utils/time.util';
import { ReportsService } from './reports.service';

const MINUTE_MS = 60_000;
const SWEEP_MS = MINUTE_MS;
/** Startup waits a moment, so the app is serving before the catch-up runs. */
const STARTUP_DELAY_MS = 30_000;
const LOCK_KEY = 'lock:weekly-report';
const LOCK_TTL_SECONDS = 55;
/** The report goes out on Sunday from this hour in Riyadh, once the office day has started. */
const SEND_HOUR = 8;
const LOG_PREFIX = 'weekly-report:';

const dateColumn = (date: string) => new Date(`${date}T00:00:00.000Z`);
const shift = (date: string, days: number) => addDays(dateColumn(date), days).toISOString().slice(0, 10);
const dayMonth = (date: string) =>
  new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(dateColumn(date));
const amount = (value: number) => `${Math.round(value).toLocaleString('en-US')} ر.س`;
const count = (value: number) => Math.round(value).toLocaleString('en-US');
const change = (now: number, before: number) => {
  if (before <= 0) return '';
  const value = Math.round(((now - before) / before) * 100);
  return ` (${value > 0 ? '+' : ''}${value}% عن الأسبوع السابق)`;
};

/**
 * The Sunday-to-Saturday week before the one the moment falls in, in Riyadh, and when its report is due:
 * this week's Sunday at SEND_HOUR.
 */
export function previousWeek(now = new Date()) {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const today = local.toISOString().slice(0, 10);
  const sunday = shift(today, -local.getUTCDay());
  const dueAt = new Date(dateColumn(sunday).getTime() + SEND_HOUR * 60 * MINUTE_MS - RIYADH_OFFSET_MS);
  return { from: shift(sunday, -7), to: shift(sunday, -1), dueAt };
}

/**
 * Every Sunday morning, last week's key figures go to everyone who can view the reports, in the app and by push.
 * The admin panel opens the reports page on that week when the notification is tapped.
 *
 * A minute sweep under a redis lock, like the trip execution. The week is claimed in TripReminderLog in the same transaction
 * as the notifications, so a week is sent once however many servers run, and a server that was down on Sunday sends it when
 * it comes back during the week. Only the latest week is ever sent, never a backlog.
 */
@Injectable()
export class WeeklyReportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeeklyReportService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private reports: ReportsService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Tests run the sweep themselves.
    if (process.env.NODE_ENV === 'test') return;
    const startup = setTimeout(() => this.tick(), STARTUP_DELAY_MS);
    startup.unref();
    const timer = setInterval(() => this.tick(), SWEEP_MS);
    timer.unref();
    this.timers.push(startup, timer);
  }

  onModuleDestroy() {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    let locked = false;
    try {
      const week = previousWeek();
      if (week.dueAt > new Date()) return;
      // Most minutes of the week find it already sent, without taking the lock.
      if (await this.prisma.tripReminderLog.findUnique({ where: { key: `${LOG_PREFIX}${week.from}` } })) return;
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      if (!locked) return;
      await this.send();
    } catch (err) {
      this.logger.error(`Weekly report failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }

  /** Sends last week's report unless it went out already. True when this call sent it. */
  async send(now = new Date()) {
    const week = previousWeek(now);
    const message = await this.compose(week.from, week.to);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tripReminderLog.createMany({ data: [{ key: `${LOG_PREFIX}${week.from}` }], skipDuplicates: true });
      if (claimed.count === 0) return false;
      await this.notifications.toStaff(tx, 'WEEKLY_REPORT', ['analytics.view'], { message });
      this.logger.log(`Weekly report sent for ${week.from} to ${week.to}`);
      return true;
    });
  }

  /** The week's key figures in a few lines, each against the week before. */
  async compose(from: string, to: string) {
    const before = { from: shift(from, -7), to: shift(to, -7) };
    const [revenue, bookings, trips, hotels, previousRevenue, previousBookings] = await Promise.all([
      this.reports.revenue({ from, to }),
      this.reports.bookings({ from, to }),
      this.reports.trips({ from, to }),
      this.reports.hotels({ from, to }),
      this.reports.revenue(before),
      this.reports.bookings(before),
    ]);
    return [
      `أرقام الأسبوع من ${dayMonth(from)} إلى ${dayMonth(to)}:`,
      `• الإيرادات: ${amount(revenue.gross)}${change(revenue.gross, previousRevenue.gross)}`,
      `• الصافي بعد الاستردادات: ${amount(revenue.net)}`,
      `• الحجوزات: ${count(bookings.total)}${change(bookings.total, previousBookings.total)}، الركاب ${count(bookings.passengers)}، الملغاة ${count(bookings.cancelled)}`,
      `• الرحلات المغادرة: ${count(trips.total)}، إشغال المنفذة ${trips.occupancyExecuted.percent}%`,
      `• مبيعات الفنادق: ${amount(hotels.sales)} (${count(hotels.bookings)} حجز، ${count(hotels.nights)} ليلة)`,
      'التفاصيل في صفحة التقارير.',
    ].join('\n');
  }
}

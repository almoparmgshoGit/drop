import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { reportError } from '../../common/monitoring/error-reporter';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { markWorkerTick } from '../../common/monitoring/worker-health';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SWEEP_MS = MINUTE_MS;
const STARTUP_DELAY_MS = 15_000;
const LOCK_KEY = 'lock:crew-watchdog';
const LOCK_TTL_SECONDS = 55;
/** Opening the app this long before the check still counts: a supervisor who checked in early is not chased. */
export const SUPERVISOR_ACTIVE_LOOKBACK_MS = 3 * HOUR_MS;
/** Past this long after departure a trip that never moved is the "not left" alert's business, not this one's. */
const NOT_OPENED_UNTIL_AFTER_DEPARTURE_MS = HOUR_MS;
const BATCH = 200;
export const WATCHDOG_WORKER = 'crew-watchdog';

export const CREW_ALERT = {
  SUPERVISOR_APP_NOT_OPENED: 'SUPERVISOR_APP_NOT_OPENED',
  TRACKING_SILENT: 'TRACKING_SILENT',
} as const;
export type CrewAlertKind = (typeof CREW_ALERT)[keyof typeof CREW_ALERT];

type Supervisor = { id: string; name: string | null; crewAppSeenAt: Date | null };

/** Whether the check for this trip has started: from supervisorAppCheckBeforeMinutes before departure. */
export const supervisorCheckStarted = (departureTime: Date, checkBeforeMinutes: number, now = Date.now()) => now >= departureTime.getTime() - checkBeforeMinutes * MINUTE_MS;

/** A supervisor counts as having opened the app when it was open at any time from a few hours before the check until now. */
export const supervisorWasActive = (supervisor: { crewAppSeenAt: Date | null }, departureTime: Date, checkBeforeMinutes: number) =>
  !!supervisor.crewAppSeenAt && supervisor.crewAppSeenAt.getTime() >= departureTime.getTime() - checkBeforeMinutes * MINUTE_MS - SUPERVISOR_ACTIVE_LOOKBACK_MS;

/**
 * Watches the crews of trips about to leave and on the road:
 * - from supervisorAppCheckBeforeMinutes before departure, a trip none of whose supervisors has opened the app;
 * - during the trip, a bus with no position (from the phone or the bus's GPS device) for trackingSilentAlertMinutes.
 * Each raises one TripCrewAlert per trip and kind, tells the office (holders of trips.manage, admins included) and
 * reminds the supervisors, by in-app notification and push. An alert is marked resolved once its condition clears,
 * but is never raised twice for the same trip.
 */
@Injectable()
export class CrewWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrewWatchdogService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private appSettings: AppSettingsService,
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
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      // Another server holding the lock is doing the work, so this one is still healthy.
      if (locked) await this.sweep();
      markWorkerTick(WATCHDOG_WORKER);
    } catch (err) {
      this.logger.error(`Crew watchdog sweep failed: ${(err as Error).message}`);
      reportError(err, undefined, { worker: WATCHDOG_WORKER });
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }

  /** Raises what is due and resolves what cleared; returns the trips alerted, by kind. */
  async sweep(now = new Date()) {
    const settings = await this.appSettings.numbers('supervisorAppCheckBeforeMinutes', 'trackingSilentAlertMinutes');
    const notOpened = await this.checkSupervisorsOpenedApp(now, settings.supervisorAppCheckBeforeMinutes);
    const silent = await this.checkTrackingSilent(now, settings.trackingSilentAlertMinutes);
    await this.resolveCleared(now, settings);
    return { notOpened, silent };
  }

  private async checkSupervisorsOpenedApp(now: Date, checkBeforeMinutes: number) {
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: 'PUBLISHED',
        liveStatus: 'NOT_STARTED',
        departureTime: { lte: new Date(now.getTime() + checkBeforeMinutes * MINUTE_MS), gte: new Date(now.getTime() - NOT_OPENED_UNTIL_AFTER_DEPARTURE_MS) },
        supervisors: { some: {} },
        crewAlerts: { none: { kind: CREW_ALERT.SUPERVISOR_APP_NOT_OPENED } },
      },
      orderBy: { departureTime: 'asc' },
      take: BATCH,
      select: { id: true, departureTime: true, supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { id: true, name: true, crewAppSeenAt: true } } } } },
    });
    const alerted: string[] = [];
    for (const trip of trips) {
      const supervisors: Supervisor[] = trip.supervisors.map((row) => row.user);
      if (supervisors.some((supervisor) => supervisorWasActive(supervisor, trip.departureTime, checkBeforeMinutes))) continue;
      if (await this.raise(trip.id, CREW_ALERT.SUPERVISOR_APP_NOT_OPENED, supervisors, {})) alerted.push(trip.id);
    }
    return alerted;
  }

  private async checkTrackingSilent(now: Date, silentMinutes: number) {
    const silentMs = silentMinutes * MINUTE_MS;
    const trips = await this.prisma.trip.findMany({
      where: {
        tripStatus: 'PUBLISHED',
        liveStatus: { not: 'ARRIVED' },
        departureTime: { lte: new Date(now.getTime() - silentMs) },
        arrivalTime: { gte: now },
        crewAlerts: { none: { kind: CREW_ALERT.TRACKING_SILENT } },
      },
      orderBy: { departureTime: 'asc' },
      take: BATCH,
      select: {
        id: true,
        departureTime: true,
        location: { select: { recordedAt: true } },
        supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { id: true, name: true, crewAppSeenAt: true } } } },
      },
    });
    const alerted: string[] = [];
    for (const trip of trips) {
      // Silence is counted from departure for a bus that never sent a position.
      const lastSignal = Math.max(trip.location?.recordedAt.getTime() ?? 0, trip.departureTime.getTime());
      const silentFor = now.getTime() - lastSignal;
      if (silentFor < silentMs) continue;
      const supervisors: Supervisor[] = trip.supervisors.map((row) => row.user);
      if (await this.raise(trip.id, CREW_ALERT.TRACKING_SILENT, supervisors, { minutes: Math.floor(silentFor / MINUTE_MS) })) alerted.push(trip.id);
    }
    return alerted;
  }

  /** Records the alert once; only the server that recorded it sends the notifications. */
  private async raise(tripId: string, kind: CrewAlertKind, supervisors: Supervisor[], values: { minutes?: number }) {
    const created = await this.prisma.tripCrewAlert.createMany({ data: [{ tripId, kind }], skipDuplicates: true });
    if (created.count === 0) return false;
    const employeeName = supervisors.map((supervisor) => supervisor.name).filter(Boolean).join('، ') || 'لا يوجد مشرف مسند';
    try {
      await this.prisma.$transaction(async (tx) => {
        if (kind === CREW_ALERT.SUPERVISOR_APP_NOT_OPENED) {
          await this.notifications.toStaff(tx, 'STAFF_SUPERVISOR_APP_NOT_OPENED', ['trips.manage'], { employeeName }, { tripId });
          await this.notifications.toTripCrew(tx, 'CREW_OPEN_APP_REMINDER', tripId, { userIds: supervisors.map((supervisor) => supervisor.id) });
        } else {
          await this.notifications.toStaff(tx, 'STAFF_TRACKING_SILENT', ['trips.manage'], { employeeName, minutes: values.minutes }, { tripId });
          if (supervisors.length) await this.notifications.toTripCrew(tx, 'CREW_TRACKING_SILENT_REMINDER', tripId, { userIds: supervisors.map((supervisor) => supervisor.id), extra: { minutes: values.minutes } });
        }
      });
    } catch (err) {
      // The alert row stays, so a failed send is not retried every minute; the tracking page still shows the flag.
      this.logger.error(`Could not send crew alert ${kind} for trip ${tripId}: ${(err as Error).message}`);
    }
    return true;
  }

  private async resolveCleared(now: Date, settings: { supervisorAppCheckBeforeMinutes: number; trackingSilentAlertMinutes: number }) {
    const open = await this.prisma.tripCrewAlert.findMany({
      where: { resolvedAt: null },
      take: BATCH,
      select: {
        id: true,
        kind: true,
        trip: {
          select: {
            tripStatus: true,
            liveStatus: true,
            departureTime: true,
            arrivalTime: true,
            location: { select: { recordedAt: true } },
            supervisors: { select: { user: { select: { crewAppSeenAt: true } } } },
          },
        },
      },
    });
    const cleared = open.filter(({ kind, trip }) => {
      if (trip.tripStatus !== 'PUBLISHED' || trip.liveStatus === 'ARRIVED') return true;
      if (kind === CREW_ALERT.SUPERVISOR_APP_NOT_OPENED) {
        return trip.supervisors.some((row) => supervisorWasActive(row.user, trip.departureTime, settings.supervisorAppCheckBeforeMinutes));
      }
      if (now.getTime() > trip.arrivalTime.getTime()) return true;
      return !!trip.location && now.getTime() - trip.location.recordedAt.getTime() < settings.trackingSilentAlertMinutes * MINUTE_MS;
    });
    if (cleared.length) await this.prisma.tripCrewAlert.updateMany({ where: { id: { in: cleared.map((row) => row.id) } }, data: { resolvedAt: now } });
  }
}

import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { distanceInMeters } from '../../common/utils/geo.util';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type LocationSource = 'PHONE' | 'DEVICE';

export interface LocationFix {
  lat: number;
  lng: number;
  /** Metres per second, as the crew app has always sent it. */
  speed?: number | null;
  accuracy?: number | null;
  heading?: number | null;
  source: LocationSource;
  /** The crew member whose phone sent it; none for the bus's GPS device. */
  reportedById?: string | null;
  /** When the fix was taken. The phone's is always the server clock; a device's is clamped so it can never be in the future. */
  recordedAt: Date;
}

export interface RecordResult {
  /** False when the fix was not used: an older one, or a phone fix while the bus's device is reporting. */
  stored: boolean;
  /** The source the map shows now. */
  source: LocationSource;
  recordedAt: Date;
}

/** The trip states and times that decide whether a position may be recorded for it at all. */
export const TRACKING_WINDOW_SELECT = { tripStatus: true, liveStatus: true, departureTime: true, arrivalTime: true } as const;

type TrackingWindowTrip = { tripStatus: string; liveStatus: string; departureTime: Date; arrivalTime: Date };

/** Inside the hours a bus's position may be broadcast: published, not arrived, from before departure until after arrival. */
export function isWithinTrackingWindow(trip: TrackingWindowTrip, limits: { trackingOpensBeforeHours: number; trackingClosesAfterHours: number }, now = Date.now()) {
  return (
    trip.tripStatus === 'PUBLISHED' &&
    trip.liveStatus !== 'ARRIVED' &&
    now >= trip.departureTime.getTime() - limits.trackingOpensBeforeHours * HOUR_MS &&
    now <= trip.arrivalTime.getTime() + limits.trackingClosesAfterHours * HOUR_MS
  );
}

/** The boarding point the bus is close enough to that the crew should be asked whether it has arrived there. */
export function nearestBoardingPoint(
  points: { id: string; name: string; lat: number | null; lng: number | null }[],
  position: { lat: number; lng: number },
  currentPointId: string | null,
  radiusMeters: number,
) {
  const near = points
    .flatMap((point) => (point.lat !== null && point.lng !== null && point.id !== currentPointId ? [{ id: point.id, name: point.name, meters: distanceInMeters(position, { lat: point.lat, lng: point.lng }) }] : []))
    .filter((point) => point.meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters)[0];
  return near ? { id: near.id, name: near.name, meters: Math.round(near.meters) } : null;
}

/**
 * The one way a bus position enters the system, whether from the supervisor's phone or the bus's fixed GPS device:
 * it is kept as the trip's latest position (which the station alerts and ETA read) and broadcast to the trip's
 * followers and the operations map. While the device is reporting, phone fixes are not used; once it falls
 * silent for gpsDeviceStaleMinutes the phone takes over again.
 */
@Injectable()
export class TripLocationService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private appSettings: AppSettingsService,
  ) {}

  async deviceStaleMs() {
    return (await this.appSettings.number('gpsDeviceStaleMinutes')) * MINUTE_MS;
  }

  async record(tripId: string, fix: LocationFix): Promise<RecordResult> {
    const current = await this.prisma.tripLocation.findUnique({ where: { tripId }, select: { source: true, recordedAt: true } });
    if (current) {
      // A device that buffered while out of coverage sends its backlog late; the map keeps the newest position.
      if (fix.recordedAt.getTime() < current.recordedAt.getTime()) return { stored: false, source: current.source as LocationSource, recordedAt: current.recordedAt };
      if (fix.source === 'PHONE' && current.source === 'DEVICE' && Date.now() - current.recordedAt.getTime() <= (await this.deviceStaleMs())) {
        return { stored: false, source: 'DEVICE', recordedAt: current.recordedAt };
      }
    }
    const data = {
      lat: fix.lat,
      lng: fix.lng,
      speed: fix.speed ?? null,
      accuracy: fix.accuracy ?? null,
      heading: fix.heading ?? null,
      source: fix.source,
      reportedById: fix.reportedById ?? null,
      recordedAt: fix.recordedAt,
    };
    await this.prisma.tripLocation.upsert({ where: { tripId }, create: { tripId, ...data }, update: data });
    this.realtime.tripLocation(tripId, { lat: data.lat, lng: data.lng, speed: data.speed, recordedAt: data.recordedAt, isLive: true, source: fix.source });
    return { stored: true, source: fix.source, recordedAt: data.recordedAt };
  }

  /** The crew stopped sharing. A position from the bus's device stays: the crew's phone has no say over it. */
  async clearPhone(tripId: string) {
    const removed = await this.prisma.tripLocation.deleteMany({ where: { tripId, source: 'PHONE' } });
    if (removed.count > 0) this.realtime.tripLocation(tripId, null);
    return removed.count > 0;
  }

  /** A crew member's app is open: the watchdog reads this, and an alert it raised about them is cleared. */
  async crewSeen(userId: string, now = new Date()) {
    await this.prisma.user.update({ where: { id: userId }, data: { crewAppSeenAt: now } });
  }
}

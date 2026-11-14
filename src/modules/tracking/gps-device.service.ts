import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { isWithinTrackingWindow, TripLocationService } from './trip-location.service';

const HOUR_MS = 60 * 60 * 1000;
const KNOTS_TO_MS = 0.514444;
/** A device sending faster than this has its extra fixes dropped; the map does not move more smoothly for them. */
const MIN_FIX_INTERVAL_SECONDS = 2;
/** A buffered fix older than this says nothing about where the bus is now. */
const MAX_FIX_AGE_MS = 15 * 60 * 1000;
export const INGEST_PATH = '/gps/ingest';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ParsedFix {
  deviceId: string | null;
  token: string | null;
  lat: number;
  lng: number;
  /** Metres per second. */
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  timestamp: Date | null;
}

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
const text = (value: unknown) => {
  const one = first(value);
  return typeof one === 'string' && one.trim() ? one.trim() : typeof one === 'number' ? String(one) : null;
};
const num = (value: unknown) => {
  const one = first(value);
  if (one === null || one === undefined || one === '') return null;
  const parsed = typeof one === 'number' ? one : Number(one);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Unix seconds, unix milliseconds or an ISO date, as trackers send them. */
function parseTimestamp(value: unknown): Date | null {
  const one = first(value);
  if (one === null || one === undefined || one === '') return null;
  const asNumber = typeof one === 'number' ? one : /^\d+(\.\d+)?$/.test(String(one)) ? Number(one) : NaN;
  const date = Number.isFinite(asNumber) ? new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber) : new Date(String(one));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads a fix in the formats trackers speak:
 * - OsmAnd / Traccar Client HTTP: `?id=IMEI&lat=..&lon=..&timestamp=..&speed=(knots)&bearing=..&accuracy=..`, as query or form body.
 * - Traccar Client JSON: `{ device_id, location: { timestamp, coords: { latitude, longitude, speed (m/s), heading, accuracy } } }`.
 * - Plain JSON: `{ id, lat, lon|lng, timestamp, speed (m/s), bearing|heading, accuracy }`.
 * The token comes from `token` (query or body), the `X-Device-Token` header or `Authorization: Bearer`.
 */
export function parseFix(query: Record<string, unknown>, body: unknown, headers: Record<string, unknown>): ParsedFix {
  const json = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, any>) : {};
  const bearer = text(headers['authorization'])?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const token = text(query.token) ?? text(json.token) ?? text(headers['x-device-token']) ?? bearer;
  const deviceId = text(query.id) ?? text(query.deviceid) ?? text(json.device_id) ?? text(json.id) ?? text(json.deviceId);

  const coords = json.location && typeof json.location === 'object' ? json.location.coords ?? json.location : null;
  if (coords && typeof coords === 'object' && (coords.latitude !== undefined || coords.lat !== undefined)) {
    return {
      deviceId,
      token,
      lat: num(coords.latitude ?? coords.lat) ?? NaN,
      lng: num(coords.longitude ?? coords.lon ?? coords.lng) ?? NaN,
      speed: num(coords.speed),
      heading: num(coords.heading ?? coords.bearing),
      accuracy: num(coords.accuracy),
      timestamp: parseTimestamp(json.location.timestamp ?? json.timestamp),
    };
  }

  // Query parameters are the OsmAnd protocol; a form or JSON body may carry the same names.
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (query[key] !== undefined) return { value: query[key], fromQuery: true };
      if (json[key] !== undefined) return { value: json[key], fromQuery: false };
    }
    return { value: undefined, fromQuery: false };
  };
  const speed = pick('speed');
  const speedValue = num(speed.value);
  // OsmAnd sends knots, in the query or a form body; the plain JSON variant is documented as metres per second.
  const isOsmAnd = speed.fromQuery || String(first(headers['content-type']) ?? '').includes('application/x-www-form-urlencoded');
  return {
    deviceId,
    token,
    lat: num(pick('lat', 'latitude').value) ?? NaN,
    lng: num(pick('lon', 'lng', 'longitude').value) ?? NaN,
    speed: speedValue === null ? null : isOsmAnd ? speedValue * KNOTS_TO_MS : speedValue,
    heading: num(pick('bearing', 'heading', 'course').value),
    accuracy: num(pick('accuracy', 'hdop').value),
    timestamp: parseTimestamp(pick('timestamp', 'time', 'fixTime').value),
  };
}

const DEVICE_SELECT = { busId: true, deviceId: true, tokenHint: true, tokenIssuedAt: true, isEnabled: true, lastSeenAt: true, lastLat: true, lastLng: true, lastSpeed: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class GpsDeviceService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private appSettings: AppSettingsService,
    private locations: TripLocationService,
  ) {}

  private async withStatus<T extends { lastSeenAt: Date | null; isEnabled: boolean }>(device: T) {
    const staleMs = await this.locations.deviceStaleMs();
    return { ...device, isOnline: device.isEnabled && !!device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() <= staleMs, staleAfterMs: staleMs };
  }

  async list() {
    const staleMs = await this.locations.deviceStaleMs();
    const rows = await this.prisma.busGpsDevice.findMany({
      select: { ...DEVICE_SELECT, tokenHash: true, bus: { select: { plateNumber: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ tokenHash, bus, ...device }) => ({
      ...device,
      busPlate: bus.plateNumber,
      hasToken: !!tokenHash,
      isOnline: device.isEnabled && !!device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() <= staleMs,
      staleAfterMs: staleMs,
    }));
  }

  async get(busId: string) {
    const bus = await this.prisma.bus.findUnique({ where: { id: busId }, select: { id: true } });
    if (!bus) throw new NotFoundException('الباص غير موجود');
    const device = await this.prisma.busGpsDevice.findUnique({ where: { busId }, select: { ...DEVICE_SELECT, tokenHash: true } });
    if (!device) return { device: null, ingestPath: INGEST_PATH };
    const { tokenHash, ...rest } = device;
    return { device: { ...(await this.withStatus(rest)), hasToken: !!tokenHash }, ingestPath: INGEST_PATH };
  }

  async save(busId: string, dto: { deviceId: string; isEnabled?: boolean }) {
    const bus = await this.prisma.bus.findUnique({ where: { id: busId }, select: { id: true } });
    if (!bus) throw new NotFoundException('الباص غير موجود');
    const deviceId = dto.deviceId.trim();
    if (!deviceId) throw new BadRequestException('أدخل رقم الجهاز (IMEI أو المعرّف)');
    const taken = await this.prisma.busGpsDevice.findUnique({ where: { deviceId }, select: { busId: true } });
    if (taken && taken.busId !== busId) throw new ConflictException('رقم الجهاز مسجل على باص آخر');
    await this.prisma.busGpsDevice.upsert({
      where: { busId },
      create: { busId, deviceId, isEnabled: dto.isEnabled ?? true },
      update: { deviceId, ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }) },
    });
    return this.get(busId);
  }

  /** A new token replaces the old one at once; it is shown only in this answer. */
  async rotateToken(busId: string) {
    const device = await this.prisma.busGpsDevice.findUnique({ where: { busId }, select: { busId: true, deviceId: true } });
    if (!device) throw new NotFoundException('سجّل رقم الجهاز أولًا');
    const token = `gps_${randomBytes(24).toString('base64url')}`;
    await this.prisma.busGpsDevice.update({ where: { busId }, data: { tokenHash: hashToken(token), tokenHint: token.slice(-4), tokenIssuedAt: new Date() } });
    return { token, deviceId: device.deviceId, ingestPath: INGEST_PATH, ...(await this.get(busId)) };
  }

  async remove(busId: string) {
    await this.prisma.busGpsDevice.deleteMany({ where: { busId } });
    return { success: true };
  }

  /** The bus's trip whose tracking window is open now: one already on the road first, else the earliest. */
  private async currentTrip(busId: string, now: number) {
    const limits = await this.appSettings.numbers('trackingOpensBeforeHours', 'trackingClosesAfterHours');
    const trips = await this.prisma.trip.findMany({
      where: {
        busId,
        tripStatus: 'PUBLISHED',
        liveStatus: { not: 'ARRIVED' },
        departureTime: { lte: new Date(now + limits.trackingOpensBeforeHours * HOUR_MS) },
        arrivalTime: { gte: new Date(now - limits.trackingClosesAfterHours * HOUR_MS) },
      },
      orderBy: { departureTime: 'asc' },
      take: 10,
      select: { id: true, tripStatus: true, liveStatus: true, departureTime: true, arrivalTime: true },
    });
    const open = trips.filter((trip) => isWithinTrackingWindow(trip, limits, now));
    return open.find((trip) => trip.liveStatus === 'ON_ROAD' || trip.liveStatus === 'AT_POINT') ?? open[0] ?? null;
  }

  /** One fix from a bus's tracker, authenticated by its token. Answers 200 whenever the fix was accepted, so trackers do not resend it. */
  async ingest(fix: ParsedFix) {
    if (!fix.token) throw new UnauthorizedException('device token required');
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) throw new BadRequestException('invalid lat/lon');
    const hash = hashToken(fix.token);
    const device = await this.prisma.busGpsDevice.findUnique({ where: { tokenHash: hash }, select: { busId: true, deviceId: true, tokenHash: true, isEnabled: true } });
    if (!device?.tokenHash || !timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))) throw new UnauthorizedException('unknown device');
    if (fix.deviceId && fix.deviceId !== device.deviceId) throw new UnauthorizedException('unknown device');
    if (!device.isEnabled) throw new ForbiddenException('device disabled');

    const now = Date.now();
    if (!(await this.redis.setnx(`gps:fix:${device.busId}`, '1', MIN_FIX_INTERVAL_SECONDS))) return { ok: true, used: false, reason: 'too_frequent' };

    // A device clock running ahead is pulled back to the server's, so a fix can never look fresher than it is.
    const takenAt = fix.timestamp ? Math.min(fix.timestamp.getTime(), now) : now;
    const speed = fix.speed !== null && fix.speed >= 0 && fix.speed < 100 ? fix.speed : null;
    const heading = fix.heading !== null && fix.heading >= 0 && fix.heading <= 360 ? fix.heading : null;
    const accuracy = fix.accuracy !== null && fix.accuracy >= 0 ? fix.accuracy : null;
    await this.prisma.busGpsDevice.update({ where: { busId: device.busId }, data: { lastSeenAt: new Date(now), lastLat: fix.lat, lastLng: fix.lng, lastSpeed: speed } });

    if (now - takenAt > MAX_FIX_AGE_MS) return { ok: true, used: false, reason: 'old_fix' };
    const trip = await this.currentTrip(device.busId, now);
    if (!trip) return { ok: true, used: false, reason: 'no_open_trip' };
    const result = await this.locations.record(trip.id, { lat: fix.lat, lng: fix.lng, speed, heading, accuracy, source: 'DEVICE', recordedAt: new Date(takenAt) });
    return { ok: true, used: result.stored, tripId: trip.id };
  }
}

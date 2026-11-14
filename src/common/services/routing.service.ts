import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { IntegrationsService } from './integrations.service';
import { RedisService } from './redis.service';

type LatLng = { lat: number; lng: number };
type Route = { seconds: number; meters: number };
type CachedEta = { arrivesAt: string; km: number; trafficAware: boolean };

const REQUEST_TIMEOUT_MS = 6000;
/** Every passenger's phone polls every few seconds; the bill must follow this, not them. */
const ETA_REFRESH_SECONDS = 5 * 60;
const FAILED_RETRY_SECONDS = 60;
const FAILED = 'failed';
const MINUTE_MS = 60_000;
/** A long road both platforms know, so a good key always gets an answer: Madinah to Makkah. */
const TEST_FROM: LatLng = { lat: 24.4672, lng: 39.6111 };
const TEST_TO: LatLng = { lat: 21.4225, lng: 39.8262 };

/** Its message is written for the panel, and never carries a key or the platform's own reply. */
class RoutingError extends Error {}

async function send(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new RoutingError('تعذر الوصول إلى المنصة، حاول مرة أخرى');
  }
}

function assertAccepted(status: number, platform: string, keyHint: string) {
  if (status === 401 || status === 403) throw new RoutingError(`رفضت ${platform} الطلب: ${keyHint}`);
  if (status === 429) throw new RoutingError(`تجاوز الحساب حد الطلبات المسموح في ${platform}`);
}

const readJson = async (res: Response): Promise<any> => res.json().catch(() => null);

const NO_ROUTE = 'لم تجد المنصة طريقًا بين النقطتين';

async function mapboxRoute(token: string, from: LatLng, to: LatLng): Promise<Route> {
  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const res = await send(`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordinates}?overview=false&access_token=${encodeURIComponent(token)}`);
  assertAccepted(res.status, 'Mapbox', 'تأكد من صحة الرمز وصلاحياته');
  const body = await readJson(res);
  const route = body?.routes?.[0];
  if (res.ok && body?.code === 'Ok' && typeof route?.duration === 'number') return { seconds: route.duration, meters: route.distance ?? 0 };
  // Mapbox answers an unreachable pair with a code rather than a failure status.
  if (body?.code === 'NoRoute' || body?.code === 'NoSegment') throw new RoutingError(NO_ROUTE);
  throw new RoutingError('ردت Mapbox بخطأ غير متوقع');
}

async function googleRoute(apiKey: string, from: LatLng, to: LatLng, trafficAware: boolean): Promise<Route> {
  const place = ({ lat, lng }: LatLng) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const res = await send('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
    // TRAFFIC_AWARE is what moves a request to the Pro price, so the admin's choice decides it.
    body: JSON.stringify({ origin: place(from), destination: place(to), travelMode: 'DRIVE', routingPreference: trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE' }),
  });
  assertAccepted(res.status, 'Google', 'تأكد من صحة المفتاح وتفعيل Routes API والفوترة');
  const body = await readJson(res);
  if (!res.ok) throw new RoutingError('ردت Google بخطأ غير متوقع');
  const route = body?.routes?.[0];
  const seconds = parseFloat(route?.duration);
  // Google answers an unreachable pair with an empty reply.
  if (!Number.isFinite(seconds)) throw new RoutingError(NO_ROUTE);
  return { seconds, meters: route.distanceMeters ?? 0 };
}

const PLATFORMS: Record<string, { label: string; keyField: string; trafficAware: boolean; route: (key: string, from: LatLng, to: LatLng) => Promise<Route> }> = {
  mapbox: { label: 'Mapbox', keyField: 'mapboxAccessToken', trafficAware: true, route: mapboxRoute },
  google_essentials: { label: 'Google (Essentials)', keyField: 'googleMapsApiKey', trafficAware: false, route: (key, from, to) => googleRoute(key, from, to, false) },
  google_pro: { label: 'Google (Pro)', keyField: 'googleMapsApiKey', trafficAware: true, route: (key, from, to) => googleRoute(key, from, to, true) },
};

/** A road a trip will drive is the same all day, so it is asked for once and shared by the whole crew. */
const ROAD_REFRESH_SECONDS = 24 * 60 * 60;
const ROAD_FAILED_RETRY_SECONDS = 10 * 60;
/** Both platforms accept this many places in one request. */
export const MAX_ROAD_POINTS = 25;

async function mapboxRoad(token: string, points: LatLng[]): Promise<LatLng[]> {
  const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await send(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}?overview=simplified&geometries=geojson&access_token=${encodeURIComponent(token)}`);
  assertAccepted(res.status, 'Mapbox', 'تأكد من صحة الرمز وصلاحياته');
  const body = await readJson(res);
  const line = body?.routes?.[0]?.geometry?.coordinates;
  if (res.ok && body?.code === 'Ok' && Array.isArray(line)) return line.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  if (body?.code === 'NoRoute' || body?.code === 'NoSegment') throw new RoutingError(NO_ROUTE);
  throw new RoutingError('ردت Mapbox بخطأ غير متوقع');
}

/** Google's encoded polyline format: https://developers.google.com/maps/documentation/utilities/polylinealgorithm */
function decodePolyline(encoded: string): LatLng[] {
  const line: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    line.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return line;
}

async function googleRoad(apiKey: string, points: LatLng[]): Promise<LatLng[]> {
  const place = ({ lat, lng }: LatLng) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const res = await send('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.polyline.encodedPolyline' },
    // The road's shape needs no traffic, which keeps the request at the Essentials price.
    body: JSON.stringify({
      origin: place(points[0]),
      destination: place(points[points.length - 1]),
      intermediates: points.slice(1, -1).map(place),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
    }),
  });
  assertAccepted(res.status, 'Google', 'تأكد من صحة المفتاح وتفعيل Routes API والفوترة');
  const body = await readJson(res);
  if (!res.ok) throw new RoutingError('ردت Google بخطأ غير متوقع');
  const encoded = body?.routes?.[0]?.polyline?.encodedPolyline;
  if (typeof encoded !== 'string' || !encoded) throw new RoutingError(NO_ROUTE);
  return decodePolyline(encoded);
}

const ROADS: Record<string, (key: string, points: LatLng[]) => Promise<LatLng[]>> = {
  mapbox: mapboxRoad,
  google_essentials: googleRoad,
  google_pro: googleRoad,
};

const minutesUntil = (arrivesAt: string) => Math.max(1, Math.ceil((new Date(arrivesAt).getTime() - Date.now()) / MINUTE_MS));
const toKm = (meters: number) => Math.round(meters / 100) / 10;

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly inFlight = new Map<string, Promise<CachedEta | null>>();
  private readonly roadsInFlight = new Map<string, Promise<LatLng[] | null>>();

  constructor(
    private integrations: IntegrationsService,
    private redis: RedisService,
  ) {}

  /** Read on every call, so a change in the panel applies at once, with no restart or new app version. */
  private async activePlatform() {
    const id = await this.integrations.value('routingProvider');
    const platform = id ? PLATFORMS[id] : undefined;
    if (!id || !platform) return null;
    return { id, platform, key: await this.integrations.value(platform.keyField) };
  }

  /** The bus's time to one boarding point, shared by everyone waiting there. Null falls back to the straight-line distance. */
  async etaToPoint(tripId: string, pointId: string, from: LatLng, to: LatLng) {
    const active = await this.activePlatform();
    if (!active?.key) return null;
    // The key is part of the name, so replacing a bad one takes effect without waiting out the last failure.
    const fingerprint = crypto.createHash('sha256').update(`${active.id}:${active.key}`).digest('hex').slice(0, 16);
    const cacheKey = `route_eta:${fingerprint}:${tripId}:${pointId}`;

    // Without the shared cache every phone would cost a paid request, so the ETA is left out until Redis is back.
    const cached = await this.redis.get(cacheKey).catch(() => undefined);
    if (cached === undefined) return null;
    let eta: CachedEta | null;
    if (cached !== null) {
      eta = cached === FAILED ? null : (JSON.parse(cached) as CachedEta);
    } else {
      // Phones polling together must not each cost a paid request.
      const running = this.inFlight.get(cacheKey);
      const request = running ?? this.fetchEta(cacheKey, active.platform, active.key, from, to).finally(() => this.inFlight.delete(cacheKey));
      if (!running) this.inFlight.set(cacheKey, request);
      eta = await request;
    }
    return eta && { minutes: minutesUntil(eta.arrivesAt), arrivesAt: eta.arrivesAt, km: eta.km, trafficAware: eta.trafficAware };
  }

  private async fetchEta(cacheKey: string, platform: (typeof PLATFORMS)[string], key: string, from: LatLng, to: LatLng) {
    try {
      const route = await platform.route(key, from, to);
      const eta: CachedEta = { arrivesAt: new Date(Date.now() + route.seconds * 1000).toISOString(), km: toKm(route.meters), trafficAware: platform.trafficAware };
      await this.redis.set(cacheKey, JSON.stringify(eta), ETA_REFRESH_SECONDS).catch(() => {});
      return eta;
    } catch (err) {
      this.logger.warn(`${platform.label}: ${err instanceof RoutingError ? err.message : 'unexpected failure'}`);
      await this.redis.set(cacheKey, FAILED, FAILED_RETRY_SECONDS).catch(() => {});
      return null;
    }
  }

  /**
   * The road through the given places in order, for the crew's map. Null when no platform is connected or it
   * found no road; the app then joins the places with straight lines.
   */
  async roadThrough(points: LatLng[]): Promise<LatLng[] | null> {
    if (points.length < 2) return null;
    const active = await this.activePlatform();
    const road = active ? ROADS[active.id] : undefined;
    if (!active?.key || !road) return null;
    const key = active.key;
    const fingerprint = crypto.createHash('sha256').update(`${active.id}:${key}`).digest('hex').slice(0, 16);
    // Rounded to about ten metres, so a pin nudged by a hair does not cost a new request.
    const places = crypto.createHash('sha256').update(points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';')).digest('hex').slice(0, 24);
    const cacheKey = `route_road:${fingerprint}:${places}`;

    // Without the shared cache every phone would cost a paid request, so the straight lines stand in until Redis is back.
    const cached = await this.redis.get(cacheKey).catch(() => undefined);
    if (cached === undefined) return null;
    if (cached !== null) return cached === FAILED ? null : (JSON.parse(cached) as LatLng[]);

    const running = this.roadsInFlight.get(cacheKey);
    if (running) return running;
    const request = (async () => {
      try {
        const line = (await road(key, points)).map((p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 }));
        await this.redis.set(cacheKey, JSON.stringify(line), ROAD_REFRESH_SECONDS).catch(() => {});
        return line;
      } catch (err) {
        this.logger.warn(`${active.platform.label} road: ${err instanceof RoutingError ? err.message : 'unexpected failure'}`);
        await this.redis.set(cacheKey, FAILED, ROAD_FAILED_RETRY_SECONDS).catch(() => {});
        return null;
      }
    })().finally(() => this.roadsInFlight.delete(cacheKey));
    this.roadsInFlight.set(cacheKey, request);
    return request;
  }

  /** One real request with the saved settings, for the panel's test button. */
  async test() {
    const active = await this.activePlatform();
    if (!active) return { ok: false, message: 'لم تُختر منصة بعد' };
    if (!active.key) return { ok: false, platform: active.platform.label, message: 'المفتاح غير محفوظ أو تعذرت قراءته، أدخله من جديد' };
    try {
      const route = await active.platform.route(active.key, TEST_FROM, TEST_TO);
      return { ok: true, platform: active.platform.label, minutes: Math.ceil(route.seconds / 60), km: toKm(route.meters), trafficAware: active.platform.trafficAware };
    } catch (err) {
      return { ok: false, platform: active.platform.label, message: err instanceof RoutingError ? err.message : 'تعذر الاختبار' };
    }
  }
}

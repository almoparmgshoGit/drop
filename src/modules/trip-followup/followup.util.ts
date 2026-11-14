import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

const DEFAULT_PUBLIC_WEB_URL = 'https://durobalhijrah.tech';

/**
 * Where the panel serves its public pages (/track/...): PUBLIC_WEB_URL when set, else the panel's own origin, which
 * production lists first in CORS_ORIGINS (see DEPLOY.md).
 */
export const publicWebUrl = (configured?: string | null, corsOrigins?: string | null) => {
  const panel = corsOrigins?.split(',').map((origin) => origin.trim()).find((origin) => /^https:\/\//.test(origin));
  return (configured?.trim() || panel || DEFAULT_PUBLIC_WEB_URL).replace(/\/+$/, '');
};

export const trackingUrl = (base: string, token: string) => `${base}/track/${token}`;

/** 24 random bytes: far beyond guessing, and short enough for a WhatsApp message. */
const newToken = () => randomBytes(24).toString('base64url');

/** The booking's sharing secret, made on first use. Two callers at once end up with the same one. */
export async function ensureTrackingToken(db: Pick<Prisma.TransactionClient, 'booking'>, bookingId: string) {
  await db.booking.updateMany({ where: { id: bookingId, trackingToken: null }, data: { trackingToken: newToken() } });
  const booking = await db.booking.findUnique({ where: { id: bookingId }, select: { trackingToken: true } });
  return booking?.trackingToken ?? null;
}

/** A link to the place on Google Maps: its coordinates when the trip has them, else a search for its name and address. */
export function mapLinkOf(point: { name?: string | null; address?: string | null; lat?: number | null; lng?: number | null } | null | undefined) {
  if (!point) return null;
  if (point.lat !== null && point.lat !== undefined && point.lng !== null && point.lng !== undefined) {
    return `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`;
  }
  const text = [point.name, point.address].filter(Boolean).join(' ').trim();
  return text ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}` : null;
}

import { BookingKind, BookingServiceType } from '@prisma/client';

/** Which parts each kind of booking is made of; the server checks a request against this. */
export const BOOKING_KIND_PARTS: Record<BookingKind, { outbound: boolean; return: boolean; stay: boolean }> = {
  TRANSPORT_ROUND: { outbound: true, return: true, stay: false },
  TRANSPORT_OUTBOUND: { outbound: true, return: false, stay: false },
  TRANSPORT_RETURN: { outbound: false, return: true, stay: false },
  PACKAGE_ROUND_STAY: { outbound: true, return: true, stay: true },
  PACKAGE_OUTBOUND_STAY: { outbound: true, return: false, stay: true },
  PACKAGE_STAY_RETURN: { outbound: false, return: true, stay: true },
  PACKAGE_ROUND_NO_STAY: { outbound: true, return: true, stay: false },
};

export const BOOKING_KIND_LABELS: Record<BookingKind, string> = {
  TRANSPORT_ROUND: 'نقل · ذهاب وعودة',
  TRANSPORT_OUTBOUND: 'نقل · ذهاب فقط',
  TRANSPORT_RETURN: 'نقل · عودة فقط',
  PACKAGE_ROUND_STAY: 'باقة · ذهاب وعودة مع السكن',
  PACKAGE_OUTBOUND_STAY: 'باقة · ذهاب فقط مع السكن',
  PACKAGE_STAY_RETURN: 'باقة · سكن وعودة فقط',
  PACKAGE_ROUND_NO_STAY: 'باقة · ذهاب وعودة بدون سكن',
};

/** What the customer bought. The admin panel and the app keep the same words in their own copies of this list. */
export const BOOKING_SERVICE_LABELS: Record<BookingServiceType, string> = {
  TRANSPORT_ONLY: 'نقل فقط',
  WITH_HOTEL: 'نقل مع سكن',
  WITH_VISITS: 'نقل مع زيارة معالم',
  WITH_HOTEL_VISITS: 'نقل مع سكن مع زيارة معالم',
};

/** Which way the booking goes, read from its kind. */
export const BOOKING_KIND_DIRECTIONS: Record<BookingKind, string> = {
  TRANSPORT_ROUND: 'ذهاب وعودة',
  TRANSPORT_OUTBOUND: 'ذهاب فقط',
  TRANSPORT_RETURN: 'عودة فقط',
  PACKAGE_ROUND_STAY: 'ذهاب وعودة',
  PACKAGE_OUTBOUND_STAY: 'ذهاب فقط',
  PACKAGE_STAY_RETURN: 'عودة فقط',
  PACKAGE_ROUND_NO_STAY: 'ذهاب وعودة',
};

/**
 * A booking of the way there alone on a round trip (ذهاب وعودة) still rides back on its own seat, as the trip promises:
 * the counter's default "ذهاب فقط" and the app's single leg both land here, so its label says ذهاب وعودة.
 */
const onRoundTripBus = (kind: BookingKind, tripDirection: string | null | undefined) =>
  tripDirection === 'ROUND_TRIP' && (kind === 'TRANSPORT_OUTBOUND' || kind === 'PACKAGE_OUTBOUND_STAY');

const HOTEL_SERVICES: BookingServiceType[] = ['WITH_HOTEL', 'WITH_HOTEL_VISITS'];
const VISIT_SERVICES: BookingServiceType[] = ['WITH_VISITS', 'WITH_HOTEL_VISITS'];

export const serviceTypeOf = (stay: boolean, visits: boolean): BookingServiceType =>
  stay ? (visits ? 'WITH_HOTEL_VISITS' : 'WITH_HOTEL') : visits ? 'WITH_VISITS' : 'TRANSPORT_ONLY';
export const serviceHasStay = (serviceType: string | null | undefined) => HOTEL_SERVICES.includes(serviceType as BookingServiceType);
export const serviceHasVisits = (serviceType: string | null | undefined) => VISIT_SERVICES.includes(serviceType as BookingServiceType);

/**
 * The one label for a booking's type, built from what is stored on the booking, so the bookings list, the booking's
 * page, the manifest, the invoice and the app all say the same thing: "نقل مع سكن · ذهاب فقط", with "باقة ·" before a package.
 * Given the booking's trip, a way-there-only kind on a round trip reads ذهاب وعودة (see onRoundTripBus).
 */
export function bookingTypeLabel(booking: {
  serviceType?: BookingServiceType | string | null;
  kind?: BookingKind | string | null;
  // Any trip the caller selected; only its direction is read, and a caller without one gets the kind's own words.
  trip?: { direction?: string | null; [field: string]: unknown } | null;
}) {
  const service = BOOKING_SERVICE_LABELS[(booking.serviceType ?? 'TRANSPORT_ONLY') as BookingServiceType] ?? BOOKING_SERVICE_LABELS.TRANSPORT_ONLY;
  const kind = booking.kind as BookingKind | null | undefined;
  const direction = kind ? (onRoundTripBus(kind, booking.trip?.direction) ? 'ذهاب وعودة' : BOOKING_KIND_DIRECTIONS[kind]) : null;
  return [kind?.startsWith('PACKAGE_') ? 'باقة' : null, service, direction].filter(Boolean).join(' · ');
}

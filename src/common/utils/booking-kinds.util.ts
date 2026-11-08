import { BookingKind } from '@prisma/client';

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

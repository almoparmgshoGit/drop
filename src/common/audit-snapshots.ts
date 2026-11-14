import { Prisma } from '@prisma/client';
import { SETTING_LABELS } from './audit-events';
import { BOOKING_TYPE_LABELS } from './booking-type-labels';
import { PERMISSION_GROUPS } from './permissions';
import { PrismaService } from './services/prisma.service';

/**
 * Before and after values for the audit log.
 *
 * The audit interceptor reads the record a write is about just before the handler runs and again once it has
 * answered, then keeps only the fields that differ. Reading the database (not the request body) means the log shows
 * what really changed, including what the service derived — a price recomputed, a status moved, a seat swapped.
 */

export type AuditRecordType =
  | 'booking'
  | 'trip'
  | 'user'
  | 'rank'
  | 'jobType'
  | 'branch'
  | 'cashSession'
  | 'custody'
  | 'coupon'
  | 'offer'
  | 'loyaltyRule'
  | 'loyaltyVoucher'
  | 'settings'
  | 'package'
  | 'bus'
  | 'hotel'
  | 'busOffice';

/** What the log's filter lists, in this order. */
export const AUDIT_RECORD_TYPES: Record<AuditRecordType, string> = {
  booking: 'الحجوزات',
  trip: 'الرحلات',
  user: 'الموظفون والعملاء',
  rank: 'الرتب والصلاحيات',
  jobType: 'الوظائف',
  branch: 'الفروع',
  cashSession: 'الصندوق اليومي',
  custody: 'العهد',
  coupon: 'الكوبونات',
  offer: 'العروض',
  loyaltyRule: 'قواعد النقاط',
  loyaltyVoucher: 'قسائم الولاء',
  settings: 'الإعدادات',
  package: 'الباقات',
  bus: 'الباصات',
  hotel: 'الفنادق',
  busOffice: 'مكاتب الباصات',
};

export type AuditTarget = { type: AuditRecordType; id: string };
export type AuditFieldChange = { field: string; before: unknown; after: unknown };
export type AuditChanges = { label: string | null; deleted?: boolean; truncated?: boolean; fields: AuditFieldChange[] };

type Snapshot = { label: string | null; values: Record<string, unknown> };
type Params = Record<string, string | undefined>;

/** Routes are written without the global prefix. The first rule that matches decides the record. */
const RULES: { pattern: RegExp; type: AuditRecordType; id: (params: Params) => string | undefined }[] = [
  { pattern: /^\/bookings\/(admin\/)?:id(\/|$)/, type: 'booking', id: (p) => p.id },
  { pattern: /^\/collections\/bookings\/:id(\/|$)/, type: 'booking', id: (p) => p.id },
  { pattern: /^\/trips\/:id(\/|$)/, type: 'trip', id: (p) => p.id },
  { pattern: /^\/branches\/:id\/employees\/:userId(\/|$)/, type: 'user', id: (p) => p.userId },
  { pattern: /^\/branches\/:id(\/manager)?$/, type: 'branch', id: (p) => p.id },
  { pattern: /^\/cash\/branches\/:id$/, type: 'branch', id: (p) => p.id },
  { pattern: /^\/cash\/sessions\/:id(\/|$)/, type: 'cashSession', id: (p) => p.id },
  { pattern: /^\/cash\/custodies\/:id(\/|$)/, type: 'custody', id: (p) => p.id },
  { pattern: /^\/users\/:id(\/|$)/, type: 'user', id: (p) => p.id },
  { pattern: /^\/hr\/employees\/:userId\/status$/, type: 'user', id: (p) => p.userId },
  { pattern: /^\/ranks\/:id$/, type: 'rank', id: (p) => p.id },
  { pattern: /^\/job-types\/:id$/, type: 'jobType', id: (p) => p.id },
  { pattern: /^\/coupons\/:id$/, type: 'coupon', id: (p) => p.id },
  { pattern: /^\/offers\/:id$/, type: 'offer', id: (p) => p.id },
  { pattern: /^\/loyalty\/rules\/:id$/, type: 'loyaltyRule', id: (p) => p.id },
  { pattern: /^\/loyalty\/vouchers\/:id$/, type: 'loyaltyVoucher', id: (p) => p.id },
  { pattern: /^\/loyalty\/program$/, type: 'settings', id: () => 'loyaltyProgram' },
  { pattern: /^\/settings(\/vehicle-types)?$/, type: 'settings', id: () => 'settings' },
  { pattern: /^\/packages\/:id$/, type: 'package', id: (p) => p.id },
  { pattern: /^\/buses\/:id$/, type: 'bus', id: (p) => p.id },
  { pattern: /^\/hotels\/:id$/, type: 'hotel', id: (p) => p.id },
  { pattern: /^\/bus-offices\/:id$/, type: 'busOffice', id: (p) => p.id },
];

const API_PREFIX = /^\/api\/v\d+(?=\/)/;

/** Creations have nothing to compare, so only writes on an existing record are snapshotted. */
export function resolveAuditTarget(method: string, routePath: string | undefined, params: Params | undefined): AuditTarget | null {
  if (!routePath || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const path = routePath.replace(API_PREFIX, '');
  for (const rule of RULES) {
    if (!rule.pattern.test(path)) continue;
    const id = rule.id(params ?? {});
    return id ? { type: rule.type, id } : null;
  }
  return null;
}

/** Never kept, whatever the record: secrets and bookkeeping noise. */
const ALWAYS_SKIPPED = new Set(['id', 'createdAt', 'updatedAt', 'idempotencyKey']);
const SECRET_FIELD = /password|hash|token|secret|otp/i;
const MAX_TEXT = 400;
const MAX_FIELDS = 80;
const MAX_JSON_BYTES = 24_000;

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** Plain JSON values: decimals as their digits, dates as ISO text, objects as capped JSON text. */
export function normalizeAuditValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString();
  if (Array.isArray(value)) return value.map((item) => (item !== null && typeof item === 'object' ? cut(JSON.stringify(item)) : item));
  if (typeof value === 'object') return cut(JSON.stringify(value));
  if (typeof value === 'string') return cut(value);
  return value;
}

function scalars(record: Record<string, unknown>, skip: string[] = []) {
  const skipped = new Set(skip);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ALWAYS_SKIPPED.has(key) || skipped.has(key) || SECRET_FIELD.test(key)) continue;
    // Relations loaded for names are taken out by the caller first, so an object left here is a Json column.
    values[key] = normalizeAuditValue(value);
  }
  return values;
}

type Loader = (db: PrismaService, id: string) => Promise<Snapshot | null>;

function fingerprint(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

const PASSENGER_FIELDS = ['fullName', 'phone', 'nationalId', 'seatNumber', 'gender', 'nationality', 'notes', 'roomNote'] as const;

const LOADERS: Record<AuditRecordType, Loader> = {
  async booking(db, id) {
    const row = await db.booking.findUnique({
      where: { id },
      include: {
        passengers: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        trip: { select: { tripCode: true } },
        branch: { select: { name: true } },
        coupon: { select: { code: true } },
        stayHotel: { select: { name: true } },
        collections: { select: { amount: true } },
      },
    });
    if (!row) return null;
    const { passengers, trip, branch, coupon, stayHotel, collections, ...booking } = row;
    const values = scalars(booking, [
      'userId', 'tripId', 'branchId', 'couponId', 'stayHotelId', 'customPackageId', 'boardingPointId',
      'createdById', 'priceAdjustedById', 'cancelReviewedById', 'loyaltyPlan', 'loyaltySettledAt', 'lateAlertAt', 'stoppedAlertAt',
    ]);
    values.tripCode = trip?.tripCode ?? null;
    values.branchName = branch?.name ?? null;
    values.couponCode = coupon?.code ?? null;
    values.stayHotelName = stayHotel?.name ?? null;
    values.collectedAmount = collections.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0)).toString();
    values.passengerCount = passengers.length;
    passengers.forEach((passenger, index) => {
      for (const field of PASSENGER_FIELDS) values[`passengers.${index + 1}.${field}`] = normalizeAuditValue(passenger[field]);
    });
    return { label: `حجز ${row.bookingReference}`, values };
  },

  async trip(db, id) {
    const row = await db.trip.findUnique({ where: { id }, include: { bus: { select: { plateNumber: true } } } });
    if (!row) return null;
    const { bus, seatLayout, ...trip } = row;
    const values = scalars(trip, [
      'codePeriod', 'codeNumber', 'seriesId', 'busId', 'packageId', 'reverseOfTripId', 'currentBoardingPointId', 'liveStatusAt',
      'crewOpenAnnouncedAt', 'boardingOpenAnnouncedAt', 'boardingCloseAnnouncedAt', 'reverseReadyAnnouncedAt', 'reminder24hAnnouncedAt',
    ]);
    values.busPlate = bus?.plateNumber ?? null;
    // The layout is large; a fingerprint is enough to say it changed.
    values.seatLayout = seatLayout ? fingerprint(JSON.stringify(seatLayout)) : null;
    return { label: `رحلة ${row.tripCode}`, values };
  },

  async user(db, id) {
    const row = await db.user.findUnique({ where: { id }, include: { rank: { select: { name: true } }, branch: { select: { name: true } } } });
    if (!row) return null;
    const { rank, branch, ...user } = row;
    const values = scalars(user, ['googleId', 'referralCode', 'referredById', 'lastLoginAt', 'loyaltyActivityAt', 'photoUpdatedAt', 'rankId', 'branchId']);
    values.rankName = rank?.name ?? null;
    values.branchName = branch?.name ?? null;
    return { label: user.name || user.phone, values };
  },

  async rank(db, id) {
    const row = await db.rank.findUnique({ where: { id }, include: { job: { select: { name: true } } } });
    if (!row) return null;
    const { job, ...rank } = row;
    return { label: `رتبة ${rank.name}`, values: { ...scalars(rank, ['jobId']), jobName: job?.name ?? null } };
  },

  async jobType(db, id) {
    const row = await db.jobType.findUnique({ where: { id } });
    return row && { label: `وظيفة ${row.name}`, values: scalars(row) };
  },

  async branch(db, id) {
    const row = await db.branch.findUnique({ where: { id }, include: { manager: { select: { name: true, phone: true } } } });
    if (!row) return null;
    const { manager, ...branch } = row;
    return { label: `فرع ${branch.name}`, values: { ...scalars(branch, ['managerId']), managerName: manager ? manager.name || manager.phone : null } };
  },

  async cashSession(db, id) {
    const row = await db.cashSession.findUnique({ where: { id }, include: { branch: { select: { name: true } } } });
    if (!row) return null;
    const { branch, ...session } = row;
    return { label: `صندوق ${branch?.name ?? ''}`.trim(), values: scalars(session, ['branchId', 'openedById', 'closedById']) };
  },

  async custody(db, id) {
    const row = await db.custody.findUnique({ where: { id } });
    return row && { label: `عهدة رقم ${row.number}`, values: scalars(row, ['branchId', 'issuedSessionId', 'recipientId', 'tripId', 'issuedById', 'settledById']) };
  },

  async coupon(db, id) {
    const row = await db.coupon.findUnique({ where: { id } });
    return row && { label: `كوبون ${row.code}`, values: scalars(row, ['ownerUserId']) };
  },

  async offer(db, id) {
    const row = await db.promoOffer.findUnique({ where: { id }, include: { coupon: { select: { code: true } } } });
    if (!row) return null;
    const { coupon, ...offer } = row;
    const values = scalars(offer, ['couponId', 'viewCount', 'clickCount', 'copyCount', 'dismissCount']);
    values.couponCode = coupon?.code ?? null;
    return { label: `عرض ${offer.title}`, values };
  },

  async loyaltyRule(db, id) {
    const row = await db.loyaltyRule.findUnique({ where: { id } });
    return row && { label: `قاعدة نقاط ${row.name}`, values: scalars(row, ['tripId']) };
  },

  async loyaltyVoucher(db, id) {
    const row = await db.loyaltyVoucher.findUnique({ where: { id } });
    return row && { label: `قسيمة ${row.name}`, values: scalars(row) };
  },

  /** Every setting except the service keys, which are encrypted and logged by name only. JSON values are spread one level. */
  async settings(db, id) {
    const rows = await db.setting.findMany({
      where: id === 'settings' ? { NOT: { key: { startsWith: 'integration.' } } } : { key: id },
    });
    const values: Record<string, unknown> = {};
    for (const row of rows) {
      if (SECRET_FIELD.test(row.key)) continue;
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) values[`${row.key}.${key}`] = normalizeAuditValue(value);
      } else {
        values[row.key] = cut(row.value);
      }
    }
    return { label: id === 'loyaltyProgram' ? 'برنامج الولاء' : 'إعدادات النظام', values };
  },

  async package(db, id) {
    const row = await db.package.findUnique({ where: { id } });
    return row && { label: `باقة ${row.name}`, values: scalars(row, ['hotelId']) };
  },

  async bus(db, id) {
    const row = await db.bus.findUnique({ where: { id } });
    return row && { label: `باص ${row.plateNumber}`, values: scalars(row, ['officeId']) };
  },

  async hotel(db, id) {
    const row = await db.hotel.findUnique({ where: { id } });
    return row && { label: `فندق ${row.name}`, values: scalars(row) };
  },

  async busOffice(db, id) {
    const row = await db.busOffice.findUnique({ where: { id } });
    return row && { label: `مكتب ${row.name}`, values: scalars(row) };
  },
};

/** Never throws: a log that cannot read the record still records the write, only without the comparison. */
export async function snapshotAuditTarget(db: PrismaService, target: AuditTarget): Promise<Snapshot | null> {
  try {
    return await LOADERS[target.type](db, target.id);
  } catch (err) {
    console.error('Audit snapshot failed:', (err as Error).message);
    return null;
  }
}

const comparable = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : value ?? null);

/** The fields that differ, or null when nothing did (the write is still logged, just without a comparison). */
export function diffAuditSnapshots(before: Snapshot | null, after: Snapshot | null): AuditChanges | null {
  if (!before && !after) return null;
  const deleted = !!before && !after;
  const keys = [...new Set([...Object.keys(before?.values ?? {}), ...Object.keys(after?.values ?? {})])];
  let fields: AuditFieldChange[] = [];
  for (const field of keys) {
    const was = before?.values[field] ?? null;
    const now = after?.values[field] ?? null;
    if (comparable(was) === comparable(now)) continue;
    fields.push({ field, before: was, after: now });
  }
  if (!fields.length) return null;
  let truncated = false;
  if (fields.length > MAX_FIELDS) {
    fields = fields.slice(0, MAX_FIELDS);
    truncated = true;
  }
  while (fields.length > 1 && JSON.stringify(fields).length > MAX_JSON_BYTES) {
    fields = fields.slice(0, Math.ceil(fields.length / 2));
    truncated = true;
  }
  return { label: (after ?? before)?.label ?? null, ...(deleted && { deleted }), ...(truncated && { truncated }), fields };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading: field names and stored values turned into words. Done when the log is read, so a better label also
// corrects past rows.

const COMMON_LABELS: Record<string, string> = {
  name: 'الاسم',
  title: 'العنوان',
  description: 'الوصف',
  phone: 'الجوال',
  email: 'البريد الإلكتروني',
  whatsapp: 'واتساب',
  city: 'المدينة',
  address: 'العنوان التفصيلي',
  notes: 'ملاحظات',
  status: 'الحالة',
  isActive: 'مفعّل',
  price: 'السعر',
  value: 'القيمة',
  amount: 'المبلغ',
  type: 'النوع',
  role: 'نوع الحساب',
  isSystem: 'رتبة نظام',
  startsAt: 'يبدأ في',
  endsAt: 'ينتهي في',
  startDate: 'تاريخ البداية',
  endDate: 'تاريخ النهاية',
  contactName: 'اسم المسؤول',
  imageUrl: 'الصورة',
  couponCode: 'الكوبون',
  branchName: 'الفرع',
};

const TYPE_LABELS: Partial<Record<AuditRecordType, Record<string, string>>> = {
  booking: {
    bookingReference: 'رقم الحجز',
    status: 'حالة الحجز',
    groupReference: 'رقم المجموعة',
    category: 'فئة الحجز',
    roomChoice: 'نوع الغرفة المطلوب',
    housingAmount: 'مبلغ السكن',
    source: 'مصدر الحجز',
    kind: 'نوع الحجز',
    leg: 'الاتجاه',
    serviceType: 'الخدمة',
    stayHotelName: 'فندق السكن',
    stayCheckIn: 'دخول السكن',
    stayCheckOut: 'خروج السكن',
    stayNights: 'عدد الليالي',
    createdByName: 'سجّله',
    subtotal: 'المبلغ قبل الخصم',
    discountAmount: 'الخصم',
    walletAmount: 'المدفوع من المحفظة',
    vatAmount: 'الضريبة',
    totalPrice: 'إجمالي الحجز',
    priceAdjustment: 'تعديل السعر',
    priceAdjustmentReason: 'سبب تعديل السعر',
    priceAdjustedByName: 'عدّل السعر',
    boardingPointName: 'نقطة الصعود',
    boardingPointTime: 'وقت الصعود',
    cancelReason: 'سبب الإلغاء',
    cancelRequestedAt: 'وقت طلب الإلغاء',
    cancelReviewNote: 'ملاحظة مراجعة الإلغاء',
    cancelCustomerNote: 'ملاحظة الإلغاء للعميل',
    cancelReviewedAt: 'وقت مراجعة الإلغاء',
    refundAmount: 'المسترد للمحفظة',
    externalRefunded: 'المسترد خارج المحفظة',
    pointsRedeemed: 'النقاط المستبدلة',
    pointsDiscount: 'خصم النقاط',
    tripCode: 'الرحلة',
    collectedAmount: 'المبلغ المحصّل',
    passengerCount: 'عدد الركاب',
  },
  trip: {
    tripCode: 'رمز الرحلة',
    title: 'اسم الرحلة',
    origin: 'من',
    destination: 'إلى',
    departureStation: 'محطة الانطلاق',
    departureTime: 'موعد الانطلاق',
    arrivalTime: 'موعد الوصول',
    estimatedArrivalAt: 'الوصول المتوقع',
    hijriDate: 'التاريخ الهجري',
    busType: 'نوع الباص',
    price: 'سعر المقعد',
    pricingRules: 'التسعير المرن',
    totalSeats: 'عدد المقاعد',
    availableSeats: 'المقاعد المتاحة',
    maxSeatsPerBooking: 'أقصى مقاعد للحجز الواحد',
    miqat: 'الميقات',
    crewOpensBeforeMinutes: 'فتح الرحلة للطاقم قبل (دقيقة)',
    boardingOpensBeforeMinutes: 'فتح الصعود قبل (دقيقة)',
    boardingClosesAfterMinutes: 'إغلاق الصعود بعد (دقيقة)',
    boardingOpenedManuallyAt: 'فتح الصعود يدويًا',
    unpaidBoarding: 'صعود غير المسددين',
    manifestSentAt: 'إرسال الكشف',
    manifestSentByName: 'أرسل الكشف',
    executedAt: 'تنفيذ الرحلة',
    financeClosedAt: 'إقفال حساب الرحلة',
    financeClosedByName: 'أقفل الحساب',
    tripStatus: 'حالة الرحلة',
    scheduleType: 'نوع الجدولة',
    recurrenceCalendar: 'تقويم التكرار',
    repeatUntil: 'التكرار حتى',
    seatLayout: 'مخطط المقاعد',
    liveStatus: 'حالة التشغيل',
    direction: 'الاتجاه',
    bookingType: 'نوع الرحلة',
    busPlate: 'الباص',
    reverseEnabled: 'الرحلة العكسية',
    reverseOpenPercent: 'فتح العكسية عند امتلاء (%)',
    reverseDepartureAt: 'موعد العودة',
    reversePrice: 'سعر العودة',
    channelApp: 'الحجز من التطبيق',
    channelBranch: 'الحجز من الفروع',
    bookingOpensAt: 'موعد فتح الحجز',
    busRentalPrice: 'إيجار الباص',
    housingPrice: 'سعر السكن',
    privateRoomPrice: 'سعر الغرفة الخاصة',
    privateRoomCapacity: 'سعة الغرفة الخاصة',
    housingPriceMode: 'طريقة تسعير السكن',
    privateRoomPriceBasis: 'أساس سعر الغرفة الخاصة',
    housingPricePeriod: 'فترة سعر السكن',
    sharedRoomCapacity: 'سعة الغرفة المشتركة',
    alertLeadMinutes: 'التنبيه قبل (دقيقة)',
    alertRepeatMinutes: 'تكرار التنبيه (دقيقة)',
  },
  user: {
    name: 'الاسم',
    rankName: 'الرتبة',
    branchName: 'الفرع',
    extraPermissions: 'صلاحيات مضافة له',
    revokedPermissions: 'صلاحيات مسحوبة منه',
    isVerified: 'موثّق',
    walletBalance: 'رصيد المحفظة',
    loyaltyPoints: 'نقاط الولاء',
    nationality: 'الجنسية',
    gender: 'الجنس',
    idType: 'نوع الهوية',
    idNumber: 'رقم الهوية',
    idIssueDate: 'تاريخ إصدار الهوية',
    idExpiryDate: 'تاريخ انتهاء الهوية',
    birthDate: 'تاريخ الميلاد',
    nativeLanguage: 'اللغة الأم',
    messageLanguage: 'لغة التنبيهات',
    marketingOptOutAt: 'إيقاف العروض',
    blockedAt: 'محظور منذ',
    blockedReason: 'سبب الحظر',
    tripAlertsEnabled: 'تنبيهات الرحلة',
    alertLeadMinutes: 'التنبيه قبل (دقيقة)',
    alertRepeatMinutes: 'تكرار التنبيه (دقيقة)',
  },
  rank: { permissions: 'الصلاحيات', jobName: 'الوظيفة', tripAllowance: 'بدل الرحلة' },
  jobType: { tripRole: 'الدور في الرحلات' },
  branch: { code: 'رمز الفرع', workingHours: 'ساعات العمل', managerName: 'مدير الفرع' },
  cashSession: {
    businessDate: 'يوم العمل',
    openingBalance: 'رصيد الافتتاح',
    carriedBalance: 'المرحّل من الإقفال السابق',
    openingNote: 'ملاحظة الافتتاح',
    openedByName: 'فتحه',
    openedAt: 'وقت الفتح',
    expectedBalance: 'الرصيد المتوقع',
    countedCash: 'النقد المعدود',
    difference: 'الفرق',
    closeNote: 'ملاحظة الإقفال',
    closedByName: 'أقفله',
    closedAt: 'وقت الإقفال',
  },
  custody: {
    number: 'رقم العهدة',
    recipientName: 'المستلم',
    recipientJob: 'وظيفة المستلم',
    purpose: 'الغرض',
    amount: 'مبلغ العهدة',
    spentAmount: 'المصروف',
    returnedAmount: 'المرتجع',
    settlementNote: 'ملاحظة التسوية',
    issuedByName: 'صرفها',
    issuedAt: 'وقت الصرف',
    settledByName: 'سوّاها',
    settledAt: 'وقت التسوية',
  },
  coupon: {
    code: 'رمز الكوبون',
    type: 'نوع الخصم',
    value: 'قيمة الخصم',
    maxUses: 'أقصى عدد استخدام',
    usedCount: 'مرات الاستخدام',
    perUserLimit: 'حد كل عميل',
    validFrom: 'صالح من',
    validUntil: 'صالح حتى',
  },
  offer: {
    label: 'السطر العلوي',
    body: 'النص',
    ctaLabel: 'نص الزر',
    translations: 'الترجمات',
    action: 'وجهة الزر',
    actionUrl: 'الرابط',
    frequency: 'مرات الظهور',
    priority: 'الأولوية',
  },
  loyaltyRule: { weekdays: 'أيام الأسبوع', minDaysBefore: 'قبل الرحلة بأيام على الأقل', minSeats: 'أقل عدد مقاعد' },
  loyaltyVoucher: { pointsCost: 'تكلفتها بالنقاط', validDays: 'صلاحيتها بالأيام' },
  package: { price2: 'سعر الثنائي', price3: 'سعر الثلاثي', price4: 'سعر الرباعي', nights: 'الليالي', terms: 'الشروط', kind: 'نوع الباقة', origin: 'من', destination: 'إلى', nightlyBedPrice: 'سعر السرير لليلة', nightlyRoomPrice: 'سعر الغرفة لليلة', minDepartureHour: 'أبكر ساعة انطلاق' },
  bus: { plateNumber: 'رقم اللوحة', model: 'الطراز', color: 'اللون', company: 'الشركة', kind: 'نوع المركبة', seatCount: 'عدد المقاعد', singlesFromSeat: 'بداية مقاعد العزاب', singlesToSeat: 'نهاية مقاعد العزاب' },
  hotel: { nightlyRate: 'سعر الليلة', offersSharedRoom: 'غرف مشتركة', offersPrivateRoom: 'غرف خاصة', rateUnit: 'وحدة السعر', bedPrice: 'سعر السرير', privateRoomPrice: 'سعر الغرفة الخاصة', privateRoomCapacity: 'سعة الغرفة الخاصة' },
  busOffice: { contractNumber: 'رقم العقد' },
};

const PASSENGER_LABELS: Record<string, string> = {
  fullName: 'الاسم',
  phone: 'الجوال',
  nationalId: 'رقم الهوية',
  seatNumber: 'المقعد',
  gender: 'الجنس',
  nationality: 'الجنسية',
  notes: 'ملاحظات',
  roomNote: 'ملاحظة السكن',
};

const PERMISSION_LABELS = new Map<string, string>(PERMISSION_GROUPS.flatMap((group) => group.items.map((item): [string, string] => [item.key, item.label])));
const PERMISSION_FIELDS = new Set(['permissions', 'extraPermissions', 'revokedPermissions']);

const STATUS_LABELS: Partial<Record<AuditRecordType, Record<string, string>>> = {
  booking: { PENDING: 'بانتظار الدفع', CONFIRMED: 'مؤكد', BOARDED: 'صعد', CANCELLED: 'ملغى', PENDING_CANCELLATION_REVIEW: 'بانتظار مراجعة الإلغاء' },
  cashSession: { OPEN: 'مفتوح', CLOSED: 'مقفل' },
  custody: { OPEN: 'مفتوحة', SETTLED: 'مسوّاة' },
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  tripStatus: { DRAFT: 'مسودة', PUBLISHED: 'منشورة', CANCELLED: 'ملغاة', COMPLETED: 'مكتملة' },
  role: { PASSENGER: 'عميل', DRIVER: 'سائق', STAFF: 'موظف', ADMIN: 'مدير نظام' },
  gender: { MALE: 'ذكر', FEMALE: 'أنثى' },
  serviceType: BOOKING_TYPE_LABELS,
  type: { PERCENT: 'نسبة مئوية', FIXED_PER_SEAT: 'مبلغ لكل مقعد', FIXED_TOTAL: 'مبلغ ثابت للحجز' },
  category: { FAMILY: 'عائلي', SINGLES: 'عزاب' },
  source: { APP: 'التطبيق', BRANCH: 'الفرع' },
  direction: { ONE_WAY: 'ذهاب فقط', ROUND_TRIP: 'ذهاب وعودة' },
  idType: { NATIONAL_ID: 'هوية وطنية', IQAMA: 'إقامة', PASSPORT: 'جواز سفر' },
};

export function auditFieldLabel(type: string | null, field: string): string {
  const passenger = /^passengers\.(\d+)\.(\w+)$/.exec(field);
  if (passenger) return `الراكب ${passenger[1]}: ${PASSENGER_LABELS[passenger[2]] ?? passenger[2]}`;
  if (type === 'settings') {
    const [key, sub] = field.split('.');
    if (sub) return `${key === 'loyaltyProgram' ? 'برنامج الولاء' : SETTING_LABELS[key] ?? key}: ${sub}`;
    return SETTING_LABELS[field] ?? field;
  }
  return TYPE_LABELS[type as AuditRecordType]?.[field] ?? COMMON_LABELS[field] ?? field;
}

/** A value as words, or a list of words for permission sets. Dates stay ISO text for the panel to format in its own way. */
export function auditValueText(type: string | null, field: string, value: unknown): string | string[] | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.map((item) => (PERMISSION_FIELDS.has(field) ? PERMISSION_LABELS.get(String(item)) ?? String(item) : String(item)));
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  const text = String(value);
  const last = field.split('.').pop() ?? field;
  if (last === 'status') return STATUS_LABELS[type as AuditRecordType]?.[text] ?? text;
  if (field === 'seatLayout') return 'مخطط محفوظ';
  return VALUE_LABELS[last]?.[text] ?? text;
}

export type PresentedAuditChanges = {
  recordType: string | null;
  recordTypeLabel: string | null;
  recordId: string | null;
  label: string | null;
  deleted: boolean;
  truncated: boolean;
  fields: { field: string; label: string; before: string | string[] | null; after: string | string[] | null }[];
};

/** What the panel draws for one row; null for rows written before values were compared. */
export function presentAuditChanges(recordType: string | null, recordId: string | null, changes: unknown): PresentedAuditChanges | null {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const stored = changes as Partial<AuditChanges>;
  if (!Array.isArray(stored.fields) || !stored.fields.length) return null;
  return {
    recordType,
    recordTypeLabel: recordType ? AUDIT_RECORD_TYPES[recordType as AuditRecordType] ?? null : null,
    recordId,
    label: stored.label ?? null,
    deleted: !!stored.deleted,
    truncated: !!stored.truncated,
    fields: stored.fields.map((change) => ({
      field: change.field,
      label: auditFieldLabel(recordType, change.field),
      before: auditValueText(recordType, change.field, change.before),
      after: auditValueText(recordType, change.field, change.after),
    })),
  };
}

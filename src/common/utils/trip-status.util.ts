import { Prisma, TripStopReason } from '@prisma/client';

/**
 * One status for a trip, read from its office workflow (tripStatus), where the bus is (liveStatus) and its sales, so the
 * dashboard and the staff app show the same word and offer the same next steps. The server decides; screens only draw it.
 */

export const TRIP_STOP_REASON_LABELS: Record<TripStopReason, string> = {
  OFFICE: 'إيقاف إداري',
  BREAKDOWN: 'عطل في الحافلة',
  EMERGENCY: 'ظرف طارئ',
};

export const TRIP_STATUS_KEYS = [
  'DRAFT',
  'BOOKING_SOON',
  'OPEN',
  'FULL',
  'SALES_CLOSED',
  'NOT_ON_SALE',
  'AWAITING_START',
  'AT_POINT',
  'ON_ROAD',
  'STOPPED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TripStatusKey = (typeof TRIP_STATUS_KEYS)[number];

export const TRIP_STATUS_ACTIONS = [
  'PUBLISH',
  'UNPUBLISH',
  'CLOSE_SALES',
  'OPEN_SALES',
  'DELAY',
  'START',
  'AT_POINT',
  'ON_ROAD',
  'ARRIVED',
  'STOP',
  'RESUME',
  'UNDO_ARRIVAL',
  'UNDO_START',
  'CANCEL',
  'RESTORE',
] as const;
export type TripStatusAction = (typeof TRIP_STATUS_ACTIONS)[number];

export type TripStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const TRIP_STATUS_SELECT = {
  id: true,
  tripCode: true,
  tripStatus: true,
  liveStatus: true,
  liveStatusAt: true,
  departureTime: true,
  arrivalTime: true,
  availableSeats: true,
  channelApp: true,
  channelBranch: true,
  bookingOpensAt: true,
  salesClosedAt: true,
  salesClosedByName: true,
  originalDepartureTime: true,
  delayReason: true,
  stopReason: true,
  stopNote: true,
  financeClosedAt: true,
  convoyLeadId: true,
  currentBoardingPoint: { select: { name: true } },
} satisfies Prisma.TripSelect;

export type TripStatusTrip = Prisma.TripGetPayload<{ select: typeof TRIP_STATUS_SELECT }>;

const STATUS_LABELS: Record<TripStatusKey, string> = {
  DRAFT: 'مسودة',
  BOOKING_SOON: 'الحجز يفتح لاحقًا',
  OPEN: 'مفتوحة للحجز',
  FULL: 'مكتملة العدد',
  SALES_CLOSED: 'مغلقة للحجز',
  NOT_ON_SALE: 'غير معروضة للبيع',
  AWAITING_START: 'تجاوزت موعدها ولم تنطلق',
  AT_POINT: 'انطلقت',
  ON_ROAD: 'في الطريق',
  STOPPED: 'متوقفة',
  COMPLETED: 'مكتملة',
  CANCELLED: 'ملغاة',
};

const STATUS_TONES: Record<TripStatusKey, TripStatusTone> = {
  DRAFT: 'neutral',
  BOOKING_SOON: 'neutral',
  OPEN: 'success',
  FULL: 'info',
  SALES_CLOSED: 'warning',
  NOT_ON_SALE: 'warning',
  AWAITING_START: 'danger',
  AT_POINT: 'info',
  ON_ROAD: 'info',
  STOPPED: 'danger',
  COMPLETED: 'success',
  CANCELLED: 'danger',
};

export const ACTION_LABELS: Record<TripStatusAction, string> = {
  PUBLISH: 'نشر الرحلة وفتح الحجز',
  UNPUBLISH: 'إرجاعها مسودة',
  CLOSE_SALES: 'إغلاق الحجز',
  OPEN_SALES: 'إعادة فتح الحجز',
  DELAY: 'تأخير / تأجيل الموعد',
  START: 'بدء الرحلة (انطلقت)',
  AT_POINT: 'الحافلة في نقطة تجمع',
  ON_ROAD: 'الحافلة في الطريق',
  ARRIVED: 'وصلت (إنهاء الرحلة)',
  STOP: 'إيقاف الرحلة',
  RESUME: 'استئناف الرحلة',
  UNDO_ARRIVAL: 'التراجع عن الوصول',
  UNDO_START: 'إرجاعها لم تنطلق',
  CANCEL: 'إلغاء الرحلة',
  RESTORE: 'استعادة الرحلة الملغاة',
};

/** What each action does to the rest of the system, shown before staff confirm it. */
export const ACTION_EFFECTS: Record<TripStatusAction, string> = {
  PUBLISH: 'تظهر الرحلة في التطبيق والفروع ويبدأ بيعها، ويُبلَّغ طاقمها بالإسناد.',
  UNPUBLISH: 'تختفي الرحلة من البيع. لا يمكن ذلك إذا كان فيها حجوزات.',
  CLOSE_SALES: 'يتوقف الحجز الجديد من التطبيق والفروع وتخرج من نتائج البحث وقائمة الانتظار، وتبقى الرحلة قائمة لمن حجز.',
  OPEN_SALES: 'تعود الرحلة للبيع في قنواتها.',
  DELAY: 'يتحرك موعد الانطلاق والوصول ونقاط التجمع ووقت تجمع كل حجز ورحلة العودة وباقي الحافلات، ويُبلَّغ المسافرون والطاقم بالموعد الجديد.',
  START: 'تصبح الحافلة في أول نقطة تجمع، ويُبلَّغ مسافرو النقطة ويفتح مسح التذاكر.',
  AT_POINT: 'يُبلَّغ مسافرو هذه النقطة بوصول الحافلة، ومن فاتته نقطة سابقة يُبلَّغ بالنقاط المتبقية.',
  ON_ROAD: 'يُبلَّغ من لم يصعد بعد أن الحافلة في الطريق.',
  ARRIVED: 'تكتمل الرحلة: يُهنَّأ الركاب بالوصول، ويتوقف التتبع، ويتحرر الباص والطاقم، وتُحتسب النقاط.',
  STOP: 'يتجمد تحديث الحالة ومسح التذاكر. العطل والظرف الطارئ يُبلَّغ بهما المسافرون والمكتب، والإيقاف الإداري لا يُبلَّغ للمسافرين.',
  RESUME: 'تعود الرحلة من آخر مكان سجله الطاقم، ويُبلَّغ المسافرون إن كانوا قد أُبلغوا بالتوقف.',
  UNDO_ARRIVAL: 'تعود الرحلة جارية في الطريق ليُكمل الطاقم تحديثها. متاح قبل إقفال حسابها وخلال مهلة التتبع.',
  UNDO_START: 'تعود الرحلة "لم تنطلق" كأنها لم تبدأ: يتوقف تحديث مكان الحافلة حتى تُبدأ من جديد، ويعود الحجز من التطبيق إن لم يحن موعدها. متاح فقط ما دام لم يصعد أي راكب.',
  CANCEL: 'تُلغى كل الحجوزات ويُعاد المبلغ للمحافظ، وتُلغى رحلة العودة وباقي الحافلات وحجوزات الفنادق، ويُبلَّغ الجميع.',
  RESTORE: 'تعود الرحلة مسودة بنفس بياناتها لتُنشر من جديد. حجوزاتها الملغاة تبقى ملغاة.',
};

/** Who may take each action: the office workflow, or running the trip on the day. */
export const ACTION_PERMISSION: Record<TripStatusAction, 'trips.manage' | 'trips.start'> = {
  PUBLISH: 'trips.manage',
  UNPUBLISH: 'trips.manage',
  CLOSE_SALES: 'trips.manage',
  OPEN_SALES: 'trips.manage',
  DELAY: 'trips.manage',
  START: 'trips.start',
  AT_POINT: 'trips.start',
  ON_ROAD: 'trips.start',
  ARRIVED: 'trips.start',
  STOP: 'trips.start',
  RESUME: 'trips.start',
  UNDO_ARRIVAL: 'trips.start',
  UNDO_START: 'trips.start',
  CANCEL: 'trips.manage',
  RESTORE: 'trips.manage',
};

const isMoving = (trip: TripStatusTrip) => trip.liveStatus === 'AT_POINT' || trip.liveStatus === 'ON_ROAD';

export function tripStatusKey(trip: TripStatusTrip, now = new Date()): TripStatusKey {
  if (trip.tripStatus === 'CANCELLED') return 'CANCELLED';
  if (trip.tripStatus === 'COMPLETED' || trip.liveStatus === 'ARRIVED') return 'COMPLETED';
  if (trip.tripStatus === 'DRAFT') return 'DRAFT';
  if (trip.liveStatus === 'STOPPED') return 'STOPPED';
  if (trip.liveStatus === 'AT_POINT') return 'AT_POINT';
  if (trip.liveStatus === 'ON_ROAD') return 'ON_ROAD';
  if (trip.departureTime <= now) return 'AWAITING_START';
  if (trip.salesClosedAt) return 'SALES_CLOSED';
  if (!trip.channelApp && !trip.channelBranch) return 'NOT_ON_SALE';
  if (trip.bookingOpensAt && trip.bookingOpensAt > now) return 'BOOKING_SOON';
  if (trip.availableSeats <= 0) return 'FULL';
  return 'OPEN';
}

export function tripStatusView(trip: TripStatusTrip, now = new Date()) {
  const key = tripStatusKey(trip, now);
  const delayMinutes =
    trip.originalDepartureTime && trip.departureTime > trip.originalDepartureTime
      ? Math.round((trip.departureTime.getTime() - trip.originalDepartureTime.getTime()) / 60_000)
      : 0;
  let label = STATUS_LABELS[key];
  if (key === 'AT_POINT' && trip.currentBoardingPoint) label = `انطلقت · في ${trip.currentBoardingPoint.name}`;
  if (key === 'STOPPED') label = `متوقفة · ${TRIP_STOP_REASON_LABELS[trip.stopReason ?? 'OFFICE']}`;
  // A delay matters until the bus leaves; after that the trip is simply under way.
  const showsDelay = delayMinutes > 0 && ['OPEN', 'FULL', 'SALES_CLOSED', 'NOT_ON_SALE', 'BOOKING_SOON', 'AWAITING_START', 'DRAFT'].includes(key);
  return {
    key,
    label,
    tone: STATUS_TONES[key],
    delayMinutes: showsDelay ? delayMinutes : 0,
    delayLabel: showsDelay ? `متأخرة ${formatDelay(delayMinutes)}` : null,
    delayReason: showsDelay ? trip.delayReason : null,
    originalDepartureTime: showsDelay ? trip.originalDepartureTime : null,
    salesClosed: !!trip.salesClosedAt,
    salesClosedByName: trip.salesClosedByName,
    stopReason: key === 'STOPPED' ? trip.stopReason ?? 'OFFICE' : null,
    // Once the bus has left, the app sells only the points ahead of it, and nothing after the last; the branches still can.
    bookingNote: key === 'AT_POINT' || key === 'ON_ROAD' || key === 'STOPPED' ? 'انطلقت الرحلة: التطبيق يبيع من نقاط التجمع التي لم تصلها الحافلة فقط، وبعد مغادرتها كل النقاط تظهر مغلقة ويكون الحجز من المكتب والفروع فقط.' : null,
    stopNote: key === 'STOPPED' ? trip.stopNote : null,
  };
}

export function formatDelay(minutes: number) {
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} يوم${hours % 24 ? ` و${hours % 24} ساعة` : ''}`;
  }
  return `${hours} ساعة${rest ? ` و${rest} دقيقة` : ''}`;
}

/**
 * The actions open from the trip's current status, for someone holding these permissions. The server checks each again
 * when it is taken; this list only keeps screens from offering what would be refused.
 */
export function tripStatusActions(trip: TripStatusTrip, permissions: string[], options: { now?: Date; trackingGraceHours: number }) {
  const now = options.now ?? new Date();
  const open: TripStatusAction[] = [];
  const notStarted = trip.liveStatus === 'NOT_STARTED';
  if (trip.tripStatus === 'DRAFT') open.push('PUBLISH', 'DELAY', 'CANCEL');
  if (trip.tripStatus === 'PUBLISHED') {
    if (notStarted) {
      open.push('START');
      open.push(trip.salesClosedAt ? 'OPEN_SALES' : 'CLOSE_SALES');
      open.push('DELAY', 'UNPUBLISH');
    }
    if (isMoving(trip)) open.push('AT_POINT', 'ON_ROAD', 'ARRIVED', 'STOP');
    if (trip.liveStatus === 'STOPPED') open.push('RESUME');
    // Started by mistake: back to not started while nobody has boarded (the server checks the boardings).
    if (isMoving(trip) || trip.liveStatus === 'STOPPED') open.push('UNDO_START');
    open.push('CANCEL');
  }
  // Arriving by mistake can be taken back while the trip's account is open and the tracking window has not closed;
  // after that the clock would complete it again at once.
  if (
    trip.tripStatus === 'COMPLETED' &&
    trip.liveStatus === 'ARRIVED' &&
    !trip.financeClosedAt &&
    trip.arrivalTime.getTime() + options.trackingGraceHours * 3_600_000 > now.getTime()
  ) {
    open.push('UNDO_ARRIVAL');
  }
  if (trip.tripStatus === 'CANCELLED' && trip.departureTime > now) open.push('RESTORE');
  // The extra buses of a multi-bus trip follow the first on delays.
  const allowed = open.filter((action) => !(action === 'DELAY' && trip.convoyLeadId));
  return allowed
    .filter((action) => permissions.includes(ACTION_PERMISSION[action]))
    .map((action) => ({ action, label: ACTION_LABELS[action], effect: ACTION_EFFECTS[action], permission: ACTION_PERMISSION[action] }));
}

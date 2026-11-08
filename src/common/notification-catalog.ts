/** Every value a template may use; the panel builds its insert buttons and preview from these. */
const VARIABLES = {
  userName: { label: 'اسم المستلم', example: 'عبدالله محمد' },
  tripCode: { label: 'رقم الرحلة', example: 'T-1024' },
  origin: { label: 'مدينة الانطلاق', example: 'الرياض' },
  destination: { label: 'الوجهة', example: 'مكة المكرمة' },
  departureDate: { label: 'تاريخ الانطلاق', example: 'الخميس، 12 مارس' },
  departureTime: { label: 'وقت الانطلاق', example: '21:30' },
  hijriDate: { label: 'التاريخ الهجري', example: '22 رمضان 1448 هـ' },
  oldDepartureDate: { label: 'تاريخ الانطلاق السابق', example: 'الأربعاء، 11 مارس' },
  oldDepartureTime: { label: 'وقت الانطلاق السابق', example: '21:00' },
  bookingReference: { label: 'رقم الحجز', example: 'DRB-58213AB' },
  seats: { label: 'أرقام المقاعد', example: '4، 5' },
  passengerCount: { label: 'عدد المسافرين', example: '2' },
  boardingPoint: { label: 'نقطة التجمع', example: 'فرع الرياض' },
  boardingTime: { label: 'وقت التجمع', example: '21:00' },
  oldBoardingPoint: { label: 'نقطة التجمع السابقة', example: 'فرع العليا' },
  oldBoardingTime: { label: 'وقت التجمع السابق', example: '20:30' },
  totalPrice: { label: 'إجمالي الحجز', example: '360 ر.س' },
  refundAmount: { label: 'المبلغ المسترد', example: '320 ر.س' },
  passengerName: { label: 'اسم المسافر', example: 'سارة أحمد' },
  oldSeat: { label: 'المقعد السابق', example: '4' },
  newSeat: { label: 'المقعد الجديد', example: '9' },
  seatNumber: { label: 'رقم المقعد', example: '4' },
  hotelName: { label: 'اسم الفندق', example: 'فندق النور' },
  roomNumber: { label: 'رقم الغرفة', example: '305' },
  message: { label: 'نص رسالة الطاقم', example: 'تأخر الانطلاق 30 دقيقة' },
  amount: { label: 'المبلغ', example: '100 ر.س' },
  walletBalance: { label: 'رصيد المحفظة بعد العملية', example: '220 ر.س' },
  points: { label: 'عدد النقاط', example: '150' },
  pointsChange: { label: 'تغير النقاط بالإشارة', example: '+150' },
  pointsBalance: { label: 'رصيد النقاط بعد العملية', example: '1240' },
  bonusName: { label: 'سبب المكافأة', example: 'مكافأة دعوة صديق' },
  voucherName: { label: 'اسم القسيمة', example: 'قسيمة 50 ريال' },
  voucherCode: { label: 'رمز القسيمة', example: 'LY1A2B3C4D5E' },
  voucherValue: { label: 'قيمة القسيمة', example: '50 ر.س' },
  customerName: { label: 'اسم العميل', example: 'خالد سعيد' },
  customerPhone: { label: 'جوال العميل', example: '+966551234567' },
  cancelReason: { label: 'سبب طلب الإلغاء', example: 'تغيرت خطة السفر' },
  reviewNote: { label: 'ملاحظة الإدارة للعميل (تختفي إن كانت فارغة)', example: 'نأمل خدمتكم في رحلة قادمة' },
  refundMethod: { label: 'وجهة الاسترداد', example: 'مدى' },
  reporterName: { label: 'اسم مقدم البلاغ', example: 'سالم المشرف' },
  reportType: { label: 'نوع البلاغ', example: 'عطل في الحافلة' },
  reportDetails: { label: 'تفاصيل البلاغ', example: 'عطل في التكييف' },
  reportCode: { label: 'رقم البلاغ', example: 'BL-0012' },
  reportCategory: { label: 'نوع البلاغ العام', example: 'طلب مساعدة' },
  reportStatus: { label: 'حالة البلاغ الجديدة (تختفي إن لم تتغير)', example: 'قيد المعالجة' },
  updateNote: { label: 'نص التحديث (يختفي إن كان فارغًا)', example: 'تم إرسال حافلة بديلة' },
  currentPoint: { label: 'النقطة الحالية للحافلة', example: 'فرع الرياض' },
  complaintReference: { label: 'رقم الشكوى', example: 'HC-17' },
  complaintSubject: { label: 'موضوع الشكوى', example: 'نظافة الغرفة' },
  complaintAuthor: { label: 'مسجل الشكوى', example: 'منى الموظفة' },
  complaintResolution: { label: 'رد الإدارة على الشكوى', example: 'تم إصلاح التكييف والاعتذار من الفندق' },
  boardingOpensTime: { label: 'وقت فتح الصعود', example: '19:30' },
  boardingClosesTime: { label: 'وقت إغلاق الصعود', example: '22:30' },
  senderName: { label: 'اسم المرسل', example: 'سالم المشرف' },
  remainingAmount: { label: 'المتبقي بعد الدفعة', example: '40 ر.س' },
  custodyNumber: { label: 'رقم العهدة', example: 'CU-031' },
  custodyPurpose: { label: 'غرض العهدة', example: 'مصاريف رحلة (ديزل + وجبات)' },
  spentAmount: { label: 'المصروف الفعلي', example: '250 ر.س' },
  returnedAmount: { label: 'المبلغ المرتجع', example: '50 ر.س' },
  voidReason: { label: 'سبب الإلغاء', example: 'الفاتورة غير واضحة' },
  branchName: { label: 'اسم الفرع', example: 'فرع الحدائق' },
  businessDate: { label: 'تاريخ الصندوق', example: '2026-10-24' },
  differenceAmount: { label: 'فرق الإقفال بالإشارة', example: '-20 ر.س' },
  carriedAmount: { label: 'رصيد آخر إقفال', example: '1810 ر.س' },
  stopName: { label: 'اسم المحطة', example: 'حي الشرم' },
  etaText: { label: 'موعد الوصول التقريبي', example: 'بعد نحو 10 دقائق' },
  minutes: { label: 'عدد الدقائق', example: '30' },
  newValue: { label: 'القيمة الجديدة التي كتبها المرسل', example: 'الساعة 23:30' },
  couponCode: { label: 'رمز الكوبون', example: 'MADINAH10' },
  nextPoints: { label: 'النقاط المتبقية للصعود', example: 'فرع الخرج (09:30)، فرع الدلم (10:15)' },
  employeeName: { label: 'اسم الموظف', example: 'سالم المشرف' },
  crewRole: { label: 'دوره في الرحلة', example: 'مشرف' },
  releaseReason: { label: 'سبب طلب التخلي', example: 'ظرف عائلي طارئ' },
  decisionNote: { label: 'ملاحظة الإدارة على القرار (تختفي إن كانت فارغة)', example: 'نرجو الإبلاغ مبكرًا في المرات القادمة' },
  penaltyType: { label: 'نوع الجزاء', example: 'إنذار' },
  penaltyDetails: { label: 'تفاصيل الجزاء وسببه', example: 'خصم من الراتب بمبلغ 200 ر.س. السبب: التخلي عن الرحلة قبل موعدها بساعات' },
  leaveType: { label: 'نوع الإجازة', example: 'إجازة سنوية' },
  leavePeriod: { label: 'فترة الإجازة', example: 'من 2026-12-01 إلى 2026-12-10' },
  leaveDays: { label: 'عدد أيام الإجازة', example: '10' },
  advanceNumber: { label: 'رقم السلفة', example: 'AD-012' },
  installmentText: { label: 'أقساط السلفة', example: '6 أقساط شهرية بمبلغ 500 ر.س تبدأ من 2026-12' },
  payrollMonth: { label: 'شهر الراتب', example: '2026-11' },
  netSalary: { label: 'صافي الراتب', example: '7,450 ر.س' },
  adjustmentLabel: { label: 'نوع الإضافة أو الخصم', example: 'خصم غياب' },
  adjustmentDetails: { label: 'تفاصيل الإضافة أو الخصم وسببها', example: 'يومان. السبب: غياب دون عذر' },
} as const;

export type NotificationVariable = keyof typeof VARIABLES;

/** Most gaps read better as a dash, but a note nobody wrote should simply not be there. */
const OPTIONAL_VARIABLES: NotificationVariable[] = ['reviewNote', 'reportStatus', 'updateNote', 'decisionNote'];
export type NotificationAudience = 'PASSENGER' | 'STAFF';
export const MESSAGE_LANGUAGES = ['ar', 'en', 'ur'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

const TRIP: NotificationVariable[] = ['userName', 'tripCode', 'origin', 'destination', 'departureDate', 'departureTime', 'hijriDate'];
const BOOKING: NotificationVariable[] = [...TRIP, 'bookingReference', 'seats', 'passengerCount', 'boardingPoint', 'boardingTime', 'totalPrice'];
const STAFF_BOOKING: NotificationVariable[] = [...BOOKING, 'customerName', 'customerPhone'];

interface CatalogEntry {
  audience: NotificationAudience;
  group: string;
  label: string;
  trigger: string;
  title: string;
  body: string;
  variables: NotificationVariable[];
  /** Sent from the supervisor's app at their choosing; everything else follows from an action in the system. */
  crewManual?: boolean;
  /** Filled by the sender each time: a template without it would say nothing. */
  requires?: NotificationVariable[];
  /** Written by staff per send, so the template only shapes its WhatsApp form. */
  campaign?: boolean;
  /** Worth nothing after this long. Undelivered WhatsApp messages give up. */
  expiresMinutes?: number;
  /** Wording for customers who chose another language. Arabic stays the entry's own text. */
  translations?: Partial<Record<Exclude<MessageLanguage, 'ar'>, { title: string; body: string }>>;
}

const LIVE_ALERT_EXPIRES_MINUTES = 30;

/**
 * One entry per action that notifies someone. Staff notes, national ids and costs are left out of the
 * passenger entries on purpose, so a template can never expose them to a customer.
 */
export const NOTIFICATION_CATALOG = {
  BOOKING_CONFIRMED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تأكيد الحجز',
    trigger: 'عند إتمام العميل للحجز',
    title: 'تم تأكيد حجزك',
    body: 'حجزك {{bookingReference}} لرحلة {{origin}} ← {{destination}} يوم {{departureDate}} الساعة {{departureTime}} مؤكد والتذكرة جاهزة.',
    variables: BOOKING,
    translations: {
      en: { title: 'Your booking is confirmed', body: 'Your booking {{bookingReference}} for the trip {{origin}} → {{destination}} on {{departureDate}} at {{departureTime}} is confirmed and your ticket is ready.' },
      ur: { title: 'آپ کی بکنگ کنفرم ہو گئی', body: 'سفر {{origin}} ← {{destination}} کے لیے آپ کی بکنگ {{bookingReference}}، بتاریخ {{departureDate}} بوقت {{departureTime}}، کنفرم ہے اور ٹکٹ تیار ہے۔' },
    },
  },
  PASSENGER_DETAILS_UPDATED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تعديل بيانات مسافر',
    trigger: 'عند تعديل اسم المسافر أو جواله من لوحة التحكم',
    title: 'تم تحديث بيانات المسافر',
    body: 'تم تحديث بيانات المسافر {{passengerName}} في الحجز {{bookingReference}}.',
    variables: [...BOOKING, 'passengerName'],
    translations: {
      en: { title: 'Passenger details updated', body: 'The details of passenger {{passengerName}} in booking {{bookingReference}} have been updated.' },
      ur: { title: 'مسافر کی تفصیلات اپ ڈیٹ ہو گئیں', body: 'بکنگ {{bookingReference}} میں مسافر {{passengerName}} کی تفصیلات اپ ڈیٹ کر دی گئی ہیں۔' },
    },
  },
  SEAT_CHANGED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تغيير المقعد',
    trigger: 'عند تغيير مقعد مسافر من لوحة التحكم',
    title: 'تم تغيير مقعدك',
    body: 'تم تغيير مقعد {{passengerName}} من {{oldSeat}} إلى {{newSeat}} في الحجز {{bookingReference}}. افتح تذكرتك الجديدة.',
    variables: [...BOOKING, 'passengerName', 'oldSeat', 'newSeat'],
    translations: {
      en: { title: 'Your seat has changed', body: 'The seat of {{passengerName}} in booking {{bookingReference}} has changed from {{oldSeat}} to {{newSeat}}. Please open your new ticket.' },
      ur: { title: 'آپ کی سیٹ تبدیل ہو گئی', body: 'بکنگ {{bookingReference}} میں {{passengerName}} کی سیٹ {{oldSeat}} سے بدل کر {{newSeat}} کر دی گئی ہے۔ اپنا نیا ٹکٹ کھولیں۔' },
    },
  },
  BOARDING_POINT_CHANGED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تغيير نقطة التجمع',
    trigger: 'عند تغيير نقطة تجمع الحجز من لوحة التحكم',
    title: 'تغيرت نقطة التجمع',
    body: 'أصبحت نقطة تجمع حجزك {{bookingReference}} هي {{boardingPoint}} الساعة {{boardingTime}}.',
    variables: [...BOOKING, 'oldBoardingPoint', 'oldBoardingTime'],
    translations: {
      en: { title: 'Your meeting point has changed', body: 'The meeting point for your booking {{bookingReference}} is now {{boardingPoint}} at {{boardingTime}}.' },
      ur: { title: 'جمع ہونے کا مقام تبدیل ہو گیا', body: 'آپ کی بکنگ {{bookingReference}} کے لیے جمع ہونے کا مقام اب {{boardingPoint}} ہے، وقت {{boardingTime}}۔' },
    },
  },
  PASSENGER_BOARDED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تسجيل صعود مسافر',
    trigger: 'عند مسح التذكرة أو تسجيل الصعود يدويًا',
    title: 'تم تسجيل الصعود',
    body: 'تم تسجيل صعود {{passengerName}} إلى الحافلة على المقعد {{seatNumber}}. رحلة موفقة.',
    variables: [...BOOKING, 'passengerName', 'seatNumber'],
    translations: {
      en: { title: 'Boarding recorded', body: '{{passengerName}} has boarded the bus in seat {{seatNumber}}. Have a safe journey.' },
      ur: { title: 'سواری درج ہو گئی', body: '{{passengerName}} کی بس میں سواری سیٹ {{seatNumber}} پر درج ہو گئی ہے۔ آپ کا سفر بخیر ہو۔' },
    },
  },
  ROOM_ASSIGNED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تسكين في غرفة',
    trigger: 'عند تسكين مسافر في غرفة من تطبيق المشرف أو لوحة التحكم',
    title: 'تم تحديد غرفتك',
    body: 'تم تسكين {{passengerName}} في الغرفة {{roomNumber}} بفندق {{hotelName}}.',
    variables: [...BOOKING, 'passengerName', 'hotelName', 'roomNumber'],
    translations: {
      en: { title: 'Your room has been assigned', body: '{{passengerName}} has been assigned room {{roomNumber}} at {{hotelName}}.' },
      ur: { title: 'آپ کا کمرہ طے ہو گیا', body: '{{passengerName}} کو ہوٹل {{hotelName}} میں کمرہ {{roomNumber}} دیا گیا ہے۔' },
    },
  },
  ROOM_UNASSIGNED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'إلغاء التسكين',
    trigger: 'عند إلغاء تسكين مسافر أو إلغاء حجز الفندق',
    title: 'تغير تسكينك',
    body: 'أُلغي تسكين {{passengerName}} في الغرفة {{roomNumber}}، وستُحدد غرفة جديدة.',
    variables: [...BOOKING, 'passengerName', 'hotelName', 'roomNumber'],
    translations: {
      en: { title: 'Your room has changed', body: '{{passengerName}} is no longer assigned to room {{roomNumber}}. A new room will be assigned.' },
      ur: { title: 'آپ کی رہائش میں تبدیلی', body: 'کمرہ {{roomNumber}} میں {{passengerName}} کی رہائش منسوخ کر دی گئی ہے، نیا کمرہ جلد طے کیا جائے گا۔' },
    },
  },
  HOTEL_COMPLAINT_RESOLVED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'الرد على شكوى فندق',
    trigger: 'عند إغلاق شكوى أرسلها العميل من التطبيق',
    title: 'تم الرد على شكواك',
    body: 'شكواك {{complaintReference}} عن {{hotelName}}: {{complaintResolution}}',
    variables: [...BOOKING, 'hotelName', 'complaintReference', 'complaintSubject', 'complaintResolution'],
    translations: {
      en: { title: 'We have responded to your complaint', body: 'Your complaint {{complaintReference}} about {{hotelName}}: {{complaintResolution}}' },
      ur: { title: 'آپ کی شکایت کا جواب', body: 'ہوٹل {{hotelName}} کے بارے میں آپ کی شکایت {{complaintReference}}: {{complaintResolution}}' },
    },
  },
  CANCELLATION_REQUESTED: {
    audience: 'PASSENGER',
    group: 'الإلغاء والاسترداد',
    label: 'استلام طلب الإلغاء',
    trigger: 'عند إرسال العميل طلب إلغاء',
    title: 'استلمنا طلب الإلغاء',
    body: 'طلب إلغاء الحجز {{bookingReference}} قيد المراجعة، وسنبلغك بالنتيجة.',
    variables: BOOKING,
    translations: {
      en: { title: 'We received your cancellation request', body: 'Your request to cancel booking {{bookingReference}} is under review. We will let you know the outcome.' },
      ur: { title: 'منسوخی کی درخواست موصول ہو گئی', body: 'بکنگ {{bookingReference}} کی منسوخی کی درخواست زیرِ غور ہے، نتیجے سے ہم آپ کو آگاہ کریں گے۔' },
    },
  },
  CANCELLATION_REJECTED: {
    audience: 'PASSENGER',
    group: 'الإلغاء والاسترداد',
    label: 'رفض طلب الإلغاء',
    trigger: 'عند رفض الموظف طلب الإلغاء',
    title: 'تعذر قبول طلب الإلغاء',
    body: 'تعذر قبول طلب إلغاء الحجز {{bookingReference}}، وحجزك ما زال مؤكدًا. {{reviewNote}}',
    variables: [...BOOKING, 'reviewNote'],
    translations: {
      en: { title: 'Cancellation request not accepted', body: 'We could not accept your request to cancel booking {{bookingReference}}, and your booking is still confirmed. {{reviewNote}}' },
      ur: { title: 'منسوخی کی درخواست قبول نہیں ہو سکی', body: 'بکنگ {{bookingReference}} کی منسوخی کی درخواست قبول نہیں ہو سکی، اور آپ کی بکنگ بدستور کنفرم ہے۔ {{reviewNote}}' },
    },
  },
  BOOKING_CANCELLED: {
    audience: 'PASSENGER',
    group: 'الإلغاء والاسترداد',
    label: 'إلغاء الحجز',
    trigger: 'عند قبول طلب الإلغاء أو إلغاء الحجز من لوحة التحكم',
    title: 'تم إلغاء حجزك',
    body: 'تم إلغاء الحجز {{bookingReference}}. المبلغ المسترد إلى محفظتك: {{refundAmount}}. {{reviewNote}}',
    variables: [...BOOKING, 'refundAmount', 'reviewNote'],
    translations: {
      en: { title: 'Your booking has been cancelled', body: 'Booking {{bookingReference}} has been cancelled. Amount refunded to your wallet: {{refundAmount}}. {{reviewNote}}' },
      ur: { title: 'آپ کی بکنگ منسوخ کر دی گئی', body: 'بکنگ {{bookingReference}} منسوخ کر دی گئی ہے۔ آپ کے والٹ میں واپس کی گئی رقم: {{refundAmount}}۔ {{reviewNote}}' },
    },
  },
  BOOKING_CANCELLED_REFUND_PENDING: {
    audience: 'PASSENGER',
    group: 'الإلغاء والاسترداد',
    label: 'إلغاء الحجز مع استرداد لوسيلة الدفع',
    trigger: 'عند قبول طلب الإلغاء مع إعادة المبلغ إلى وسيلة الدفع الأصلية',
    title: 'تم إلغاء حجزك',
    body: 'تم إلغاء الحجز {{bookingReference}}. سيُعاد {{amount}} إلى وسيلة الدفع الأصلية وسنبلغك فور إتمامه، والمضاف إلى محفظتك الآن: {{refundAmount}}. {{reviewNote}}',
    variables: [...BOOKING, 'amount', 'refundAmount', 'reviewNote'],
    translations: {
      en: { title: 'Your booking has been cancelled', body: 'Booking {{bookingReference}} has been cancelled. {{amount}} will be returned to your original payment method and we will let you know once it is done. Added to your wallet now: {{refundAmount}}. {{reviewNote}}' },
      ur: { title: 'آپ کی بکنگ منسوخ کر دی گئی', body: 'بکنگ {{bookingReference}} منسوخ کر دی گئی ہے۔ {{amount}} آپ کے اصل ادائیگی کے طریقے پر واپس کیے جائیں گے اور مکمل ہوتے ہی ہم آپ کو اطلاع دیں گے۔ ابھی آپ کے والٹ میں شامل رقم: {{refundAmount}}۔ {{reviewNote}}' },
    },
  },
  REFUND_COMPLETED: {
    audience: 'PASSENGER',
    group: 'الإلغاء والاسترداد',
    label: 'إتمام الاسترداد',
    trigger: 'عند تأكيد تنفيذ الاسترداد إلى وسيلة الدفع أو تحويله إلى المحفظة',
    title: 'تم رد المبلغ',
    body: 'تم رد {{amount}} عن الحجز {{bookingReference}} إلى {{refundMethod}}.',
    variables: [...BOOKING, 'amount', 'refundMethod'],
    translations: {
      en: { title: 'Your refund is complete', body: '{{amount}} for booking {{bookingReference}} has been refunded to {{refundMethod}}.' },
      ur: { title: 'رقم واپس کر دی گئی', body: 'بکنگ {{bookingReference}} کے {{amount}} آپ کو {{refundMethod}} پر واپس کر دیے گئے ہیں۔' },
    },
  },
  TRIP_CANCELLED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'إلغاء الرحلة',
    trigger: 'عند إلغاء الإدارة لرحلة عليها حجوزات',
    title: 'أُلغيت رحلتك',
    body: 'نعتذر، أُلغيت رحلة {{origin}} ← {{destination}} يوم {{departureDate}}. المبلغ المسترد إلى محفظتك عن الحجز {{bookingReference}}: {{refundAmount}}.',
    variables: [...BOOKING, 'refundAmount'],
    translations: {
      en: { title: 'Your trip has been cancelled', body: 'We are sorry, the trip {{origin}} → {{destination}} on {{departureDate}} has been cancelled. Amount refunded to your wallet for booking {{bookingReference}}: {{refundAmount}}.' },
      ur: { title: 'آپ کا سفر منسوخ ہو گیا', body: 'معذرت، {{departureDate}} کو {{origin}} ← {{destination}} کا سفر منسوخ کر دیا گیا ہے۔ بکنگ {{bookingReference}} کی آپ کے والٹ میں واپس کی گئی رقم: {{refundAmount}}۔' },
    },
  },
  RETURN_RIDE_CANCELLED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'إلغاء طريق العودة',
    trigger: 'عند إلغاء الإدارة لرحلة عكسية عليها ركاب ذهاب وعودة',
    title: 'أُلغي طريق عودتك',
    body: 'نعتذر، أُلغيت رحلة العودة {{origin}} ← {{destination}} يوم {{departureDate}}. ستتواصل معك الإدارة بخصوص الحجز {{bookingReference}}.',
    variables: BOOKING,
    translations: {
      en: { title: 'Your return trip has been cancelled', body: 'We are sorry, the return trip {{origin}} → {{destination}} on {{departureDate}} has been cancelled. Our team will contact you about booking {{bookingReference}}.' },
      ur: { title: 'آپ کا واپسی کا سفر منسوخ ہو گیا', body: 'معذرت، {{departureDate}} کو {{origin}} ← {{destination}} کا واپسی کا سفر منسوخ کر دیا گیا ہے۔ بکنگ {{bookingReference}} کے بارے میں انتظامیہ آپ سے رابطہ کرے گی۔' },
    },
  },
  TRIP_TIME_CHANGED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'تغيير موعد الرحلة',
    trigger: 'عند تعديل موعد انطلاق رحلة منشورة',
    title: 'تغير موعد رحلتك',
    body: 'تغير موعد انطلاق رحلة {{origin}} ← {{destination}} من {{oldDepartureTime}} إلى {{departureTime}} يوم {{departureDate}}.',
    variables: [...BOOKING, 'oldDepartureDate', 'oldDepartureTime'],
    translations: {
      en: { title: 'Your trip time has changed', body: 'The departure time of the trip {{origin}} → {{destination}} on {{departureDate}} has changed from {{oldDepartureTime}} to {{departureTime}}.' },
      ur: { title: 'آپ کے سفر کا وقت تبدیل ہو گیا', body: '{{departureDate}} کو {{origin}} ← {{destination}} کے سفر کی روانگی کا وقت {{oldDepartureTime}} سے بدل کر {{departureTime}} ہو گیا ہے۔' },
    },
  },
  CREW_NOTICE: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'رسالة طاقم الرحلة',
    trigger: 'عند إرسال المشرف إشعارًا لركاب رحلته',
    title: 'رسالة من طاقم الرحلة',
    body: '{{message}}',
    variables: [...BOOKING, 'message'],
    translations: {
      en: { title: 'Message from your trip crew', body: '{{message}}' },
      ur: { title: 'سفر کے عملے کا پیغام', body: '{{message}}' },
    },
  },
  CHAT_STAFF_REPLY: {
    audience: 'PASSENGER',
    group: 'المحادثات',
    label: 'رد من خدمة العملاء',
    trigger: 'عند رد الموظف على محادثة العميل وهو خارج شاشة المحادثة',
    title: 'رد جديد من خدمة العملاء',
    body: '{{message}}',
    variables: ['userName', 'message'],
    translations: {
      en: { title: 'New reply from customer service', body: '{{message}}' },
      ur: { title: 'کسٹمر سروس کی طرف سے نیا جواب', body: '{{message}}' },
    },
  },
  WALLET_CREDITED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'إضافة رصيد للمحفظة',
    trigger: 'عند إضافة رصيد من لوحة التحكم',
    title: 'أضيف رصيد إلى محفظتك',
    body: 'أضيف {{amount}} إلى محفظتك. رصيدك الحالي {{walletBalance}}.',
    variables: ['userName', 'amount', 'walletBalance'],
    translations: {
      en: { title: 'Credit added to your wallet', body: '{{amount}} has been added to your wallet. Your current balance is {{walletBalance}}.' },
      ur: { title: 'آپ کے والٹ میں رقم شامل', body: 'آپ کے والٹ میں {{amount}} شامل کر دیے گئے ہیں۔ آپ کا موجودہ بیلنس {{walletBalance}} ہے۔' },
    },
  },
  WALLET_DEBITED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'خصم من المحفظة',
    trigger: 'عند خصم رصيد أو تصفير المحفظة من لوحة التحكم',
    title: 'خصم من محفظتك',
    body: 'خُصم {{amount}} من محفظتك. رصيدك الحالي {{walletBalance}}.',
    variables: ['userName', 'amount', 'walletBalance'],
    translations: {
      en: { title: 'Deduction from your wallet', body: '{{amount}} has been deducted from your wallet. Your current balance is {{walletBalance}}.' },
      ur: { title: 'آپ کے والٹ سے کٹوتی', body: 'آپ کے والٹ سے {{amount}} کاٹ لیے گئے ہیں۔ آپ کا موجودہ بیلنس {{walletBalance}} ہے۔' },
    },
  },
  POINTS_EARNED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'كسب نقاط رحلة',
    trigger: 'بعد اكتمال الرحلة واحتساب نقاطها',
    title: 'حصلت على نقاط جديدة',
    body: 'حصلت على {{points}} نقطة عن الحجز {{bookingReference}}. رصيدك الحالي {{pointsBalance}} نقطة.',
    variables: [...BOOKING, 'points', 'pointsBalance'],
    translations: {
      en: { title: 'You earned new points', body: 'You earned {{points}} points for booking {{bookingReference}}. Your current balance is {{pointsBalance}} points.' },
      ur: { title: 'آپ کو نئے پوائنٹس ملے', body: 'بکنگ {{bookingReference}} پر آپ کو {{points}} پوائنٹس ملے ہیں۔ آپ کا موجودہ بیلنس {{pointsBalance}} پوائنٹس ہے۔' },
    },
  },
  POINTS_BONUS: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'مكافأة نقاط',
    trigger: 'عند منح مكافأة التحدي أو دعوة صديق',
    title: 'حصلت على مكافأة نقاط',
    body: '{{bonusName}}: أضيفت {{points}} نقطة. رصيدك الحالي {{pointsBalance}} نقطة.',
    variables: ['userName', 'bonusName', 'points', 'pointsBalance'],
    translations: {
      en: { title: 'You received bonus points', body: '{{bonusName}}: {{points}} points added. Your current balance is {{pointsBalance}} points.' },
      ur: { title: 'آپ کو بونس پوائنٹس ملے', body: '{{bonusName}}: {{points}} پوائنٹس شامل کر دیے گئے۔ آپ کا موجودہ بیلنس {{pointsBalance}} پوائنٹس ہے۔' },
    },
  },
  POINTS_ADJUSTED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'تعديل النقاط يدويًا',
    trigger: 'عند تعديل نقاط العميل من لوحة التحكم',
    title: 'تم تعديل نقاطك',
    body: 'تم تعديل رصيد نقاطك بمقدار {{pointsChange}}. رصيدك الحالي {{pointsBalance}} نقطة.',
    variables: ['userName', 'pointsChange', 'pointsBalance'],
    translations: {
      en: { title: 'Your points have been adjusted', body: 'Your points balance has been adjusted by {{pointsChange}}. Your current balance is {{pointsBalance}} points.' },
      ur: { title: 'آپ کے پوائنٹس میں ترمیم', body: 'آپ کے پوائنٹس کے بیلنس میں {{pointsChange}} کی ترمیم کی گئی ہے۔ آپ کا موجودہ بیلنس {{pointsBalance}} پوائنٹس ہے۔' },
    },
  },
  POINTS_EXPIRED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'انتهاء صلاحية النقاط',
    trigger: 'عند انتهاء صلاحية النقاط بسبب عدم النشاط',
    title: 'انتهت صلاحية نقاطك',
    body: 'انتهت صلاحية {{points}} نقطة من رصيدك بسبب عدم النشاط.',
    variables: ['userName', 'points'],
    translations: {
      en: { title: 'Your points have expired', body: '{{points}} points in your balance have expired due to inactivity.' },
      ur: { title: 'آپ کے پوائنٹس کی میعاد ختم', body: 'غیر فعال رہنے کی وجہ سے آپ کے بیلنس کے {{points}} پوائنٹس کی میعاد ختم ہو گئی ہے۔' },
    },
  },
  VOUCHER_REDEEMED: {
    audience: 'PASSENGER',
    group: 'المحفظة والنقاط',
    label: 'استبدال قسيمة',
    trigger: 'عند استبدال العميل نقاطه بقسيمة',
    title: 'قسيمتك جاهزة',
    body: 'استبدلت {{points}} نقطة بـ{{voucherName}} بقيمة {{voucherValue}}. رمز القسيمة: {{voucherCode}}.',
    variables: ['userName', 'points', 'voucherName', 'voucherValue', 'voucherCode'],
    translations: {
      en: { title: 'Your voucher is ready', body: 'You redeemed {{points}} points for {{voucherName}} worth {{voucherValue}}. Voucher code: {{voucherCode}}.' },
      ur: { title: 'آپ کا واؤچر تیار ہے', body: 'آپ نے {{points}} پوائنٹس کے بدلے {{voucherValue}} مالیت کا {{voucherName}} حاصل کیا ہے۔ واؤچر کوڈ: {{voucherCode}}۔' },
    },
  },
  REVERSE_TRIP_READY: {
    audience: 'STAFF',
    group: 'الرحلات',
    label: 'رحلة عكسية جاهزة للفتح',
    trigger: 'عند وصول إشغال الرحلة إلى نسبة فتح رحلتها العكسية',
    title: 'رحلة عكسية جاهزة للفتح',
    body: 'وصلت رحلة {{tripCode}} ({{origin}} ← {{destination}}) إلى نسبة فتح رحلتها العكسية، ويمكن فتحها من شاشة الرحلات العكسية.',
    variables: TRIP,
    translations: {
      en: { title: 'Return trip ready to open', body: 'Trip {{tripCode}} ({{origin}} → {{destination}}) has reached the occupancy needed to open its return trip. You can open it from the return trips screen.' },
      ur: { title: 'واپسی کا سفر کھولنے کے لیے تیار', body: 'سفر {{tripCode}} ({{origin}} ← {{destination}}) واپسی کا سفر کھولنے کی مطلوبہ شرح تک پہنچ گیا ہے، اسے واپسی کے سفروں کی اسکرین سے کھولا جا سکتا ہے۔' },
    },
  },
  CREW_TRIP_ASSIGNED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'إسناد رحلة',
    trigger: 'عند إسناد سائق أو مشرف إلى رحلة منشورة',
    title: 'أُسندت إليك رحلة',
    body: 'أُسندت إليك رحلة {{tripCode}} من {{origin}} إلى {{destination}} يوم {{departureDate}} الساعة {{departureTime}}.',
    variables: TRIP,
    translations: {
      en: { title: 'A trip has been assigned to you', body: 'Trip {{tripCode}} from {{origin}} to {{destination}} on {{departureDate}} at {{departureTime}} has been assigned to you.' },
      ur: { title: 'آپ کو ایک سفر سونپا گیا ہے', body: 'سفر {{tripCode}}، {{origin}} سے {{destination}}، بتاریخ {{departureDate}} بوقت {{departureTime}}، آپ کو سونپا گیا ہے۔' },
    },
  },
  CREW_TRIP_UNASSIGNED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'إلغاء إسناد رحلة',
    trigger: 'عند إزالة سائق أو مشرف من رحلة منشورة',
    title: 'أُلغي إسناد رحلة',
    body: 'لم تعد رحلة {{tripCode}} من {{origin}} إلى {{destination}} مسندة إليك.',
    variables: TRIP,
    translations: {
      en: { title: 'Trip assignment removed', body: 'Trip {{tripCode}} from {{origin}} to {{destination}} is no longer assigned to you.' },
      ur: { title: 'سفر کی ذمہ داری واپس لے لی گئی', body: 'سفر {{tripCode}}، {{origin}} سے {{destination}}، اب آپ کے ذمے نہیں ہے۔' },
    },
  },
  CREW_TRIP_TIME_CHANGED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'تغيير موعد رحلة مسندة',
    trigger: 'عند تعديل موعد انطلاق رحلة منشورة',
    title: 'تغير موعد رحلتك',
    body: 'تغير موعد رحلة {{tripCode}} من {{oldDepartureTime}} إلى {{departureTime}} يوم {{departureDate}}.',
    variables: [...TRIP, 'oldDepartureDate', 'oldDepartureTime'],
    translations: {
      en: { title: 'Your trip time has changed', body: 'Trip {{tripCode}} on {{departureDate}} has been moved from {{oldDepartureTime}} to {{departureTime}}.' },
      ur: { title: 'آپ کے سفر کا وقت تبدیل ہو گیا', body: '{{departureDate}} کو سفر {{tripCode}} کا وقت {{oldDepartureTime}} سے بدل کر {{departureTime}} ہو گیا ہے۔' },
    },
  },
  CREW_TRIP_CANCELLED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'إلغاء رحلة مسندة',
    trigger: 'عند إلغاء رحلة منشورة',
    title: 'أُلغيت رحلة مسندة إليك',
    body: 'أُلغيت رحلة {{tripCode}} من {{origin}} إلى {{destination}} يوم {{departureDate}}.',
    variables: TRIP,
    translations: {
      en: { title: 'Your assigned trip has been cancelled', body: 'Trip {{tripCode}} from {{origin}} to {{destination}} on {{departureDate}} has been cancelled.' },
      ur: { title: 'آپ کو سونپا گیا سفر منسوخ ہو گیا', body: '{{departureDate}} کو سفر {{tripCode}}، {{origin}} سے {{destination}}، منسوخ کر دیا گیا ہے۔' },
    },
  },
  CREW_TRIP_OPENED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'فتح الرحلة للطاقم',
    trigger: 'عند حلول وقت فتح الرحلة المحدد عند إنشائها',
    title: 'فُتحت رحلتك',
    body: 'فُتحت رحلة {{tripCode}} من {{origin}} إلى {{destination}}، وتنطلق يوم {{departureDate}} الساعة {{departureTime}}. يفتح الصعود الساعة {{boardingOpensTime}}.',
    variables: [...TRIP, 'boardingOpensTime', 'boardingClosesTime'],
    translations: {
      en: { title: 'Your trip is open', body: 'Trip {{tripCode}} from {{origin}} to {{destination}} is now open and departs on {{departureDate}} at {{departureTime}}. Boarding opens at {{boardingOpensTime}}.' },
      ur: { title: 'آپ کا سفر کھل گیا', body: 'سفر {{tripCode}}، {{origin}} سے {{destination}}، کھل گیا ہے اور {{departureDate}} کو {{departureTime}} بجے روانہ ہوگا۔ سواری {{boardingOpensTime}} بجے شروع ہوگی۔' },
    },
  },
  CREW_BOARDING_OPENED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'فتح الصعود',
    trigger: 'عند حلول وقت فتح الصعود المحدد عند إنشاء الرحلة',
    title: 'فُتح الصعود',
    body: 'يمكنك الآن مسح تذاكر رحلة {{tripCode}}. يُغلق الصعود الساعة {{boardingClosesTime}}.',
    variables: [...TRIP, 'boardingOpensTime', 'boardingClosesTime'],
    translations: {
      en: { title: 'Boarding is open', body: 'You can now scan tickets for trip {{tripCode}}. Boarding closes at {{boardingClosesTime}}.' },
      ur: { title: 'سواری شروع ہو گئی', body: 'اب آپ سفر {{tripCode}} کے ٹکٹ اسکین کر سکتے ہیں۔ سواری {{boardingClosesTime}} بجے بند ہوگی۔' },
    },
  },
  CREW_BOARDING_CLOSED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'إغلاق الصعود',
    trigger: 'عند حلول وقت إغلاق الصعود المحدد عند إنشاء الرحلة',
    title: 'أُغلق الصعود',
    body: 'أُغلق الصعود في رحلة {{tripCode}} من {{origin}} إلى {{destination}}.',
    variables: [...TRIP, 'boardingOpensTime', 'boardingClosesTime'],
    translations: {
      en: { title: 'Boarding is closed', body: 'Boarding has closed for trip {{tripCode}} from {{origin}} to {{destination}}.' },
      ur: { title: 'سواری بند ہو گئی', body: 'سفر {{tripCode}}، {{origin}} سے {{destination}}، کی سواری بند ہو گئی ہے۔' },
    },
  },
  CREW_PASSENGERS_NOTIFIED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'إشعار زميل للركاب',
    trigger: 'عند إرسال أحد مشرفي الرحلة إشعارًا لركابها (لبقية الطاقم)',
    title: 'أُرسل إشعار لركاب رحلتك',
    body: 'أرسل {{senderName}} لركاب رحلة {{tripCode}}: {{message}}',
    variables: [...TRIP, 'senderName', 'message'],
    translations: {
      en: { title: 'A notice was sent to your trip passengers', body: '{{senderName}} sent to the passengers of trip {{tripCode}}: {{message}}' },
      ur: { title: 'آپ کے سفر کے مسافروں کو اطلاع بھیجی گئی', body: '{{senderName}} نے سفر {{tripCode}} کے مسافروں کو بھیجا: {{message}}' },
    },
  },
  STAFF_LEAVE_REQUESTED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'طلب إجازة',
    trigger: 'عند تقديم موظف طلب إجازة (لمن يملك البت في الإجازات)',
    title: 'طلب إجازة من {{employeeName}}',
    body: 'طلب {{employeeName}} {{leaveType}} {{leavePeriod}} ({{leaveDays}} يوم).',
    variables: ['userName', 'employeeName', 'leaveType', 'leavePeriod', 'leaveDays'],
    translations: {
      en: { title: 'Leave request from {{employeeName}}', body: '{{employeeName}} requested {{leaveType}} {{leavePeriod}} ({{leaveDays}} days).' },
      ur: { title: '{{employeeName}} کی چھٹی کی درخواست', body: '{{employeeName}} نے {{leaveType}} کی درخواست دی ہے، {{leavePeriod}} ({{leaveDays}} دن)۔' },
    },
  },
  LEAVE_APPROVED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'الموافقة على إجازة',
    trigger: 'عند الموافقة على إجازة الموظف أو تسجيلها له (للموظف نفسه)',
    title: 'تمت الموافقة على إجازتك',
    body: 'تمت الموافقة على {{leaveType}} {{leavePeriod}} ({{leaveDays}} يوم). {{decisionNote}}',
    variables: ['userName', 'leaveType', 'leavePeriod', 'leaveDays', 'decisionNote'],
    translations: {
      en: { title: 'Your leave has been approved', body: 'Your {{leaveType}} {{leavePeriod}} ({{leaveDays}} days) has been approved. {{decisionNote}}' },
      ur: { title: 'آپ کی چھٹی منظور ہو گئی', body: 'آپ کی {{leaveType}}، {{leavePeriod}} ({{leaveDays}} دن)، منظور ہو گئی ہے۔ {{decisionNote}}' },
    },
  },
  LEAVE_REJECTED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'رفض إجازة',
    trigger: 'عند رفض طلب إجازة الموظف (للموظف نفسه)',
    title: 'لم تتم الموافقة على إجازتك',
    body: 'لم تتم الموافقة على {{leaveType}} {{leavePeriod}}. {{decisionNote}}',
    variables: ['userName', 'leaveType', 'leavePeriod', 'decisionNote'],
    translations: {
      en: { title: 'Your leave was not approved', body: 'Your {{leaveType}} {{leavePeriod}} was not approved. {{decisionNote}}' },
      ur: { title: 'آپ کی چھٹی منظور نہیں ہوئی', body: 'آپ کی {{leaveType}}، {{leavePeriod}}، منظور نہیں ہوئی۔ {{decisionNote}}' },
    },
  },
  LEAVE_CHANGED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'إلغاء إجازة أو قطعها',
    trigger: 'عند إلغاء إجازة معتمدة أو قطعها بالعودة المبكرة (للموظف نفسه)',
    title: 'تغيّرت إجازتك',
    body: 'أصبحت {{leaveType}} الخاصة بك: {{leavePeriod}}. {{decisionNote}}',
    variables: ['userName', 'leaveType', 'leavePeriod', 'decisionNote'],
    translations: {
      en: { title: 'Your leave has changed', body: 'Your {{leaveType}} is now: {{leavePeriod}}. {{decisionNote}}' },
      ur: { title: 'آپ کی چھٹی میں تبدیلی', body: 'آپ کی {{leaveType}} اب یہ ہے: {{leavePeriod}}۔ {{decisionNote}}' },
    },
  },
  STAFF_ADVANCE_REQUESTED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'طلب سلفة',
    trigger: 'عند تقديم موظف طلب سلفة (لمن يملك البت في السلف)',
    title: 'طلب سلفة من {{employeeName}}',
    body: 'طلب {{employeeName}} سلفة بمبلغ {{amount}}، {{installmentText}}.',
    variables: ['userName', 'employeeName', 'amount', 'installmentText'],
    translations: {
      en: { title: 'Advance request from {{employeeName}}', body: '{{employeeName}} requested an advance of {{amount}}, {{installmentText}}.' },
      ur: { title: '{{employeeName}} کی ایڈوانس کی درخواست', body: '{{employeeName}} نے {{amount}} ایڈوانس کی درخواست دی ہے، {{installmentText}}۔' },
    },
  },
  ADVANCE_APPROVED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'الموافقة على سلفة',
    trigger: 'عند الموافقة على طلب سلفة الموظف (للموظف نفسه)',
    title: 'تمت الموافقة على سلفتك',
    body: 'تمت الموافقة على السلفة {{advanceNumber}} بمبلغ {{amount}}، {{installmentText}}. ستُصرف لك قريبًا. {{decisionNote}}',
    variables: ['userName', 'advanceNumber', 'amount', 'installmentText', 'decisionNote'],
    translations: {
      en: { title: 'Your advance has been approved', body: 'Advance {{advanceNumber}} of {{amount}} has been approved, {{installmentText}}. It will be paid to you soon. {{decisionNote}}' },
      ur: { title: 'آپ کا ایڈوانس منظور ہو گیا', body: 'ایڈوانس {{advanceNumber}} بمبلغ {{amount}} منظور ہو گیا ہے، {{installmentText}}۔ یہ جلد آپ کو ادا کر دیا جائے گا۔ {{decisionNote}}' },
    },
  },
  ADVANCE_REJECTED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'رفض سلفة',
    trigger: 'عند رفض طلب سلفة الموظف (للموظف نفسه)',
    title: 'لم تتم الموافقة على سلفتك',
    body: 'لم تتم الموافقة على طلب السلفة بمبلغ {{amount}}. {{decisionNote}}',
    variables: ['userName', 'amount', 'decisionNote'],
    translations: {
      en: { title: 'Your advance was not approved', body: 'Your advance request of {{amount}} was not approved. {{decisionNote}}' },
      ur: { title: 'آپ کا ایڈوانس منظور نہیں ہوا', body: '{{amount}} ایڈوانس کی آپ کی درخواست منظور نہیں ہوئی۔ {{decisionNote}}' },
    },
  },
  ADVANCE_DISBURSED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'صرف سلفة',
    trigger: 'عند صرف السلفة للموظف نقدًا أو بالتحويل (للموظف نفسه)',
    title: 'صُرفت لك السلفة {{advanceNumber}}',
    body: 'صُرف لك مبلغ {{amount}}، ويُسدَّد {{installmentText}}.',
    variables: ['userName', 'advanceNumber', 'amount', 'installmentText'],
    translations: {
      en: { title: 'Advance {{advanceNumber}} has been paid to you', body: '{{amount}} has been paid to you. Repayment: {{installmentText}}.' },
      ur: { title: 'ایڈوانس {{advanceNumber}} آپ کو ادا کر دیا گیا', body: '{{amount}} آپ کو ادا کر دیے گئے ہیں۔ واپسی: {{installmentText}}۔' },
    },
  },
  PAYSLIP_READY: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'اعتماد الراتب',
    trigger: 'عند اعتماد مسيّر رواتب الشهر (لكل موظف فيه)',
    title: 'راتب شهر {{payrollMonth}} معتمد',
    body: 'اعتُمد راتبك لشهر {{payrollMonth}}، والصافي {{netSalary}}. تجد التفاصيل في قسيمة الراتب.',
    variables: ['userName', 'payrollMonth', 'netSalary'],
    translations: {
      en: { title: 'Salary for {{payrollMonth}} approved', body: 'Your salary for {{payrollMonth}} has been approved, with a net of {{netSalary}}. See your payslip for details.' },
      ur: { title: '{{payrollMonth}} کی تنخواہ منظور', body: '{{payrollMonth}} کی آپ کی تنخواہ منظور ہو گئی ہے، خالص رقم {{netSalary}}۔ تفصیلات تنخواہ کی پرچی میں دیکھیں۔' },
    },
  },
  SALARY_PAID: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'صرف الراتب',
    trigger: 'عند تسجيل صرف راتب الموظف (للموظف نفسه)',
    title: 'صُرف راتب شهر {{payrollMonth}}',
    body: 'صُرف لك راتب شهر {{payrollMonth}} بمبلغ {{netSalary}}.',
    variables: ['userName', 'payrollMonth', 'netSalary'],
    translations: {
      en: { title: 'Salary for {{payrollMonth}} paid', body: 'Your salary for {{payrollMonth}} of {{netSalary}} has been paid.' },
      ur: { title: '{{payrollMonth}} کی تنخواہ ادا کر دی گئی', body: '{{payrollMonth}} کی آپ کی تنخواہ {{netSalary}} ادا کر دی گئی ہے۔' },
    },
  },
  SALARY_ADJUSTMENT_ADDED: {
    audience: 'STAFF',
    group: 'الموارد البشرية',
    label: 'إضافة أو خصم على الراتب',
    trigger: 'عند تسجيل مكافأة أو خصم على راتب الموظف (للموظف نفسه)',
    title: 'سُجّل على راتبك: {{adjustmentLabel}}',
    body: '{{adjustmentDetails}}',
    variables: ['userName', 'adjustmentLabel', 'adjustmentDetails'],
    translations: {
      en: { title: 'Recorded on your salary: {{adjustmentLabel}}', body: '{{adjustmentDetails}}' },
      ur: { title: 'آپ کی تنخواہ پر درج: {{adjustmentLabel}}', body: '{{adjustmentDetails}}' },
    },
  },
  STAFF_CREW_RELEASE_REQUEST: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'طلب تخلٍ عن رحلة',
    trigger: 'عند طلب مشرف أو سائق التخلي عن رحلة مسندة إليه (لمن يملك البت في الطلبات)',
    title: 'طلب تخلٍ عن رحلة {{tripCode}}',
    body: 'يطلب {{employeeName}} ({{crewRole}}) التخلي عن رحلة {{tripCode}} من {{origin}} إلى {{destination}} يوم {{departureDate}} الساعة {{departureTime}}. السبب: {{releaseReason}}',
    variables: [...TRIP, 'employeeName', 'crewRole', 'releaseReason'],
    translations: {
      en: { title: 'Release request for trip {{tripCode}}', body: '{{employeeName}} ({{crewRole}}) asks to be released from trip {{tripCode}} from {{origin}} to {{destination}} on {{departureDate}} at {{departureTime}}. Reason: {{releaseReason}}' },
      ur: { title: 'سفر {{tripCode}} سے دستبرداری کی درخواست', body: '{{employeeName}} ({{crewRole}}) سفر {{tripCode}}، {{origin}} سے {{destination}}، بتاریخ {{departureDate}} بوقت {{departureTime}}، سے دستبرداری چاہتے ہیں۔ وجہ: {{releaseReason}}' },
    },
  },
  CREW_RELEASE_APPROVED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'الموافقة على طلب التخلي',
    trigger: 'عند موافقة الإدارة على طلب التخلي عن رحلة (لصاحب الطلب)',
    title: 'تمت الموافقة على طلب التخلي',
    body: 'وافقت الإدارة على طلبك التخلي عن رحلة {{tripCode}} يوم {{departureDate}}، ولم تعد مسندة إليك. {{decisionNote}}',
    variables: [...TRIP, 'decisionNote'],
    translations: {
      en: { title: 'Release request approved', body: 'Management approved your request to be released from trip {{tripCode}} on {{departureDate}}, and it is no longer assigned to you. {{decisionNote}}' },
      ur: { title: 'دستبرداری کی درخواست منظور', body: 'انتظامیہ نے {{departureDate}} کے سفر {{tripCode}} سے دستبرداری کی آپ کی درخواست منظور کر لی ہے، اور یہ اب آپ کے ذمے نہیں۔ {{decisionNote}}' },
    },
  },
  CREW_RELEASE_REJECTED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'رفض طلب التخلي',
    trigger: 'عند رفض الإدارة طلب التخلي عن رحلة (لصاحب الطلب)',
    title: 'رُفض طلب التخلي عن رحلة {{tripCode}}',
    body: 'لم توافق الإدارة على طلبك التخلي عن رحلة {{tripCode}} يوم {{departureDate}}، وما زالت مسندة إليك. {{decisionNote}}',
    variables: [...TRIP, 'decisionNote'],
    translations: {
      en: { title: 'Release request for trip {{tripCode}} declined', body: 'Management did not approve your request to be released from trip {{tripCode}} on {{departureDate}}, and it is still assigned to you. {{decisionNote}}' },
      ur: { title: 'سفر {{tripCode}} سے دستبرداری کی درخواست مسترد', body: 'انتظامیہ نے {{departureDate}} کے سفر {{tripCode}} سے دستبرداری کی آپ کی درخواست منظور نہیں کی، اور یہ بدستور آپ کے ذمے ہے۔ {{decisionNote}}' },
    },
  },
  STAFF_PENALTY_ISSUED: {
    audience: 'STAFF',
    group: 'الموظفون',
    label: 'تسجيل جزاء',
    trigger: 'عند تسجيل تنبيه أو إنذار أو خصم أو جزاء على موظف (للموظف نفسه)',
    title: 'سُجّل عليك {{penaltyType}}',
    body: '{{penaltyDetails}}',
    variables: ['userName', 'penaltyType', 'penaltyDetails'],
    translations: {
      en: { title: 'Recorded against you: {{penaltyType}}', body: '{{penaltyDetails}}' },
      ur: { title: 'آپ کے خلاف درج: {{penaltyType}}', body: '{{penaltyDetails}}' },
    },
  },
  CREW_COLLEAGUE_REPORT: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'بلاغ من زميل',
    trigger: 'عند تسجيل أحد طاقم الرحلة بلاغًا (لبقية الطاقم)',
    title: 'بلاغ على رحلتك: {{reportType}}',
    body: 'سجل {{reporterName}} بلاغًا على رحلة {{tripCode}}: {{reportDetails}}',
    variables: [...TRIP, 'reporterName', 'reportType', 'reportDetails', 'reportCode', 'reportCategory'],
    translations: {
      en: { title: 'Report on your trip: {{reportType}}', body: '{{reporterName}} filed a report on trip {{tripCode}}: {{reportDetails}}' },
      ur: { title: 'آپ کے سفر پر رپورٹ: {{reportType}}', body: '{{reporterName}} نے سفر {{tripCode}} پر رپورٹ درج کی: {{reportDetails}}' },
    },
  },
  STAFF_NEW_BOOKING: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'حجز جديد',
    trigger: 'عند إتمام حجز جديد (لمن يملك عرض الحجوزات)',
    title: 'حجز جديد',
    body: 'حجز {{customerName}} {{passengerCount}} مقعد على رحلة {{tripCode}}. رقم الحجز {{bookingReference}}.',
    variables: STAFF_BOOKING,
    translations: {
      en: { title: 'New booking', body: '{{customerName}} booked {{passengerCount}} seat(s) on trip {{tripCode}}. Booking number {{bookingReference}}.' },
      ur: { title: 'نئی بکنگ', body: '{{customerName}} نے سفر {{tripCode}} پر {{passengerCount}} سیٹیں بک کیں۔ بکنگ نمبر {{bookingReference}}۔' },
    },
  },
  STAFF_CANCELLATION_REQUEST: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'طلب إلغاء جديد',
    trigger: 'عند طلب عميل إلغاء حجزه (لمن يملك مراجعة الإلغاء)',
    title: 'طلب إلغاء بانتظار المراجعة',
    body: 'طلب {{customerName}} إلغاء الحجز {{bookingReference}} على رحلة {{tripCode}}. السبب: {{cancelReason}}.',
    variables: [...STAFF_BOOKING, 'cancelReason'],
    translations: {
      en: { title: 'Cancellation request awaiting review', body: '{{customerName}} requested to cancel booking {{bookingReference}} on trip {{tripCode}}. Reason: {{cancelReason}}.' },
      ur: { title: 'منسوخی کی درخواست جائزے کی منتظر', body: '{{customerName}} نے سفر {{tripCode}} پر بکنگ {{bookingReference}} کی منسوخی کی درخواست کی ہے۔ وجہ: {{cancelReason}}۔' },
    },
  },
  STAFF_REFUND_PENDING: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'استرداد بانتظار التنفيذ',
    trigger: 'عند قبول إلغاء مبلغه يعود إلى وسيلة الدفع الأصلية (لمن يملك تنفيذ الاستردادات)',
    title: 'استرداد بانتظار التنفيذ',
    body: 'أعد {{amount}} إلى {{refundMethod}} عن الحجز {{bookingReference}} للعميل {{customerName}}.',
    variables: [...STAFF_BOOKING, 'amount', 'refundMethod'],
    translations: {
      en: { title: 'Refund awaiting processing', body: 'Return {{amount}} to {{refundMethod}} for booking {{bookingReference}} of customer {{customerName}}.' },
      ur: { title: 'رقم کی واپسی زیرِ التوا', body: 'گاہک {{customerName}} کی بکنگ {{bookingReference}} کی رقم {{amount}} واپس {{refundMethod}} پر بھیجیں۔' },
    },
  },
  STAFF_TRIP_SOS: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'استغاثة من طاقم رحلة',
    trigger: 'عند إرسال أحد طاقم الرحلة استغاثة (لمن يملك عرض البلاغات)',
    title: 'استغاثة عاجلة: رحلة {{tripCode}}',
    body: 'استغاثة من {{reporterName}} على رحلة {{tripCode}} ({{reportCode}}): {{reportDetails}}',
    variables: [...TRIP, 'reporterName', 'reportType', 'reportDetails', 'reportCode', 'reportCategory'],
    translations: {
      en: { title: 'Urgent SOS: trip {{tripCode}}', body: 'SOS from {{reporterName}} on trip {{tripCode}} ({{reportCode}}): {{reportDetails}}' },
      ur: { title: 'فوری ہنگامی اپیل: سفر {{tripCode}}', body: 'سفر {{tripCode}} پر {{reporterName}} کی طرف سے ہنگامی اپیل ({{reportCode}}): {{reportDetails}}' },
    },
  },
  STAFF_REPORT_UPDATED: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'تحديث من الطاقم على بلاغ',
    trigger: 'عند إضافة أحد طاقم الرحلة تحديثًا على بلاغ (لمن يملك عرض البلاغات)',
    title: 'تحديث على البلاغ {{reportCode}}',
    body: 'كتب {{senderName}} على البلاغ {{reportCode}} في رحلة {{tripCode}}: {{updateNote}}',
    variables: [...TRIP, 'reportCode', 'updateNote', 'senderName'],
    translations: {
      en: { title: 'Update on report {{reportCode}}', body: '{{senderName}} wrote on report {{reportCode}} for trip {{tripCode}}: {{updateNote}}' },
      ur: { title: 'رپورٹ {{reportCode}} پر اپ ڈیٹ', body: '{{senderName}} نے سفر {{tripCode}} کی رپورٹ {{reportCode}} پر لکھا: {{updateNote}}' },
    },
  },
  CREW_REPORT_UPDATED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'تحديث على بلاغ',
    trigger: 'عند تغيير حالة بلاغ أو إضافة ملاحظة عليه (لطاقم الرحلة)',
    title: 'تحديث على البلاغ {{reportCode}}',
    body: 'البلاغ {{reportCode}} في رحلة {{tripCode}}. {{reportStatus}} {{updateNote}}',
    variables: [...TRIP, 'reportCode', 'reportStatus', 'updateNote', 'senderName'],
    translations: {
      en: { title: 'Update on report {{reportCode}}', body: 'Report {{reportCode}} on trip {{tripCode}}. {{reportStatus}} {{updateNote}}' },
      ur: { title: 'رپورٹ {{reportCode}} پر اپ ڈیٹ', body: 'سفر {{tripCode}} کی رپورٹ {{reportCode}}۔ {{reportStatus}} {{updateNote}}' },
    },
  },
  CREW_TRIP_STATUS_CHANGED: {
    audience: 'STAFF',
    group: 'طاقم الرحلة',
    label: 'تحديث زميل لمكان الحافلة',
    trigger: 'عند تحديث أحد الطاقم حالة الرحلة (لبقية الطاقم)',
    title: 'تحديث مكان الحافلة',
    body: 'حدّث {{senderName}} رحلة {{tripCode}}: {{currentPoint}}.',
    variables: [...TRIP, 'senderName', 'currentPoint'],
    translations: {
      en: { title: 'Bus location update', body: '{{senderName}} updated trip {{tripCode}}: {{currentPoint}}.' },
      ur: { title: 'بس کے مقام کی اپ ڈیٹ', body: '{{senderName}} نے سفر {{tripCode}} اپ ڈیٹ کیا: {{currentPoint}}۔' },
    },
  },
  BUS_AT_YOUR_POINT: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'وصول الحافلة إلى نقطة المسافر',
    trigger: 'عند تحديد الطاقم أن الحافلة في نقطة التجمع الخاصة بالحجز',
    title: 'الحافلة وصلت إلى نقطتك',
    body: 'الحافلة الآن في {{currentPoint}}، نقطة صعودك في الحجز {{bookingReference}}. توجه إليها بتذكرتك.',
    variables: [...BOOKING, 'currentPoint'],
    translations: {
      en: { title: 'The bus has reached your point', body: 'The bus is now at {{currentPoint}}, your boarding point for booking {{bookingReference}}. Please head there with your ticket.' },
      ur: { title: 'بس آپ کے مقام پر پہنچ گئی', body: 'بس اب {{currentPoint}} پر ہے، جو بکنگ {{bookingReference}} میں آپ کے سوار ہونے کا مقام ہے۔ اپنا ٹکٹ لے کر وہاں پہنچیں۔' },
    },
  },
  BUS_AT_OTHER_POINT: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'وصول الحافلة إلى نقطة أخرى',
    trigger: 'عند تحديد الطاقم نقطة الحافلة، لمن لم يصعد وصعوده من نقطة أخرى',
    title: 'الحافلة الآن في {{currentPoint}}',
    body: 'وصلت حافلة رحلتك إلى {{currentPoint}}، ونقطة صعودك {{boardingPoint}} الساعة {{boardingTime}}.',
    variables: [...BOOKING, 'currentPoint'],
    translations: {
      en: { title: 'The bus is now at {{currentPoint}}', body: 'Your trip\'s bus has reached {{currentPoint}}. Your boarding point is {{boardingPoint}} at {{boardingTime}}.' },
      ur: { title: 'بس اب {{currentPoint}} پر ہے', body: 'آپ کے سفر کی بس {{currentPoint}} پہنچ گئی ہے، اور آپ کے سوار ہونے کا مقام {{boardingPoint}} ہے، وقت {{boardingTime}}۔' },
    },
  },
  BUS_ON_ROAD: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'انطلاق الحافلة من نقطة',
    trigger: 'عند تحديد الطاقم أن الحافلة في الطريق، لمن لم يصعد بعد',
    title: 'الحافلة في الطريق',
    body: 'غادرت حافلة رحلتك {{currentPoint}} وهي في الطريق الآن. نقطة صعودك {{boardingPoint}}.',
    variables: [...BOOKING, 'currentPoint'],
    translations: {
      en: { title: 'The bus is on its way', body: 'Your trip\'s bus has left {{currentPoint}} and is now on the road. Your boarding point is {{boardingPoint}}.' },
      ur: { title: 'بس راستے میں ہے', body: 'آپ کے سفر کی بس {{currentPoint}} سے روانہ ہو کر اب راستے میں ہے۔ آپ کے سوار ہونے کا مقام {{boardingPoint}} ہے۔' },
    },
  },
  TICKET_LATE: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'التأخر عن نقطة الصعود',
    trigger: 'تلقائيًا عند مغادرة الحافلة نقطة صعود المسافر ولم تُمسح تذكرته وما زالت هناك نقاط بعدها',
    title: 'تأخرت عن نقطة صعودك',
    body: 'غادرت الحافلة {{boardingPoint}} ولم يُسجَّل صعودك في الحجز {{bookingReference}}. يمكنك اللحاق بها من: {{nextPoints}}. توجه إليها الآن ومعك تذكرتك.',
    variables: [...BOOKING, 'nextPoints'],
    expiresMinutes: 60,
    translations: {
      en: { title: 'You missed your boarding point', body: 'The bus has left {{boardingPoint}} and booking {{bookingReference}} has not boarded. You can still catch it at: {{nextPoints}}. Please go there now with your ticket.' },
      ur: { title: 'آپ اپنے سوار ہونے کے مقام سے رہ گئے', body: 'بس {{boardingPoint}} سے روانہ ہو چکی ہے اور بکنگ {{bookingReference}} کی سواری درج نہیں ہوئی۔ آپ اسے یہاں سے پکڑ سکتے ہیں: {{nextPoints}}۔ اپنا ٹکٹ لے کر ابھی وہاں پہنچیں۔' },
    },
  },
  TICKET_STOPPED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'إيقاف التذكرة',
    trigger: 'تلقائيًا عند مغادرة الحافلة كل نقاط الصعود أو انتهاء وقت الصعود ولم تُمسح التذكرة',
    title: 'تذكرتك موقوفة',
    body: 'لم يُسجَّل صعودك في الحجز {{bookingReference}} ولم تعد هناك نقطة صعود متاحة، فأُوقفت التذكرة. تواصل مع الدعم من صفحة التذكرة لحل المشكلة أو بحث التعويض.',
    variables: BOOKING,
    translations: {
      en: { title: 'Your ticket has been stopped', body: 'Booking {{bookingReference}} has not boarded and no boarding point is left, so the ticket has been stopped. Contact support from the ticket page to resolve this or ask about compensation.' },
      ur: { title: 'آپ کا ٹکٹ روک دیا گیا ہے', body: 'بکنگ {{bookingReference}} کی سواری درج نہیں ہوئی اور سوار ہونے کا کوئی مقام باقی نہیں، اس لیے ٹکٹ روک دیا گیا ہے۔ مسئلہ حل کرنے یا معاوضے کے لیے ٹکٹ کے صفحے سے سپورٹ سے رابطہ کریں۔' },
    },
  },
  TICKET_COMPENSATED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'تعويض تذكرة موقوفة',
    trigger: 'عند صرف تعويض عن تذكرة موقوفة، من موظف أو تلقائيًا',
    title: 'أضفنا تعويضًا إلى محفظتك',
    body: 'أضفنا {{amount}} إلى محفظتك تعويضًا عن الحجز {{bookingReference}}. رصيدك الآن {{walletBalance}}.',
    variables: [...BOOKING, 'amount', 'walletBalance'],
    translations: {
      en: { title: 'Compensation added to your wallet', body: 'We added {{amount}} to your wallet as compensation for booking {{bookingReference}}. Your balance is now {{walletBalance}}.' },
      ur: { title: 'معاوضہ آپ کے والٹ میں شامل', body: 'ہم نے بکنگ {{bookingReference}} کے معاوضے کے طور پر {{amount}} آپ کے والٹ میں شامل کر دیے۔ آپ کا بیلنس اب {{walletBalance}} ہے۔' },
    },
  },
  BUS_ARRIVED: {
    audience: 'PASSENGER',
    group: 'الرحلات',
    label: 'وصول الرحلة',
    trigger: 'عند تحديد الطاقم أن الحافلة وصلت إلى وجهتها',
    title: 'وصلت رحلتك',
    body: 'وصلت الحافلة إلى {{destination}}. حمدًا لله على السلامة.',
    variables: BOOKING,
    translations: {
      en: { title: 'Your trip has arrived', body: 'The bus has arrived in {{destination}}. Praise be to God for your safe arrival.' },
      ur: { title: 'آپ کا سفر پہنچ گیا', body: 'بس {{destination}} پہنچ گئی ہے۔ الحمدللہ، آپ بخیریت پہنچ گئے۔' },
    },
  },
  STAFF_TRIP_REPORT: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'بلاغ من طاقم رحلة',
    trigger: 'عند تسجيل الطاقم بلاغًا (لمن يملك عرض الكشوفات)',
    title: 'بلاغ جديد: {{reportType}}',
    body: 'بلاغ من {{reporterName}} على رحلة {{tripCode}}: {{reportDetails}}',
    variables: [...TRIP, 'reporterName', 'reportType', 'reportDetails', 'reportCode', 'reportCategory'],
    translations: {
      en: { title: 'New report: {{reportType}}', body: 'Report from {{reporterName}} on trip {{tripCode}}: {{reportDetails}}' },
      ur: { title: 'نئی رپورٹ: {{reportType}}', body: 'سفر {{tripCode}} پر {{reporterName}} کی رپورٹ: {{reportDetails}}' },
    },
  },
  STAFF_FIXED_TRIP_DRAFTED: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'مسودة رحلة ثابتة',
    trigger: 'عند إنشاء نسخة السنة القادمة من رحلة ثابتة (لمن يملك إدارة الرحلات)',
    title: 'مسودة رحلة ثابتة {{tripCode}}',
    body: 'أُنشئت رحلة {{tripCode}} من {{origin}} إلى {{destination}} يوم {{departureDate}} كمسودة. راجعها وأسند الباص والطاقم ثم انشرها.',
    variables: TRIP,
    translations: {
      en: { title: 'Fixed trip draft {{tripCode}}', body: 'Trip {{tripCode}} from {{origin}} to {{destination}} on {{departureDate}} has been created as a draft. Review it, assign the bus and crew, then publish it.' },
      ur: { title: 'مستقل سفر کا مسودہ {{tripCode}}', body: 'سفر {{tripCode}}، {{origin}} سے {{destination}}، بتاریخ {{departureDate}}، مسودے کے طور پر بنایا گیا ہے۔ اس کا جائزہ لیں، بس اور عملہ مقرر کریں، پھر اسے شائع کریں۔' },
    },
  },
  STAFF_HOTEL_COMPLAINT: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'شكوى فندق جديدة',
    trigger: 'عند تسجيل شكوى فندق (لمن يملك عرض الفنادق)',
    title: 'شكوى جديدة {{complaintReference}}',
    body: 'شكوى على {{hotelName}}: {{complaintSubject}}. سجلها {{complaintAuthor}}.',
    variables: ['userName', 'hotelName', 'complaintReference', 'complaintSubject', 'complaintAuthor'],
    translations: {
      en: { title: 'New complaint {{complaintReference}}', body: 'Complaint about {{hotelName}}: {{complaintSubject}}. Recorded by {{complaintAuthor}}.' },
      ur: { title: 'نئی شکایت {{complaintReference}}', body: 'ہوٹل {{hotelName}} کے بارے میں شکایت: {{complaintSubject}}۔ درج کنندہ: {{complaintAuthor}}۔' },
    },
  },
  PAYMENT_COLLECTED: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'استلام دفعة',
    trigger: 'عند تسجيل دفعة على الحجز من صفحة المتبقي والتحصيل',
    title: 'استلمنا دفعتك',
    body: 'استلمنا {{amount}} للحجز {{bookingReference}}، والمتبقي {{remainingAmount}}.',
    variables: [...BOOKING, 'amount', 'remainingAmount'],
    translations: {
      en: { title: 'We received your payment', body: 'We received {{amount}} for booking {{bookingReference}}. Remaining: {{remainingAmount}}.' },
      ur: { title: 'آپ کی ادائیگی موصول ہو گئی', body: 'ہمیں بکنگ {{bookingReference}} کے لیے {{amount}} موصول ہو گئے ہیں، باقی رقم {{remainingAmount}} ہے۔' },
    },
  },
  BRANCH_ASSIGNED: {
    audience: 'STAFF',
    group: 'المكتب',
    label: 'تعيين في فرع',
    trigger: 'عند إضافة موظف إلى فرع أو تعيينه مديرًا له',
    title: 'تم تعيينك في فرع',
    body: 'أصبحت تعمل في {{branchName}}. حجوزاتك وصندوقك من الآن على هذا الفرع.',
    variables: ['userName', 'branchName'],
    translations: {
      en: { title: 'You have been assigned to a branch', body: 'You now work at {{branchName}}. From now on, your bookings and cash box belong to this branch.' },
      ur: { title: 'آپ کو ایک برانچ میں مقرر کیا گیا', body: 'اب آپ {{branchName}} میں کام کریں گے۔ اب سے آپ کی بکنگز اور کیش باکس اسی برانچ کے تحت ہوں گے۔' },
    },
  },
  CUSTODY_ISSUED: {
    audience: 'STAFF',
    group: 'الصندوق والعهد',
    label: 'صرف عهدة',
    trigger: 'عند صرف عهدة لموظف من الصندوق',
    title: 'صُرفت لك عهدة',
    body: 'صُرفت لك العهدة {{custodyNumber}} بمبلغ {{amount}} من {{branchName}} لغرض: {{custodyPurpose}}.',
    variables: ['userName', 'custodyNumber', 'custodyPurpose', 'amount', 'branchName'],
    translations: {
      en: { title: 'Custody funds issued to you', body: 'Custody {{custodyNumber}} of {{amount}} has been issued to you from {{branchName}} for: {{custodyPurpose}}.' },
      ur: { title: 'آپ کو امانتی رقم جاری کی گئی', body: '{{branchName}} سے امانتی رقم {{custodyNumber}} بمبلغ {{amount}} آپ کو جاری کی گئی ہے، مقصد: {{custodyPurpose}}۔' },
    },
  },
  CUSTODY_SETTLED: {
    audience: 'STAFF',
    group: 'الصندوق والعهد',
    label: 'تسوية عهدة',
    trigger: 'عند تسوية عهدة الموظف',
    title: 'تمت تسوية عهدتك',
    body: 'تمت تسوية العهدة {{custodyNumber}}: المصروف الفعلي {{spentAmount}} والمرتجع {{returnedAmount}}.',
    variables: ['userName', 'custodyNumber', 'custodyPurpose', 'amount', 'spentAmount', 'returnedAmount', 'branchName'],
    translations: {
      en: { title: 'Your custody has been settled', body: 'Custody {{custodyNumber}} has been settled: actual spending {{spentAmount}}, returned {{returnedAmount}}.' },
      ur: { title: 'آپ کی امانتی رقم کا تصفیہ ہو گیا', body: 'امانتی رقم {{custodyNumber}} کا تصفیہ ہو گیا: اصل خرچ {{spentAmount}} اور واپس شدہ {{returnedAmount}}۔' },
    },
  },
  CUSTODY_EXPENSE_VOIDED: {
    audience: 'STAFF',
    group: 'الصندوق والعهد',
    label: 'إلغاء مصروف عهدة',
    trigger: 'عند إلغاء الإدارة مصروفًا سجّله صاحب العهدة',
    title: 'أُلغي مصروف من عهدتك',
    body: 'ألغت الإدارة مصروف {{amount}} من العهدة {{custodyNumber}}. السبب: {{voidReason}}.',
    variables: ['userName', 'custodyNumber', 'custodyPurpose', 'amount', 'voidReason'],
    translations: {
      en: { title: 'An expense was voided from your custody', body: 'Management voided an expense of {{amount}} from custody {{custodyNumber}}. Reason: {{voidReason}}.' },
      ur: { title: 'آپ کی امانتی رقم سے ایک خرچ منسوخ', body: 'انتظامیہ نے امانتی رقم {{custodyNumber}} سے {{amount}} کا خرچ منسوخ کر دیا۔ وجہ: {{voidReason}}۔' },
    },
  },
  CASH_CLOSING_DIFFERENCE: {
    audience: 'STAFF',
    group: 'الصندوق والعهد',
    label: 'فرق عند إقفال الصندوق',
    trigger: 'عند إقفال صندوق يختلف نقده الفعلي عن المتوقع',
    title: 'فرق في إقفال الصندوق',
    body: 'أقفل {{senderName}} صندوق {{branchName}} ليوم {{businessDate}} بفرق {{differenceAmount}}.',
    variables: ['userName', 'senderName', 'branchName', 'businessDate', 'differenceAmount'],
    translations: {
      en: { title: 'Cash box closing difference', body: '{{senderName}} closed the {{branchName}} cash box for {{businessDate}} with a difference of {{differenceAmount}}.' },
      ur: { title: 'کیش باکس بند کرنے میں فرق', body: '{{senderName}} نے {{businessDate}} کے لیے {{branchName}} کا کیش باکس {{differenceAmount}} کے فرق کے ساتھ بند کیا۔' },
    },
  },
  CASH_OPENING_CHANGED: {
    audience: 'STAFF',
    group: 'الصندوق والعهد',
    label: 'افتتاح صندوق برصيد مختلف',
    trigger: 'عند فتح صندوق برصيد يختلف عن آخر إقفال',
    title: 'رصيد افتتاحي مختلف',
    body: 'فتح {{senderName}} صندوق {{branchName}} برصيد {{amount}} بينما آخر إقفال {{carriedAmount}}.',
    variables: ['userName', 'senderName', 'branchName', 'amount', 'carriedAmount'],
    translations: {
      en: { title: 'Different opening balance', body: '{{senderName}} opened the {{branchName}} cash box with {{amount}}, while the last closing was {{carriedAmount}}.' },
      ur: { title: 'مختلف ابتدائی بیلنس', body: '{{senderName}} نے {{branchName}} کا کیش باکس {{amount}} کے ساتھ کھولا، جبکہ آخری بندش {{carriedAmount}} پر ہوئی تھی۔' },
    },
  },
  TRIP_REMINDER_24H: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'تذكير قبل الرحلة بـ24 ساعة',
    trigger: 'قبل انطلاق الرحلة بـ24 ساعة، مرة واحدة لكل حجز',
    title: 'رحلتك غدًا',
    body: 'تذكير بحجزك {{bookingReference}}: تنطلق رحلة {{origin}} ← {{destination}} يوم {{departureDate}} الساعة {{departureTime}}. نقطة التجمع {{boardingPoint}} الساعة {{boardingTime}}.',
    variables: BOOKING,
    expiresMinutes: 12 * 60,
    translations: {
      en: { title: 'Your trip is tomorrow', body: 'A reminder for your booking {{bookingReference}}: the trip {{origin}} → {{destination}} departs on {{departureDate}} at {{departureTime}}. Meeting point: {{boardingPoint}} at {{boardingTime}}.' },
      ur: { title: 'آپ کا سفر کل ہے', body: 'آپ کی بکنگ {{bookingReference}} کی یاد دہانی: {{origin}} ← {{destination}} کا سفر {{departureDate}} کو {{departureTime}} بجے روانہ ہوگا۔ جمع ہونے کا مقام {{boardingPoint}}، وقت {{boardingTime}}۔' },
    },
  },
  PAYMENT_INCOMPLETE: {
    audience: 'PASSENGER',
    group: 'الحجوزات',
    label: 'فشل الدفع أو حجز غير مكتمل',
    trigger: 'عند انتهاء مهلة المقاعد التي اختارها العميل دون إتمام الدفع',
    title: 'لم يكتمل حجزك',
    body: 'انتهت مهلة المقاعد التي اخترتها في رحلة {{origin}} ← {{destination}} يوم {{departureDate}} دون إتمام الدفع. يمكنك الحجز من جديد من التطبيق.',
    variables: TRIP,
    expiresMinutes: 2 * 60,
    translations: {
      en: { title: 'Your booking was not completed', body: 'The hold on the seats you chose for the trip {{origin}} → {{destination}} on {{departureDate}} has expired without payment. You can book again from the app.' },
      ur: { title: 'آپ کی بکنگ مکمل نہیں ہوئی', body: '{{departureDate}} کو {{origin}} ← {{destination}} کے سفر کے لیے آپ کی منتخب سیٹوں کی مہلت ادائیگی کے بغیر ختم ہو گئی۔ آپ ایپ سے دوبارہ بکنگ کر سکتے ہیں۔' },
    },
  },
  CREW_DEPARTURE_REMINDER: {
    audience: 'PASSENGER',
    group: 'الرحلات (المشرف)',
    label: 'تذكير بموعد الانطلاق',
    trigger: 'يرسله مشرف الرحلة من التطبيق',
    title: 'تذكير بموعد الانطلاق',
    body: 'تذكير من دروب الهجرة: تنطلق رحلتكم من {{origin}} إلى {{destination}} يوم {{departureDate}} الساعة {{departureTime}}. نرجو الحضور قبل الموعد بـ30 دقيقة. رقم الرحلة {{tripCode}}.',
    variables: BOOKING,
    crewManual: true,
    expiresMinutes: 6 * 60,
    translations: {
      en: { title: 'Departure time reminder', body: 'A reminder from Durob Al Hijra: your trip from {{origin}} to {{destination}} departs on {{departureDate}} at {{departureTime}}. Please arrive 30 minutes early. Trip number {{tripCode}}.' },
      ur: { title: 'روانگی کے وقت کی یاد دہانی', body: 'دروب الہجرہ کی طرف سے یاد دہانی: {{origin}} سے {{destination}} کے لیے آپ کا سفر {{departureDate}} کو {{departureTime}} بجے روانہ ہوگا۔ براہ کرم وقت سے 30 منٹ پہلے پہنچیں۔ سفر نمبر {{tripCode}}۔' },
    },
  },
  CREW_DEPARTURE_CHANGE: {
    audience: 'PASSENGER',
    group: 'الرحلات (المشرف)',
    label: 'تغيير موعد الانطلاق',
    trigger: 'يرسله مشرف الرحلة من التطبيق ويكتب الموعد الجديد',
    title: 'تغير موعد الانطلاق',
    body: 'تحديث من دروب الهجرة: نود إحاطتكم بتعديل موعد انطلاق رحلة {{origin}} إلى {{destination}} ليكون {{newValue}}. شكرًا لتفهمكم.',
    variables: [...BOOKING, 'newValue'],
    crewManual: true,
    requires: ['newValue'],
    expiresMinutes: 6 * 60,
    translations: {
      en: { title: 'Departure time changed', body: 'An update from Durob Al Hijra: please note that the departure time of the trip from {{origin}} to {{destination}} has been changed to {{newValue}}. Thank you for your understanding.' },
      ur: { title: 'روانگی کا وقت تبدیل ہو گیا', body: 'دروب الہجرہ کی طرف سے اپ ڈیٹ: آپ کو مطلع کیا جاتا ہے کہ {{origin}} سے {{destination}} کے سفر کی روانگی کا وقت اب {{newValue}} ہے۔ آپ کے تعاون کا شکریہ۔' },
    },
  },
  CREW_POINT_CHANGE: {
    audience: 'PASSENGER',
    group: 'الرحلات (المشرف)',
    label: 'تغيير نقطة التجمع',
    trigger: 'يرسله مشرف الرحلة من التطبيق ويكتب الموقع الجديد',
    title: 'تغيرت نقطة التجمع',
    body: 'تحديث من دروب الهجرة: تغيرت نقطة التجمع لرحلة {{origin}} إلى {{destination}} لتصبح {{newValue}}. شكرًا لتفهمكم.',
    variables: [...BOOKING, 'newValue'],
    crewManual: true,
    requires: ['newValue'],
    expiresMinutes: 6 * 60,
    translations: {
      en: { title: 'Meeting point changed', body: 'An update from Durob Al Hijra: the meeting point for the trip from {{origin}} to {{destination}} has changed to {{newValue}}. Thank you for your understanding.' },
      ur: { title: 'جمع ہونے کا مقام تبدیل ہو گیا', body: 'دروب الہجرہ کی طرف سے اپ ڈیٹ: {{origin}} سے {{destination}} کے سفر کے لیے جمع ہونے کا مقام اب {{newValue}} ہے۔ آپ کے تعاون کا شکریہ۔' },
    },
  },
  CREW_MIQAT_REMINDER: {
    audience: 'PASSENGER',
    group: 'الرحلات (المشرف)',
    label: 'تذكير الإحرام قبل الميقات',
    trigger: 'يرسله مشرف الرحلة من التطبيق',
    title: 'تذكير الإحرام',
    body: 'تذكير من دروب الهجرة: سنصل بمشيئة الله إلى الميقات خلال ساعة تقريبًا. نرجو الاستعداد والتهيؤ للإحرام. تقبل الله طاعتكم.',
    variables: BOOKING,
    crewManual: true,
    expiresMinutes: 60,
    translations: {
      en: { title: 'Ihram reminder', body: 'A reminder from Durob Al Hijra: God willing, we will reach the Miqat in about an hour. Please get ready for Ihram. May Allah accept your worship.' },
      ur: { title: 'احرام کی یاد دہانی', body: 'دروب الہجرہ کی طرف سے یاد دہانی: ان شاء اللہ ہم تقریباً ایک گھنٹے میں میقات پہنچیں گے۔ براہ کرم احرام کی تیاری کر لیں۔ اللہ آپ کی عبادت قبول فرمائے۔' },
    },
  },
  STATION_APPROACHING: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'الحافلة تقترب من المحطة',
    trigger: 'تلقائيًا قبل وصول الحافلة إلى محطة الراكب، أو يدويًا من صفحة تنبيهات المحطات',
    title: 'الحافلة تقترب من محطتك',
    body: 'الحافلة في طريقها إلى محطة {{stopName}} {{etaText}}. نرجو التواجد الآن. رحلة {{tripCode}} إلى {{destination}}.',
    variables: [...BOOKING, 'stopName', 'etaText'],
    expiresMinutes: LIVE_ALERT_EXPIRES_MINUTES,
    translations: {
      en: { title: 'Your bus is approaching', body: 'The bus is on its way to {{stopName}}. Please be at the stop now. Trip {{tripCode}} to {{destination}}.' },
      ur: { title: 'بس آپ کے اسٹاپ کے قریب ہے', body: 'بس {{stopName}} کی طرف آ رہی ہے۔ براہ کرم ابھی اسٹاپ پر موجود رہیں۔ سفر {{tripCode}} برائے {{destination}}۔' },
    },
  },
  STATION_ARRIVED: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'وصلت الحافلة (إرسال يدوي)',
    trigger: 'يدويًا من صفحة تنبيهات المحطات. الإرسال التلقائي عند الوصول هو «وصول الحافلة إلى نقطة المسافر»',
    title: 'وصلت الحافلة إلى المحطة',
    body: 'وصلت الحافلة إلى محطة {{stopName}}. توجه إليها بتذكرتك. رحلة {{tripCode}} إلى {{destination}}.',
    variables: [...BOOKING, 'stopName'],
    expiresMinutes: LIVE_ALERT_EXPIRES_MINUTES,
    translations: {
      en: { title: 'The bus has arrived', body: 'The bus has arrived at {{stopName}}. Please board with your ticket. Trip {{tripCode}} to {{destination}}.' },
      ur: { title: 'بس پہنچ گئی ہے', body: 'بس {{stopName}} پہنچ گئی ہے۔ اپنا ٹکٹ لے کر سوار ہوں۔ سفر {{tripCode}} برائے {{destination}}۔' },
    },
  },
  STATION_LATE_REMINDER: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'تذكير من لم يصعد',
    trigger: 'تلقائيًا بعد وصول الحافلة إلى المحطة بدقائق، لمن لم يصعد من ركابها',
    title: 'الحافلة بانتظارك',
    body: 'الحافلة في محطة {{stopName}} ولم يُسجل صعودك بعد. نرجو الصعود الآن قبل المغادرة.',
    variables: [...BOOKING, 'stopName'],
    expiresMinutes: 15,
    translations: {
      en: { title: 'The bus is waiting for you', body: 'The bus is at {{stopName}} and you have not boarded yet. Please board now before it leaves.' },
      ur: { title: 'بس آپ کا انتظار کر رہی ہے', body: 'بس {{stopName}} پر ہے اور آپ ابھی سوار نہیں ہوئے۔ روانگی سے پہلے ابھی سوار ہوں۔' },
    },
  },
  STATION_DELAY: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'تأخر الحافلة',
    trigger: 'يدويًا من صفحة تنبيهات المحطات',
    title: 'تأخرت الحافلة',
    body: 'نعتذر، تأخر وصول الحافلة إلى محطة {{stopName}} نحو {{minutes}} دقيقة. رحلة {{tripCode}} إلى {{destination}}.',
    variables: [...BOOKING, 'stopName', 'minutes'],
    expiresMinutes: LIVE_ALERT_EXPIRES_MINUTES,
    translations: {
      en: { title: 'The bus is delayed', body: 'Sorry, the bus will reach {{stopName}} about {{minutes}} minutes late. Trip {{tripCode}} to {{destination}}.' },
      ur: { title: 'بس میں تاخیر ہے', body: 'معذرت، بس {{stopName}} پر تقریباً {{minutes}} منٹ تاخیر سے پہنچے گی۔ سفر {{tripCode}} برائے {{destination}}۔' },
    },
  },
  STATION_LOCATION_CHANGED: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'تغيير موقع المحطة',
    trigger: 'يدويًا من صفحة تنبيهات المحطات، ويكتب الموظف الموقع الجديد',
    title: 'تغير موقع المحطة',
    body: 'تغير موقع محطة {{stopName}} إلى: {{newValue}}. رحلة {{tripCode}} إلى {{destination}}.',
    variables: [...BOOKING, 'stopName', 'newValue'],
    requires: ['newValue'],
    expiresMinutes: LIVE_ALERT_EXPIRES_MINUTES,
    translations: {
      en: { title: 'Stop location changed', body: 'The location of {{stopName}} has changed to: {{newValue}}. Trip {{tripCode}} to {{destination}}.' },
      ur: { title: 'اسٹاپ کی جگہ تبدیل ہو گئی', body: '{{stopName}} کی جگہ اب یہ ہے: {{newValue}}۔ سفر {{tripCode}} برائے {{destination}}۔' },
    },
  },
  STATION_MIQAT_REMINDER: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'تذكير الإحرام قبل الميقات',
    trigger: 'تلقائيًا قبل موعد الوصول إلى الميقات في جدول الرحلة',
    title: 'اقترب الميقات',
    body: 'نصل بمشيئة الله إلى {{stopName}} بعد نحو {{minutes}} دقيقة. نرجو الاستعداد والتهيؤ للإحرام. تقبل الله طاعتكم.',
    variables: [...BOOKING, 'stopName', 'minutes'],
    expiresMinutes: LIVE_ALERT_EXPIRES_MINUTES,
    translations: {
      en: { title: 'The Miqat is near', body: 'We will reach {{stopName}} in about {{minutes}} minutes, God willing. Please prepare for Ihram.' },
      ur: { title: 'میقات قریب ہے', body: 'ان شاء اللہ ہم تقریباً {{minutes}} منٹ میں {{stopName}} پہنچیں گے۔ براہ کرم احرام کی تیاری کریں۔' },
    },
  },
  STATION_DESTINATION_WELCOME: {
    audience: 'PASSENGER',
    group: 'تنبيهات المحطات',
    label: 'الوصول للوجهة ورقم الفندق',
    trigger: 'تلقائيًا عند تحديد الطاقم وصول الحافلة إلى وجهتها',
    title: 'حمدًا لله على السلامة',
    body: 'وصلت رحلتك إلى {{destination}}. فندقك {{hotelName}} والغرفة {{roomNumber}}. نتمنى لك إقامة مباركة.',
    variables: [...BOOKING, 'hotelName', 'roomNumber'],
    expiresMinutes: 2 * 60,
    translations: {
      en: { title: 'Welcome', body: 'Your trip has reached {{destination}}. Your hotel is {{hotelName}}, room {{roomNumber}}. Wishing you a blessed stay.' },
      ur: { title: 'خوش آمدید', body: 'آپ کا سفر {{destination}} پہنچ گیا ہے۔ آپ کا ہوٹل {{hotelName}} اور کمرہ {{roomNumber}} ہے۔ آپ کا قیام مبارک ہو۔' },
    },
  },
  CAMPAIGN_ANNOUNCEMENT: {
    audience: 'PASSENGER',
    group: 'الحملات والعروض',
    label: 'رسالة لمجموعة عملاء',
    trigger: 'قالب واتساب للرسائل المرسلة من صفحة العروض. نص الرسالة يكتبه المرسل',
    title: 'رسالة من دروب الهجرة',
    body: 'مرحبًا {{userName}}، لديك رسالة من دروب الهجرة: {{message}} شكرًا لاختيارك دروب الهجرة.',
    variables: ['userName', 'message'],
    requires: ['message'],
    campaign: true,
    expiresMinutes: 48 * 60,
    translations: {
      en: { title: 'A message from Durob Al Hijra', body: 'Hello {{userName}}, you have a message from Durob Al Hijra: {{message}} Thank you for choosing Durob Al Hijra.' },
      ur: { title: 'دروب الہجرہ کا پیغام', body: 'السلام علیکم {{userName}}، دروب الہجرہ کی طرف سے آپ کے لیے پیغام: {{message}} دروب الہجرہ کا انتخاب کرنے کا شکریہ۔' },
    },
  },
  CAMPAIGN_OFFER: {
    audience: 'PASSENGER',
    group: 'الحملات والعروض',
    label: 'رسالة مع كوبون',
    trigger: 'قالب واتساب للرسائل التي يُرفق بها كوبون. نص الرسالة يكتبه المرسل',
    title: 'عرض من دروب الهجرة',
    body: 'مرحبًا {{userName}}، {{message}} استخدم الكوبون {{couponCode}} عند الحجز من التطبيق.',
    variables: ['userName', 'message', 'couponCode'],
    requires: ['message', 'couponCode'],
    campaign: true,
    expiresMinutes: 48 * 60,
    translations: {
      en: { title: 'An offer from Durob Al Hijra', body: 'Hello {{userName}}, {{message}} Use coupon {{couponCode}} when booking in the app.' },
      ur: { title: 'دروب الہجرہ کی پیشکش', body: 'السلام علیکم {{userName}}، {{message}} ایپ سے بکنگ کرتے وقت کوپن {{couponCode}} استعمال کریں۔' },
    },
  },
} satisfies Record<string, CatalogEntry>;

export type NotificationEvent = keyof typeof NOTIFICATION_CATALOG;
export type NotificationValues = Partial<Record<NotificationVariable, string | number | null | undefined>>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export const isNotificationEvent = (value: string): value is NotificationEvent => Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, value);

export const describeVariables = (event: NotificationEvent) => {
  const keys: NotificationVariable[] = NOTIFICATION_CATALOG[event].variables;
  return keys.map((key) => ({ key, ...VARIABLES[key] }));
};

/** One pass only, so a value that happens to contain {{...}} is never expanded again. */
export const renderTemplate = (template: string, values: NotificationValues) =>
  template
    .replace(PLACEHOLDER, (_, key: NotificationVariable) => {
      const value = values[key];
      if (value !== null && value !== undefined && value !== '') return String(value);
      return OPTIONAL_VARIABLES.includes(key) ? '' : '—';
    })
    .trim();

/** Returns what is wrong with a template, or null when it can be saved. */
export function findTemplateProblem(event: NotificationEvent, text: string): string | null {
  const allowed: string[] = NOTIFICATION_CATALOG[event].variables;
  for (const [, key] of text.matchAll(PLACEHOLDER)) {
    if (!allowed.includes(key)) return `المتغير {{${key}}} غير متاح لهذا الإشعار`;
  }
  const leftover = text.replace(PLACEHOLDER, '');
  if (leftover.includes('{{') || leftover.includes('}}')) return 'صيغة المتغير غير صحيحة، استخدم {{اسم_المتغير}}';
  return null;
}

const entryOf = (event: NotificationEvent): CatalogEntry => NOTIFICATION_CATALOG[event];

/** A template that lost what the sender fills in would send the same empty words to everyone. */
export function findMissingRequired(event: NotificationEvent, body: string): string | null {
  const used = [...body.matchAll(PLACEHOLDER)].map(([, key]) => key);
  const missing = (entryOf(event).requires ?? []).find((key) => !used.includes(key));
  return missing ? `يجب أن يبقى المتغير {{${missing}}} في نص هذا الإشعار` : null;
}

export const describeEntry = (event: NotificationEvent) => {
  const { crewManual, campaign, requires, expiresMinutes, translations } = entryOf(event);
  return { crewManual: !!crewManual, campaign: !!campaign, requires: requires ?? [], expiresMinutes: expiresMinutes ?? null, translations: translations ?? {} };
};

export const crewManualEvents = () => (Object.keys(NOTIFICATION_CATALOG) as NotificationEvent[]).filter((event) => entryOf(event).crewManual);

export const variableExample = (key: NotificationVariable) => VARIABLES[key].example;

/** WhatsApp numbers its variables, so the order they appear in is kept for filling them later. */
export function toWhatsAppBody(text: string) {
  const order: NotificationVariable[] = [];
  const body = text.replace(PLACEHOLDER, (_, key: NotificationVariable) => {
    order.push(key);
    return `{{${order.length}}}`;
  });
  return { body, order };
}

/** Meta's refusal only comes days later, so what it always refuses is caught here. */
export function findWhatsAppProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > 1024) return 'نص قالب واتساب لا يتجاوز 1024 حرفًا';
  if (/^\{\{/.test(trimmed) || /\}\}[.،!؟]?$/.test(trimmed)) return 'واتساب لا يقبل نصًا يبدأ أو ينتهي بمتغير، أضف كلمات قبله أو بعده';
  if (/\}\}\s*\{\{/.test(trimmed)) return 'واتساب لا يقبل متغيرين متجاورين دون كلمات بينهما';
  return null;
}

/** WhatsApp refuses line breaks, tabs and long runs of spaces inside a variable, and an empty one. */
export const toWhatsAppParam = (value: unknown) => {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900);
  return text || '—';
};

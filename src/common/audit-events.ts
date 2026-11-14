import { INTEGRATION_FIELDS } from './services/integrations.service';

const SECTIONS = {
  bookings: 'الحجوزات',
  trips: 'الرحلات',
  buses: 'الباصات والسائقون',
  branches: 'الفروع',
  cash: 'الصندوق والعهد',
  collections: 'التحصيل',
  hotels: 'الفنادق والسكن',
  accounts: 'حساب الرحلات',
  payments: 'المدفوعات والاسترداد',
  loyalty: 'الولاء والعروض',
  customers: 'العملاء والموظفون',
  ranks: 'الوظائف والرتب',
  hr: 'الموارد البشرية',
  notifications: 'الإشعارات',
  chat: 'المحادثات',
  crew: 'طاقم الرحلة',
  packages: 'الباقات والخدمات',
  settings: 'الإعدادات',
  account: 'الدخول والحساب',
} as const;

type Event = { event: string; section: keyof typeof SECTIONS; hidden?: boolean };
const on = (section: keyof typeof SECTIONS, event: string, hidden = false): Event => ({ section, event, hidden });

/**
 * What each write means to the person reading the log. A test fails when a new route has no entry here.
 * Rows store the route, not this wording, so a rename here also corrects past rows.
 */
export const AUDIT_EVENTS: Record<string, Event> = {
  'POST /auth/send-otp': on('account', 'طلب رمز تحقق'),
  'POST /auth/verify-otp': on('account', 'دخول برمز التحقق'),
  'POST /auth/login': on('account', 'تسجيل دخول'),
  'POST /auth/refresh': on('account', 'تجديد الجلسة', true),
  'POST /auth/logout': on('account', 'تسجيل خروج'),

  'GET /bookings/admin/export': on('bookings', 'تصدير الحجوزات'),
  'GET /bookings/admin/lookup': on('bookings', 'بحث عن حجز (موظف بحث فقط)'),
  'PATCH /bookings/admin/:id/passengers/:passengerId': on('bookings', 'تعديل بيانات راكب'),
  'POST /bookings/admin/:id/passengers/:passengerId/seat': on('bookings', 'تغيير مقعد راكب'),
  'POST /bookings/admin/:id/boarding-point': on('bookings', 'تغيير نقطة صعود الحجز'),
  'POST /bookings/admin/:id/compensation': on('bookings', 'تعويض عميل عن تذكرة موقوفة'),
  'POST /chat/mine/booking-card': on('chat', 'إرسال بيانات حجز إلى الدعم'),
  'POST /bookings/admin/:id/passengers/:passengerId/board': on('bookings', 'تسجيل صعود راكب من اللوحة'),
  'POST /bookings/admin/:id/passengers/:passengerId/unboard': on('bookings', 'إلغاء تسجيل صعود راكب'),
  'POST /bookings/admin/:id/notes': on('bookings', 'إضافة ملاحظة على حجز'),
  'POST /bookings/quote': on('bookings', 'حساب سعر حجز', true),
  'POST /bookings/holds': on('bookings', 'حجز مقاعد مؤقتًا', true),
  'DELETE /bookings/holds': on('bookings', 'إطلاق مقاعد محجوزة مؤقتًا', true),
  'POST /bookings': on('bookings', 'إنشاء حجز'),
  'POST /bookings/:id/cancel': on('bookings', 'طلب إلغاء حجز'),
  'POST /bookings/:id/cancellation/review': on('bookings', 'مراجعة طلب إلغاء حجز'),
  'POST /bookings/:id/admin-cancel': on('bookings', 'إلغاء حجز من الإدارة'),

  'POST /trips': on('trips', 'إضافة رحلة'),
  'POST /trips/images': on('trips', 'رفع صور رحلة أو باص'),
  'PUT /trips/:id': on('trips', 'تعديل رحلة'),
  'POST /trips/:id/open-reverse': on('trips', 'فتح رحلة عكسية'),
  'POST /trips/:id/duplicate': on('trips', 'نسخ رحلة إلى موعد جديد'),
  'POST /trips/:id/boarding/open': on('trips', 'فتح الصعود يدويًا'),
  'POST /trips/:id/boarding/reset': on('trips', 'إرجاع الصعود لموعده'),
  'POST /trips/series/generate-month': on('trips', 'توليد جدول الشهر من الجداول الأسبوعية'),
  'POST /trips/series/far-drafts/delete': on('trips', 'حذف مسودات الجداول الأسبوعية البعيدة'),
  'POST /trips/series/:seriesId/publish': on('trips', 'نشر مسودات جدول أسبوعي'),
  'POST /trips/series/:seriesId/stop': on('trips', 'إيقاف جدول أسبوعي'),
  'POST /trips/:id/cancel': on('trips', 'إلغاء رحلة'),
  'DELETE /trips/:id': on('trips', 'حذف رحلة'),

  'POST /buses': on('buses', 'إضافة باص'),
  'PUT /buses/:id': on('buses', 'تعديل باص'),
  'DELETE /buses/:id': on('buses', 'حذف باص'),
  'POST /drivers': on('buses', 'إضافة سائق'),
  'PATCH /drivers/:id': on('buses', 'تعديل بيانات سائق'),
  'POST /bus-offices': on('buses', 'إضافة مكتب باصات'),
  'PATCH /bus-offices/:id': on('buses', 'تعديل مكتب باصات'),
  'PATCH /bus-offices/trips/:tripId/cost': on('buses', 'تحديد إيجار باص ومصاريف رحلة'),
  'POST /bus-offices/:id/payments': on('buses', 'تسجيل سداد لمكتب باصات'),
  'POST /bus-offices/payments/:paymentId/void': on('buses', 'إلغاء سداد لمكتب باصات'),

  'POST /branches': on('branches', 'إضافة فرع'),
  'PATCH /branches/:id': on('branches', 'تعديل بيانات فرع'),
  'PUT /branches/:id/manager': on('branches', 'تعيين مدير فرع'),
  'POST /branches/:id/employees': on('branches', 'تسجيل موظف في فرع'),
  'POST /branches/:id/employees/assign': on('branches', 'إضافة موظف إلى فرع'),
  'DELETE /branches/:id/employees/:userId': on('branches', 'إخراج موظف من فرع'),
  'PUT /branches/:id/employees/:userId/access': on('branches', 'تعديل رتبة موظف وصلاحياته'),
  'PUT /users/:id/access': on('customers', 'تعديل رتبة موظف وصلاحياته'),
  'POST /branch-bookings': on('bookings', 'تسجيل حجز من الفرع'),
  'POST /branch-bookings/quote': on('bookings', 'حساب سعر حجز', true),
  'POST /cash/branches': on('cash', 'إضافة فرع'),
  'PATCH /cash/branches/:id': on('cash', 'تعديل فرع'),
  'POST /cash/branches/:branchId/sessions': on('cash', 'فتح الصندوق اليومي'),
  'POST /cash/sessions/:id/close': on('cash', 'إقفال الصندوق اليومي'),
  'POST /cash/branches/:branchId/custodies': on('cash', 'صرف عهدة'),
  'POST /cash/custodies/:id/settle': on('cash', 'تسوية عهدة'),
  'POST /cash/custody-expenses/:id/void': on('cash', 'رفض مصروف عهدة'),
  'POST /crew/custodies/:id/expenses': on('cash', 'تسجيل مصروف من عهدة'),
  'POST /crew/custodies/expenses/:id/void': on('cash', 'إلغاء مصروف عهدة'),

  'POST /collections/bookings/:id': on('collections', 'تسجيل دفعة تحصيل على حجز'),
  'PATCH /collections/bookings/:id/note': on('collections', 'تعديل ملاحظة المتابعة على حجز'),

  'POST /hotels': on('hotels', 'إضافة فندق'),
  'PATCH /hotels/:id': on('hotels', 'تعديل فندق'),
  'POST /hotels/bookings': on('hotels', 'حجز فندق لرحلة'),
  'POST /hotels/bookings/:id/rooms': on('hotels', 'تسكين ركاب في غرفة'),
  'POST /hotels/bookings/:id/rooms/bulk': on('hotels', 'توزيع ركاب على الغرف تلقائيًا'),
  'PATCH /hotels/passengers/:passengerId/profile': on('hotels', 'تحديد جنس وجنسية راكب للتسكين'),
  'POST /hotels/bookings/:id/inventory': on('hotels', 'إضافة غرف متاحة للحجز'),
  'POST /hotels/bookings/:id/cancel': on('hotels', 'إلغاء حجز فندق'),
  'POST /hotels/assign-booking': on('hotels', 'حجز غرفة من حجز عميل'),
  'PUT /manifests/:tripId/housing-sheet': on('hotels', 'تجهيز كشف التسكين للفندق'),
  'DELETE /hotels/passengers/:passengerId/room': on('hotels', 'إخراج راكب من غرفته'),
  'POST /hotels/:id/room-blocks': on('hotels', 'إخراج غرفة من الخدمة'),
  'POST /hotels/:id/room-blocks/:blockId/release': on('hotels', 'إعادة غرفة إلى الخدمة'),
  'POST /hotels/:id/complaints': on('hotels', 'تسجيل شكوى فندق'),
  'POST /hotels/:id/complaints/:complaintId/resolve': on('hotels', 'إغلاق شكوى فندق'),
  'POST /hotels/:id/complaints/:complaintId/reopen': on('hotels', 'إعادة فتح شكوى فندق'),
  'POST /bookings/:bookingId/hotel-complaints': on('hotels', 'إرسال شكوى عن فندق'),
  'POST /complaints': on('customers', 'إرسال شكوى من التطبيق'),
  'POST /complaints/:id/resolve': on('customers', 'الرد على شكوى عميل وإغلاقها'),
  'POST /complaints/:id/reopen': on('customers', 'إعادة فتح شكوى عميل'),

  'POST /trip-accounts/categories': on('accounts', 'إضافة بند لحساب الرحلات'),
  'PATCH /trip-accounts/categories/:id': on('accounts', 'تعديل بند في حساب الرحلات'),
  'POST /trip-accounts/entries/:id/void': on('accounts', 'إلغاء قيد في حساب رحلة'),
  'POST /trip-accounts/entries/:id/settle': on('accounts', 'تسوية قيد مستحق آخر الشهر'),
  'POST /trip-accounts/:id/entries': on('accounts', 'تسجيل قيد في حساب رحلة'),
  'PATCH /trip-accounts/:id/tax-flags': on('accounts', 'تعديل بيانات ضريبة تكاليف رحلة'),

  'GET /payments/export': on('payments', 'تصدير سجل المدفوعات'),
  'POST /cancellations/refunds/:id/execute': on('payments', 'تأكيد تنفيذ استرداد'),
  'POST /cancellations/refunds/:id/move-to-wallet': on('payments', 'تحويل استرداد إلى المحفظة'),

  'POST /coupons': on('loyalty', 'إضافة كوبون'),
  'PUT /coupons/:id': on('loyalty', 'تعديل كوبون'),
  'DELETE /coupons/:id': on('loyalty', 'حذف كوبون'),
  'PUT /loyalty/program': on('loyalty', 'تعديل إعدادات برنامج الولاء'),
  'POST /loyalty/rules': on('loyalty', 'إضافة قاعدة نقاط'),
  'PATCH /loyalty/rules/:id': on('loyalty', 'تعديل قاعدة نقاط'),
  'DELETE /loyalty/rules/:id': on('loyalty', 'حذف قاعدة نقاط'),
  'POST /loyalty/vouchers': on('loyalty', 'إضافة قسيمة'),
  'PATCH /loyalty/vouchers/:id': on('loyalty', 'تعديل قسيمة'),
  'POST /loyalty/customers/:id/adjust': on('loyalty', 'تعديل نقاط عميل يدويًا'),

  'POST /users': on('customers', 'إضافة موظف'),
  'POST /users/:id/promote': on('customers', 'تعيين شخص موظفًا'),
  'PUT /users/:id': on('customers', 'تعديل بيانات مستخدم'),
  'PUT /users/:id/wallet': on('customers', 'تعديل رصيد محفظة'),
  'PUT /users/:id/wallet/reset': on('customers', 'تصفير رصيد محفظة'),
  'DELETE /users/:id': on('customers', 'حذف مستخدم'),
  'PUT /users/profile': on('account', 'تعديل الملف الشخصي'),
  'PUT /users/profile/photo': on('account', 'تغيير الصورة الشخصية'),
  'DELETE /users/profile/photo': on('account', 'حذف الصورة الشخصية'),
  'PUT /users/:id/photo': on('customers', 'تغيير صورة عميل'),
  'DELETE /users/:id/photo': on('customers', 'حذف صورة عميل'),
  'POST /users/profile/loyalty/referral': on('account', 'إدخال رمز دعوة'),
  'POST /users/profile/loyalty/vouchers/:id/redeem': on('account', 'استبدال قسيمة بالنقاط'),

  'POST /ranks': on('ranks', 'إضافة رتبة'),
  'PUT /ranks/:id': on('ranks', 'تعديل رتبة وصلاحياتها'),
  'DELETE /ranks/:id': on('ranks', 'حذف رتبة'),
  'POST /job-types': on('ranks', 'إضافة وظيفة'),
  'PUT /job-types/:id': on('ranks', 'تعديل وظيفة'),
  'DELETE /job-types/:id': on('ranks', 'حذف وظيفة'),

  'POST /app-events': on('settings', 'تسجيل حدث من التطبيق', true),
  'POST /webhooks/whatsapp': on('notifications', 'تحديث حالة رسالة من واتساب', true),
  'POST /chat/mine/messages': on('chat', 'رسالة عميل للدعم', true),
  'POST /chat/mine/read': on('chat', 'قراءة العميل للمحادثة', true),
  'POST /chat/conversations/start': on('chat', 'بدء محادثة مع عميل'),
  'POST /chat/conversations/:id/messages': on('chat', 'رد موظف على عميل'),
  'POST /chat/conversations/:id/read': on('chat', 'قراءة الموظف للمحادثة', true),
  'PUT /chat/conversations/:id': on('chat', 'إغلاق أو استلام محادثة'),
  'POST /chat/conversations/:id/assign': on('chat', 'تحويل محادثة لموظف'),
  'POST /presence': on('chat', 'تحديث وجود العميل في التطبيق', true),
  'POST /presence/leave': on('chat', 'خروج العميل من التطبيق', true),
  'PUT /users/:id/block': on('customers', 'حظر حساب أو رفع الحظر'),
  'GET /users/lookup': on('customers', 'بحث عن عميل (موظف بحث فقط)'),
  'POST /users/:id/wallet/promo': on('customers', 'إضافة رصيد ترويجي'),
  'POST /supervisors/:id/trips/:tripId': on('crew', 'إسناد رحلة لمشرف'),
  'DELETE /supervisors/:id/trips/:tripId': on('crew', 'إلغاء إسناد رحلة من مشرف'),
  'POST /crew/trips/:tripId/release-request': on('crew', 'طلب التخلي عن رحلة'),
  'DELETE /crew/trips/:tripId/release-request': on('crew', 'سحب طلب التخلي عن رحلة'),
  'POST /crew-requests/:id/decision': on('crew', 'البت في طلب تخلٍ عن رحلة'),
  'POST /staff-penalties': on('customers', 'تسجيل جزاء على موظف'),

  'PUT /hr/employees/:userId/profile': on('hr', 'تعديل الملف الوظيفي لموظف'),
  'POST /hr/employees/:userId/salaries': on('hr', 'تسجيل راتب أو تعديله لموظف'),
  'DELETE /hr/employees/:userId/salaries/:salaryId': on('hr', 'حذف سطر راتب'),
  'PUT /hr/employees/:userId/status': on('hr', 'إيقاف موظف عن العمل أو إعادته'),
  'POST /hr/employees/:userId/documents': on('hr', 'إرفاق وثيقة أو صورة لموظف'),
  'DELETE /hr/employees/documents/:id': on('hr', 'حذف وثيقة موظف'),
  'POST /hr/leave-types': on('hr', 'إضافة نوع إجازة'),
  'PUT /hr/leave-types/:id': on('hr', 'تعديل نوع إجازة'),
  'POST /hr/leaves': on('hr', 'تسجيل إجازة لموظف'),
  'POST /hr/leaves/adjustments': on('hr', 'تعديل رصيد إجازة يدويًا'),
  'POST /hr/leaves/:id/decision': on('hr', 'البت في طلب إجازة'),
  'POST /hr/leaves/:id/cancel': on('hr', 'إلغاء إجازة'),
  'POST /hr/leaves/:id/return': on('hr', 'تسجيل عودة موظف من إجازة'),
  'POST /hr/leaves/:id/attachments': on('hr', 'إرفاق مستند بإجازة'),
  'POST /hr/me/leaves': on('hr', 'طلب إجازة'),
  'POST /hr/me/leaves/:id/attachments': on('hr', 'إرفاق مستند بطلب إجازة'),
  'DELETE /hr/me/leaves/:id': on('hr', 'سحب طلب إجازة'),
  'POST /hr/me/advances': on('hr', 'طلب سلفة'),
  'DELETE /hr/me/advances/:id': on('hr', 'سحب طلب سلفة'),
  'POST /hr/advances': on('hr', 'تسجيل سلفة لموظف'),
  'POST /hr/advances/:id/decision': on('hr', 'البت في طلب سلفة'),
  'POST /hr/advances/:id/disburse': on('hr', 'صرف سلفة'),
  'POST /hr/advances/:id/skip': on('hr', 'تأجيل قسط سلفة'),
  'POST /hr/advances/:id/repay': on('hr', 'استلام سداد سلفة نقدًا'),
  'POST /hr/advances/:id/cancel': on('hr', 'إلغاء سلفة'),
  'POST /hr/adjustments': on('hr', 'تسجيل إضافة أو خصم على راتب'),
  'POST /hr/adjustments/:id/cancel': on('hr', 'إلغاء إضافة أو خصم على راتب'),
  'POST /hr/payroll': on('hr', 'إعداد مسيّر رواتب'),
  'POST /hr/payroll/:id/calculate': on('hr', 'إعادة حساب مسيّر رواتب'),
  'DELETE /hr/payroll/:id': on('hr', 'حذف مسودة مسيّر رواتب'),
  'POST /hr/payroll/:id/approve': on('hr', 'اعتماد مسيّر رواتب'),
  'POST /hr/payroll/:id/pay': on('hr', 'تسجيل صرف رواتب'),
  'POST /hr/payroll/:id/approve-and-pay': on('hr', 'اعتماد مسيّر رواتب وصرفه'),
  'GET /hr/payroll/:id/bank-file': on('hr', 'تصدير ملف رواتب البنك'),
  'POST /hr/settlements': on('hr', 'إعداد مخالصة نهاية خدمة'),
  'PUT /hr/settlements/:id': on('hr', 'تعديل مخالصة نهاية خدمة'),
  'DELETE /hr/settlements/:id': on('hr', 'حذف مسودة مخالصة'),
  'POST /hr/settlements/:id/approve': on('hr', 'اعتماد مخالصة وإنهاء خدمة'),
  'POST /hr/settlements/:id/pay': on('hr', 'صرف مخالصة نهاية خدمة'),

  'POST /notifications/mine/read-all': on('notifications', 'قراءة كل الإشعارات', true),
  'POST /notifications/mine/:id/read': on('notifications', 'قراءة إشعار', true),
  'POST /notifications/staff-messages': on('notifications', 'إرسال إشعار للموظفين'),
  'PUT /notifications/templates/:event': on('notifications', 'تعديل نص إشعار'),
  'DELETE /notifications/templates/:event': on('notifications', 'إعادة نص إشعار لأصله'),
  'POST /notifications/templates/:event/test': on('notifications', 'إرسال تجريبي لقالب إشعار'),
  'PUT /notifications/templates/:event/channels': on('notifications', 'تغيير قنوات إشعار'),
  'POST /notifications/templates/:event/whatsapp': on('notifications', 'إرسال قالب واتساب للاعتماد'),
  'POST /notifications/whatsapp/test': on('notifications', 'اختبار ربط واتساب'),
  'POST /notifications/whatsapp/sync': on('notifications', 'مزامنة قوالب واتساب'),
  'POST /notifications/campaigns': on('notifications', 'إنشاء رسالة لمجموعة عملاء'),
  'POST /notifications/campaigns/audience': on('notifications', 'حساب جمهور رسالة', true),
  'PUT /notifications/campaigns/:id': on('notifications', 'تعديل رسالة لمجموعة عملاء'),
  'DELETE /notifications/campaigns/:id': on('notifications', 'حذف مسودة رسالة'),
  'POST /notifications/campaigns/:id/send': on('notifications', 'إرسال أو جدولة رسالة لمجموعة عملاء'),
  'POST /notifications/campaigns/:id/cancel': on('notifications', 'إلغاء رسالة مجدولة'),
  'PUT /station-alerts/rules/:key': on('notifications', 'تعديل قاعدة تنبيه محطات'),
  'PUT /station-alerts/trips/:tripId/rules/:key': on('notifications', 'تعديل قاعدة تنبيه لرحلة'),
  'POST /station-alerts/trips/:tripId/preview': on('notifications', 'معاينة تنبيه محطة', true),
  'POST /station-alerts/trips/:tripId/send': on('notifications', 'إرسال تنبيه محطة يدويًا'),
  'POST /tickets/trips/:tripId/template-notices': on('crew', 'إرسال قالب إشعار لركاب رحلة'),
  'PUT /users/profile/messaging': on('account', 'تغيير لغة التنبيهات والعروض'),

  'POST /crew/trips/:tripId/passengers/:passengerId/room': on('crew', 'تسكين مسافر في غرفة من تطبيق المشرف'),
  'POST /tickets/trips/:tripId/notices': on('crew', 'إرسال تنبيه لركاب رحلة'),
  'POST /tickets/trips/:tripId/reports': on('crew', 'إرسال بلاغ عن رحلة'),
  'POST /tickets/trips/:tripId/status': on('crew', 'تحديث مكان الحافلة'),
  'POST /tickets/verify': on('crew', 'مسح تذكرة وتسجيل صعود'),
  'POST /tickets/verify-paper': on('crew', 'مسح تذكرة ورقية وتسجيل صعود'),
  'POST /tickets/:ticketNumber/board': on('crew', 'تسجيل صعود راكب من الكشف'),
  'POST /tracking/trips/:tripId/location': on('crew', 'بث موقع الحافلة', true),
  'POST /tracking/trips/:tripId/stop': on('crew', 'إيقاف بث موقع الحافلة'),
  'POST /crew/reports/:id/updates': on('crew', 'إضافة ملاحظة على بلاغ'),
  'POST /crew/reports/:id/attachments': on('crew', 'إرفاق صور أو فيديو ببلاغ'),
  'POST /trip-reports/:id/updates': on('crew', 'تحديث بلاغ أو الرد عليه'),

  'POST /packages': on('packages', 'إضافة باقة'),
  'PUT /packages/:id': on('packages', 'تعديل باقة'),
  'DELETE /packages/:id': on('packages', 'حذف باقة'),
  'POST /services': on('packages', 'إضافة خدمة'),
  'DELETE /services/:id': on('packages', 'حذف خدمة'),

  'PUT /settings': on('settings', 'تعديل إعدادات النظام'),
  'PUT /settings/integrations': on('settings', 'تعديل مفاتيح الخدمات الخارجية'),
  'POST /settings/integrations/routing/test': on('settings', 'اختبار ربط منصة الطرق'),
};

export const AUDIT_SECTIONS: string[] = Object.values(SECTIONS);

/** Rows of the interceptor keep the global prefix and hand-written rows do not, so both spellings must match. */
const API_PREFIX = '/api/v1';
const withPrefix = (key: string) => key.replace(' /', ` ${API_PREFIX}/`);
const withoutPrefix = (action: string) => action.replace(` ${API_PREFIX}/`, ' /');

/** Machine traffic that says nothing about what anyone did. */
export const HIDDEN_AUDIT_ACTIONS = Object.entries(AUDIT_EVENTS)
  .filter(([, entry]) => entry.hidden)
  .flatMap(([key]) => [key, withPrefix(key)]);

export const auditActionsInSection = (title: string) =>
  Object.entries(AUDIT_EVENTS)
    .filter(([, entry]) => !entry.hidden && SECTIONS[entry.section] === title)
    .flatMap(([key]) => [key, withPrefix(key)]);

const VERB_FALLBACK: Record<string, string> = { POST: 'إضافة أو تنفيذ عملية', PUT: 'تعديل بيانات', PATCH: 'تعديل بيانات', DELETE: 'حذف بيانات', GET: 'تصدير بيانات' };

/** Never falls back to the route, so an address can not reach the page even for a route missing from the list. */
export function describeAuditAction(action: string): { event: string; section: string } {
  const entry = AUDIT_EVENTS[withoutPrefix(action)];
  if (entry) return { event: entry.event, section: SECTIONS[entry.section] };
  return { event: VERB_FALLBACK[action.split(' ')[0]] ?? 'عملية إدارية', section: 'أخرى' };
}

const SETTING_LABELS: Record<string, string> = {
  systemName: 'اسم النظام',
  vatRate: 'نسبة الضريبة',
  supportPhone: 'جوال الدعم',
  supportWhatsapp: 'واتساب الدعم',
  cancellationPolicy: 'سياسة الإلغاء',
  cancellationRules: 'نسب الاسترداد',
  termsAndConditions: 'الشروط والأحكام',
  privacyPolicy: 'سياسة الخصوصية',
  sellerName: 'اسم المنشأة',
  sellerTagline: 'العبارة أسفل الاسم',
  vatNumber: 'الرقم الضريبي',
  crNumber: 'السجل التجاري',
  sellerCity: 'المدينة والدولة',
  invoiceContacts: 'أرقام الفروع',
  invoiceTripNotice: 'تنبيه الرحلة في الفاتورة',
  invoiceFooter: 'شروط الفاتورة',
  maintenanceMode: 'وضع الصيانة',
  maintenanceMessage: 'رسالة الصيانة',
  bookingsEnabled: 'استقبال الحجوزات',
  registrationEnabled: 'تسجيل العملاء الجدد',
  minAppVersion: 'أقل إصدار مسموح',
  androidStoreUrl: 'رابط متجر أندرويد',
  iosStoreUrl: 'رابط متجر آبل',
  announcementTitle: 'عنوان الإعلان',
  announcementBody: 'نص الإعلان',
  panelTitle: 'اسم اللوحة',
  panelSubtitle: 'العبارة أسفل اسم اللوحة',
  panelNotice: 'تنبيه الموظفين',
  holdMinutes: 'مدة حجز المقعد المؤقت',
  boardingOpensBeforeHours: 'فتح الصعود من اللوحة',
  trackingOpensBeforeHours: 'بدء بث الموقع',
  trackingClosesAfterHours: 'انتهاء بث الموقع',
  supervisorContactOpensBeforeHours: 'إظهار جوال المشرف',
  arrivalRadiusMeters: 'نطاق الوصول',
  defaultCrewOpensBeforeMinutes: 'فتح الرحلة للطاقم',
  defaultBoardingOpensBeforeMinutes: 'فتح الصعود',
  defaultBoardingClosesAfterMinutes: 'إغلاق الصعود',
  defaultSinglesFromSeat: 'بداية مقاعد العزّاب',
  defaultSinglesToSeat: 'نهاية مقاعد العزّاب',
  otpTtlMinutes: 'صلاحية رمز التحقق',
  otpMaxAttempts: 'محاولات رمز التحقق',
  otpResendCooldownSeconds: 'انتظار إعادة الإرسال',
  otpMaxSendsPerHour: 'الرموز في الساعة',
  loginMaxFailures: 'محاولات دخول الموظفين',
  loginLockMinutes: 'مدة إيقاف الدخول',
  customerLookupDailyLimit: 'حد البحث اليومي عن العملاء',
  scheduleGenerateDaysBefore: 'توليد جدول الشهر قبل بدايته',
  scheduleBookingOpens: 'موعد فتح الحجز للرحلات الثابتة',
  scheduleOpenDaysBefore: 'فتح الحجز قبل الشهر بأيام',
  ...Object.fromEntries(INTEGRATION_FIELDS.map((field) => [field.key, field.label])),
};

const DETAIL_LABELS: Record<string, string> = { reason: 'السبب', amount: 'المبلغ', note: 'ملاحظة', name: 'الاسم', title: 'العنوان', tripCode: 'رمز الرحلة', rows: 'عدد السجلات', by: 'البحث بـ' };
const MAX_SUMMARY_VALUE = 80;

/** A short line of what the row changed, drawn only from details safe to read. */
export function summarizeAuditDetails(action: string, details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const key = withoutPrefix(action);
  if (key === 'PUT /settings' || key === 'PUT /settings/integrations') {
    const fields = key === 'PUT /settings' ? Object.keys(details) : ((details as { changed?: string[] }).changed ?? []);
    const names = fields.map((field) => SETTING_LABELS[field]).filter(Boolean);
    return names.length ? names.join('، ') : null;
  }
  const parts = Object.entries(DETAIL_LABELS).flatMap(([field, label]) => {
    const value = (details as Record<string, unknown>)[field];
    if (typeof value !== 'string' && typeof value !== 'number') return [];
    const text = String(value).trim();
    if (!text) return [];
    return [`${label}: ${text.length > MAX_SUMMARY_VALUE ? `${text.slice(0, MAX_SUMMARY_VALUE)}…` : text}`];
  });
  return parts.length ? parts.join(' · ') : null;
}

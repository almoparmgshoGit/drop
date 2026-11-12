import { Role } from '@prisma/client';

const NOTIFICATIONS_GROUP_TITLE = 'الإشعارات';

/** Everything a rank can be granted; the panel draws its checkboxes from this list. */
export const PERMISSION_GROUPS = [
  {
    title: 'لوحة المعلومات',
    items: [{ key: 'dashboard.view', label: 'عرض لوحة المعلومات والإحصائيات' }],
  },
  {
    title: 'الرحلات',
    items: [
      { key: 'trips.view', label: 'عرض الرحلات' },
      { key: 'trips.manage', label: 'إضافة وتعديل ونشر وإلغاء الرحلات' },
    ],
  },
  {
    title: 'الحجوزات',
    items: [
      { key: 'bookings.view', label: 'البحث عن حجوزات فرعه وفتحها' },
      { key: 'bookings.list', label: 'عرض جدول الحجوزات وتصفحه وتصفيته (بدونها يصل للحجز بالبحث الدقيق فقط)' },
      { key: 'bookings.all_branches', label: 'عرض حجوزات كل الفروع وحجوزات التطبيق' },
      { key: 'bookings.create', label: 'تسجيل الحجوزات والباقات من الفرع' },
      { key: 'bookings.price_override', label: 'تعديل سعر الحجز عند تسجيله' },
      { key: 'bookings.edit', label: 'تعديل الركاب والمقاعد ونقاط الصعود والملاحظات' },
      { key: 'bookings.unboard', label: 'إلغاء تسجيل صعود راكب' },
      { key: 'bookings.cancel', label: 'إلغاء الحجز إداريًا' },
      { key: 'bookings.export', label: 'تصدير الحجوزات' },
      { key: 'cancellations.review', label: 'رفض طلبات الإلغاء' },
      { key: 'cancellations.approve', label: 'قبول طلبات الإلغاء والاسترداد' },
    ],
  },
  {
    title: 'الكشوفات',
    items: [
      { key: 'manifests.view', label: 'عرض كشوفات الرحلات' },
      { key: 'manifests.inventory', label: 'عرض جرد الرحلة' },
    ],
  },
  {
    title: 'بلاغات الرحلات',
    items: [
      { key: 'reports.view', label: 'عرض بلاغات طاقم الرحلات وتفاصيلها ومرفقاتها' },
      { key: 'reports.manage', label: 'تغيير حالة البلاغات والرد على الطاقم' },
    ],
  },
  {
    title: 'شكاوى العملاء',
    items: [
      { key: 'complaints.view', label: 'عرض شكاوى العملاء من التطبيق وشكاوى الفنادق' },
      { key: 'complaints.manage', label: 'الرد على شكاوى العملاء والفنادق وإغلاقها وإعادة فتحها' },
    ],
  },
  {
    title: 'الفنادق والسكن',
    items: [
      { key: 'hotels.view', label: 'عرض الفنادق والتسكين والشكاوى' },
      { key: 'hotels.book', label: 'حجز الغرف وتسكين الركاب وتسجيل الشكاوى' },
      { key: 'hotels.rates', label: 'عرض أسعار التعاقد والتكاليف' },
      { key: 'hotels.manage', label: 'إضافة الفنادق وتعديلها وإلغاء حجوزاتها وإغلاق الشكاوى وإخراج الغرف من الخدمة' },
    ],
  },
  {
    title: 'الحافلات والباقات',
    items: [
      { key: 'buses.view', label: 'عرض الباصات والسائقين' },
      { key: 'buses.manage', label: 'إدارة الباصات والسائقين' },
      { key: 'buses.rates', label: 'عرض أسعار الإيجار وكشوف حساب مكاتب الباصات' },
      { key: 'buses.accounts', label: 'إدارة عقود المكاتب ومصاريف الرحلات وسداد المستحقات' },
      { key: 'packages.view', label: 'عرض الباقات' },
      { key: 'packages.manage', label: 'إدارة الباقات والخدمات' },
    ],
  },
  {
    title: 'الصندوق والعهد',
    items: [
      { key: 'cash.view', label: 'عرض الصندوق اليومي وسجل العهد' },
      { key: 'cash.operate', label: 'فتح الصندوق اليومي وإقفاله' },
      { key: 'custody.issue', label: 'صرف العهد من الصندوق' },
      { key: 'custody.settle', label: 'تسوية العهد بالفواتير والمرتجع' },
      { key: 'collections.view', label: 'عرض الحجوزات التي عليها متبقٍ وأرقام التحصيل' },
      { key: 'collections.collect', label: 'تسجيل دفعات التحصيل على الحجوزات' },
      { key: 'cash.all_branches', label: 'الوصول إلى صناديق وتحصيلات وفواتير كل الفروع واستلام تنبيهات فروقات الصندوق' },
    ],
  },
  {
    title: 'الفروع',
    items: [
      { key: 'branches.view', label: 'عرض بيانات فرعه وموظفيه وأدائه' },
      { key: 'branches.all', label: 'عرض كل الفروع وأدائها' },
      { key: 'branches.staff', label: 'إدارة موظفي فرعه ورتبهم وصلاحياتهم' },
      { key: 'branches.manage', label: 'إضافة الفروع وتعديلها وإيقافها وتعيين مدرائها' },
    ],
  },
  {
    title: 'المدفوعات والاسترداد',
    items: [
      { key: 'payments.view', label: 'عرض المدفوعات الإلكترونية وتصديرها' },
      { key: 'refunds.execute', label: 'تأكيد تنفيذ الاستردادات إلى وسيلة الدفع الأصلية أو تحويلها إلى المحفظة' },
      { key: 'refunds.override_policy', label: 'استرداد مبلغ أعلى مما تحدده سياسة الإلغاء' },
      { key: 'bookings.compensate', label: 'تعويض العملاء عن التذاكر الموقوفة' },
    ],
  },
  {
    title: 'التقارير',
    items: [{ key: 'analytics.view', label: 'عرض التقارير المالية والتشغيلية وإحصائيات التطبيق' }],
  },
  {
    title: 'الفواتير وحساب الرحلات',
    items: [
      { key: 'invoices.view', label: 'عرض سجل الفواتير وطباعتها' },
      { key: 'tax.view', label: 'عرض التقرير الضريبي للشركة كلها وتصديره' },
      { key: 'trip_accounts.view', label: 'عرض حساب الرحلات وإيراداتها وتكاليفها' },
      { key: 'trip_accounts.manage', label: 'تسجيل مصاريف الرحلات وإلغاؤها وإدارة بنودها' },
    ],
  },
  {
    title: 'العملاء والمحفظة',
    items: [
      { key: 'customers.view', label: 'البحث عن العملاء وفتح ملفاتهم' },
      { key: 'customers.list', label: 'عرض جدول العملاء وتصفحه وأرصدة المحافظ (بدونها يصل للعميل بالبحث الدقيق فقط)' },
      { key: 'customers.manage', label: 'تعديل بيانات العملاء وحذفهم' },
      { key: 'wallet.adjust', label: 'تعديل أرصدة المحافظ ضمن الحد اليومي' },
      { key: 'wallet.adjust_unlimited', label: 'تعديل أرصدة المحافظ فوق الحد اليومي' },
      { key: 'wallet.adjust_self', label: 'تعديل رصيد محفظته الشخصية' },
      { key: 'customers.block', label: 'حظر العملاء ورفع الحظر عنهم' },
    ],
  },
  {
    title: 'المحادثات',
    items: [
      { key: 'chat.view', label: 'عرض محادثات العملاء ومن يستخدم التطبيق الآن' },
      { key: 'chat.reply', label: 'الرد على العملاء وبدء المحادثات وإغلاقها' },
    ],
  },
  {
    title: 'الولاء والعروض',
    items: [
      { key: 'loyalty.view', label: 'عرض برنامج الولاء ونقاط العملاء' },
      { key: 'loyalty.manage', label: 'إدارة برنامج الولاء وقواعده وقسائمه' },
      { key: 'loyalty.adjust', label: 'تعديل نقاط العملاء يدويًا ضمن الحد اليومي' },
      { key: 'loyalty.adjust_unlimited', label: 'تعديل نقاط العملاء فوق الحد اليومي' },
      { key: 'loyalty.adjust_self', label: 'تعديل نقاطه الشخصية' },
      { key: 'coupons.manage', label: 'إدارة الكوبونات' },
      { key: 'offers.manage', label: 'إدارة العروض الترويجية التي تظهر عند فتح التطبيق' },
    ],
  },
  {
    title: 'الموظفون والنظام',
    items: [
      { key: 'employees.view', label: 'عرض الموظفين والوظائف والرتب' },
      { key: 'employees.manage', label: 'إدارة الموظفين والوظائف والرتب' },
      { key: 'employees.discipline', label: 'البت في طلبات تخلي الطاقم عن الرحلات وتسجيل الجزاءات على الموظفين' },
      { key: 'settings.manage', label: 'تعديل إعدادات النظام' },
      { key: 'integrations.manage', label: 'إدارة مفاتيح الخدمات الخارجية والتكاملات' },
      { key: 'audit.view', label: 'عرض سجل العمليات' },
    ],
  },
  {
    title: 'الموارد البشرية',
    items: [
      { key: 'hr.view', label: 'عرض الملفات الوظيفية للموظفين وإجازاتهم وسلفهم' },
      { key: 'hr.salaries', label: 'عرض الرواتب والبدلات والآيبان ومسيّرات الرواتب وقسائمها' },
      { key: 'hr.manage', label: 'تعديل الملف الوظيفي والعقد والراتب وإيقاف الموظف عن العمل' },
      { key: 'hr.all_branches', label: 'التعامل مع موظفي كل الفروع (بدونها موظفو فرعه فقط)' },
      { key: 'leaves.approve', label: 'البت في طلبات الإجازات وتسجيلها نيابة عن الموظف وقطعها' },
      { key: 'leaves.manage', label: 'إدارة أنواع الإجازات وتعديل الأرصدة يدويًا' },
      { key: 'advances.approve', label: 'البت في طلبات السلف وصرفها وتأجيل أقساطها واستلام سدادها' },
      { key: 'deductions.manage', label: 'تسجيل الخصومات والإضافات على الرواتب وإلغاؤها' },
      { key: 'payroll.prepare', label: 'إعداد مسيّر الرواتب وحسابه' },
      { key: 'payroll.approve', label: 'اعتماد مسيّر الرواتب ومخالصات نهاية الخدمة' },
      { key: 'payroll.pay', label: 'تسجيل صرف الرواتب والمخالصات وتصدير ملف البنك' },
      { key: 'settlements.manage', label: 'إعداد مخالصة نهاية الخدمة' },
    ],
  },
  {
    title: NOTIFICATIONS_GROUP_TITLE,
    items: [
      { key: 'notifications.manage', label: 'تعديل نصوص الإشعارات وتفعيلها' },
      { key: 'notifications.send', label: 'إرسال إشعارات لموظفي الأقسام التي يملك صلاحية فيها' },
      { key: 'notifications.log', label: 'عرض سجل إرسال واتساب وحالة التسليم' },
      { key: 'notifications.campaigns', label: 'إرسال الرسائل والعروض لمجموعات العملاء' },
      { key: 'notifications.campaigns_unlimited', label: 'إرسال حملة لعدد عملاء فوق الحد المحدد في الإعدادات' },
      { key: 'notifications.stations', label: 'عرض مسار الرحلات وإرسال تنبيهات المحطات يدويًا' },
    ],
  },
  {
    title: 'طاقم الرحلة (التطبيق)',
    items: [
      { key: 'crew.trips', label: 'عرض الرحلات المسندة إليه' },
      { key: 'crew.manifest', label: 'عرض كشف ركاب رحلاته' },
      { key: 'crew.board', label: 'مسح التذاكر وتسجيل الصعود' },
      { key: 'crew.track', label: 'بث موقع الحافلة' },
      { key: 'crew.status', label: 'تحديث حالة الرحلة وتحديد النقطة التي وصلت إليها الحافلة' },
      { key: 'crew.notify', label: 'إرسال إشعار لمسافري رحلاته' },
      { key: 'crew.custody', label: 'عرض عهده وتسجيل مصروفاتها وفواتيرها من التطبيق' },
      { key: 'crew.housing', label: 'تسكين مسافري رحلاته في الغرف من التطبيق' },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]['items'][number]['key'];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((group) => group.items.map((item) => item.key)) as Permission[];

/** Holding the right to send must not itself make someone a member of a section, so the notifications group is not one. */
export const NOTIFICATION_SECTIONS = PERMISSION_GROUPS.filter((group) => group.title !== NOTIFICATIONS_GROUP_TITLE).map((group) => ({
  title: group.title as string,
  permissions: group.items.map((item) => item.key as string),
}));

/**
 * Admins hold everything, so a new permission can never lock the owner out. Anyone else holds their rank's
 * permissions, adjusted by what was added or removed for them personally; a staff account without a rank holds only what was added.
 */
export function permissionsOf(user: { role: Role | string; rank?: { permissions: string[] } | null; extraPermissions?: string[]; revokedPermissions?: string[] }): string[] {
  if (user.role === 'ADMIN') return ALL_PERMISSIONS;
  if (user.role === 'PASSENGER') return [];
  const revoked = new Set(user.revokedPermissions ?? []);
  return [...new Set([...(user.rank?.permissions ?? []), ...(user.extraPermissions ?? [])])].filter((permission) => !revoked.has(permission));
}

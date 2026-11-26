import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, Module, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/services/prisma.service';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { taxRecordsDeletable } from '../../common/utils/tax-records.util';

/**
 * «تصفير بيانات النظام»: wipes one system's data, or all of it, with everything that depends on it.
 *
 * Each group names its root tables. Whatever cannot exist without a deleted row (a required foreign key) is deleted with it,
 * however deep; a row that only points at it optionally keeps living with that link emptied. The foreign keys are read
 * from the database when the reset runs, so a table added later is covered without touching this file.
 *
 * Never deleted: settings, staff accounts, ranks and jobs, and the templates and categories the system is configured with.
 */

type Root = { table: string; where?: string };
type Group = { key: string; title: string; description: string; roots: Root[]; include?: string[]; after?: string[] };

const RESET_SEATS = [
  `UPDATE "Seat" SET "isBooked" = false, "heldByUserId" = NULL, "heldUntil" = NULL WHERE "isBooked" OR "heldByUserId" IS NOT NULL`,
  `UPDATE "Trip" t SET "availableSeats" = COALESCE((SELECT NULLIF(count(*), 0) FROM "Seat" s WHERE s."tripId" = t."id"), t."totalSeats")`,
  `UPDATE "Coupon" SET "usedCount" = 0`,
];

export const RESET_GROUPS: Group[] = [
  {
    key: 'bookings',
    title: 'الحجوزات والتذاكر والمدفوعات',
    description: 'كل الحجوزات وركابها وتذاكرها ومدفوعاتها وتحصيلاتها وفواتيرها وإشعاراتها الدائنة وتعويضاتها وتقييماتها وقوائم الانتظار. تُفرَّغ مقاعد الرحلات ويبدأ ترقيم الحجوزات من جديد.',
    roots: [
      { table: 'Booking' },
      { table: 'BookingNumberCounter' },
      { table: 'ZatcaDocument' },
      { table: 'WaitlistEntry' },
      { table: 'StayBooking' },
      { table: 'CashMovement', where: `"bookingId" IS NOT NULL` },
    ],
    after: RESET_SEATS,
  },
  {
    key: 'trips',
    title: 'الرحلات',
    description: 'كل الرحلات بمقاعدها ونقاط صعودها وطاقمها وتتبعها وبلاغاتها وحساباتها وحجوزات فنادقها، ومعها كل الحجوزات والمدفوعات والفواتير.',
    roots: [{ table: 'Trip' }, { table: 'TripReminderLog' }, { table: 'OfflineBoardingSync' }],
    include: ['bookings'],
  },
  {
    key: 'packages',
    title: 'الباقات',
    description: 'كل الباقات وصورها وخدماتها. الرحلات والحجوزات المرتبطة بها تبقى بلا باقة.',
    roots: [{ table: 'Package' }],
  },
  {
    key: 'hotels',
    title: 'الفنادق والسكن',
    description: 'كل الفنادق وصورها وحجوزات غرفها والتسكين وكشوف السكن وشكاوى الفنادق والغرف المغلقة.',
    roots: [{ table: 'Hotel' }, { table: 'TripHousingSheet' }],
  },
  {
    key: 'fleet',
    title: 'الحافلات ومكاتب النقل',
    description: 'كل الحافلات وصورها وأجهزة التتبع وسجلات الصيانة، ومكاتب الباصات بعقودها ومدفوعاتها. الرحلات تبقى بلا حافلة.',
    roots: [{ table: 'Bus' }, { table: 'BusOffice' }],
  },
  {
    key: 'finance',
    title: 'الصندوق والعهد والمصروفات والتصفيات',
    description: 'جلسات الصندوق وحركاتها والعهد ومصروفاتها وحسابات الرحلات والمصروفات العامة والثابتة والتصفيات الشهرية والتوريدات.',
    roots: [
      { table: 'CashSession' },
      { table: 'CashMovement' },
      { table: 'Custody' },
      { table: 'TripAccountEntry' },
      { table: 'GeneralExpense' },
      { table: 'FixedExpense' },
      { table: 'FixedExpenseAttachment' },
      { table: 'AccountClosing' },
      { table: 'MonthSettlementApproval' },
      { table: 'CashRemittance' },
    ],
  },
  {
    key: 'branches',
    title: 'الفروع',
    description: 'كل الفروع ومعها كل بيانات الصندوق والعهد والمصروفات والتصفيات. الموظفون والحجوزات يبقون بلا فرع.',
    roots: [{ table: 'Branch' }],
    include: ['finance'],
  },
  {
    key: 'loyalty',
    title: 'الولاء والمحافظ والكوبونات',
    description: 'كل حركات المحافظ والنقاط وقواعد الولاء والقسائم ومشترياتها والكوبونات. تُصفَّر أرصدة المحافظ والنقاط لكل العملاء.',
    roots: [{ table: 'WalletTransaction' }, { table: 'LoyaltyTransaction' }, { table: 'LoyaltyRule' }, { table: 'LoyaltyVoucher' }, { table: 'Coupon' }],
    after: [`UPDATE "User" SET "walletBalance" = 0, "walletTransportBalance" = 0, "loyaltyPoints" = 0, "loyaltyActivityAt" = NULL`],
  },
  {
    key: 'complaints',
    title: 'الشكاوى والبلاغات',
    description: 'شكاوى العملاء ورسائلها ومرفقاتها، وشكاوى الفنادق، وبلاغات طاقم الرحلات بتحديثاتها ومرفقاتها.',
    roots: [{ table: 'CustomerComplaint' }, { table: 'HotelComplaint' }, { table: 'TripReport' }],
  },
  {
    key: 'hr',
    title: 'الموارد البشرية',
    description: 'الملفات الوظيفية والرواتب والإجازات والسلف والخصومات ومسيّرات الرواتب والمخالصات والوثائق والجزاءات وطلبات التخلي. حسابات الموظفين نفسها تبقى.',
    roots: [
      { table: 'EmployeeProfile' },
      { table: 'LeaveRequest' },
      { table: 'LeaveAdjustment' },
      { table: 'SalaryAdvance' },
      { table: 'PayrollAdjustment' },
      { table: 'PayrollRun' },
      { table: 'FinalSettlement' },
      { table: 'EmployeeDocument' },
      { table: 'StaffPenalty' },
      { table: 'CrewReleaseRequest' },
    ],
  },
  {
    key: 'messaging',
    title: 'الإشعارات والمحادثات والحملات',
    description: 'إشعارات المستخدمين وسجل رسائل واتساب والحملات والعروض الترويجية ومحادثات الدعم ومحادثات الرحلات وتنبيهات المحطات والطاقم.',
    roots: [
      { table: 'Notification' },
      { table: 'MessageDelivery' },
      { table: 'Campaign' },
      { table: 'PromoOffer' },
      { table: 'Conversation' },
      { table: 'TripChatThread' },
      { table: 'StationAlert' },
      { table: 'TripCrewAlert' },
    ],
  },
  {
    key: 'logs',
    title: 'السجلات',
    description: 'سجل العمليات وأحداث التطبيق وسجل تتبع الرحلات وتحديثات حالتها وسجل إسناد الطاقم والتذكيرات ومزامنة الصعود.',
    roots: [
      { table: 'AuditLog' },
      { table: 'AppEvent' },
      { table: 'TripLocation' },
      { table: 'TripStatusUpdate' },
      { table: 'CrewAssignmentLog' },
      { table: 'TripReminderLog' },
      { table: 'OfflineBoardingSync' },
    ],
  },
  {
    key: 'services',
    title: 'الخدمات والصور العامة',
    description: 'قائمة الخدمات (تُزال من الرحلات والباقات والفنادق والحافلات) والصور العامة المرفوعة.',
    roots: [{ table: 'Service' }, { table: 'PublicImage' }],
  },
  {
    key: 'customers',
    title: 'حسابات العملاء',
    description: 'كل حسابات الركاب ومحافظهم ونقاطهم وصورهم وأجهزتهم ومحادثاتهم، ومعها كل الحجوزات. حسابات الموظفين والسائقين تبقى.',
    roots: [{ table: 'User', where: `"role" = 'PASSENGER'` }],
    include: ['bookings'],
  },
];

export const ALL_GROUPS_KEY = 'all';
const GROUP_KEYS = RESET_GROUPS.map((group) => group.key);
export const CONFIRMATION_WORD = 'تصفير';

/** Issued tax documents (and their signed ZATCA copies), kept forever once the system is live. */
const TAX_RECORD_TABLES = new Set(['Invoice', 'CreditNote', 'ZatcaDocument']);

/** Deleting these would break the system itself, so a reset refuses to reach them. User rows go only through a root that filters them. */
const PROTECTED_TABLES = new Set(['_prisma_migrations', 'Setting', 'User', 'Rank', 'JobType', 'LeaveType', 'AccountCategory', 'NotificationTemplate', 'WhatsAppTemplate', 'StationAlertRule']);

const TABLE_LABELS: Record<string, string> = {
  Booking: 'الحجوزات', BookingPassenger: 'ركاب الحجوزات', Ticket: 'التذاكر', Payment: 'المدفوعات', PaymentTransaction: 'عمليات الدفع',
  BookingEvent: 'سجل الحجوزات', BookingCollection: 'التحصيلات', BookingNumberCounter: 'عداد أرقام الحجوزات', Invoice: 'الفواتير',
  CreditNote: 'الإشعارات الدائنة', ZatcaDocument: 'مستندات الفوترة الإلكترونية', TicketCompensation: 'التعويضات', TripRating: 'تقييمات الرحلات',
  WaitlistEntry: 'قوائم الانتظار', Trip: 'الرحلات', TripImage: 'صور الرحلات', TripService: 'خدمات الرحلات', Seat: 'المقاعد',
  BoardingPoint: 'نقاط الصعود', ItineraryStop: 'محطات المسار', TripDriver: 'سائقو الرحلات', TripSupervisor: 'مشرفو الرحلات',
  TripVisit: 'المزارات', Accommodation: 'السكن', TripBusCost: 'تكاليف الحافلات', TripLocation: 'سجل التتبع', TripStatusUpdate: 'تحديثات الحالة',
  TripCrewAlert: 'تنبيهات الطاقم', TripReport: 'بلاغات الرحلات', TripReportUpdate: 'تحديثات البلاغات', TripReportAttachment: 'مرفقات البلاغات',
  TripHousingSheet: 'كشوف السكن', TripStationRule: 'قواعد المحطات', StationAlert: 'تنبيهات المحطات', CrewAssignmentLog: 'سجل إسناد الطاقم',
  CrewReleaseRequest: 'طلبات تخلي الطاقم', TripChatThread: 'محادثات الرحلات', TripChatMessage: 'رسائل محادثات الرحلات', TripReminderLog: 'سجل التذكيرات',
  OfflineBoardingSync: 'مزامنة الصعود', Package: 'الباقات', PackageImage: 'صور الباقات', PackageService: 'خدمات الباقات', Hotel: 'الفنادق',
  HotelImage: 'صور الفنادق', HotelService: 'خدمات الفنادق', HotelBooking: 'حجوزات الفنادق', HotelRoom: 'الغرف', HotelComplaint: 'شكاوى الفنادق',
  HotelRoomBlock: 'الغرف المغلقة', StayBooking: 'حجوزات السكن فقط', HotelRating: 'تقييمات الفنادق', Bus: 'الحافلات', BusImage: 'صور الحافلات', BusService: 'خدمات الحافلات', BusGpsDevice: 'أجهزة التتبع',
  BusMaintenanceLog: 'سجلات الصيانة', BusOffice: 'مكاتب الباصات', BusOfficeRate: 'عقود المكاتب', BusOfficePayment: 'مدفوعات المكاتب',
  CashSession: 'جلسات الصندوق', CashMovement: 'حركات الصندوق', Custody: 'العهد', CustodyExpense: 'مصروفات العهد', CustodyAttachment: 'مرفقات العهد',
  TripAccountEntry: 'قيود حسابات الرحلات', TripAccountAttachment: 'مرفقات حسابات الرحلات', GeneralExpense: 'المصروفات العامة',
  GeneralExpenseAttachment: 'مرفقات المصروفات', FixedExpense: 'المصروفات الثابتة', FixedExpensePosting: 'قيود المصروفات الثابتة',
  FixedExpensePayment: 'سداد المصروفات الثابتة', FixedExpenseAttachment: 'مرفقات المصروفات الثابتة', AccountClosing: 'التصفيات',
  MonthSettlementApproval: 'اعتمادات التصفية الشهرية', CashRemittance: 'التوريدات', RemittedSession: 'جلسات التوريد', CashRemittanceAttachment: 'مرفقات التوريدات',
  Branch: 'الفروع', WalletTransaction: 'حركات المحافظ', LoyaltyTransaction: 'حركات النقاط', LoyaltyRule: 'قواعد الولاء', LoyaltyVoucher: 'القسائم',
  VoucherPurchase: 'مشتريات القسائم', VoucherCard: 'بطاقات القسائم', Coupon: 'الكوبونات', CustomerComplaint: 'شكاوى العملاء',
  ComplaintMessage: 'رسائل الشكاوى', ComplaintAttachment: 'مرفقات الشكاوى', EmployeeProfile: 'الملفات الوظيفية', SalaryStructure: 'هياكل الرواتب',
  LeaveRequest: 'طلبات الإجازات', LeaveAttachment: 'مرفقات الإجازات', LeaveAdjustment: 'تعديلات الأرصدة', SalaryAdvance: 'السلف',
  AdvanceRepayment: 'سداد السلف', PayrollAdjustment: 'الخصومات والإضافات', PayrollRun: 'مسيّرات الرواتب', PayrollLine: 'بنود المسيّرات',
  PayrollLineItem: 'تفاصيل بنود المسيّرات', FinalSettlement: 'المخالصات', EmployeeDocument: 'وثائق الموظفين', StaffPenalty: 'الجزاءات',
  Notification: 'الإشعارات', MessageDelivery: 'سجل الرسائل', Campaign: 'الحملات', PromoOffer: 'العروض الترويجية', Conversation: 'محادثات الدعم',
  ChatMessage: 'رسائل الدعم', AuditLog: 'سجل العمليات', AppEvent: 'أحداث التطبيق', Service: 'الخدمات', PublicImage: 'الصور العامة',
  User: 'حسابات العملاء', RefreshToken: 'جلسات الدخول', UserPhoto: 'صور العملاء', PushToken: 'أجهزة الإشعارات', AppPresence: 'حالة الاتصال',
  UserTablePreference: 'تفضيلات الجداول', DriverProfile: 'ملفات السائقين',
};

type ForeignKey = { child: string; column: string; required: boolean; parent: string; ref: string; onDelete: string };
type Plan = { order: string[]; where: Map<string, string>; unlink: string[]; after: string[] };

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

class ResetDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GROUP_KEYS.length + 1)
  @IsIn([ALL_GROUPS_KEY, ...GROUP_KEYS], { each: true, message: 'اختر نظامًا صحيحًا لتصفيره' })
  groups: string[];
}

class ConfirmResetDto extends ResetDto {
  @IsString()
  @MaxLength(50)
  confirmation: string;

  @IsString()
  @MaxLength(200)
  password: string;
}

@Injectable()
export class SystemResetService {
  private logger = new Logger('SystemReset');

  constructor(private prisma: PrismaService) {}

  list() {
    return {
      confirmationWord: CONFIRMATION_WORD,
      groups: RESET_GROUPS.map(({ key, title, description, include }) => ({
        key,
        title,
        description,
        includes: (include ?? []).map((other) => RESET_GROUPS.find((group) => group.key === other)!.title),
      })),
      kept: 'إعدادات النظام · حسابات الموظفين والسائقين · الرتب والوظائف · أنواع الإجازات · تصنيفات الحسابات · قوالب الإشعارات وواتساب · قواعد تنبيه المحطات',
    };
  }

  /** The chosen groups with the groups they pull in. */
  private resolveGroups(keys: string[]): Group[] {
    const chosen = new Set<string>();
    const visit = (key: string) => {
      if (chosen.has(key)) return;
      chosen.add(key);
      RESET_GROUPS.find((group) => group.key === key)?.include?.forEach(visit);
    };
    (keys.includes(ALL_GROUPS_KEY) ? GROUP_KEYS : keys).forEach(visit);
    return RESET_GROUPS.filter((group) => chosen.has(group.key));
  }

  private async foreignKeys(): Promise<ForeignKey[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ child: string; column: string; required: boolean; parent: string; ref: string; ondelete: string; columns: number }[]>(`
      SELECT ch.relname AS child, a.attname AS column, a.attnotnull AS required, pa_rel.relname AS parent, pa.attname AS ref,
             c.confdeltype::text AS ondelete, array_length(c.conkey, 1) AS columns
      FROM pg_constraint c
      JOIN pg_class ch ON ch.oid = c.conrelid
      JOIN pg_class pa_rel ON pa_rel.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const composite = rows.find((row) => Number(row.columns) > 1);
    if (composite) throw new BadRequestException(`لا يمكن التصفير: ارتباط مركّب في جدول ${composite.child}`);
    return rows.map((row) => ({ child: row.child, column: row.column, required: row.required, parent: row.parent, ref: row.ref, onDelete: row.ondelete }));
  }

  /**
   * Which rows of which tables go, as one condition per table, and in what order: a table is emptied before the tables
   * it points at. Optional links into deleted rows are emptied first, except on rows that are themselves going.
   */
  private plan(groups: Group[], allKeys: ForeignKey[]): Plan {
    // A link the database itself cascades goes with its parent, as the database would do it.
    const keys = allKeys.map((key) => ({ ...key, required: key.required || key.onDelete === 'c' }));
    const roots = new Map<string, string[]>();
    for (const root of groups.flatMap((group) => group.roots)) roots.set(root.table, [...(roots.get(root.table) ?? []), root.where ?? 'TRUE']);

    // Everything that cannot exist without a deleted row.
    const tables = new Set(roots.keys());
    for (let grew = true; grew; ) {
      grew = false;
      for (const key of keys) {
        if (key.required && tables.has(key.parent) && !tables.has(key.child)) {
          if (PROTECTED_TABLES.has(key.child)) throw new BadRequestException(`لا يمكن التصفير: جدول ${key.child} محمي ويعتمد على ${key.parent}`);
          tables.add(key.child);
          grew = true;
        }
      }
    }
    for (const table of tables) if (PROTECTED_TABLES.has(table) && !roots.get(table)?.every((where) => where !== 'TRUE')) throw new BadRequestException(`لا يمكن حذف جدول ${table} كاملًا`);

    // Parents first, so each child's condition can name its parents' rows.
    const between = keys.filter((key) => tables.has(key.parent) && tables.has(key.child) && key.parent !== key.child);
    const parentsFirst: string[] = [];
    const placed = new Set<string>();
    const pending = new Set(tables);
    while (pending.size) {
      const ready = [...pending].filter((table) => between.every((key) => key.child !== table || placed.has(key.parent)));
      // Optional links order the deletes too; when they loop, the loop is broken by emptying those links first (below).
      // A loop: free one table, the one waiting on the fewest optional links and holding up the most, so the rest keep their order.
      const waitingOn = (table: string) => between.filter((key) => key.child === table && !placed.has(key.parent)).length;
      const blocking = (table: string) => between.filter((key) => key.parent === table && pending.has(key.child)).length;
      const next = ready.length
        ? ready
        : [...pending]
            .filter((table) => between.every((key) => key.child !== table || placed.has(key.parent) || !key.required))
            .sort((a, b) => waitingOn(a) - waitingOn(b) || blocking(b) - blocking(a))
            .slice(0, 1);
      if (!next.length) throw new BadRequestException(`لا يمكن التصفير: ارتباط دائري بين ${[...pending].join('، ')}`);
      for (const table of next) {
        pending.delete(table);
        placed.add(table);
        parentsFirst.push(table);
      }
    }

    const where = new Map<string, string>();
    for (const table of parentsFirst) {
      const conditions = [...(roots.get(table) ?? [])];
      for (const key of between) {
        if (key.child !== table || !key.required) continue;
        const parentWhere = where.get(key.parent)!;
        conditions.push(parentWhere === 'TRUE' ? 'TRUE' : `${quote(key.column)} IN (SELECT ${quote(key.ref)} FROM ${quote(key.parent)} WHERE ${parentWhere})`);
      }
      where.set(table, conditions.includes('TRUE') ? 'TRUE' : conditions.map((condition) => `(${condition})`).join(' OR '));
    }

    const unlink: string[] = [];
    for (const key of keys) {
      if (key.required || !tables.has(key.parent)) continue;
      const childWhere = where.get(key.child);
      // A self-link with ON DELETE SET NULL or CASCADE sorts itself out inside one delete.
      if (key.child === key.parent && (key.onDelete === 'n' || key.onDelete === 'c') && childWhere === 'TRUE') continue;
      const deletedAfterParent = key.child !== key.parent && tables.has(key.child) && this.ordersBefore(parentsFirst, key);
      if (childWhere === 'TRUE' && key.child !== key.parent && !deletedAfterParent) continue;
      const parentWhere = where.get(key.parent)!;
      const pointsAtDeleted = parentWhere === 'TRUE' ? `${quote(key.column)} IS NOT NULL` : `${quote(key.column)} IN (SELECT ${quote(key.ref)} FROM ${quote(key.parent)} WHERE ${parentWhere})`;
      const keepsLiving = childWhere === undefined || key.child === key.parent || deletedAfterParent ? '' : ` AND NOT COALESCE((${childWhere}), false)`;
      unlink.push(`UPDATE ${quote(key.child)} SET ${quote(key.column)} = NULL WHERE ${pointsAtDeleted}${keepsLiving}`);
    }

    return { order: [...parentsFirst].reverse(), where, unlink, after: [...new Set(groups.flatMap((group) => group.after ?? []))] };
  }

  /** Whether the child of an optional link would be deleted after its parent, which the link would block. */
  private ordersBefore(parentsFirst: string[], key: ForeignKey) {
    return parentsFirst.indexOf(key.child) < parentsFirst.indexOf(key.parent);
  }

  private async counts(plan: Plan) {
    const rows = await Promise.all(
      plan.order.map(async (table) => {
        const [{ count }] = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT count(*) AS count FROM ${quote(table)} WHERE ${plan.where.get(table)}`);
        return { table, label: TABLE_LABELS[table] ?? table, count: Number(count) };
      }),
    );
    return rows.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
  }

  async preview(dto: ResetDto) {
    const groups = this.resolveGroups(dto.groups);
    const plan = this.plan(groups, await this.foreignKeys());
    const tables = await this.counts(plan);
    return {
      groups: groups.map((group) => group.title),
      tables,
      total: tables.reduce((sum, row) => sum + row.count, 0),
      // Shown before the password is asked for, so nobody types it for a reset that will be refused.
      blockedBy: await this.keptTaxRecords(plan, tables),
    };
  }

  /** On the live server, a reset that would reach issued invoices or credit notes is refused: they are never deleted. */
  private async keptTaxRecords(plan: Plan, counted?: { table: string }[]) {
    if (taxRecordsDeletable()) return null;
    const tables = counted ?? (await this.counts(plan));
    const touched = tables.filter((row) => TAX_RECORD_TABLES.has(row.table));
    return touched.length
      ? `لا يمكن التصفير: سيحذف ${touched.map((row) => TABLE_LABELS[row.table]).join(' و')}، والفواتير الضريبية وإشعارات الدائن لا تُحذف من النظام حفاظًا على الأثر المحاسبي. اختر أقسامًا لا تشملها.`
      : null;
  }

  async reset(actor: { userId: string }, dto: ConfirmResetDto, ip?: string) {
    if (dto.confirmation.trim() !== CONFIRMATION_WORD) throw new BadRequestException(`اكتب كلمة «${CONFIRMATION_WORD}» للتأكيد`);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { passwordHash: true } });
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, dto.password))) throw new ForbiddenException('كلمة المرور غير صحيحة');

    const groups = this.resolveGroups(dto.groups);
    const plan = this.plan(groups, await this.foreignKeys());
    const keptTaxRecords = await this.keptTaxRecords(plan);
    if (keptTaxRecords) throw new BadRequestException(keptTaxRecords);
    // The guards that keep financial records append-only (invoices, cash movements, closed sessions, approved payrolls…)
    // reject every delete, so they are switched off for this transaction only. ALTER TABLE is transactional: they come
    // back on at the end, and on any failure the rollback restores them along with every row.
    const guarded = (
      await this.prisma.$queryRawUnsafe<{ table: string }[]>(`
        SELECT DISTINCT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`)
    ).map((row) => row.table);

    let deleted: { table: string; label: string; count: number }[];
    try {
      deleted = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 0`);
          for (const table of guarded) await tx.$executeRawUnsafe(`ALTER TABLE ${quote(table)} DISABLE TRIGGER USER`);
          for (const statement of plan.unlink) await tx.$executeRawUnsafe(statement);
          const result: { table: string; label: string; count: number }[] = [];
          for (const table of plan.order) {
            const count = await tx.$executeRawUnsafe(`DELETE FROM ${quote(table)} WHERE ${plan.where.get(table)}`);
            if (count > 0) result.push({ table, label: TABLE_LABELS[table] ?? table, count });
          }
          for (const statement of plan.after) await tx.$executeRawUnsafe(statement);
          for (const table of guarded) await tx.$executeRawUnsafe(`ALTER TABLE ${quote(table)} ENABLE TRIGGER USER`);
          return result;
        },
        { maxWait: 10_000, timeout: 15 * 60_000 },
      );
    } catch (err: any) {
      this.logger.error(`System reset failed: ${err?.message}`, err?.stack);
      const reason = String(err?.meta?.message ?? err?.message ?? '').split('\n').filter(Boolean).pop()?.slice(0, 300);
      throw new BadRequestException(`تعذّر التصفير ولم يُحذف شيء${reason ? `: ${reason}` : ''}`);
    }

    const total = deleted.reduce((sum, row) => sum + row.count, 0);
    // Written by hand: the audit interceptor would copy the password from the request body.
    await this.prisma.auditLog.create({
      data: {
        userId: actor.userId,
        action: 'POST /system-reset',
        entity: 'System',
        ip,
        details: { groups: groups.map((group) => group.key), total, deleted: Object.fromEntries(deleted.map((row) => [row.table, row.count])) },
      },
    });
    return { groups: groups.map((group) => group.title), tables: deleted.sort((a, b) => b.count - a.count), total };
  }
}

@ApiTags('System reset')
@ApiBearerAuth()
@Controller('system-reset')
class SystemResetController {
  constructor(private service: SystemResetService) {}

  @Get()
  @RequirePermission('system.reset')
  @ApiOperation({ summary: 'The systems whose data can be wiped, and what is always kept' })
  list() {
    return this.service.list();
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('system.reset')
  @ApiOperation({ summary: 'How many rows of which tables a reset of these systems would delete; deletes nothing' })
  preview(@Body() dto: ResetDto) {
    return this.service.preview(dto);
  }

  @Post()
  @HttpCode(200)
  @SkipAudit()
  @RequirePermission('system.reset')
  @ApiOperation({ summary: 'Permanently delete the data of these systems and everything that depends on it; needs the admin password' })
  reset(@Req() req, @Body() dto: ConfirmResetDto) {
    return this.service.reset(req.user, dto, req.ip);
  }
}

@Module({
  controllers: [SystemResetController],
  providers: [SystemResetService],
})
export class SystemResetModule {}

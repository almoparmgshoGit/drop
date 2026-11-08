import { NotificationEvent } from './notification-catalog';

interface StationRule {
  label: string;
  /** The word on a stop's row in the panel. */
  short: string;
  help: string;
  defaultActive: boolean;
  /** How long before or after the moment; a rule without it fires at the moment. */
  defaultMinutes?: number;
  event: NotificationEvent;
  /** Which stops it speaks about. */
  on: 'POINT' | 'MIQAT' | 'DESTINATION';
}

export const STATION_RULES = {
  BEFORE_STOP: {
    label: 'قبل وصول الحافلة للمحطة',
    short: 'قبل الوصول',
    help: 'حسب موقع الحافلة. مع منصة حساب الطرق يُحسب الوقت، ودونها تُقدّر المسافة بسرعة 60 كم/س.',
    defaultActive: true,
    defaultMinutes: 10,
    event: 'STATION_APPROACHING',
    on: 'POINT',
  },
  AT_STOP: {
    label: 'عند وصول الحافلة للمحطة',
    short: 'عند الوصول',
    help: 'حين يحدد طاقم الرحلة أن الحافلة في المحطة، لمن لم يصعد من ركابها.',
    defaultActive: true,
    event: 'BUS_AT_YOUR_POINT',
    on: 'POINT',
  },
  LATE_BOARDING: {
    label: 'تذكير الركاب الذين لم يصعدوا بعد الوصول',
    short: 'تذكير المتأخرين',
    help: 'يُرسل ما دامت الحافلة واقفة في المحطة.',
    defaultActive: true,
    defaultMinutes: 3,
    event: 'STATION_LATE_REMINDER',
    on: 'POINT',
  },
  MIQAT: {
    label: 'تذكير الإحرام قبل الميقات',
    short: 'تذكير الإحرام',
    help: 'حسب موعد الميقات في جدول الرحلة، بعد انطلاق الحافلة.',
    defaultActive: true,
    defaultMinutes: 30,
    event: 'STATION_MIQAT_REMINDER',
    on: 'MIQAT',
  },
  DESTINATION: {
    label: 'عند الوصول للوجهة: رسالة ترحيب ورقم الفندق',
    short: 'رسالة الوصول',
    help: 'لمن له سكن في الحجز، حين يحدد الطاقم وصول الحافلة.',
    defaultActive: false,
    event: 'STATION_DESTINATION_WELCOME',
    on: 'DESTINATION',
  },
} satisfies Record<string, StationRule>;

export type StationRuleKey = keyof typeof STATION_RULES;

export const STATION_RULE_KEYS = Object.keys(STATION_RULES) as StationRuleKey[];

export const isStationRuleKey = (value: string): value is StationRuleKey => Object.prototype.hasOwnProperty.call(STATION_RULES, value);

/** What staff can send by hand from a stop's row. */
export const MANUAL_STATION_TYPES = {
  DELAY: { label: 'تأخير', event: 'STATION_DELAY' },
  ARRIVED: { label: 'وصلت الحافلة', event: 'STATION_ARRIVED' },
  APPROACHING: { label: 'الحافلة تقترب', event: 'STATION_APPROACHING' },
  LOCATION_CHANGE: { label: 'تغيير موقع المحطة', event: 'STATION_LOCATION_CHANGED' },
} satisfies Record<string, { label: string; event: NotificationEvent }>;

export type ManualStationType = keyof typeof MANUAL_STATION_TYPES;

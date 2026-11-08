import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from './prisma.service';

const ROW_PREFIX = 'integration.';
const CIPHER_VERSION = 'v1';
const HINT_LENGTH = 4;
const MAX_VALUE_LENGTH = 8000;

type IntegrationOption = {
  value: string;
  label: string;
  help: string;
  /** Fields that must hold a value before this option can be chosen. */
  requires: string[];
};

type IntegrationField = {
  key: string;
  group: string;
  label: string;
  /** A secret is stored encrypted and never sent back; other values are shown as they are. */
  secret: boolean;
  /** True once something in the system actually reads this value. */
  inUse?: boolean;
  pattern?: RegExp;
  patternMessage?: string;
  help?: string;
  /** Makes the field a choice between these values; the empty value means none. */
  options?: IntegrationOption[];
  /** Shown only while the group's choice field holds one of these values. */
  showFor?: string[];
};

const ROUTING_PROVIDER_KEY = 'routingProvider';
const DEFAULT_MAPBOX_STYLE = 'mapbox/streets-v12';
const MAPBOX_ATTRIBUTION = '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const MAP_OPTIONS: IntegrationOption[] = [
  { value: '', label: 'الخريطة الافتراضية أو رابط طبقات', help: 'بلا إعداد تعمل خريطة OpenStreetMap العامة، وهي لا تصلح لاستخدام تجاري كثيف. ولا يتوفر فيها البحث عن الأماكن.', requires: [] },
  { value: 'mapbox', label: 'Mapbox', help: 'خريطة التطبيق واللوحة والبحث عن الأماكن عند إنشاء الرحلة. أنشئ حسابًا في console.mapbox.com ثم انسخ الرمز العام من صفحة Tokens.', requires: ['mapboxPublicToken'] },
];

const ROUTING_OPTIONS: IntegrationOption[] = [
  { value: '', label: 'متوقف', help: 'يعرض التطبيق المسافة في خط مستقيم والموعد المجدول، دون وقت وصول متوقع.', requires: [] },
  { value: 'mapbox', label: 'Mapbox', help: 'يحسب الوقت مع الازدحام. أنشئ حسابًا في console.mapbox.com وأنشئ رمزًا منفصلًا لهذا الحقل دون تقييده بعنوان موقع، لأن الخادم هو من يستخدمه.', requires: ['mapboxAccessToken'] },
  { value: 'google_essentials', label: 'Google (Essentials)', help: 'يحسب الوقت دون الازدحام الحالي. فعّل Routes API في Google Cloud وأنشئ مفتاحًا لا يقتصر على تطبيق جوال، لأن الخادم هو من يستخدمه.', requires: ['googleMapsApiKey'] },
  { value: 'google_pro', label: 'Google (Pro)', help: 'يحسب الوقت مع الازدحام وتكلفته أعلى من Essentials. فعّل Routes API في Google Cloud وأنشئ مفتاحًا لا يقتصر على تطبيق جوال، لأن الخادم هو من يستخدمه.', requires: ['googleMapsApiKey'] },
];

export const INTEGRATION_GROUPS = [
  { id: 'maps', title: 'الخرائط والمواقع', description: 'خريطة التتبع في التطبيق وخريطة تحديد نقاط التجمع في اللوحة. يسري أي تغيير هنا فور الحفظ، ويظهر في التطبيق عند فتحه من جديد.' },
  { id: 'routing', title: 'حساب الطرق ووقت الوصول', description: 'يحسب الخادم وقت وصول الحافلة إلى محطة الراكب ويرسله إلى التطبيق، ولا يصل المفتاح إلى الأجهزة. يسري أي تغيير هنا فور الحفظ.' },
  { id: 'whatsapp', title: 'واتساب أعمال', description: 'إشعارات العملاء وقوالبها عبر WhatsApp Cloud API من Meta، وتُدار من صفحة الإشعارات. ورمز دخول العملاء يُرسل عبر قالب المصادقة أدناه، ودونه لا يعمل دخول العملاء في الإنتاج.' },
  { id: 'payments', title: 'بوابة الدفع', description: 'الدفع الإلكتروني من التطبيق.' },
  {
    id: 'push',
    title: 'الإشعارات الفورية',
    description: 'تصل الإشعارات إلى الجوال والتطبيق مغلق عبر خدمة Expo، وهي تمر على Firebase في أندرويد وعلى Apple في آيفون. تعمل دون أي إعداد هنا، أما ملف حساب خدمة Firebase وشهادة Apple فيُرفعان إلى EAS لا إلى هذه الصفحة.',
  },
] as const;

export const INTEGRATION_FIELDS: IntegrationField[] = [
  {
    key: 'mapProvider',
    group: 'maps',
    label: 'منصة الخريطة',
    secret: false,
    inUse: true,
    options: MAP_OPTIONS,
    pattern: /^mapbox$/,
    patternMessage: 'منصة غير معروفة',
  },
  // A map is drawn on each device, so this token reaches them all. That is what Mapbox's public tokens are for.
  {
    key: 'mapboxPublicToken',
    group: 'maps',
    label: 'الرمز العام (Public Token)',
    secret: false,
    inUse: true,
    showFor: ['mapbox'],
    pattern: /^pk\.\S+$/,
    patternMessage: 'الرمز العام يبدأ بـ pk. ولا تضع هنا رمزًا سريًا يبدأ بـ sk.',
    help: 'يصل إلى كل الأجهزة، لذلك قيّده من صفحة Tokens بعنوان اللوحة وبالعنوان https://com.durobalhejra.app الخاص بالتطبيق.',
  },
  {
    key: 'mapboxStyle',
    group: 'maps',
    label: 'نمط الخريطة (اختياري)',
    secret: false,
    inUse: true,
    showFor: ['mapbox'],
    pattern: /^(mapbox:\/\/styles\/)?[\w.-]+\/[\w-]+$/,
    patternMessage: 'الصق Style URL كما في Mapbox Studio، مثل mapbox://styles/mapbox/streets-v12',
    help: 'فارغ يعني mapbox/streets-v12. لنمط خاص الصق Style URL من Mapbox Studio.',
  },
  // Sent to every copy of the app, which is why it is not a secret even when the address carries a provider's key.
  {
    key: 'mapTilesUrl',
    group: 'maps',
    label: 'رابط طبقات الخريطة (اختياري)',
    secret: false,
    inUse: true,
    showFor: [''],
    pattern: /^https:\/\/[^\s"'<>]*\{z\}[^\s"'<>]*\{x\}[^\s"'<>]*\{y\}[^\s"'<>]*$/,
    patternMessage: 'رابط طبقات الخريطة يبدأ بـ https ويحوي {z} و{x} و{y}',
    help: 'يصل إلى كل نسخ التطبيق، فلا تضع فيه مفتاحًا سريًا. فارغ يعني الخادم الافتراضي للخرائط.',
  },
  {
    key: ROUTING_PROVIDER_KEY,
    group: 'routing',
    label: 'المنصة المستخدمة',
    secret: false,
    inUse: true,
    options: ROUTING_OPTIONS,
    pattern: new RegExp(`^(${ROUTING_OPTIONS.map((option) => option.value).filter(Boolean).join('|')})$`),
    patternMessage: 'منصة غير معروفة',
  },
  { key: 'mapboxAccessToken', group: 'routing', label: 'رمز Mapbox (Access Token)', secret: true, inUse: true, showFor: ['mapbox'], pattern: /^(pk|sk)\.\S+$/, patternMessage: 'رمز Mapbox يبدأ بـ pk. أو sk.' },
  // Keeps its original key, so a value saved before this group existed still works.
  { key: 'googleMapsApiKey', group: 'routing', label: 'مفتاح Google Maps', secret: true, inUse: true, showFor: ['google_essentials', 'google_pro'] },
  // Only Meta's own host: this address receives the access token, so a typo or a bad actor must not redirect it.
  {
    key: 'whatsappApiUrl',
    group: 'whatsapp',
    label: 'إصدار واجهة Meta (اختياري)',
    secret: false,
    inUse: true,
    pattern: /^https:\/\/graph\.facebook\.com\/v\d+\.\d+$/,
    patternMessage: 'الرابط بالشكل https://graph.facebook.com/v23.0',
    help: 'فارغ يعني https://graph.facebook.com/v23.0.',
  },
  { key: 'whatsappPhoneId', group: 'whatsapp', label: 'معرّف رقم الإرسال (Phone Number ID)', secret: false, inUse: true, pattern: /^\d{5,30}$/, patternMessage: 'المعرّف أرقام فقط' },
  { key: 'whatsappBusinessAccountId', group: 'whatsapp', label: 'معرّف حساب الأعمال (WABA ID)', secret: false, inUse: true, pattern: /^\d{5,30}$/, patternMessage: 'المعرّف أرقام فقط', help: 'لإرسال القوالب للاعتماد ومعرفة حالتها.' },
  { key: 'whatsappToken', group: 'whatsapp', label: 'رمز الوصول الدائم (System User Token)', secret: true, inUse: true },
  { key: 'whatsappAppSecret', group: 'whatsapp', label: 'App Secret', secret: true, inUse: true, help: 'يثبت أن تحديثات حالة الرسائل قادمة من Meta فعلًا. دونه تُرفض كلها.' },
  { key: 'whatsappWebhookVerifyToken', group: 'whatsapp', label: 'رمز التحقق من الـWebhook', secret: true, inUse: true, help: 'اختر نصًا طويلًا عشوائيًا والصقه نفسه في إعدادات Webhook عند Meta.' },
  {
    key: 'whatsappOtpTemplate',
    group: 'whatsapp',
    label: 'اسم قالب رمز الدخول (Authentication)',
    secret: false,
    inUse: true,
    pattern: /^[a-z0-9_]{1,512}$/,
    patternMessage: 'اسم القالب كما في Meta: أحرف إنجليزية صغيرة وأرقام وشرطة سفلية',
    help: 'أنشئه في WhatsApp Manager من فئة Authentication مع زر "نسخ الرمز" (Copy code)، وانتظر اعتماده ثم الصق اسمه هنا. فارغ يعني أن دخول العملاء متوقف في الإنتاج.',
  },
  {
    key: 'whatsappOtpLanguage',
    group: 'whatsapp',
    label: 'لغة قالب رمز الدخول (اختياري)',
    secret: false,
    inUse: true,
    pattern: /^[a-z]{2,3}(_[A-Z]{2})?$/,
    patternMessage: 'رمز اللغة كما في Meta، مثل ar أو en_US',
    help: 'فارغ يعني ar. يجب أن يطابق لغة القالب المعتمد.',
  },
  { key: 'paymentGatewayName', group: 'payments', label: 'اسم البوابة', secret: false },
  { key: 'paymentPublishableKey', group: 'payments', label: 'المفتاح العام', secret: false },
  { key: 'paymentSecretKey', group: 'payments', label: 'المفتاح السري', secret: true },
  { key: 'paymentWebhookSecret', group: 'payments', label: 'سر إشعارات البوابة (Webhook)', secret: true },
  {
    key: 'expoAccessToken',
    group: 'push',
    label: 'رمز وصول Expo (اختياري)',
    secret: true,
    inUse: true,
    help: 'مطلوب فقط إذا فعّلت "Enhanced security for push notifications" في مشروع Expo. أنشئه من expo.dev ثم Account settings ثم Access tokens.',
  },
];

const FIELDS_BY_KEY = new Map(INTEGRATION_FIELDS.map((field) => [field.key, field]));

@Injectable()
export class IntegrationsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  private cipherKey() {
    const secret = this.config.get<string>('SETTINGS_ENCRYPTION_KEY');
    return secret ? crypto.createHash('sha256').update(secret).digest() : null;
  }

  private encrypt(plain: string) {
    const key = this.cipherKey();
    if (!key) throw new ServiceUnavailableException('لا يمكن حفظ المفاتيح السرية: ضع SETTINGS_ENCRYPTION_KEY في ملف بيئة الخادم أولًا');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [CIPHER_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Null when the key is missing or was changed since this value was saved. */
  private decrypt(stored: string) {
    const key = this.cipherKey();
    const [version, iv, tag, data] = stored.split(':');
    if (!key || version !== CIPHER_VERSION || !iv || !tag || data === undefined) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** For the code that talks to a provider. Never return its result from an endpoint. */
  async value(key: string): Promise<string | null> {
    const field = FIELDS_BY_KEY.get(key);
    if (!field) return null;
    const row = await this.prisma.setting.findUnique({ where: { key: `${ROW_PREFIX}${key}` } });
    if (!row) return null;
    return field.secret ? this.decrypt(row.value) : row.value;
  }

  /** What any device needs to draw the map. Only public values belong here. Null tiles mean the device's default map. */
  async mapConfig() {
    const [provider, token, style, tilesUrl] = await Promise.all([this.value('mapProvider'), this.value('mapboxPublicToken'), this.value('mapboxStyle'), this.value('mapTilesUrl')]);
    if (provider === 'mapbox' && token) {
      const stylePath = (style ?? DEFAULT_MAPBOX_STYLE).replace('mapbox://styles/', '');
      return {
        provider: 'mapbox',
        // 256-pixel tiles need no zoom offset, so copies of the app already installed can draw this address as it is.
        tilesUrl: `https://api.mapbox.com/styles/v1/${stylePath}/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(token)}`,
        attribution: MAPBOX_ATTRIBUTION,
        searchToken: token,
      };
    }
    return { provider: 'default', tilesUrl, attribution: null, searchToken: null };
  }

  /** What the panel draws: a secret appears only as whether it is set and its last characters. */
  async status() {
    const rows = await this.prisma.setting.findMany({ where: { key: { startsWith: ROW_PREFIX } } });
    const saved = new Map(rows.map((row) => [row.key.slice(ROW_PREFIX.length), row.value]));
    return {
      encryptionReady: !!this.cipherKey(),
      map: await this.mapConfig(),
      system: {
        paymentMode: this.config.get<string>('PAYMENT_MODE') ?? 'disabled',
        otpDevEcho: this.config.get<string>('OTP_DEV_ECHO') === 'true',
        clientTrial: this.config.get<string>('CLIENT_TRIAL_MODE') === 'true',
        redisConfigured: !!this.config.get<string>('REDIS_HOST'),
      },
      groups: INTEGRATION_GROUPS.map((group) => ({
        ...group,
        fields: INTEGRATION_FIELDS.filter((field) => field.group === group.id).map((field) => {
          const stored = saved.get(field.key);
          const common = { key: field.key, label: field.label, inUse: !!field.inUse, configured: stored !== undefined, help: field.help, options: field.options, showFor: field.showFor };
          if (!field.secret) return { ...common, secret: false, value: stored ?? '' };
          const plain = stored === undefined ? null : this.decrypt(stored);
          return {
            ...common,
            secret: true,
            unreadable: stored !== undefined && plain === null,
            // A short secret would be mostly given away by its last characters.
            hint: plain && plain.length >= HINT_LENGTH * 3 ? plain.slice(-HINT_LENGTH) : null,
          };
        }),
      })),
    };
  }

  /** A null or empty value removes the key. Returns the names of the keys it touched, for the audit log. */
  async update(values: Record<string, unknown>) {
    const writes = Object.entries(values).map(([key, raw]) => {
      const field = FIELDS_BY_KEY.get(key);
      if (!field) throw new BadRequestException(`مفتاح غير معروف: ${key}`);
      if (raw !== null && typeof raw !== 'string') throw new BadRequestException(`قيمة غير صالحة: ${field.label}`);
      const plain = typeof raw === 'string' ? raw.trim() : '';
      if (plain.length > MAX_VALUE_LENGTH) throw new BadRequestException(`القيمة طويلة جدًا: ${field.label}`);
      if (plain && field.pattern && !field.pattern.test(plain)) throw new BadRequestException(field.patternMessage);
      return { field, plain };
    });
    await this.assertChoicesComplete(writes);

    const rows = writes.map(({ field, plain }) => {
      const key = `${ROW_PREFIX}${field.key}`;
      if (!plain) return this.prisma.setting.deleteMany({ where: { key } });
      const value = field.secret ? this.encrypt(plain) : plain;
      return this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    });
    await this.prisma.$transaction(rows);
    return writes.map(({ field }) => field.key);
  }

  /** The chosen platform must keep the key it needs, so the panel cannot show a connection that cannot work. */
  private async assertChoicesComplete(writes: { field: IntegrationField; plain: string }[]) {
    const written = new Map(writes.map(({ field, plain }) => [field.key, plain]));
    const current = async (key: string) => (written.has(key) ? written.get(key) : await this.value(key));
    const touchedGroups = new Set(writes.map(({ field }) => field.group));
    for (const choice of INTEGRATION_FIELDS.filter((field) => field.options && touchedGroups.has(field.group))) {
      const selected = await current(choice.key);
      const option = choice.options!.find((row) => row.value === (selected ?? ''));
      for (const key of option?.requires ?? []) {
        if (!(await current(key))) throw new BadRequestException(`${option!.label} يحتاج: ${FIELDS_BY_KEY.get(key)!.label}`);
      }
    }
  }
}

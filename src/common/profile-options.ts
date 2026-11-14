/**
 * The choices behind a person's profile. Customers pick from these rather than type,
 * because the customers' audience filter matches the stored text exactly: "مصري" and "مصرى" would be two groups.
 */
export const NATIONALITIES = [
  'سعودي',
  'مصري',
  'باكستاني',
  'سوداني',
  'يمني',
  'هندي',
  'بنغلاديشي',
  'إندونيسي',
  'سوري',
  'أردني',
  'فلسطيني',
  'لبناني',
  'عراقي',
  'إماراتي',
  'كويتي',
  'قطري',
  'بحريني',
  'عماني',
  'مغربي',
  'جزائري',
  'تونسي',
  'ليبي',
  'موريتاني',
  'صومالي',
  'إثيوبي',
  'إريتري',
  'تشادي',
  'نيجيري',
  'سنغالي',
  'تركي',
  'أفغاني',
  'إيراني',
  'ماليزي',
  'فلبيني',
  'نيبالي',
  'سريلانكي',
  'أخرى',
];

/** Each language also carries its own name, so someone who does not read Arabic can still find theirs. */
export const NATIVE_LANGUAGES = [
  { key: 'ar', label: 'العربية' },
  { key: 'en', label: 'الإنجليزية · English' },
  { key: 'ur', label: 'الأردية · اردو' },
  { key: 'hi', label: 'الهندية · हिन्दी' },
  { key: 'bn', label: 'البنغالية · বাংলা' },
  { key: 'id', label: 'الإندونيسية · Bahasa Indonesia' },
  { key: 'ms', label: 'الماليزية · Bahasa Melayu' },
  { key: 'tl', label: 'الفلبينية · Filipino' },
  { key: 'ml', label: 'المالايالامية · മലയാളം' },
  { key: 'ta', label: 'التاميلية · தமிழ்' },
  { key: 'ne', label: 'النيبالية · नेपाली' },
  { key: 'tr', label: 'التركية · Türkçe' },
  { key: 'fa', label: 'الفارسية · فارسی' },
  { key: 'ps', label: 'البشتو · پښتو' },
  { key: 'fr', label: 'الفرنسية · Français' },
  { key: 'am', label: 'الأمهرية · አማርኛ' },
  { key: 'so', label: 'الصومالية · Soomaali' },
  { key: 'ha', label: 'الهوسا · Hausa' },
  { key: 'other', label: 'لغة أخرى' },
];

export const NATIVE_LANGUAGE_KEYS = NATIVE_LANGUAGES.map((language) => language.key);

export const GENDERS = ['MALE', 'FEMALE'] as const;

/**
 * The cities a customer can say they live in, picked when the app first opens.
 * Kept in Arabic and matched exactly, the same names as SAUDI_CITIES in the app (durob-app/src/utils/cities.js).
 */
export const CUSTOMER_CITIES = [
  'الرياض',
  'مكة المكرمة',
  'المدينة المنورة',
  'جدة',
  'الدمام',
  'ينبع',
  'الطائف',
  'تبوك',
  'أبها',
  'بريدة',
  'حائل',
  'جازان',
  'نجران',
  'الهفوف',
  'الجبيل',
  'الخبر',
  'خميس مشيط',
  'عنيزة',
  'الخرج',
  'عرعر',
  'سكاكا',
  'الباحة',
];

/**
 * The last choice under the city list: picking it opens a box to type a city the list does not have. The typed name is
 * what is saved, never this word.
 */
export const OTHER_CITY = 'أخرى';

/** A city from the list or one typed under "أخرى": trimmed, 2 to 60 letters. */
export const CITY_MAX_LENGTH = 60;

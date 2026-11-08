import { BadRequestException } from '@nestjs/common';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toEnglishDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = ARABIC_DIGITS.indexOf(digit);
    return String(arabic >= 0 ? arabic : PERSIAN_DIGITS.indexOf(digit));
  });
}

/** Returns the canonical +9665XXXXXXXX form, or throws for anything that isn't a Saudi mobile. */
export function normalizeSaudiPhone(input: string): string {
  const digits = toEnglishDigits(String(input ?? '')).replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  const local = digits.replace(/^966/, '').replace(/^0/, '');
  if (!/^5\d{8}$/.test(local)) {
    throw new BadRequestException('رقم الجوال غير صحيح، يجب أن يكون رقمًا سعوديًا يبدأ بـ 5');
  }
  return `+966${local}`;
}

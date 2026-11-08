import { BadRequestException } from '@nestjs/common';
import { IdType } from '@prisma/client';
import { toEnglishDigits } from './phone.util';

export const ID_TYPES = ['NATIONAL_ID', 'IQAMA', 'PASSPORT'] as const satisfies readonly IdType[];

export const ID_TYPE_LABELS: Record<IdType, string> = {
  NATIONAL_ID: 'هوية وطنية',
  IQAMA: 'إقامة',
  PASSPORT: 'جواز سفر',
};

/** A national ID holder is Saudi, so choosing one fills the nationality instead of asking for it twice. */
export const SAUDI_NATIONALITY = 'سعودي';

/** Latin digits, no spaces or dashes, passport letters upper-case: the one form numbers are stored and searched in. */
export function cleanIdNumber(input: string) {
  return toEnglishDigits(String(input ?? '')).replace(/[\s-]/g, '').toUpperCase();
}

/** Lengths a number may have. Saudi IDs and iqamas are 10 digits today, but older records, border numbers
 * and other documents differ, so only the kind of characters is held fixed, not the length or the first digit. */
export const ID_NUMBER_LENGTH = { min: 5, max: 20 } as const;

/** Returns the stored form of the number, or throws a message that says what this document's number looks like. */
export function normalizeIdNumber(type: IdType, input: string): string {
  const number = cleanIdNumber(input);
  const { min, max } = ID_NUMBER_LENGTH;
  if (type === 'PASSPORT') {
    if (!/^[A-Z0-9]+$/.test(number) || number.length < min || number.length > max) {
      throw new BadRequestException(`رقم جواز السفر من ${min} إلى ${max} حرفًا لاتينيًا أو رقمًا`);
    }
  } else if (!/^\d+$/.test(number) || number.length < min || number.length > max) {
    throw new BadRequestException(`رقم ${type === 'NATIONAL_ID' ? 'الهوية الوطنية' : 'الإقامة'} أرقام فقط، من ${min} إلى ${max} رقمًا`);
  }
  return number;
}

/**
 * The fields to write for an identity change: both together, or both cleared. undefined means the request did not touch them.
 * A national ID also sets the nationality, and an iqama cannot belong to a Saudi.
 */
export function identityData(data: { idType?: IdType | null; idNumber?: string | null }, nationality?: string | null) {
  if (data.idType === undefined && data.idNumber === undefined) return {};
  if (!data.idType || !data.idNumber?.trim()) {
    if (data.idType || data.idNumber?.trim()) throw new BadRequestException('اختر نوع الهوية وأدخل رقمها معًا');
    return { idType: null, idNumber: null };
  }
  const idNumber = normalizeIdNumber(data.idType, data.idNumber);
  if (data.idType === 'IQAMA' && nationality === SAUDI_NATIONALITY) {
    throw new BadRequestException('الإقامة لغير السعوديين، اختر الهوية الوطنية');
  }
  return { idType: data.idType, idNumber, ...(data.idType === 'NATIONAL_ID' && { nationality: SAUDI_NATIONALITY }) };
}

/** Phones are stored as +9665XXXXXXXX; this reads a full mobile typed any common way, or returns null. */
function fullSaudiPhone(term: string) {
  const digits = term.replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  const local = digits.replace(/^966/, '').replace(/^0/, '');
  return /^5\d{8}$/.test(local) ? `+966${local}` : null;
}

export type CustomerLookup =
  | { kind: 'phone'; phone: string }
  | { kind: 'idNumber'; idNumber: string }
  | { kind: 'name'; name: string }
  | { kind: 'code'; code: string };

/** The fewest name parts and letters a search-only employee must type, so a name search finds a person, not a list. */
export const LOOKUP_NAME_MIN_WORDS = 2;
const LOOKUP_NAME_MIN_WORD_LENGTH = 2;

/**
 * For employees who may not browse customers: a search must point at one person. A full mobile number,
 * a full ID number, a booking or ticket code, or a name of at least two words. Anything partial is refused,
 * so typing "5" or "محمد" cannot be used to page through everyone.
 */
export function parseCustomerLookup(raw: string, { allowCodes = false } = {}): CustomerLookup {
  const term = toEnglishDigits(String(raw ?? '')).trim().replace(/\s+/g, ' ');
  // Booking and ticket codes: DRB-XXXXXXXX, DR-123, TKT-XXXXXXXXXX, or a scanned paper ticket (code.signature). Matched whole.
  if (allowCodes && /^[A-Za-z]{2,4}-[A-Za-z0-9-]{2,}(\.[\w-]+)?$/.test(term)) return { kind: 'code', code: term };
  const phone = fullSaudiPhone(term);
  if (phone) return { kind: 'phone', phone };
  const compact = cleanIdNumber(term);
  // National ID, iqama or passport: matched only as the whole number, so a few digits never list anyone.
  if (/^[A-Z0-9]{6,15}$/.test(compact) && /\d/.test(compact)) return { kind: 'idNumber', idNumber: compact };
  const words = term.split(' ').filter((word) => word.length >= LOOKUP_NAME_MIN_WORD_LENGTH);
  if (!/\d/.test(term) && words.length >= LOOKUP_NAME_MIN_WORDS) return { kind: 'name', name: term };
  throw new BadRequestException(
    allowCodes
      ? 'ابحث برقم الجوال كاملًا أو رقم الهوية أو الإقامة أو الجواز كاملًا أو رقم الحجز أو التذكرة كاملًا أو الاسم الثنائي على الأقل'
      : 'ابحث برقم الجوال كاملًا أو رقم الهوية أو الإقامة أو الجواز كاملًا أو الاسم الثنائي على الأقل',
  );
}

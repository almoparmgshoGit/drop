import { BadRequestException } from '@nestjs/common';
import { Gender, IdType } from '@prisma/client';
import { NATIONALITIES } from '../profile-options';
import { identityData, SAUDI_NATIONALITY } from './identity.util';

/** The official details every new employee or driver is registered with. */
export interface StaffIdentityInput {
  nationality?: string | null;
  gender?: Gender | null;
  birthDate?: string | null;
  idType?: IdType | null;
  idNumber?: string | null;
  idIssueDate?: string | null;
  idExpiryDate?: string | null;
}

/** What the account already holds, so a change to one date is checked against the others. */
export interface StaffIdentityExisting {
  nationality?: string | null;
  birthDate?: Date | null;
  idIssueDate?: Date | null;
  idExpiryDate?: Date | null;
}

/** Working age: drivers need a licence, which is 18 and over; past 70 a date is far more likely a typo than a hire. */
export const STAFF_AGE = { min: 18, max: 70 } as const;
/** A Saudi ID or iqama is issued for at most ten years; a passport for at most ten as well. */
const MAX_VALIDITY_YEARS = 10;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const parseStaffDay = (value: string, label: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  // Rejects 2026-02-31 and the like, which Date would otherwise roll over silently.
  if (!DAY.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${label} غير صحيح`);
  return date;
};

/** Today in Riyadh as a UTC midnight, the form @db.Date columns hold. */
const riyadhToday = () => new Date(`${new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)}T00:00:00.000Z`);

const shiftYears = (date: Date, years: number) => new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()));

const show = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Checks the dates of a person and their document together: an age within working years, an issue date that is
 * neither in the future nor before birth, and an expiry after the issue within the document's longest validity.
 * A new registration also refuses a document that has already run out.
 */
export function assertStaffDates(dates: { birthDate?: Date | null; idIssueDate?: Date | null; idExpiryDate?: Date | null }, options: { forNewStaff?: boolean } = {}) {
  const today = riyadhToday();
  const { birthDate, idIssueDate, idExpiryDate } = dates;
  if (birthDate) {
    if (birthDate > shiftYears(today, -STAFF_AGE.min)) throw new BadRequestException(`عمر الموظف لا يقل عن ${STAFF_AGE.min} سنة، فتاريخ الميلاد يكون في ${show(shiftYears(today, -STAFF_AGE.min))} أو قبله`);
    if (birthDate < shiftYears(today, -STAFF_AGE.max)) throw new BadRequestException(`عمر الموظف لا يزيد عن ${STAFF_AGE.max} سنة، تأكد من تاريخ الميلاد`);
  }
  if (idIssueDate) {
    if (idIssueDate > today) throw new BadRequestException('تاريخ إصدار الهوية لا يكون في المستقبل');
    if (birthDate && idIssueDate < birthDate) throw new BadRequestException('تاريخ إصدار الهوية لا يسبق تاريخ الميلاد');
  }
  if (idExpiryDate) {
    if (idIssueDate && idExpiryDate <= idIssueDate) throw new BadRequestException('تاريخ انتهاء الهوية يكون بعد تاريخ إصدارها');
    if (idIssueDate && idExpiryDate > shiftYears(idIssueDate, MAX_VALIDITY_YEARS)) throw new BadRequestException(`صلاحية الهوية لا تتجاوز ${MAX_VALIDITY_YEARS} سنوات من تاريخ إصدارها`);
    if (!idIssueDate && idExpiryDate > shiftYears(today, MAX_VALIDITY_YEARS)) throw new BadRequestException('تاريخ انتهاء الهوية بعيد جدًا، تأكد منه');
    if (options.forNewStaff && idExpiryDate <= today) throw new BadRequestException('الهوية منتهية، ولا يُسجل موظف بهوية منتهية. جدّدها أولًا');
  }
}

/**
 * Checks and shapes the official details of a staff account. With `required`, a new account cannot be saved
 * without its nationality, gender, birth date and identity document with both its dates; otherwise only what was
 * sent is checked, against what the account already holds.
 * The driver registry keeps its own copy of the number, which the manifests print, so it is returned too.
 */
export function staffIdentityData(input: StaffIdentityInput, options: { required?: boolean; existing?: StaffIdentityExisting } = {}) {
  const existing = options.existing ?? {};
  const nationality = input.nationality?.trim() || null;
  if (options.required) {
    if (!nationality) throw new BadRequestException('اختر جنسية الموظف');
    if (!input.gender) throw new BadRequestException('حدد جنس الموظف');
    if (!input.birthDate) throw new BadRequestException('أدخل تاريخ ميلاد الموظف');
    if (!input.idType || !input.idNumber?.trim()) throw new BadRequestException('أدخل نوع هوية الموظف ورقمها');
    if (!input.idIssueDate) throw new BadRequestException('أدخل تاريخ إصدار الهوية');
    if (!input.idExpiryDate) throw new BadRequestException('أدخل تاريخ انتهاء الهوية');
  }
  // A value typed before the list existed may stay, or saving anything else on an old record would fail.
  if (nationality && input.nationality !== undefined && nationality !== existing.nationality && !NATIONALITIES.includes(nationality)) {
    throw new BadRequestException('اختر الجنسية من القائمة');
  }

  const identity = identityData({ idType: input.idType, idNumber: input.idNumber }, nationality ?? existing.nationality ?? null);
  if (nationality && nationality !== SAUDI_NATIONALITY && input.idType === 'NATIONAL_ID') throw new BadRequestException('الهوية الوطنية للسعوديين، اختر الإقامة أو جواز السفر');

  const day = (value: string | null | undefined, label: string) => (value === undefined ? undefined : value ? parseStaffDay(value, label) : null);
  const birthDate = day(input.birthDate, 'تاريخ الميلاد');
  const idIssueDate = day(input.idIssueDate, 'تاريخ إصدار الهوية');
  const idExpiryDate = day(input.idExpiryDate, 'تاريخ انتهاء الهوية');
  // Each date is checked against the others as they will stand after this change.
  assertStaffDates(
    {
      birthDate: birthDate !== undefined ? birthDate : existing.birthDate,
      idIssueDate: idIssueDate !== undefined ? idIssueDate : existing.idIssueDate,
      idExpiryDate: idExpiryDate !== undefined ? idExpiryDate : existing.idExpiryDate,
    },
    { forNewStaff: options.required },
  );

  const user = {
    ...(input.nationality !== undefined && { nationality }),
    ...(input.gender !== undefined && { gender: input.gender }),
    ...(birthDate !== undefined && { birthDate }),
    ...(idIssueDate !== undefined && { idIssueDate }),
    ...(idExpiryDate !== undefined && { idExpiryDate }),
    ...identity,
  };
  // A national ID or an iqama is the number the manifests print for a driver; a passport has no place there.
  const driverNumber = 'idNumber' in identity ? (identity.idType === 'PASSPORT' ? null : identity.idNumber) : undefined;
  return { user, driverNumber, nationality: (user as { nationality?: string | null }).nationality };
}

/** Old forms sent a bare number as the iqama; a Saudi national ID starts with 1. */
export function legacyIdentity(iqamaNumber?: string | null): Pick<StaffIdentityInput, 'idType' | 'idNumber'> {
  if (!iqamaNumber) return {};
  return { idType: iqamaNumber.trim().startsWith('1') ? 'NATIONAL_ID' : 'IQAMA', idNumber: iqamaNumber };
}

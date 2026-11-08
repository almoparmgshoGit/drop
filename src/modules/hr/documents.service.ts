import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EmployeeDocumentKind, Prisma } from '@prisma/client';
import { readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { HrActor, HrCoreService } from './hr-core.service';
import { addDays, fromDbDate, parseDay, toDbDate, today } from './hr.util';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const EXPIRY_WINDOW_DAYS = 60;

export const DOCUMENT_LABELS: Record<EmployeeDocumentKind, string> = {
  PHOTO: 'صورة شخصية',
  NATIONAL_ID: 'الهوية الوطنية',
  IQAMA: 'الإقامة',
  PASSPORT: 'جواز السفر',
  DRIVING_LICENSE: 'رخصة القيادة',
  CONTRACT: 'عقد العمل',
  CERTIFICATE: 'شهادة',
  OTHER: 'وثيقة أخرى',
};

const DOCUMENT_SELECT = { id: true, kind: true, number: true, issueDate: true, expiryDate: true, note: true, fileName: true, mimeType: true, size: true, uploadedByName: true, createdAt: true } satisfies Prisma.EmployeeDocumentSelect;

const out = (row: Prisma.EmployeeDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>) => ({
  ...row,
  label: DOCUMENT_LABELS[row.kind],
  issueDate: row.issueDate && fromDbDate(row.issueDate),
  expiryDate: row.expiryDate && fromDbDate(row.expiryDate),
});

export interface DocumentInput {
  kind: EmployeeDocumentKind;
  number?: string;
  issueDate?: string;
  expiryDate?: string;
  note?: string;
}

@Injectable()
export class DocumentsService {
  constructor(private core: HrCoreService) {}

  private get prisma() {
    return this.core.db;
  }

  /**
   * Employee managers already see every employee on the employees page, so they reach every file here too;
   * HR staff without that reach their own branch unless they hold hr.all_branches.
   */
  private async target(actor: HrActor, userId: string) {
    if (this.core.can(actor, 'employees.view', 'employees.manage')) {
      const user = await this.prisma.user.findFirst({ where: { id: userId, role: { not: 'PASSENGER' } }, select: { id: true, role: true, idType: true, birthDate: true } });
      if (!user) throw new NotFoundException('الموظف غير موجود');
      return user;
    }
    const user = await this.core.employee(actor, userId);
    const identity = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { idType: true, birthDate: true } });
    return { id: user.id, role: user.role, idType: identity.idType, birthDate: identity.birthDate };
  }

  async list(actor: HrActor, userId: string) {
    await this.target(actor, userId);
    const rows = await this.prisma.employeeDocument.findMany({ where: { userId }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }], select: DOCUMENT_SELECT });
    return rows.map(out);
  }

  /**
   * Keeps the file and its details. A scan of the identity document or the driving licence also refreshes the
   * expiry the rest of the system reads, so the alerts follow the newest paper.
   */
  async upload(actor: HrActor, userId: string, input: DocumentInput, file?: UploadedInvoice) {
    const user = await this.target(actor, userId);
    if (!file) throw new BadRequestException('أرفق ملف الوثيقة');
    if (file.size > MAX_DOCUMENT_BYTES) throw new BadRequestException('حجم الملف لا يتجاوز 5 ميجابايت');
    const [stored] = readInvoiceFiles([file], actor.userId);
    if (input.kind === 'PHOTO' && !stored.mimeType.startsWith('image/')) throw new BadRequestException('الصورة الشخصية تكون صورة JPG أو PNG أو WEBP');
    const issueDate = input.issueDate ? toDbDate(parseDay(input.issueDate, 'تاريخ الإصدار')) : null;
    const expiryDate = input.expiryDate ? toDbDate(parseDay(input.expiryDate, 'تاريخ الانتهاء')) : null;
    // The same rules as the identity on the account: issued in the past and after birth, expiring after issue.
    if (issueDate && issueDate > toDbDate(today())) throw new BadRequestException('تاريخ الإصدار لا يكون في المستقبل');
    if (issueDate && user.birthDate && issueDate < user.birthDate) throw new BadRequestException('تاريخ الإصدار لا يسبق تاريخ ميلاد الموظف');
    if (issueDate && expiryDate && expiryDate <= issueDate) throw new BadRequestException('تاريخ الانتهاء يكون بعد تاريخ الإصدار');

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.employeeDocument.create({
        data: { userId, kind: input.kind, number: input.number?.trim() || null, issueDate, expiryDate, note: input.note?.trim() || null, ...stored, uploadedByName: actor.name ?? null },
        select: DOCUMENT_SELECT,
      });
      // A newer scan of the account's own identity document brings its dates with it.
      if ((issueDate || expiryDate) && input.kind === user.idType) {
        await tx.user.update({ where: { id: userId }, data: { ...(issueDate && { idIssueDate: issueDate }), ...(expiryDate && { idExpiryDate: expiryDate }) } });
      }
      if (expiryDate && input.kind === 'DRIVING_LICENSE' && user.role === 'DRIVER') {
        await tx.driverProfile.upsert({ where: { userId }, create: { userId, licenseExpiry: expiryDate }, update: { licenseExpiry: expiryDate } });
      }
      return row;
    });
    return out(created);
  }

  async remove(actor: HrActor, id: string) {
    const row = await this.prisma.employeeDocument.findUnique({ where: { id }, select: { userId: true } });
    if (!row) throw new NotFoundException('الوثيقة غير موجودة');
    await this.target(actor, row.userId);
    await this.prisma.employeeDocument.delete({ where: { id } });
    return { success: true };
  }

  async file(actor: HrActor, id: string) {
    const row = await this.prisma.employeeDocument.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('الوثيقة غير موجودة');
    await this.target(actor, row.userId);
    return row;
  }

  /** The newest personal photo, or null. */
  async photo(actor: HrActor | null, userId: string) {
    if (actor) await this.target(actor, userId);
    return this.prisma.employeeDocument.findFirst({ where: { userId, kind: 'PHOTO' }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Identity documents, driving licences and filed papers that have run out or will within 60 days, for staff
   * still at work. Each person's newest paper of a kind is the one that counts.
   */
  async expiring(actor: HrActor) {
    const limit = toDbDate(addDays(today(), EXPIRY_WINDOW_DAYS));
    const scope = this.core.can(actor, 'employees.view', 'employees.manage') ? {} : await this.core.scopeWhere(actor);
    const working: Prisma.UserWhereInput = { role: { not: 'PASSENGER' }, blockedAt: null, NOT: { employeeProfile: { is: { status: 'TERMINATED' } } }, ...scope };
    const person = { id: true, name: true, phone: true, branch: { select: { name: true } } } as const;

    const [identities, licences, documents] = await Promise.all([
      this.prisma.user.findMany({ where: { ...working, idExpiryDate: { lte: limit } }, select: { ...person, idType: true, idNumber: true, idExpiryDate: true } }),
      this.prisma.user.findMany({ where: { ...working, driverProfile: { is: { isActive: true, licenseExpiry: { lte: limit } } } }, select: { ...person, driverProfile: { select: { licenseExpiry: true } } } }),
      this.prisma.employeeDocument.findMany({
        where: { expiryDate: { not: null }, kind: { notIn: ['PHOTO', 'NATIONAL_ID', 'IQAMA', 'PASSPORT', 'DRIVING_LICENSE'] }, user: working },
        orderBy: { createdAt: 'desc' },
        select: { kind: true, expiryDate: true, number: true, user: { select: person } },
      }),
    ]);

    const newest = new Map<string, (typeof documents)[number]>();
    for (const row of documents) if (!newest.has(`${row.user.id}:${row.kind}`)) newest.set(`${row.user.id}:${row.kind}`, row);

    const ID_LABELS: Record<string, string> = { NATIONAL_ID: 'الهوية الوطنية', IQAMA: 'الإقامة', PASSPORT: 'جواز السفر' };
    const rows = [
      ...identities.map(({ idType, idNumber, idExpiryDate, ...user }) => ({ user, document: ID_LABELS[idType ?? ''] ?? 'الهوية', number: idNumber, expiryDate: idExpiryDate! })),
      ...licences.map(({ driverProfile, ...user }) => ({ user, document: 'رخصة القيادة', number: null, expiryDate: driverProfile!.licenseExpiry! })),
      ...[...newest.values()].filter((row) => row.expiryDate! <= limit).map((row) => ({ user: row.user, document: DOCUMENT_LABELS[row.kind], number: row.number, expiryDate: row.expiryDate! })),
    ];
    const now = toDbDate(today());
    return rows
      .map((row) => ({ ...row, expiryDate: fromDbDate(row.expiryDate), expired: row.expiryDate < now }))
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  }
}

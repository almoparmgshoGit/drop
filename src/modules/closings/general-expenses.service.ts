import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneralExpenseCategory, Prisma } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { vatInside } from '../../common/utils/invoice.util';
import { halalas } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import { readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { CreateGeneralExpenseDto, GeneralExpensesQuery } from './closings.dto';

const PAGE_SIZE = 50;
const sar = (value: number) => Math.round(value) / 100;

export const EXPENSE_CATEGORY_LABELS: Record<GeneralExpenseCategory, string> = {
  OFFICE_RENT: 'إيجار مقر',
  UTILITIES: 'كهرباء ومياه',
  TELECOM: 'اتصالات وإنترنت',
  SUPPLIES: 'قرطاسية ومستلزمات',
  MAINTENANCE: 'صيانة المكاتب',
  GOVERNMENT: 'رسوم حكومية',
  MARKETING: 'تسويق وإعلان',
  HOSPITALITY: 'ضيافة ونظافة',
  OTHER: 'مصاريف أخرى',
};

/** Company expenses outside the trips: premises rent and what running the offices costs. */
@Injectable()
export class GeneralExpensesService {
  constructor(
    private prisma: PrismaService,
    private ledger: InvoiceLedgerService,
  ) {}

  async list(query: GeneralExpensesQuery) {
    const from = query.from ?? `${riyadhDate(new Date()).slice(0, 7)}-01`;
    const to = query.to ?? riyadhDate(new Date());
    const [first, last] = from <= to ? [from, to] : [to, from];
    if (!riyadhDayRange(first) || !riyadhDayRange(last)) throw new BadRequestException('التاريخ غير صحيح');
    const where: Prisma.GeneralExpenseWhereInput = {
      spentOn: { gte: new Date(`${first}T00:00:00Z`), lte: new Date(`${last}T00:00:00Z`) },
      ...(query.category && { category: query.category }),
      ...(query.branchId && { branchId: query.branchId === 'none' ? null : query.branchId }),
    };
    const page = query.page ?? 1;
    const [rows, total, groups, branches] = await Promise.all([
      this.prisma.generalExpense.findMany({
        where,
        orderBy: [{ spentOn: 'desc' }, { number: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { branch: { select: { name: true } }, attachments: { select: { id: true, fileName: true, size: true }, orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.generalExpense.count({ where }),
      this.prisma.generalExpense.groupBy({ by: ['category'], where: { ...where, voidedAt: null }, _sum: { amount: true, vat: true }, _count: true }),
      this.prisma.branch.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } }),
    ]);
    const totalOf = (match: (category: GeneralExpenseCategory) => boolean) =>
      sar(groups.filter((group) => match(group.category)).reduce((sum, group) => sum + halalas(group._sum.amount ?? 0), 0));
    return {
      from: first,
      to: last,
      page,
      pageSize: PAGE_SIZE,
      total,
      branches,
      categories: Object.entries(EXPENSE_CATEGORY_LABELS).map(([key, label]) => ({ key, label })),
      summary: {
        rent: totalOf((category) => category === 'OFFICE_RENT'),
        offices: totalOf((category) => category !== 'OFFICE_RENT'),
        total: totalOf(() => true),
        vat: sar(groups.reduce((sum, group) => sum + halalas(group._sum.vat ?? 0), 0)),
        byCategory: groups
          .map((group) => ({ category: group.category, label: EXPENSE_CATEGORY_LABELS[group.category], count: group._count, amount: Number(group._sum.amount ?? 0) }))
          .sort((a, b) => b.amount - a.amount),
      },
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        category: row.category,
        categoryLabel: EXPENSE_CATEGORY_LABELS[row.category],
        branchId: row.branchId,
        branchName: row.branch?.name ?? null,
        amount: Number(row.amount),
        vat: Number(row.vat),
        hasTaxInvoice: row.hasTaxInvoice,
        method: row.method,
        supplierName: row.supplierName,
        description: row.description,
        notes: row.notes,
        spentOn: row.spentOn.toISOString().slice(0, 10),
        createdByName: row.createdByName,
        createdAt: row.createdAt,
        voidedAt: row.voidedAt,
        voidedByName: row.voidedByName,
        voidReason: row.voidReason,
        attachments: row.attachments,
      })),
    };
  }

  async create(actor: { userId: string; name?: string | null }, dto: CreateGeneralExpenseDto, files: UploadedInvoice[] = []) {
    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;
    const repeated = await this.prisma.generalExpense.findUnique({ where: { idempotencyKey } });
    if (repeated) return repeated;

    const day = riyadhDayRange(dto.spentOn);
    if (!day) throw new BadRequestException('التاريخ غير صحيح');
    if (day.start > new Date()) throw new BadRequestException('لا يمكن تسجيل مصروف بتاريخ لاحق');
    if (dto.branchId) {
      const branch = await this.prisma.branch.count({ where: { id: dto.branchId } });
      if (!branch) throw new BadRequestException('الفرع غير موجود');
    }
    await this.assertPeriodOpen(dto.spentOn);
    // Reclaiming VAT needs a document the authority can ask for.
    if (dto.hasTaxInvoice && files.length === 0) throw new BadRequestException('ارفع الفاتورة الضريبية');
    const invoices = readInvoiceFiles(files, actor.userId);
    const vatRate = await this.ledger.vatRate(this.prisma);
    const vat = dto.hasTaxInvoice ? vatInside(halalas(dto.amount), vatRate) : 0;

    try {
      return await this.prisma.generalExpense.create({
        data: {
          category: dto.category,
          branchId: dto.branchId ?? null,
          amount: dto.amount,
          vat: vat / 100,
          hasTaxInvoice: dto.hasTaxInvoice,
          method: dto.method,
          supplierName: dto.supplierName || null,
          description: dto.description,
          notes: dto.notes || null,
          spentOn: new Date(`${dto.spentOn}T00:00:00Z`),
          idempotencyKey,
          createdById: actor.userId,
          createdByName: actor.name ?? null,
          ...(invoices.length && { attachments: { create: invoices } }),
        },
      });
    } catch (err) {
      // Two identical submits raced; the winner's expense is the answer to both.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.generalExpense.findUnique({ where: { idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  async void(actor: { name?: string | null }, id: string, reason: string) {
    const expense = await this.prisma.generalExpense.findUnique({ where: { id }, select: { spentOn: true, voidedAt: true } });
    if (!expense) throw new NotFoundException('هذا المصروف غير موجود');
    if (expense.voidedAt) throw new ConflictException('هذا المصروف ملغى مسبقًا');
    await this.assertPeriodOpen(expense.spentOn.toISOString().slice(0, 10));
    const voided = await this.prisma.generalExpense.updateMany({
      where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidedByName: actor.name ?? null, voidReason: reason },
    });
    if (voided.count === 0) throw new ConflictException('هذا المصروف ملغى مسبقًا');
    return { success: true };
  }

  async attachment(id: string) {
    const file = await this.prisma.generalExpenseAttachment.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }

  /** A day inside an approved comprehensive closing is final: void that closing before changing its expenses. */
  private async assertPeriodOpen(day: string) {
    const date = new Date(`${day}T00:00:00Z`);
    const closing = await this.prisma.accountClosing.findFirst({
      where: { voidedAt: null, kind: 'COMPREHENSIVE', period: { not: 'TRIP' }, fromDate: { lte: date }, toDate: { gte: date } },
      select: { number: true, label: true },
    });
    if (closing) throw new ConflictException(`هذا التاريخ داخل تقفيل معتمد (${closing.label})، ألغِ اعتماده أولًا`);
  }
}

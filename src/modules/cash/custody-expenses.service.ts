import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { vatInside } from '../../common/utils/invoice.util';
import { halalas } from '../../common/utils/payment.util';
import { riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import { CashActor, CashService, custodyCode, readInvoiceFiles, UploadedInvoice } from './cash.service';
import { CreateCustodyExpenseDto } from './cash.dto';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const LIST_LIMIT = 50;
const sar = (value: number) => Math.round(value) / 100;

const SUMMARY_SELECT = {
  id: true,
  number: true,
  purpose: true,
  amount: true,
  status: true,
  issuedAt: true,
  issuedByName: true,
  spentAmount: true,
  returnedAmount: true,
  settlementNote: true,
  settledAt: true,
  settledByName: true,
  branch: { select: { name: true } },
  trip: { select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true } },
  expenses: { where: { voidedAt: null }, select: { amount: true } },
} satisfies Prisma.CustodySelect;

const EXPENSE_SELECT = {
  id: true,
  amount: true,
  vat: true,
  hasTaxInvoice: true,
  supplierName: true,
  notes: true,
  spentOn: true,
  createdAt: true,
  voidedAt: true,
  voidedByName: true,
  voidReason: true,
  category: { select: { name: true } },
  // The file bytes stay out: they are fetched one at a time, and only when asked for.
  attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CustodyExpenseSelect;

type Summary = Prisma.CustodyGetPayload<{ select: typeof SUMMARY_SELECT }>;
type Expense = Prisma.CustodyExpenseGetPayload<{ select: typeof EXPENSE_SELECT }>;

/** Before settlement the figures come from what the holder recorded; afterwards the office's settlement is final. */
const toSummary = (custody: Summary) => {
  const settled = custody.status === 'SETTLED';
  const logged = custody.expenses.reduce((sum, row) => sum + halalas(row.amount), 0);
  const spent = settled ? halalas(custody.spentAmount ?? 0) : logged;
  return {
    id: custody.id,
    code: custodyCode(custody.number),
    purpose: custody.purpose,
    status: custody.status,
    amount: Number(custody.amount),
    spent: sar(spent),
    remaining: settled ? 0 : sar(halalas(custody.amount) - spent),
    returned: settled ? Number(custody.returnedAmount ?? 0) : null,
    expenseCount: custody.expenses.length,
    issuedAt: custody.issuedAt,
    issuedByName: custody.issuedByName,
    branchName: custody.branch.name,
    settledAt: custody.settledAt,
    settledByName: custody.settledByName,
    settlementNote: custody.settlementNote,
    trip: custody.trip,
  };
};

const toExpense = (expense: Expense) => ({
  id: expense.id,
  categoryName: expense.category.name,
  amount: Number(expense.amount),
  vat: Number(expense.vat),
  hasTaxInvoice: expense.hasTaxInvoice,
  supplierName: expense.supplierName,
  notes: expense.notes,
  spentOn: expense.spentOn.toISOString().slice(0, 10),
  createdAt: expense.createdAt,
  voidedAt: expense.voidedAt,
  voidedByName: expense.voidedByName,
  voidReason: expense.voidReason,
  attachments: expense.attachments,
});

@Injectable()
export class CustodyExpensesService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
    private ledger: InvoiceLedgerService,
    private notifications: NotificationsService,
  ) {}

  /** Always the caller's own custodies, whatever their rank: this is a holder's view, not the office's. */
  async listMine(actor: CashActor, tripId?: string) {
    const custodies = await this.prisma.custody.findMany({
      where: { recipientId: actor.userId, ...(tripId && { tripId }) },
      orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
      take: LIST_LIMIT,
      select: SUMMARY_SELECT,
    });
    const items = custodies.map(toSummary);
    return { items, totalRemaining: sar(items.reduce((sum, row) => sum + halalas(row.remaining), 0)) };
  }

  async detailMine(actor: CashActor, id: string) {
    const custody = await this.prisma.custody.findFirst({ where: { id, recipientId: actor.userId }, select: SUMMARY_SELECT });
    // Someone else's custody answers the same as one that does not exist.
    if (!custody) throw new NotFoundException('العهدة غير موجودة');
    const [expenses, categories] = await Promise.all([
      this.prisma.custodyExpense.findMany({ where: { custodyId: id }, orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }], select: EXPENSE_SELECT }),
      custody.status === 'OPEN'
        ? this.prisma.accountCategory.findMany({ where: { isActive: true, group: { in: ['DRIVER', 'ADMIN', 'OTHER'] } }, orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }], select: { id: true, name: true } })
        : [],
    ]);
    return { custody: toSummary(custody), expenses: expenses.map(toExpense), categories };
  }

  async addExpense(actor: CashActor, custodyId: string, dto: CreateCustodyExpenseDto, files: UploadedInvoice[] = []) {
    if (files.length === 0) throw new BadRequestException('أرفق صورة الفاتورة');
    const invoices = readInvoiceFiles(files, actor.userId);
    const day = riyadhDayRange(dto.spentOn);
    if (!day) throw new BadRequestException('التاريخ غير صحيح');
    if (day.start > new Date()) throw new BadRequestException('لا يمكن تسجيل مصروف بتاريخ لاحق');

    const [category, vatRate] = await Promise.all([
      this.prisma.accountCategory.findUnique({ where: { id: dto.categoryId } }),
      this.ledger.vatRate(this.prisma),
    ]);
    // Hotels and bus rent come from the trip's own data, and income is not spending.
    if (!category || !category.isActive || !['DRIVER', 'ADMIN', 'OTHER'].includes(category.group)) throw new BadRequestException('هذا البند غير متاح');

    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;
    const amount = halalas(dto.amount);

    const expense = await this.prisma.$transaction(async (tx) => {
      // One writer per custody, so two expenses cannot both fit into the same remaining balance.
      await tx.$queryRaw`SELECT "id" FROM "Custody" WHERE "id" = ${custodyId} AND "recipientId" = ${actor.userId} FOR UPDATE`;
      const custody = await tx.custody.findFirst({ where: { id: custodyId, recipientId: actor.userId }, select: { id: true, amount: true, status: true, issuedAt: true } });
      if (!custody) throw new NotFoundException('العهدة غير موجودة');

      const repeated = await tx.custodyExpense.findUnique({ where: { idempotencyKey }, select: EXPENSE_SELECT });
      if (repeated) return repeated;

      if (custody.status !== 'OPEN') throw new ConflictException('سُوّيت هذه العهدة، فلا يمكن إضافة مصروف إليها');
      if (dto.spentOn < riyadhDate(custody.issuedAt)) throw new BadRequestException('تاريخ المصروف قبل تاريخ صرف العهدة');

      const logged = await tx.custodyExpense.aggregate({ where: { custodyId, voidedAt: null }, _sum: { amount: true } });
      const remaining = halalas(custody.amount) - halalas(logged._sum.amount ?? 0);
      if (amount > remaining) throw new BadRequestException(`المبلغ أكبر من المتبقي في العهدة (${formatSar(sar(remaining))})`);

      return tx.custodyExpense.create({
        data: {
          custodyId,
          categoryId: category.id,
          amount: dto.amount,
          vat: dto.hasTaxInvoice ? vatInside(amount, vatRate) / 100 : 0,
          hasTaxInvoice: dto.hasTaxInvoice,
          supplierName: dto.supplierName,
          notes: dto.notes || null,
          spentOn: new Date(`${dto.spentOn}T00:00:00Z`),
          idempotencyKey,
          createdById: actor.userId,
          createdByName: actor.name ?? null,
          attachments: { create: invoices.map((invoice) => ({ ...invoice, custodyId })) },
        },
        select: EXPENSE_SELECT,
      });
    }, TX_OPTIONS);
    return toExpense(expense);
  }

  async voidMine(actor: CashActor, expenseId: string, reason: string) {
    const expense = await this.prisma.custodyExpense.findFirst({ where: { id: expenseId, custody: { recipientId: actor.userId } }, select: { custodyId: true } });
    if (!expense) throw new NotFoundException('هذا المصروف غير موجود');
    return this.prisma.$transaction((tx) => this.voidInTx(tx, actor, expenseId, expense.custodyId, reason), TX_OPTIONS);
  }

  async voidAsOffice(actor: CashActor, expenseId: string, reason: string) {
    const expense = await this.prisma.custodyExpense.findUnique({
      where: { id: expenseId },
      select: { amount: true, custodyId: true, custody: { select: { number: true, purpose: true, branchId: true, recipientId: true } } },
    });
    if (!expense) throw new NotFoundException('هذا المصروف غير موجود');
    await this.cash.assertBranchAccess(actor, expense.custody.branchId);
    return this.prisma.$transaction(async (tx) => {
      const result = await this.voidInTx(tx, actor, expenseId, expense.custodyId, reason);
      if (expense.custody.recipientId !== actor.userId) {
        await this.notifications.toUser(tx, 'CUSTODY_EXPENSE_VOIDED', expense.custody.recipientId, {
          custodyNumber: custodyCode(expense.custody.number),
          custodyPurpose: expense.custody.purpose,
          amount: formatSar(expense.amount),
          voidReason: reason,
        });
      }
      return result;
    }, TX_OPTIONS);
  }

  /** A settled custody is closed: voiding now would move figures the office has already signed off. */
  private async voidInTx(tx: Prisma.TransactionClient, actor: CashActor, expenseId: string, custodyId: string, reason: string) {
    await tx.$queryRaw`SELECT "id" FROM "Custody" WHERE "id" = ${custodyId} FOR UPDATE`;
    const custody = await tx.custody.findUniqueOrThrow({ where: { id: custodyId }, select: { status: true } });
    if (custody.status !== 'OPEN') throw new ConflictException('سُوّيت هذه العهدة، فلا يمكن تعديل مصروفاتها');
    const voided = await tx.custodyExpense.updateMany({
      where: { id: expenseId, voidedAt: null },
      data: { voidedAt: new Date(), voidedByName: actor.name ?? null, voidReason: reason },
    });
    if (voided.count === 0) throw new ConflictException('هذا المصروف ملغى مسبقًا');
    return { success: true };
  }

  async attachmentMine(actor: CashActor, id: string) {
    const file = await this.prisma.custodyAttachment.findFirst({ where: { id, custody: { recipientId: actor.userId } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    return file;
  }
}

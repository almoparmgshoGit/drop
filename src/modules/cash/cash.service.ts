import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CashMovementType, CashSession, Prisma } from '@prisma/client';
import { BookingEventsService } from '../../common/services/booking-events.service';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { halalas, paymentFigures } from '../../common/utils/payment.util';
import { startOfRiyadhMonth } from '../../common/utils/time.util';
import { toHalalas, toSar } from '../bookings/bookings.service';
import { CloseSessionDto, IssueCustodyDto, OpenSessionDto, SaveBranchDto, SettleCustodyDto, UpdateBranchDto } from './cash.dto';

type Db = Prisma.TransactionClient;

export interface CashActor {
  userId: string;
  role: string;
  name?: string | null;
  permissions: string[];
}

export interface UploadedInvoice {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export const MAX_INVOICES = 5;
export const MAX_INVOICE_BYTES = 5 * 1024 * 1024;

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const MIN_REASON_LENGTH = 3;

const riyadhToday = () => new Date(Date.now() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const nextMonthStart = (start: Date) => new Date(Date.UTC(new Date(start.getTime() + RIYADH_OFFSET_MS).getUTCFullYear(), new Date(start.getTime() + RIYADH_OFFSET_MS).getUTCMonth() + 1, 1) - RIYADH_OFFSET_MS);

/** Checks uploaded invoices by their own bytes and shapes them for storage. Refuses the whole upload if any file is not a PDF or an image. */
export const readInvoiceFiles = (files: UploadedInvoice[], uploadedById: string) =>
  files.map((file) => {
    const type = INVOICE_TYPES.find((candidate) => candidate.matches(file.buffer));
    if (!type) throw new BadRequestException(`الملف "${cleanFileName(file.originalname)}" ليس PDF أو صورة`);
    return { fileName: cleanFileName(file.originalname), mimeType: type.mimeType, size: file.size, data: file.buffer, uploadedById };
  });

export const custodyCode = (number: number) => `CU-${String(number).padStart(3, '0')}`;

// The declared type comes from the client, so the stored type is decided by the file's own bytes.
const INVOICE_TYPES: { mimeType: string; matches: (file: Buffer) => boolean }[] = [
  { mimeType: 'application/pdf', matches: (f) => f.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mimeType: 'image/jpeg', matches: (f) => f[0] === 0xff && f[1] === 0xd8 && f[2] === 0xff },
  { mimeType: 'image/png', matches: (f) => f.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n' },
  { mimeType: 'image/webp', matches: (f) => f.subarray(0, 4).toString('latin1') === 'RIFF' && f.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export const cleanFileName = (name: string) => {
  // Multipart parsers hand over UTF-8 names as Latin-1.
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const base = decoded.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return base.slice(-120) || 'invoice';
};

const CUSTODY_ROW = {
  id: true,
  number: true,
  branchId: true,
  recipientId: true,
  recipientName: true,
  recipientJob: true,
  purpose: true,
  amount: true,
  status: true,
  spentAmount: true,
  returnedAmount: true,
  settlementNote: true,
  issuedByName: true,
  issuedAt: true,
  settledByName: true,
  settledAt: true,
  trip: { select: { tripCode: true } },
  attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } },
  expenses: {
    orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      amount: true,
      vat: true,
      hasTaxInvoice: true,
      supplierName: true,
      notes: true,
      spentOn: true,
      createdByName: true,
      voidedAt: true,
      voidedByName: true,
      voidReason: true,
      category: { select: { name: true } },
      attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } },
    },
  },
} satisfies Prisma.CustodySelect;

@Injectable()
export class CashService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private events: BookingEventsService,
    private invoices: InvoiceLedgerService,
  ) {}

  // ---------------------------------------------------------------- branches

  /** Drawers the caller can open, unless a branch or employee manager asks for every branch to administer. */
  async listBranches(actor: CashActor, forAdministration = false) {
    const administers = forAdministration && ['branches.manage', 'employees.manage'].some((p) => actor.permissions.includes(p));
    if (administers || actor.permissions.includes('cash.all_branches')) {
      return this.prisma.branch.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    }
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branch: true } });
    return me?.branch ? [me.branch] : [];
  }

  createBranch(dto: SaveBranchDto) {
    return this.prisma.branch.create({ data: dto });
  }

  async updateBranch(id: string, dto: UpdateBranchDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockBranch(tx, id);
      if (dto.isActive === false) {
        const [openSessions, openCustodies] = await Promise.all([
          tx.cashSession.count({ where: { branchId: id, status: 'OPEN' } }),
          tx.custody.count({ where: { branchId: id, status: 'OPEN' } }),
        ]);
        if (openSessions) throw new ConflictException('أقفل صندوق الفرع قبل إيقافه');
        if (openCustodies) throw new ConflictException('سوِّ عهد الفرع المفتوحة قبل إيقافه');
      }
      return tx.branch.update({ where: { id }, data: dto });
    }, TX_OPTIONS);
  }

  // ---------------------------------------------------------------- reading

  async overview(actor: CashActor, branchId: string) {
    const branch = await this.visibleBranch(actor, branchId);
    const session = await this.prisma.cashSession.findFirst({ where: { branchId }, orderBy: { openedAt: 'desc' } });
    const monthStart = startOfRiyadhMonth();
    const thisMonth = { gte: monthStart, lt: nextMonthStart(monthStart) };

    const [open, issued, returned] = await Promise.all([
      this.prisma.custody.aggregate({ where: { branchId, status: 'OPEN' }, _count: true, _sum: { amount: true } }),
      this.prisma.custody.aggregate({ where: { branchId, issuedAt: thisMonth }, _count: true, _sum: { amount: true } }),
      this.prisma.custody.aggregate({ where: { branchId, settledAt: thisMonth }, _sum: { returnedAmount: true } }),
    ]);

    const balance = session && (await this.balanceOf(this.prisma, session));
    return {
      branch,
      session: session && {
        ...session,
        // A drawer left open from an earlier day has to be closed before it can take new movements.
        isCurrent: session.status === 'OPEN' && dateOnly(session.businessDate) === riyadhToday(),
      },
      lines: balance && {
        opening: toSar(balance.opening),
        receipts: toSar(balance.receipts),
        refunds: toSar(balance.refunds),
        custodyIssued: toSar(balance.custodyIssued),
        custodyReturned: toSar(balance.custodyReturned),
        advancesIssued: toSar(balance.advancesIssued),
        advancesRepaid: toSar(balance.advancesRepaid),
        salariesPaid: toSar(balance.salariesPaid),
        expected: toSar(balance.expected),
      },
      stats: {
        openCount: open._count,
        openAmount: Number(open._sum.amount ?? 0),
        monthCount: issued._count,
        monthAmount: Number(issued._sum.amount ?? 0),
        monthReturned: Number(returned._sum.returnedAmount ?? 0),
      },
    };
  }

  async listCustodies(actor: CashActor, branchId: string, page = 1, limit = 20) {
    await this.visibleBranch(actor, branchId);
    const where = { branchId };
    const [items, total] = await Promise.all([
      this.prisma.custody.findMany({ where, select: CUSTODY_ROW, orderBy: { number: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.custody.count({ where }),
    ]);
    // Oldest first, because that is the one the page asks to settle next.
    const open = await this.prisma.custody.findMany({ where: { branchId, status: 'OPEN' }, select: CUSTODY_ROW, orderBy: { number: 'asc' }, take: 50 });
    return { items, open, total, page, limit };
  }

  async listSessions(actor: CashActor, branchId: string, page = 1, limit = 30) {
    await this.visibleBranch(actor, branchId);
    const where = { branchId };
    const [items, total] = await Promise.all([
      this.prisma.cashSession.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.cashSession.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  /** Who can receive a custody and which trips it can be charged to. */
  async custodyOptions() {
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const [recipients, trips] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: { not: 'PASSENGER' }, NOT: { driverProfile: { is: { isActive: false } } } },
        select: { id: true, name: true, phone: true, rank: { select: { job: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.trip.findMany({
        where: { tripStatus: { not: 'CANCELLED' }, departureTime: { gte: since } },
        select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true },
        orderBy: { departureTime: 'desc' },
        take: 200,
      }),
    ]);
    return { recipients: recipients.map(({ rank, ...user }) => ({ ...user, job: rank?.job.name ?? null })), trips };
  }

  async attachment(actor: CashActor, id: string) {
    const file = await this.prisma.custodyAttachment.findUnique({ where: { id }, include: { custody: { select: { branchId: true } } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    await this.assertBranchAccess(actor, file.custody.branchId);
    return file;
  }

  // ---------------------------------------------------------------- the drawer

  async openSession(actor: CashActor, branchId: string, dto: OpenSessionDto) {
    await this.assertBranchAccess(actor, branchId);
    return this.prisma.$transaction(async (tx) => {
      const branch = await this.lockBranch(tx, branchId);
      if (!branch.isActive) throw new ConflictException('هذا الفرع موقوف');
      const last = await tx.cashSession.findFirst({ where: { branchId }, orderBy: { openedAt: 'desc' } });
      if (last?.status === 'OPEN') throw new ConflictException('يوجد صندوق مفتوح لهذا الفرع، أقفله أولًا');

      const carried = last?.countedCash ?? null;
      // Cash that left between two days (a bank deposit, say) must be explained, or it would simply vanish from the books.
      const changed = carried !== null && toHalalas(carried) !== toHalalas(dto.openingBalance);
      const note = dto.note || null;
      if (changed && (note?.length ?? 0) < MIN_REASON_LENGTH) {
        throw new BadRequestException(`آخر إقفال كان ${formatSar(carried!)}. اكتب سبب اختلاف الرصيد الافتتاحي`);
      }

      const today = riyadhToday();
      const session = await tx.cashSession.create({
        data: {
          branchId,
          businessDate: new Date(`${today}T00:00:00.000Z`),
          openingBalance: dto.openingBalance,
          carriedBalance: carried,
          openingNote: note,
          openedById: actor.userId,
          openedByName: actor.name ?? null,
        },
      });
      if (changed) {
        await this.notifications.toStaff(tx, 'CASH_OPENING_CHANGED', ['cash.all_branches'], {
          senderName: actor.name ?? 'موظف',
          branchName: branch.name,
          amount: formatSar(dto.openingBalance),
          carriedAmount: formatSar(carried!),
        }, { exceptUserId: actor.userId });
      }
      return session;
    }, TX_OPTIONS);
  }

  async closeSession(actor: CashActor, sessionId: string, dto: CloseSessionDto) {
    const found = await this.prisma.cashSession.findUnique({ where: { id: sessionId }, select: { branchId: true } });
    if (!found) throw new NotFoundException('الصندوق غير موجود');
    await this.assertBranchAccess(actor, found.branchId);

    return this.prisma.$transaction(async (tx) => {
      const branch = await this.lockBranch(tx, found.branchId);
      const session = await tx.cashSession.findUniqueOrThrow({ where: { id: sessionId } });
      if (session.status !== 'OPEN') throw new ConflictException('تم إقفال هذا الصندوق مسبقًا');

      const { expected } = await this.balanceOf(tx, session);
      if (toHalalas(dto.expectedBalance) !== expected) {
        throw new ConflictException(`تغيرت حركة الصندوق أثناء الإقفال، والرصيد المتوقع الآن ${formatSar(toSar(expected))}. راجع النقد ثم أعد المحاولة`);
      }

      const counted = toHalalas(dto.countedCash);
      const difference = counted - expected;
      const note = dto.note || null;
      if (difference !== 0 && (note?.length ?? 0) < MIN_REASON_LENGTH) {
        throw new BadRequestException('يوجد فرق بين النقد الفعلي والمتوقع، اكتب سببه');
      }

      const closed = await tx.cashSession.update({
        where: { id: sessionId },
        data: {
          status: 'CLOSED',
          expectedBalance: toSar(expected),
          countedCash: toSar(counted),
          difference: toSar(difference),
          closeNote: note,
          closedById: actor.userId,
          closedByName: actor.name ?? null,
          closedAt: new Date(),
        },
      });
      if (difference !== 0) {
        await this.notifications.toStaff(tx, 'CASH_CLOSING_DIFFERENCE', ['cash.all_branches'], {
          senderName: actor.name ?? 'موظف',
          branchName: branch.name,
          businessDate: dateOnly(session.businessDate),
          differenceAmount: `${difference > 0 ? '+' : '-'}${formatSar(toSar(Math.abs(difference)))}`,
        }, { exceptUserId: actor.userId });
      }
      return closed;
    }, TX_OPTIONS);
  }

  // ---------------------------------------------------------------- custody

  async issueCustody(actor: CashActor, branchId: string, dto: IssueCustodyDto) {
    await this.assertBranchAccess(actor, branchId);
    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;

    return this.prisma.$transaction(async (tx) => {
      const branch = await this.lockBranch(tx, branchId);
      const repeated = await tx.custody.findUnique({ where: { idempotencyKey }, select: CUSTODY_ROW });
      if (repeated) return repeated;
      if (!branch.isActive) throw new ConflictException('هذا الفرع موقوف');

      const session = await this.currentSession(tx, branchId);
      const { expected } = await this.balanceOf(tx, session);
      if (toHalalas(dto.amount) > expected) {
        throw new ConflictException(`المبلغ أكبر من الرصيد المتوقع في الصندوق (${formatSar(toSar(expected))})`);
      }

      const recipient = await tx.user.findFirst({
        where: { id: dto.recipientId, role: { not: 'PASSENGER' }, NOT: { driverProfile: { is: { isActive: false } } } },
        select: { id: true, name: true, rank: { select: { job: { select: { name: true } } } } },
      });
      if (!recipient) throw new BadRequestException('لا تُصرف العهدة إلا لموظف أو سائق نشط');

      if (dto.tripId) {
        const trip = await tx.trip.findUnique({ where: { id: dto.tripId }, select: { tripStatus: true } });
        if (!trip) throw new BadRequestException('الرحلة غير موجودة');
        if (trip.tripStatus === 'CANCELLED') throw new ConflictException('لا تُصرف عهدة على رحلة ملغاة');
      }

      const custody = await tx.custody.create({
        data: {
          branchId,
          issuedSessionId: session.id,
          recipientId: recipient.id,
          recipientName: recipient.name,
          recipientJob: recipient.rank?.job.name ?? null,
          purpose: dto.purpose,
          tripId: dto.tripId,
          amount: dto.amount,
          idempotencyKey,
          issuedById: actor.userId,
          issuedByName: actor.name ?? null,
        },
        select: CUSTODY_ROW,
      });
      await this.addMovement(tx, actor, session.id, 'CUSTODY_ISSUE', dto.amount, { custodyId: custody.id });
      if (recipient.id !== actor.userId) {
        await this.notifications.toUser(tx, 'CUSTODY_ISSUED', recipient.id, {
          custodyNumber: custodyCode(custody.number),
          custodyPurpose: custody.purpose,
          amount: formatSar(dto.amount),
          branchName: branch.name,
        });
      }
      return custody;
    }, TX_OPTIONS);
  }

  async settleCustody(actor: CashActor, custodyId: string, dto: SettleCustodyDto, files: UploadedInvoice[] = []) {
    const invoices = readInvoiceFiles(files, actor.userId);

    const found = await this.prisma.custody.findUnique({ where: { id: custodyId }, select: { branchId: true } });
    if (!found) throw new NotFoundException('العهدة غير موجودة');
    await this.assertBranchAccess(actor, found.branchId);

    return this.prisma.$transaction(async (tx) => {
      const branch = await this.lockBranch(tx, found.branchId);
      // The holder may be adding an expense from the app at this very moment.
      await tx.$queryRaw`SELECT "id" FROM "Custody" WHERE "id" = ${custodyId} FOR UPDATE`;
      const custody = await tx.custody.findUniqueOrThrow({ where: { id: custodyId } });
      if (custody.status !== 'OPEN') throw new ConflictException('تمت تسوية هذه العهدة مسبقًا');
      // Whoever holds the money cannot approve their own spending; the owner has nobody above them to ask.
      if (custody.recipientId === actor.userId && actor.role !== 'ADMIN') {
        throw new ForbiddenException('لا يمكنك تسوية عهدة مصروفة باسمك، يسوّيها موظف آخر');
      }

      const total = toHalalas(custody.amount);
      const spent = toHalalas(dto.spentAmount);
      if (spent > total) throw new BadRequestException(`المصروف الفعلي أكبر من مبلغ العهدة (${formatSar(custody.amount)})`);
      const logged = await tx.custodyExpense.aggregate({ where: { custodyId, voidedAt: null }, _sum: { amount: true } });
      const loggedSpent = toHalalas(logged._sum.amount ?? 0);
      if (spent < loggedSpent) throw new BadRequestException(`المصروفات المسجّلة ${formatSar(toSar(loggedSpent))}، ألغِ ما لا تعتمده أولًا`);
      // Expenses from the app came with their invoices; only spending beyond them still needs one here.
      if (spent > loggedSpent && invoices.length === 0) throw new BadRequestException('أرفق فاتورة واحدة على الأقل للمصروف');
      const returned = total - spent;

      if (returned > 0) {
        // The returned cash physically goes back in the drawer, so today's drawer must be open to receive it.
        const session = await this.currentSession(tx, custody.branchId);
        await this.addMovement(tx, actor, session.id, 'CUSTODY_RETURN', toSar(returned), { custodyId: custody.id });
      }

      if (invoices.length) await tx.custodyAttachment.createMany({ data: invoices.map((invoice) => ({ ...invoice, custodyId: custody.id })) });
      const settled = await tx.custody.update({
        where: { id: custody.id },
        data: {
          status: 'SETTLED',
          spentAmount: toSar(spent),
          returnedAmount: toSar(returned),
          settlementNote: dto.note || null,
          settledById: actor.userId,
          settledByName: actor.name ?? null,
          settledAt: new Date(),
        },
        select: CUSTODY_ROW,
      });
      if (custody.recipientId !== actor.userId) {
        await this.notifications.toUser(tx, 'CUSTODY_SETTLED', custody.recipientId, {
          custodyNumber: custodyCode(custody.number),
          custodyPurpose: custody.purpose,
          amount: formatSar(custody.amount),
          spentAmount: formatSar(toSar(spent)),
          returnedAmount: formatSar(toSar(returned)),
          branchName: branch.name,
        });
      }
      return settled;
    }, TX_OPTIONS);
  }

  // ---------------------------------------------------------------- booking cash

  /** Locks a branch and returns the drawer that can take money today. Take this before locking a booking. */
  async openDrawer(tx: Db, branchId: string) {
    await this.lockBranch(tx, branchId);
    return this.currentSession(tx, branchId);
  }

  /**
   * Cash handed back for a cancelled booking. Every refund already made in any other way counts
   * against what the customer paid, so the same money cannot be refunded twice.
   */
  async recordBookingRefund(tx: Db, actor: CashActor, input: { branchId: string; bookingId: string; amount: number }) {
    await this.lockBranch(tx, input.branchId);
    const session = await this.currentSession(tx, input.branchId);
    await this.events.lock(tx, input.bookingId);
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: input.bookingId },
      include: { payment: true, collections: { select: { amount: true } }, cashMovements: { where: { type: 'BOOKING_REFUND' }, select: { amount: true } } },
    });
    if (booking.status !== 'CANCELLED') throw new ConflictException('يُسترد النقد بعد إلغاء الحجز');

    const { received, wallet } = paymentFigures(booking.payment, booking.collections);
    const cashRefunded = booking.cashMovements.reduce((sum, row) => sum + halalas(row.amount), 0);
    const unrefunded = received + wallet - halalas(booking.refundAmount ?? 0) - halalas(booking.externalRefunded) - cashRefunded;
    const refundable = Math.min(await this.netCashOf(tx, booking.id), unrefunded);
    const amount = toHalalas(input.amount);
    if (amount <= 0 || amount > refundable) {
      throw new BadRequestException(`الحد الأقصى للاسترداد النقدي من هذا الحجز ${formatSar(toSar(Math.max(0, refundable)))}`);
    }
    const { expected } = await this.balanceOf(tx, session);
    if (amount > expected) throw new ConflictException(`المبلغ أكبر من الرصيد المتوقع في الصندوق (${formatSar(toSar(expected))})`);

    await this.addMovement(tx, actor, session.id, 'BOOKING_REFUND', input.amount, { bookingId: booking.id });
    await this.invoices.credit(tx, { bookingId: booking.id, amount, reason: 'استرداد نقدي', actorId: actor.userId });
  }

  // ---------------------------------------------------------------- internals

  addMovement(tx: Db, actor: CashActor, sessionId: string, type: CashMovementType, amount: number, link: { custodyId?: string; bookingId?: string }) {
    return tx.cashMovement.create({ data: { sessionId, type, amount, ...link, createdById: actor.userId, createdByName: actor.name ?? null } });
  }

  /** The balance is always summed from the ledger and never stored while the drawer is open, so it cannot drift from it. */
  private async balanceOf(db: Db, session: Pick<CashSession, 'id' | 'openingBalance'>) {
    const groups = await db.cashMovement.groupBy({ by: ['type'], where: { sessionId: session.id }, _sum: { amount: true } });
    const sum = (type: CashMovementType) => toHalalas(groups.find((group) => group.type === type)?._sum.amount ?? 0);
    const opening = toHalalas(session.openingBalance);
    const receipts = sum('BOOKING_RECEIPT');
    const refunds = sum('BOOKING_REFUND');
    const custodyIssued = sum('CUSTODY_ISSUE');
    const custodyReturned = sum('CUSTODY_RETURN');
    const advancesIssued = sum('ADVANCE_ISSUE');
    const advancesRepaid = sum('ADVANCE_REPAYMENT');
    const salariesPaid = sum('SALARY_PAYMENT');
    return {
      opening,
      receipts,
      refunds,
      custodyIssued,
      custodyReturned,
      advancesIssued,
      advancesRepaid,
      salariesPaid,
      expected: opening + receipts - refunds - custodyIssued + custodyReturned - advancesIssued + advancesRepaid - salariesPaid,
    };
  }

  private async netCashOf(db: Db, bookingId: string) {
    const groups = await db.cashMovement.groupBy({ by: ['type'], where: { bookingId }, _sum: { amount: true } });
    const sum = (type: CashMovementType) => toHalalas(groups.find((group) => group.type === type)?._sum.amount ?? 0);
    return sum('BOOKING_RECEIPT') - sum('BOOKING_REFUND');
  }

  private async currentSession(db: Db, branchId: string) {
    const session = await db.cashSession.findFirst({ where: { branchId, status: 'OPEN' } });
    if (!session) throw new ConflictException('الصندوق مغلق، افتح صندوق اليوم أولًا');
    const date = dateOnly(session.businessDate);
    if (date !== riyadhToday()) throw new ConflictException(`صندوق يوم ${date} ما زال مفتوحًا، أقفله ثم افتح صندوق اليوم`);
    return session;
  }

  /** Every write to a branch's money takes this first, so balance checks cannot race each other. */
  private async lockBranch(tx: Db, branchId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    return branch;
  }

  private async visibleBranch(actor: CashActor, branchId: string) {
    await this.assertBranchAccess(actor, branchId);
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    return branch;
  }

  /**
   * One person's custodies across the branches the caller may see, open ones first, with what is still in their
   * hands: the amount less the expenses they logged that nobody refused.
   */
  async custodiesOf(actor: CashActor, recipientId: string) {
    let branchFilter: Prisma.CustodyWhereInput = {};
    if (!actor.permissions.includes('cash.all_branches')) {
      const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
      branchFilter = { branchId: me?.branchId ?? '__none__' };
    }
    const rows = await this.prisma.custody.findMany({
      where: { recipientId, ...branchFilter },
      orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
      take: 100,
      select: { ...CUSTODY_ROW, branch: { select: { id: true, name: true } } },
    });
    const logged = (row: (typeof rows)[number]) => row.expenses.filter((expense) => !expense.voidedAt).reduce((sum, expense) => sum + toHalalas(expense.amount), 0);
    const items = rows.map((row) => ({ ...row, code: custodyCode(row.number), remaining: row.status === 'OPEN' ? toSar(toHalalas(row.amount) - logged(row)) : 0 }));
    const open = items.filter((row) => row.status === 'OPEN');
    return {
      items,
      summary: {
        openCount: open.length,
        openAmount: toSar(open.reduce((sum, row) => sum + toHalalas(row.amount), 0)),
        inHand: toSar(open.reduce((sum, row) => sum + toHalalas(row.remaining), 0)),
        totalIssued: toSar(items.reduce((sum, row) => sum + toHalalas(row.amount), 0)),
        totalSpent: toSar(items.filter((row) => row.status === 'SETTLED').reduce((sum, row) => sum + toHalalas(row.spentAmount ?? 0), 0)),
      },
      // Branches seen by the caller: a custody elsewhere is not shown, and the page says so.
      limitedToBranch: !actor.permissions.includes('cash.all_branches'),
    };
  }

  /**
   * Cash paid out of, or back into, today's drawer for HR: an advance, its repayment, or a salary. It takes the
   * branch lock like every other drawer write, and money out cannot exceed what the drawer should hold.
   */
  async hrMovement(tx: Db, actor: CashActor, branchId: string, type: 'ADVANCE_ISSUE' | 'ADVANCE_REPAYMENT' | 'SALARY_PAYMENT', amount: number, link: { advanceId?: string; employeeId?: string }) {
    if (!actor.permissions.includes('cash.operate')) throw new ForbiddenException('الصرف من الصندوق يحتاج صلاحية تشغيل الصندوق');
    await this.assertBranchAccess(actor, branchId);
    const branch = await this.lockBranch(tx, branchId);
    if (!branch.isActive) throw new ConflictException('هذا الفرع موقوف');
    const session = await this.currentSession(tx, branchId);
    if (type !== 'ADVANCE_REPAYMENT') {
      const { expected } = await this.balanceOf(tx, session);
      if (toHalalas(amount) > expected) throw new ConflictException(`المبلغ أكبر من الرصيد المتوقع في صندوق ${branch.name} (${formatSar(toSar(expected))})`);
    }
    await tx.cashMovement.create({ data: { sessionId: session.id, type, amount, ...link, createdById: actor.userId, createdByName: actor.name ?? null } });
    return session;
  }

  /** The assigned branch is read from the database, so moving an employee applies immediately. */
  async assertBranchAccess(actor: CashActor, branchId: string) {
    if (actor.permissions.includes('cash.all_branches')) return;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    if (me?.branchId !== branchId) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
  }
}

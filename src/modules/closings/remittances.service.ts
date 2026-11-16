import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RemittanceMethod, RemittanceStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { formatSar, NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { RedisService } from '../../common/services/redis.service';
import { WhatsAppService } from '../../common/services/whatsapp.service';
import { halalas } from '../../common/utils/payment.util';
import { riyadhDate, riyadhMonthRange } from '../../common/utils/time.util';
import { toHalalas, toSar } from '../bookings/bookings.service';
import { CashActor, CashService, readInvoiceFiles, UploadedInvoice } from '../cash/cash.service';
import { CreateRemittanceDto, RemittancesQuery } from './settlement.dto';

const PAGE_SIZE = 30;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const CODE_TTL_SECONDS = 10 * 60;
const CODE_MAX_ATTEMPTS = 5;
const sar = (value: number) => Math.round(value) / 100;

export const remittanceCode = (number: number) => `TR-${String(number).padStart(4, '0')}`;
export const REMITTANCE_METHOD_LABELS: Record<RemittanceMethod, string> = { BANK_DEPOSIT: 'إيداع بنكي', CASH_HANDOVER: 'تسليم نقدي للمالك' };
export const REMITTANCE_STATUS_LABELS: Record<RemittanceStatus, string> = {
  PENDING: 'بانتظار التأكيد',
  RECEIVED: 'مستلَم',
  MATCHED: 'مطابق للبنك',
  DIFFERENCE: 'فرق',
  REJECTED: 'لم يُستلم',
  CANCELLED: 'مسحوب',
};

/** Statuses whose money left the drawers: everything but a withdrawn remittance. */
const LIVE: RemittanceStatus[] = ['PENDING', 'RECEIVED', 'MATCHED', 'DIFFERENCE', 'REJECTED'];
/** Statuses where the owner or the bank has the money in hand. */
const CONFIRMED: RemittanceStatus[] = ['RECEIVED', 'MATCHED', 'DIFFERENCE'];

const ROW_SELECT = {
  id: true,
  number: true,
  branchId: true,
  branch: { select: { name: true } },
  method: true,
  amount: true,
  fromDate: true,
  toDate: true,
  status: true,
  receivedAmount: true,
  difference: true,
  note: true,
  createdById: true,
  createdByName: true,
  createdAt: true,
  confirmedVia: true,
  confirmedByName: true,
  confirmedAt: true,
  rejectReason: true,
  justification: true,
  justifiedByName: true,
  justifiedAt: true,
  cancelledByName: true,
  cancelReason: true,
  attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' as const } },
  _count: { select: { sessions: true } },
} satisfies Prisma.CashRemittanceSelect;

type Row = Prisma.CashRemittanceGetPayload<{ select: typeof ROW_SELECT }>;

const shape = (row: Row) => ({
  id: row.id,
  number: row.number,
  code: remittanceCode(row.number),
  branchId: row.branchId,
  branchName: row.branch.name,
  method: row.method,
  methodLabel: REMITTANCE_METHOD_LABELS[row.method],
  amount: Number(row.amount),
  fromDate: row.fromDate.toISOString().slice(0, 10),
  toDate: row.toDate.toISOString().slice(0, 10),
  sessions: row._count.sessions,
  status: row.status,
  statusLabel: REMITTANCE_STATUS_LABELS[row.status],
  receivedAmount: row.receivedAmount === null ? null : Number(row.receivedAmount),
  difference: row.difference === null ? null : Number(row.difference),
  /** A difference or a refusal nobody has explained yet: it stays on whoever made the remittance. */
  unexplained: (row.status === 'DIFFERENCE' || row.status === 'REJECTED') && !row.justifiedAt,
  note: row.note,
  createdById: row.createdById,
  createdByName: row.createdByName,
  createdAt: row.createdAt,
  confirmedVia: row.confirmedVia,
  confirmedByName: row.confirmedByName,
  confirmedAt: row.confirmedAt,
  rejectReason: row.rejectReason,
  justification: row.justification,
  justifiedByName: row.justifiedByName,
  justifiedAt: row.justifiedAt,
  cancelledByName: row.cancelledByName,
  cancelReason: row.cancelReason,
  attachments: row.attachments,
});

/**
 * Cash taken out of a branch's closed drawers for the owner or the bank (التوريد). Only closed drawers are remitted, each
 * once; the money counts as received only after the owner confirms it from his phone or the bank statement shows it, and a
 * gap between declared and received stays on whoever made the remittance until someone explains it.
 */
@Injectable()
export class RemittancesService {
  constructor(
    private prisma: PrismaService,
    private cash: CashService,
    private notifications: NotificationsService,
    private redis: RedisService,
    private whatsapp: WhatsAppService,
    private config: ConfigService,
  ) {}

  // ───────────────────────────── reading ─────────────────────────────

  /** The branches whose remittances the caller may see: every branch for the owner and the accounts, otherwise their own. */
  private async visibleBranchIds(actor: CashActor): Promise<string[] | null> {
    if (['cash.all_branches', 'owner.confirm', 'remittances.match'].some((permission) => actor.permissions.includes(permission))) return null;
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { branchId: true } });
    return me?.branchId ? [me.branchId] : [];
  }

  async list(actor: CashActor, query: RemittancesQuery) {
    const visible = await this.visibleBranchIds(actor);
    if (query.branchId && visible && !visible.includes(query.branchId)) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    const where: Prisma.CashRemittanceWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : visible ? { branchId: { in: visible } } : {}),
      ...(query.status && { status: query.status }),
    };
    const page = query.page ?? 1;
    const [rows, total] = await Promise.all([
      this.prisma.cashRemittance.findMany({ where, orderBy: { number: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: ROW_SELECT }),
      this.prisma.cashRemittance.count({ where }),
    ]);
    return { page, pageSize: PAGE_SIZE, total, items: rows.map(shape) };
  }

  async get(actor: CashActor, id: string) {
    const row = await this.prisma.cashRemittance.findUnique({ where: { id }, select: { ...ROW_SELECT, sessions: { select: { amount: true, session: { select: { businessDate: true } } } } } });
    if (!row) throw new NotFoundException('التوريد غير موجود');
    const visible = await this.visibleBranchIds(actor);
    if (visible && !visible.includes(row.branchId)) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    return {
      ...shape(row),
      drawers: row.sessions
        .map((item) => ({ businessDate: item.session.businessDate.toISOString().slice(0, 10), amount: Number(item.amount) }))
        .sort((a, b) => a.businessDate.localeCompare(b.businessDate)),
    };
  }

  /** A branch's closed drawers not yet remitted, for the new-remittance form. */
  async unremitted(actor: CashActor, branchId: string) {
    await this.cash.assertBranchAccess(actor, branchId);
    const sessions = await this.cash.unremittedSessions(this.prisma, branchId);
    return {
      sessions: sessions.map((session) => ({ id: session.id, businessDate: session.businessDate, amount: toSar(session.net) })).reverse(),
      total: toSar(sessions.reduce((sum, session) => sum + session.net, 0)),
    };
  }

  /** The numbers above the remittances register: cash waiting in drawers, waiting for the owner, received, and what went to the bank directly. */
  async summary(actor: CashActor, month = riyadhDate(new Date()).slice(0, 7)) {
    const visible = await this.visibleBranchIds(actor);
    const branches = await this.prisma.branch.findMany({ where: { ...(visible && { id: { in: visible } }) }, select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } });
    const range = riyadhMonthRange(month);
    const branchFilter = visible ? { branchId: { in: visible } } : {};
    const [waiting, pending, received, staffBank, online] = await Promise.all([
      Promise.all(branches.map(async (branch) => ({ branch, sessions: await this.cash.unremittedSessions(this.prisma, branch.id) }))),
      this.prisma.cashRemittance.aggregate({ where: { ...branchFilter, status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      this.prisma.cashRemittance.groupBy({ by: ['method'], where: { ...branchFilter, status: { in: CONFIRMED }, confirmedAt: range }, _sum: { receivedAmount: true } }),
      this.prisma.bookingCollection.aggregate({ where: { ...branchFilter, method: { in: ['NETWORK', 'TRANSFER'] }, createdAt: range }, _sum: { amount: true } }),
      visible ? null : this.prisma.paymentTransaction.aggregate({ where: { type: 'CHARGE', status: 'SUCCEEDED', processedById: null, createdAt: range }, _sum: { amount: true } }),
    ]);
    const byBranch = waiting
      .map(({ branch, sessions }) => ({
        branchId: branch.id,
        branchName: branch.name,
        amount: toSar(sessions.reduce((sum, session) => sum + session.net, 0)),
        oldest: sessions[0]?.businessDate ?? null,
        drawers: sessions.length,
      }))
      .filter((row) => row.drawers > 0);
    const receivedOf = (method: RemittanceMethod) => halalas(received.find((row) => row.method === method)?._sum.receivedAmount ?? 0);
    return {
      month,
      unremitted: { amount: sar(byBranch.reduce((sum, row) => sum + toHalalas(row.amount), 0)), branches: byBranch.sort((a, b) => b.amount - a.amount) },
      pending: { amount: Number(pending._sum.amount ?? 0), count: pending._count },
      received: { amount: sar(receivedOf('CASH_HANDOVER') + receivedOf('BANK_DEPOSIT')), cash: sar(receivedOf('CASH_HANDOVER')), bank: sar(receivedOf('BANK_DEPOSIT')) },
      bankDirect: {
        amount: sar(halalas(staffBank._sum.amount ?? 0) + halalas(online?._sum.amount ?? 0)),
        network: Number(staffBank._sum.amount ?? 0),
        online: Number(online?._sum.amount ?? 0),
        gatewayLive: this.gatewayLive(),
      },
      codeRequired: await this.codeRequired(),
    };
  }

  /** Until the payment gateway ships, the app's payments are simulated and nothing reaches the bank through it. */
  gatewayLive() {
    return this.config.get('PAYMENT_MODE') !== 'simulated';
  }

  async attachment(actor: CashActor, id: string) {
    const file = await this.prisma.cashRemittanceAttachment.findUnique({ where: { id }, include: { remittance: { select: { branchId: true } } } });
    if (!file) throw new NotFoundException('الملف غير موجود');
    const visible = await this.visibleBranchIds(actor);
    if (visible && !visible.includes(file.remittance.branchId)) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    return file;
  }

  // ───────────────────────────── creating and withdrawing ─────────────────────────────

  async create(actor: CashActor, dto: CreateRemittanceDto, files: UploadedInvoice[] = []) {
    await this.cash.assertBranchAccess(actor, dto.branchId);
    const idempotencyKey = `${actor.userId}:${dto.idempotencyKey}`;
    const repeated = await this.prisma.cashRemittance.findUnique({ where: { idempotencyKey }, select: ROW_SELECT });
    if (repeated) return shape(repeated);
    // A deposit is proven by its slip; cash in hand is proven by the owner's confirmation.
    if (dto.method === 'BANK_DEPOSIT' && files.length === 0) throw new BadRequestException('ارفع صورة إيصال الإيداع');
    const receipts = readInvoiceFiles(files, actor.userId);

    const saved = await this.prisma.$transaction(async (tx) => {
      const branch = await this.cash.lockBranchFor(tx, dto.branchId);
      const waiting = await this.cash.unremittedSessions(tx, dto.branchId);
      const chosen = dto.sessionIds ? waiting.filter((session) => dto.sessionIds!.includes(session.id)) : waiting;
      if (dto.sessionIds && chosen.length !== new Set(dto.sessionIds).size) throw new ConflictException('بعض الصناديق المختارة وُرّدت أو لم تُقفل بعد، حدّث الصفحة');
      if (chosen.length === 0) throw new ConflictException('لا توجد صناديق مقفلة لم تُورَّد في هذا الفرع');
      const amount = chosen.reduce((sum, session) => sum + session.net, 0);
      if (amount <= 0) throw new ConflictException('صافي الصناديق المختارة لا يكفي لتوريد');

      const row = await tx.cashRemittance.create({
        data: {
          branchId: dto.branchId,
          method: dto.method,
          amount: toSar(amount),
          fromDate: new Date(`${chosen[0].businessDate}T00:00:00Z`),
          toDate: new Date(`${chosen[chosen.length - 1].businessDate}T00:00:00Z`),
          note: dto.note || null,
          idempotencyKey,
          createdById: actor.userId,
          createdByName: actor.name ?? null,
          sessions: { create: chosen.map((session) => ({ sessionId: session.id, amount: toSar(session.net) })) },
          ...(receipts.length && { attachments: { create: receipts } }),
        },
        select: ROW_SELECT,
      });
      // Earlier days' cash sits in today's open drawer, so it leaves through it; with no drawer open it simply leaves the
      // safe, and the next opening balance is expected without it.
      const drawer = await this.cash.todaysDrawer(tx, dto.branchId);
      if (drawer) await this.cash.ledgerMovement(tx, actor, dto.branchId, 'REMITTANCE_OUT', toSar(amount), { remittanceId: row.id }, drawer);

      await this.notifications.toStaff(tx, 'REMITTANCE_SUBMITTED', ['owner.confirm'], {
        senderName: actor.name ?? 'موظف',
        branchName: branch.name,
        remittanceNumber: remittanceCode(row.number),
        remittanceMethod: REMITTANCE_METHOD_LABELS[dto.method],
        amount: formatSar(toSar(amount)),
      }, { exceptUserId: actor.userId });
      return row;
    }, TX_OPTIONS).catch((err) => {
      // Two identical submits raced; the winner's remittance is the answer to both.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.cashRemittance.findUnique({ where: { idempotencyKey }, select: ROW_SELECT }).then((winner) => {
          if (winner) return winner;
          throw new ConflictException('أحد الصناديق المختارة وُرّد للتو، حدّث الصفحة');
        });
      }
      throw err;
    });
    return shape(saved);
  }

  /** Withdrawn before anyone confirmed it: its drawers are free to remit again and its cash goes back where it came from. */
  async cancel(actor: CashActor, id: string, reason: string) {
    const found = await this.prisma.cashRemittance.findUnique({ where: { id }, select: { branchId: true, createdById: true } });
    if (!found) throw new NotFoundException('التوريد غير موجود');
    if (found.createdById !== actor.userId && !actor.permissions.includes('remittances.match')) throw new ForbiddenException('يسحب التوريد من أنشأه أو المحاسب');
    await this.cash.assertBranchAccess(actor, found.branchId).catch((err) => {
      if (!actor.permissions.includes('remittances.match')) throw err;
    });

    return this.prisma.$transaction(async (tx) => {
      await this.cash.lockBranchFor(tx, found.branchId);
      const row = await tx.cashRemittance.findUniqueOrThrow({ where: { id }, select: { status: true, amount: true, createdAt: true } });
      if (row.status !== 'PENDING') throw new ConflictException('لا يُسحب توريد بعد تأكيده أو رفضه');
      const [movedOut, drawerSince] = await Promise.all([
        tx.cashMovement.count({ where: { remittanceId: id, type: 'REMITTANCE_OUT' } }),
        tx.cashSession.count({ where: { branchId: found.branchId, openedAt: { gt: row.createdAt } } }),
      ]);
      // Once a drawer counted it gone, the cash has to come back through a drawer too.
      if (movedOut || drawerSince) {
        const drawer = await this.cash.todaysDrawer(tx, found.branchId);
        if (!drawer) throw new ConflictException('افتح صندوق اليوم ليعود مبلغ التوريد إليه');
        await this.cash.ledgerMovement(tx, actor, found.branchId, 'REMITTANCE_RETURN', Number(row.amount), { remittanceId: id }, drawer);
      }
      await tx.remittedSession.deleteMany({ where: { remittanceId: id } });
      await tx.cashRemittance.update({ where: { id }, data: { status: 'CANCELLED', cancelledByName: actor.name ?? null, cancelReason: reason } });
      return { success: true };
    }, TX_OPTIONS);
  }

  // ───────────────────────────── the owner ─────────────────────────────

  /** A WhatsApp code is asked for only once the code template is live; until then the owner's own login is the proof. */
  async codeRequired() {
    if (this.config.get('OTP_DEV_ECHO') === 'true') return true;
    return this.whatsapp.isOtpConfigured().catch(() => false);
  }

  private codeKey(userId: string, id: string) {
    return `remit_code:${userId}:${id}`;
  }

  private hash(userId: string, id: string, code: string) {
    return crypto.createHash('sha256').update(`${userId}:${id}:${code}`).digest('hex');
  }

  /** Sends the owner a code on WhatsApp to confirm or refuse this remittance. */
  async sendCode(actor: CashActor, id: string) {
    const row = await this.prisma.cashRemittance.findUnique({ where: { id }, select: { status: true } });
    if (!row) throw new NotFoundException('التوريد غير موجود');
    if (row.status !== 'PENDING') throw new ConflictException('هذا التوريد ليس بانتظار التأكيد');
    if (!(await this.codeRequired())) return { sent: false, required: false };
    const me = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { phone: true } });
    if (!me?.phone) throw new ConflictException('لا يوجد رقم جوال في حسابك لإرسال الرمز');
    if (!(await this.redis.setnx(`${this.codeKey(actor.userId, id)}:cooldown`, '1', 60))) throw new ConflictException('انتظر دقيقة قبل طلب رمز جديد');
    const code = crypto.randomInt(1000, 10000).toString();
    await this.redis.set(this.codeKey(actor.userId, id), this.hash(actor.userId, id, code), CODE_TTL_SECONDS);
    await this.redis.del(`${this.codeKey(actor.userId, id)}:attempts`);
    if (this.config.get('OTP_DEV_ECHO') === 'true') return { sent: true, required: true, devCode: code };
    await this.whatsapp.sendOtp(me.phone, code);
    return { sent: true, required: true };
  }

  /** Checks and spends the code; returns how the owner proved it was them. */
  private async proveOwner(actor: CashActor, id: string, code?: string) {
    if (!(await this.codeRequired())) return 'OWNER';
    if (!code) throw new BadRequestException('اكتب الرمز الذي وصلك على واتساب');
    const key = this.codeKey(actor.userId, id);
    if ((await this.redis.incr(`${key}:attempts`, CODE_TTL_SECONDS)) > CODE_MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new ConflictException('تجاوزت عدد المحاولات، اطلب رمزًا جديدًا');
    }
    const stored = await this.redis.get(key);
    if (!stored) throw new ConflictException('انتهت صلاحية الرمز، اطلب رمزًا جديدًا');
    const given = Buffer.from(this.hash(actor.userId, id, code));
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, Buffer.from(stored))) throw new BadRequestException('الرمز غير صحيح');
    await this.redis.del(key);
    return 'OWNER_CODE';
  }

  /** The owner confirms the money reached him; a smaller amount is recorded as a difference on whoever made it. */
  async confirm(actor: CashActor, id: string, dto: { receivedAmount?: number; code?: string }) {
    const via = await this.proveOwner(actor, id, dto.code);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.cashRemittance.findUnique({ where: { id }, select: { status: true, amount: true, number: true, createdById: true, branch: { select: { name: true } } } });
      if (!row) throw new NotFoundException('التوريد غير موجود');
      if (row.status !== 'PENDING') throw new ConflictException('هذا التوريد ليس بانتظار التأكيد');
      const received = toHalalas(dto.receivedAmount ?? Number(row.amount));
      const difference = received - toHalalas(row.amount);
      await tx.cashRemittance.update({
        where: { id },
        data: {
          status: difference === 0 ? 'RECEIVED' : 'DIFFERENCE',
          receivedAmount: toSar(received),
          difference: toSar(difference),
          confirmedVia: via,
          confirmedById: actor.userId,
          confirmedByName: actor.name ?? null,
          confirmedAt: new Date(),
        },
      });
      if (difference !== 0) await this.notifyDifference(tx, row, difference);
      return { success: true };
    }, TX_OPTIONS);
  }

  /** The owner says nothing reached him: the whole amount stays on whoever made the remittance until explained. */
  async reject(actor: CashActor, id: string, dto: { reason: string; code?: string }) {
    const via = await this.proveOwner(actor, id, dto.code);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.cashRemittance.findUnique({ where: { id }, select: { status: true, amount: true, number: true, createdById: true, branch: { select: { name: true } } } });
      if (!row) throw new NotFoundException('التوريد غير موجود');
      if (row.status !== 'PENDING') throw new ConflictException('هذا التوريد ليس بانتظار التأكيد');
      await tx.cashRemittance.update({
        where: { id },
        data: {
          status: 'REJECTED',
          receivedAmount: 0,
          difference: toSar(-toHalalas(row.amount)),
          rejectReason: dto.reason,
          confirmedVia: via,
          confirmedById: actor.userId,
          confirmedByName: actor.name ?? null,
          confirmedAt: new Date(),
        },
      });
      const values = { senderName: actor.name ?? 'المالك', branchName: row.branch.name, remittanceNumber: remittanceCode(row.number), amount: formatSar(Number(row.amount)), rejectReason: dto.reason };
      await this.notifications.toUser(tx, 'REMITTANCE_REJECTED', row.createdById, values);
      await this.notifications.toStaff(tx, 'REMITTANCE_REJECTED', ['remittances.match'], values, { exceptUserId: row.createdById });
      return { success: true };
    }, TX_OPTIONS);
  }

  // ───────────────────────────── the accounts ─────────────────────────────

  /** A deposit checked against the bank statement: the amount the bank shows settles it, and any gap is a difference. */
  async match(actor: CashActor, id: string, bankAmount: number) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.cashRemittance.findUnique({ where: { id }, select: { status: true, method: true, amount: true, number: true, createdById: true, branch: { select: { name: true } } } });
      if (!row) throw new NotFoundException('التوريد غير موجود');
      if (row.method !== 'BANK_DEPOSIT') throw new ConflictException('المطابقة مع البنك للإيداعات البنكية فقط');
      if (row.status !== 'PENDING' && row.status !== 'RECEIVED') throw new ConflictException('هذا التوريد طوبق أو أُغلق مسبقًا');
      const difference = toHalalas(bankAmount) - toHalalas(row.amount);
      await tx.cashRemittance.update({
        where: { id },
        data: {
          status: difference === 0 ? 'MATCHED' : 'DIFFERENCE',
          receivedAmount: bankAmount,
          difference: toSar(difference),
          confirmedVia: 'BANK',
          confirmedById: actor.userId,
          confirmedByName: actor.name ?? null,
          confirmedAt: new Date(),
        },
      });
      if (difference !== 0) await this.notifyDifference(tx, row, difference);
      return { success: true };
    }, TX_OPTIONS);
  }

  /** Someone explains a difference or a refusal; it then stops counting against whoever made the remittance. */
  async justify(actor: CashActor, id: string, reason: string) {
    const updated = await this.prisma.cashRemittance.updateMany({
      where: { id, status: { in: ['DIFFERENCE', 'REJECTED'] }, justifiedAt: null },
      data: { justification: reason, justifiedByName: actor.name ?? null, justifiedAt: new Date() },
    });
    if (updated.count === 0) {
      if (!(await this.prisma.cashRemittance.count({ where: { id } }))) throw new NotFoundException('التوريد غير موجود');
      throw new ConflictException('لا يوجد فرق مفتوح على هذا التوريد');
    }
    return { success: true };
  }

  private async notifyDifference(tx: Prisma.TransactionClient, row: { number: number; amount: Prisma.Decimal; createdById: string; branch: { name: string } }, difference: number) {
    const values = {
      branchName: row.branch.name,
      remittanceNumber: remittanceCode(row.number),
      amount: formatSar(Number(row.amount)),
      differenceAmount: `${difference > 0 ? '+' : '-'}${formatSar(toSar(Math.abs(difference)))}`,
    };
    await this.notifications.toUser(tx, 'REMITTANCE_DIFFERENCE', row.createdById, values);
    await this.notifications.toStaff(tx, 'REMITTANCE_DIFFERENCE', ['remittances.match', 'owner.confirm'], values, { exceptUserId: row.createdById });
  }

  // ───────────────────────────── for the settlement ─────────────────────────────

  /** Each branch's remittances made in a period (halalas), whatever came of them, and those still unexplained. */
  async periodFigures(range: { gte: Date; lt: Date }) {
    const [made, open, unexplained] = await Promise.all([
      this.prisma.cashRemittance.groupBy({ by: ['branchId'], where: { status: { in: LIVE }, createdAt: range }, _sum: { amount: true } }),
      this.prisma.cashRemittance.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      this.prisma.cashRemittance.count({ where: { status: { in: ['DIFFERENCE', 'REJECTED'] }, justifiedAt: null } }),
    ]);
    return {
      byBranch: new Map(made.map((row) => [row.branchId, halalas(row._sum.amount ?? 0)])),
      pending: { count: open._count, amount: halalas(open._sum.amount ?? 0) },
      unexplained,
    };
  }
}

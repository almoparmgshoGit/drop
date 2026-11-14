import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtimeService } from '../../common/services/realtime.service';
import { customerComplaintReference } from '../complaints/complaints.service';
import { complaintReference } from '../hotels/hotels.service';
import type { UserActor } from './users.service';

const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
const MAX_GROUPS = 50;
const MAX_CANDIDATES = 20;

export type DuplicateReason = 'idNumber' | 'phone' | 'name';

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  idNumber: 'نفس رقم الهوية',
  phone: 'نفس رقم الجوال',
  name: 'اسم متطابق أو متشابه',
};

/** What staff compare before choosing which account stays. */
const CANDIDATE_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  idType: true,
  idNumber: true,
  nationality: true,
  city: true,
  gender: true,
  birthDate: true,
  walletBalance: true,
  walletTransportBalance: true,
  loyaltyPoints: true,
  blockedAt: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { bookings: true, customerComplaints: true } },
} satisfies Prisma.UserSelect;

type CandidateRow = Prisma.UserGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const candidate = ({ _count, ...user }: CandidateRow) => ({ ...user, bookingCount: _count.bookings, complaintCount: _count.customerComplaints });

/**
 * One way of spelling a name, so "أحمد  محمد" and "احمد محمد" read as the same person: hamzas, taa marbuta and alif
 * maqsura are folded and spaces collapsed. Written once for SQL, and the same in TypeScript for the reasons shown.
 */
const NAME_KEY_SQL = Prisma.sql`lower(regexp_replace(translate(btrim(coalesce(u."name", '')), 'أإآةى', 'اااهي'), '\\s+', ' ', 'g'))`;
/** The last nine digits of the mobile, however it was stored. */
const PHONE_KEY_SQL = Prisma.sql`right(regexp_replace(u."phone", '\\D', '', 'g'), 9)`;

const nameKey = (name: string | null) =>
  (name ?? '').trim().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').toLowerCase();

const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-9);

/** First and last word of a name, for "أحمد محمد علي" matching "أحمد علي". */
const nameEnds = (name: string | null) => {
  const words = nameKey(name).split(' ').filter(Boolean);
  return words.length >= 2 ? [words[0], words[words.length - 1]] : null;
};

/** Customers who are still their own account: not staff and not already merged away. */
const ACTIVE_CUSTOMER_SQL = Prisma.sql`u."role" = 'PASSENGER' AND u."mergedIntoId" IS NULL`;

@Injectable()
export class CustomerMergeService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
  ) {}

  /**
   * Groups of customer accounts that look like one person: the same ID number (under different document types), the same
   * mobile written differently, or the same name once spelling is folded. A name group needs a name of two words or more.
   */
  async duplicateGroups(reason?: DuplicateReason) {
    const reasons: DuplicateReason[] = reason ? [reason] : ['idNumber', 'phone', 'name'];
    const groups: { reason: DuplicateReason; key: string; ids: string[] }[] = [];
    for (const kind of reasons) {
      const key =
        kind === 'idNumber' ? Prisma.sql`u."idNumber"` : kind === 'phone' ? PHONE_KEY_SQL : NAME_KEY_SQL;
      const extra =
        kind === 'idNumber'
          ? Prisma.sql`AND u."idNumber" IS NOT NULL`
          : kind === 'name'
            ? Prisma.sql`AND position(' ' in ${NAME_KEY_SQL}) > 0 AND length(${NAME_KEY_SQL}) >= 5`
            : Prisma.empty;
      const rows = await this.prisma.$queryRaw<{ key: string; ids: string[] }[]>`
        SELECT ${key} AS key, array_agg(u."id" ORDER BY u."createdAt") AS ids
        FROM "User" u
        WHERE ${ACTIVE_CUSTOMER_SQL} ${extra}
        GROUP BY 1
        HAVING count(*) > 1
        ORDER BY max(u."createdAt") DESC
        LIMIT ${MAX_GROUPS}`;
      groups.push(...rows.map((row) => ({ reason: kind, key: row.key, ids: row.ids })));
    }
    const ids = [...new Set(groups.flatMap((group) => group.ids))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: CANDIDATE_SELECT });
    const byId = new Map(users.map((user) => [user.id, candidate(user)]));
    return {
      groups: groups.slice(0, MAX_GROUPS * reasons.length).map((group) => ({
        reason: group.reason,
        reasonLabel: DUPLICATE_REASON_LABELS[group.reason],
        key: group.key,
        customers: group.ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => !!row),
      })),
    };
  }

  /** Accounts that may be the same person as this customer, each with why it was suggested. */
  async duplicatesOf(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, name: true, phone: true, idNumber: true } });
    if (!user || user.role !== 'PASSENGER') throw new NotFoundException('العميل غير موجود');
    const name = nameKey(user.name);
    const ends = nameEnds(user.name);
    const conditions: Prisma.Sql[] = [Prisma.sql`${PHONE_KEY_SQL} = ${phoneKey(user.phone)}`];
    if (user.idNumber) conditions.push(Prisma.sql`u."idNumber" = ${user.idNumber}`);
    if (name.length >= 3) conditions.push(Prisma.sql`${NAME_KEY_SQL} = ${name}`);
    if (ends) conditions.push(Prisma.sql`(${NAME_KEY_SQL} LIKE ${`${ends[0]} %`} AND ${NAME_KEY_SQL} LIKE ${`% ${ends[1]}`})`);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "User" u
      WHERE ${ACTIVE_CUSTOMER_SQL} AND u."id" <> ${user.id} AND (${Prisma.join(conditions, ' OR ')})
      ORDER BY u."createdAt" DESC
      LIMIT ${MAX_CANDIDATES}`;
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: CANDIDATE_SELECT });
    return {
      items: users.map((row) => {
        const reasons: DuplicateReason[] = [];
        if (user.idNumber && row.idNumber === user.idNumber) reasons.push('idNumber');
        if (phoneKey(row.phone) === phoneKey(user.phone)) reasons.push('phone');
        if (name && nameKey(row.name) === name) reasons.push('name');
        else if (ends) {
          const other = nameEnds(row.name);
          if (other && other[0] === ends[0] && other[1] === ends[1]) reasons.push('name');
        }
        return { ...candidate(row), reasons, reasonLabels: reasons.map((reason) => DUPLICATE_REASON_LABELS[reason]) };
      }),
    };
  }

  /**
   * Moves everything the duplicate holds to the primary account in one transaction: bookings with their tickets, wallet and
   * points history and balances, complaints, chats, notifications, phones, coupons and photo. Empty details on the primary
   * are filled from the duplicate. The duplicate is kept, blocked and pointing at the primary, so old references still resolve.
   */
  async merge(actor: UserActor, primaryId: string, duplicateId: string, meta: { ip?: string; userAgent?: string }) {
    if (primaryId === duplicateId) throw new BadRequestException('اختر حسابًا آخر لدمجه');

    const result = await this.prisma.$transaction(async (tx) => {
      // Both rows are locked so a booking or wallet change cannot slip between reading the balances and moving them.
      await tx.$executeRaw`SELECT 1 FROM "User" WHERE "id" IN (${primaryId}, ${duplicateId}) ORDER BY "id" FOR UPDATE`;
      const [primary, duplicate] = await Promise.all([
        tx.user.findUnique({ where: { id: primaryId }, include: { photo: { select: { userId: true } } } }),
        tx.user.findUnique({ where: { id: duplicateId }, include: { photo: { select: { userId: true } } } }),
      ]);
      if (!primary || !duplicate) throw new NotFoundException('العميل غير موجود');
      if (primary.role !== 'PASSENGER' || duplicate.role !== 'PASSENGER') throw new BadRequestException('الدمج للعملاء فقط، لا لحسابات الموظفين');
      if (primary.mergedIntoId) throw new ConflictException('الحساب الأساسي نفسه مدموج في حساب آخر');
      if (duplicate.mergedIntoId) throw new ConflictException('هذا الحساب دُمج من قبل');

      const where = { userId: duplicateId };
      const moved = {
        bookings: (await tx.booking.updateMany({ where, data: { userId: primaryId } })).count,
        walletTransactions: (await tx.walletTransaction.updateMany({ where, data: { userId: primaryId } })).count,
        loyaltyTransactions: (await tx.loyaltyTransaction.updateMany({ where, data: { userId: primaryId } })).count,
        complaints: (await tx.customerComplaint.updateMany({ where, data: { userId: primaryId } })).count,
        notifications: (await tx.notification.updateMany({ where, data: { userId: primaryId } })).count,
        messageDeliveries: (await tx.messageDelivery.updateMany({ where, data: { userId: primaryId } })).count,
        // A token is its own key, so a phone signed into both accounts has one row and simply moves.
        pushTokens: (await tx.pushToken.updateMany({ where, data: { userId: primaryId } })).count,
        ticketCompensations: (await tx.ticketCompensation.updateMany({ where, data: { userId: primaryId } })).count,
        ownedCoupons: (await tx.coupon.updateMany({ where: { ownerUserId: duplicateId }, data: { ownerUserId: primaryId } })).count,
        seatHolds: (await tx.seat.updateMany({ where: { heldByUserId: duplicateId }, data: { heldByUserId: primaryId } })).count,
        referrals: (await tx.user.updateMany({ where: { referredById: duplicateId, id: { not: primaryId } }, data: { referredById: primaryId } })).count,
        conversation: await this.mergeConversation(tx, primaryId, duplicateId),
        tripChats: await this.mergeTripChats(tx, primaryId, duplicateId),
        photo: false,
      };

      // The duplicate's sessions end; what is only about its own device or screens goes.
      await tx.refreshToken.updateMany({ where: { userId: duplicateId, revoked: false }, data: { revoked: true } });
      await tx.appPresence.deleteMany({ where });
      await tx.userTablePreference.deleteMany({ where });

      const patch: Prisma.UserUncheckedUpdateInput = {};
      const freed: Prisma.UserUncheckedUpdateInput = {};
      const fields: { field: string; before: unknown; after: unknown }[] = [];
      const fill = <K extends keyof typeof primary & keyof Prisma.UserUncheckedUpdateInput>(key: K, unique = false) => {
        const mine = primary[key];
        const theirs = duplicate[key];
        if ((mine === null || mine === '') && theirs !== null && theirs !== '') {
          (patch as Record<string, unknown>)[key] = theirs;
          if (unique) (freed as Record<string, unknown>)[key] = null;
          fields.push({ field: key, before: mine, after: theirs });
        }
      };
      fill('name');
      fill('email', true);
      fill('googleId', true);
      fill('referralCode', true);
      fill('nationality');
      fill('city');
      fill('gender');
      fill('birthDate');
      fill('nativeLanguage');
      fill('passwordHash');
      // The identity document moves as a whole, or the type and the number would describe two different papers.
      if (!primary.idNumber && duplicate.idNumber) {
        Object.assign(patch, { idType: duplicate.idType, idNumber: duplicate.idNumber, idIssueDate: duplicate.idIssueDate, idExpiryDate: duplicate.idExpiryDate });
        Object.assign(freed, { idType: null, idNumber: null });
        fields.push({ field: 'idNumber', before: null, after: duplicate.idNumber });
      }
      if (!primary.referredById && duplicate.referredById && duplicate.referredById !== primaryId) patch.referredById = duplicate.referredById;
      // Merging the account that invited this one would leave it invited by itself.
      if (primary.referredById === duplicateId) patch.referredById = null;
      if (!primary.isVerified && duplicate.isVerified) patch.isVerified = true;
      const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : a ?? b);
      if (duplicate.lastLoginAt) patch.lastLoginAt = later(primary.lastLoginAt, duplicate.lastLoginAt);
      if (duplicate.loyaltyActivityAt) patch.loyaltyActivityAt = later(primary.loyaltyActivityAt, duplicate.loyaltyActivityAt);

      if (!primary.photo && duplicate.photo) {
        await tx.$executeRaw`UPDATE "UserPhoto" SET "userId" = ${primaryId} WHERE "userId" = ${duplicateId}`;
        patch.photoUpdatedAt = duplicate.photoUpdatedAt ?? new Date();
        moved.photo = true;
      } else if (duplicate.photo) {
        await tx.userPhoto.delete({ where: { userId: duplicateId } });
      }

      const wallet = new Prisma.Decimal(duplicate.walletBalance);
      if (!wallet.isZero()) {
        patch.walletBalance = { increment: wallet };
        fields.push({ field: 'walletBalance', before: primary.walletBalance, after: new Prisma.Decimal(primary.walletBalance).plus(wallet) });
      }
      // The transport-only part stays transport-only on the merged account.
      const transportWallet = new Prisma.Decimal(duplicate.walletTransportBalance);
      if (transportWallet.gt(0)) patch.walletTransportBalance = { increment: transportWallet };
      if (duplicate.loyaltyPoints) {
        patch.loyaltyPoints = { increment: duplicate.loyaltyPoints };
        fields.push({ field: 'loyaltyPoints', before: primary.loyaltyPoints, after: primary.loyaltyPoints + duplicate.loyaltyPoints });
      }

      // Unique values leave the duplicate before the primary takes them.
      const mergedAt = new Date();
      await tx.user.update({
        where: { id: duplicateId },
        data: {
          ...freed,
          walletBalance: 0,
          walletTransportBalance: 0,
          loyaltyPoints: 0,
          mergedIntoId: primaryId,
          mergedAt,
          blockedAt: duplicate.blockedAt ?? mergedAt,
          blockedReason: `دُمج في حساب العميل ${primary.name || primary.phone} (${primary.phone})`,
        },
      });
      if (Object.keys(patch).length) await tx.user.update({ where: { id: primaryId }, data: patch });

      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          action: 'POST /users/:id/merge',
          entity: 'Users',
          entityId: primaryId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            duplicateId,
            duplicateName: duplicate.name,
            duplicatePhone: duplicate.phone,
            walletMoved: wallet.toString(),
            pointsMoved: duplicate.loyaltyPoints,
            moved,
          } as Prisma.InputJsonValue,
          recordType: 'user',
          recordId: primaryId,
          changes: { label: primary.name || primary.phone, fields: JSON.parse(JSON.stringify(fields)) } as Prisma.InputJsonValue,
        },
      });

      return { primaryId, duplicateId, moved, filled: fields.map((row) => row.field) };
    }, TX_OPTIONS);

    this.realtime.disconnectUser(duplicateId);
    return result;
  }

  /** One support thread per customer: the duplicate's messages join the primary's thread, or its thread simply moves. */
  private async mergeConversation(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
    const [mine, theirs] = await Promise.all([
      tx.conversation.findUnique({ where: { customerId: primaryId } }),
      tx.conversation.findUnique({ where: { customerId: duplicateId } }),
    ]);
    if (!theirs) return 0;
    if (!mine) {
      await tx.conversation.update({ where: { id: theirs.id }, data: { customerId: primaryId } });
      return 1;
    }
    // A message's device key is unique within a thread; a clash only means both phones picked the same one.
    await tx.$executeRaw`
      UPDATE "ChatMessage" d SET "clientId" = NULL
      WHERE d."conversationId" = ${theirs.id} AND d."clientId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "ChatMessage" p WHERE p."conversationId" = ${mine.id} AND p."clientId" = d."clientId")`;
    await tx.chatMessage.updateMany({ where: { conversationId: theirs.id }, data: { conversationId: mine.id } });
    const theirsIsLater = theirs.lastMessageAt > mine.lastMessageAt;
    await tx.conversation.update({
      where: { id: mine.id },
      data: {
        staffUnread: mine.staffUnread + theirs.staffUnread,
        customerUnread: mine.customerUnread + theirs.customerUnread,
        ...(theirsIsLater && { lastMessageAt: theirs.lastMessageAt, lastMessagePreview: theirs.lastMessagePreview, lastSender: theirs.lastSender }),
        ...(theirs.status === 'OPEN' && { status: 'OPEN', closedAt: null }),
        ...(!mine.assignedToId && theirs.assignedToId && { assignedToId: theirs.assignedToId, assignedToName: theirs.assignedToName }),
      },
    });
    await tx.conversation.delete({ where: { id: theirs.id } });
    return 1;
  }

  /** A customer has one thread per trip: threads on the same trip become one, the rest move as they are. */
  private async mergeTripChats(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
    const threads = await tx.tripChatThread.findMany({ where: { customerId: duplicateId } });
    for (const thread of threads) {
      const mine = await tx.tripChatThread.findUnique({ where: { tripId_customerId: { tripId: thread.tripId, customerId: primaryId } } });
      if (!mine) {
        await tx.tripChatThread.update({ where: { id: thread.id }, data: { customerId: primaryId } });
        continue;
      }
      await tx.$executeRaw`
        UPDATE "TripChatMessage" d SET "clientId" = NULL
        WHERE d."threadId" = ${thread.id} AND d."clientId" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "TripChatMessage" p WHERE p."threadId" = ${mine.id} AND p."clientId" = d."clientId")`;
      await tx.tripChatMessage.updateMany({ where: { threadId: thread.id }, data: { threadId: mine.id } });
      const theirsIsLater = thread.lastMessageAt > mine.lastMessageAt;
      await tx.tripChatThread.update({
        where: { id: mine.id },
        data: {
          crewUnread: mine.crewUnread + thread.crewUnread,
          customerUnread: mine.customerUnread + thread.customerUnread,
          ...(theirsIsLater && { lastMessageAt: thread.lastMessageAt, lastMessagePreview: thread.lastMessagePreview, lastSender: thread.lastSender }),
        },
      });
      await tx.tripChatThread.delete({ where: { id: thread.id } });
    }
    return threads.length;
  }

  /** The customer's complaints from the app, and hotel complaints made on their bookings or by their travellers. */
  async complaintsOf(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('العميل غير موجود');
    const [customer, hotel] = await Promise.all([
      this.prisma.customerComplaint.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          category: true,
          status: true,
          details: true,
          tripCode: true,
          supervisorNames: true,
          resolution: true,
          resolvedAt: true,
          resolvedByName: true,
          createdAt: true,
          booking: { select: { id: true, bookingReference: true } },
        },
      }),
      this.prisma.hotelComplaint.findMany({
        where: { OR: [{ booking: { userId } }, { passenger: { booking: { userId } } }] },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          number: true,
          source: true,
          status: true,
          subject: true,
          details: true,
          travelerName: true,
          roomNumber: true,
          resolution: true,
          resolvedAt: true,
          createdAt: true,
          bookingId: true,
          hotel: { select: { id: true, name: true } },
        },
      }),
    ]);
    return {
      customer: customer.map(({ number, ...row }) => ({ ...row, reference: customerComplaintReference(number) })),
      hotel: hotel.map(({ number, ...row }) => ({ ...row, reference: complaintReference(number) })),
    };
  }
}

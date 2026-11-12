import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { customerValues, customerWording, MessageLanguage, NOTIFICATION_CATALOG, NotificationEvent, NotificationValues, renderTemplate, toWhatsAppParam } from '../notification-catalog';
import { readWordings, Wording } from '../message-languages';
import { Permission, permissionsOf } from '../permissions';
import { formatRiyadhDate, formatRiyadhTime } from '../utils/time.util';
import { randomUUID } from 'crypto';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';

type Db = Prisma.TransactionClient;

interface Message {
  user: { id: string; name: string | null };
  values: NotificationValues;
  bookingId?: string;
  tripId?: string;
  reportId?: string;
}

const PASSENGER_FALLBACK_NAME = 'عميلنا العزيز';
const STAFF_FALLBACK_NAME = 'زميلنا';

export const formatSar = (amount: number | Prisma.Decimal) => {
  const value = Number(amount);
  return `${Number.isInteger(value) ? value : value.toFixed(2)} ر.س`;
};

const TRIP_CONTEXT = { tripCode: true, origin: true, destination: true, departureTime: true, hijriDate: true } satisfies Prisma.TripSelect;

const BOOKING_CONTEXT = {
  id: true,
  tripId: true,
  bookingReference: true,
  totalPrice: true,
  boardingPointName: true,
  boardingPointTime: true,
  user: { select: { id: true, name: true, phone: true } },
  passengers: { select: { seatNumber: true } },
  trip: { select: TRIP_CONTEXT },
} satisfies Prisma.BookingSelect;

type TripContext = Prisma.TripGetPayload<{ select: typeof TRIP_CONTEXT }>;
type BookingContext = Prisma.BookingGetPayload<{ select: typeof BOOKING_CONTEXT }>;

export const tripValues = (trip: TripContext): NotificationValues => ({
  tripCode: trip.tripCode,
  origin: trip.origin,
  destination: trip.destination,
  departureDate: formatRiyadhDate(trip.departureTime),
  departureTime: formatRiyadhTime(trip.departureTime),
  hijriDate: trip.hijriDate,
});

const bookingValues = (booking: BookingContext): NotificationValues => ({
  ...tripValues(booking.trip),
  bookingReference: booking.bookingReference,
  seats: booking.passengers.map((p) => p.seatNumber).sort((a, b) => Number(a) - Number(b)).join('، '),
  passengerCount: booking.passengers.length,
  boardingPoint: booking.boardingPointName,
  boardingTime: booking.boardingPointTime,
  totalPrice: formatSar(booking.totalPrice),
});

export type CatalogView = { audience: string; title: string; body: string; expiresMinutes?: number; translations?: Partial<Record<Exclude<MessageLanguage, 'ar'>, { title: string; body: string }>> };

/**
 * The wording one language receives: the admin's own for that language, else the catalog's translation,
 * else the Arabic (the admin's or the catalog's). Shared with campaigns so WhatsApp approval compares the same text.
 * With the event, what that action's audience must not see (the trip number, for customers) is taken out.
 */
export function templateWording(entry: CatalogView, custom?: { title: string; body: string; translations?: Prisma.JsonValue } | null, event?: NotificationEvent) {
  const arabic: Wording = { title: custom?.title ?? entry.title, body: custom?.body ?? entry.body };
  const own = readWordings(custom?.translations);
  const pick = (language: string): Wording => {
    if (language === 'ar') return arabic;
    const key = language as Exclude<MessageLanguage, 'ar'>;
    return own[key] ?? entry.translations?.[key] ?? arabic;
  };
  if (!event) return pick;
  return (language: string): Wording => {
    const wording = pick(language);
    return { title: customerWording(event, wording.title), body: customerWording(event, wording.body) };
  };
}

/** Lets one send narrow the channels the action's template has on. It can never turn on one that is off. */
export interface ChannelChoice {
  inApp?: boolean;
  whatsapp?: boolean;
}

const WHATSAPP_DEFAULT_EXPIRES_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const TRIAL_LOGIN_CODE_EVENT = 'TRIAL_LOGIN_CODE';

type ApprovedTemplate = { name: string; language: string; paramOrder: string[] };

/** Approved templates of this action that still say what is about to be sent; an edit waits for a new approval. */
export async function approvedWhatsAppTemplates(db: Pick<Prisma.TransactionClient, 'whatsAppTemplate'>, event: string, currentBody: (language: string) => string) {
  const rows = await db.whatsAppTemplate.findMany({ where: { event, status: 'APPROVED' } });
  return new Map<string, ApprovedTemplate>(rows.filter((row) => row.bodySnapshot === currentBody(row.language)).map((row) => [row.language, row]));
}

export function whatsappDelivery(userId: string, event: string, template: ApprovedTemplate, values: Record<string, unknown>, tripId?: string, expiresMinutes?: number, campaignId?: string): Prisma.MessageDeliveryCreateManyInput {
  return {
    userId,
    event,
    language: template.language,
    templateName: template.name,
    params: template.paramOrder.map((key) => toWhatsAppParam(values[key])),
    expiresAt: new Date(Date.now() + (expiresMinutes ?? WHATSAPP_DEFAULT_EXPIRES_MINUTES) * MINUTE_MS),
    tripId,
    campaignId,
  };
}

/**
 * Every method takes the caller's transaction client, so a notification only exists if its action
 * committed, and a rolled-back action can never tell someone it happened.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private realtime: RealtimeService,
    private push: PushService,
  ) {}

  private async send(db: Db, event: NotificationEvent, messages: Message[], channels: ChannelChoice = {}) {
    if (messages.length === 0) return;
    const entry: CatalogView = NOTIFICATION_CATALOG[event];
    const custom = await db.notificationTemplate.findUnique({ where: { event } });
    const wantsInApp = (custom?.isActive ?? true) && channels.inApp !== false;
    const wantsWhatsapp = !!custom?.whatsappEnabled && entry.audience === 'PASSENGER' && channels.whatsapp !== false;
    if (!wantsInApp && !wantsWhatsapp) return;

    const wordingFor = templateWording(entry, custom, event);
    const hasTranslations = !!entry.translations || Object.keys(readWordings(custom?.translations)).length > 0;
    // Only asked for when it can change something, because most events reach staff or carry one wording.
    const languages = wantsWhatsapp || hasTranslations
      ? new Map((await db.user.findMany({ where: { id: { in: messages.map(({ user }) => user.id) } }, select: { id: true, messageLanguage: true } })).map((row) => [row.id, row.messageLanguage]))
      : new Map<string, string>();

    const fallbackName = entry.audience === 'STAFF' ? STAFF_FALLBACK_NAME : PASSENGER_FALLBACK_NAME;
    const prepared = messages.map((message) => ({
      ...message,
      all: customerValues(event, { ...message.values, userName: message.user.name || fallbackName }),
      language: languages.get(message.user.id) ?? 'ar',
    }));

    if (wantsInApp) {
      // The ids are chosen here so the push can carry them and a tap marks the right one read.
      const rows = prepared.map(({ user, all, language, bookingId, tripId, reportId }) => {
        const wording = wordingFor(language);
        return {
          id: randomUUID(),
          userId: user.id,
          event,
          title: renderTemplate(wording.title, all),
          body: renderTemplate(wording.body, all),
          bookingId,
          tripId,
          reportId,
        };
      });
      await db.notification.createMany({ data: rows });
      this.realtime.notificationsCreated(rows.map((row) => row.userId));
      this.push.notificationsCreated(rows);
    }

    if (wantsWhatsapp) {
      const approved = await approvedWhatsAppTemplates(db, event, (language) => wordingFor(language).body);
      await db.messageDelivery.createMany({
        data: prepared.flatMap(({ user, all, language, tripId }) => {
          const template = approved.get(language) ?? approved.get('ar');
          if (!template) return [];
          return [whatsappDelivery(user.id, event, template, all, tripId, entry.expiresMinutes)];
        }),
      });
    }
  }

  /** Tells each booking's owner, in one read and one write however many bookings there are. */
  async toBookingOwners(db: Db, event: NotificationEvent, bookingIds: string[], extra: NotificationValues = {}, channels: ChannelChoice = {}) {
    if (bookingIds.length === 0) return;
    const bookings = await db.booking.findMany({ where: { id: { in: bookingIds } }, select: BOOKING_CONTEXT });
    await this.send(
      db,
      event,
      bookings.map((booking) => ({
        user: booking.user,
        values: { ...bookingValues(booking), ...extra },
        bookingId: booking.id,
        tripId: booking.tripId,
      })),
      channels,
    );
  }

  /** The same, with values that differ per booking, such as each one's hotel room. */
  async toBookingOwnersEach(db: Db, event: NotificationEvent, extras: Map<string, NotificationValues>, channels: ChannelChoice = {}) {
    if (extras.size === 0) return;
    const bookings = await db.booking.findMany({ where: { id: { in: [...extras.keys()] } }, select: BOOKING_CONTEXT });
    await this.send(
      db,
      event,
      bookings.map((booking) => ({
        user: booking.user,
        values: { ...bookingValues(booking), ...extras.get(booking.id) },
        bookingId: booking.id,
        tripId: booking.tripId,
      })),
      channels,
    );
  }

  /** Staff holding any of these permissions, except whoever caused the event. */
  private async holders(db: Db, permissions: Permission[], exceptUserId?: string) {
    const staff = await db.user.findMany({
      where: {
        // Admins hold every permission without it being listed on a rank.
        OR: [{ role: 'ADMIN' }, { role: { not: 'PASSENGER' }, OR: [{ rank: { permissions: { hasSome: permissions } } }, { extraPermissions: { hasSome: permissions } }] }],
        NOT: [...(exceptUserId ? [{ id: exceptUserId }] : []), { driverProfile: { is: { isActive: false } } }],
      },
      select: { id: true, name: true, role: true, extraPermissions: true, revokedPermissions: true, rank: { select: { permissions: true } } },
    });
    return staff.filter((user) => permissions.some((permission) => permissionsOf(user).includes(permission))).map(({ id, name }) => ({ id, name }));
  }

  /** Whoever watches every branch, plus the employees of the branch this happened in. */
  async toBranchStaffAboutBooking(db: Db, event: NotificationEvent, branchId: string, bookingId: string, options: { exceptUserId?: string } = {}) {
    const [everywhere, local] = await Promise.all([
      this.holders(db, ['bookings.all_branches'], options.exceptUserId),
      this.holders(db, ['bookings.view'], options.exceptUserId).then(async (staff) => {
        const inBranch = await db.user.findMany({ where: { id: { in: staff.map((user) => user.id) }, branchId }, select: { id: true, name: true } });
        return inBranch;
      }),
    ]);
    const recipients = [...new Map([...everywhere, ...local].map((user) => [user.id, user])).values()];
    if (recipients.length === 0) return;
    const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: BOOKING_CONTEXT });
    const values = { ...bookingValues(booking), customerName: booking.user.name, customerPhone: booking.user.phone };
    await this.send(db, event, recipients.map((user) => ({ user, values, bookingId, tripId: booking.tripId })));
  }

  async toStaffAboutBooking(db: Db, event: NotificationEvent, permissions: Permission[], bookingId: string, options: { exceptUserId?: string; extra?: NotificationValues } = {}) {
    const staff = await this.holders(db, permissions, options.exceptUserId);
    if (staff.length === 0) return;
    const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: BOOKING_CONTEXT });
    const values = { ...bookingValues(booking), customerName: booking.user.name, customerPhone: booking.user.phone, ...options.extra };
    await this.send(db, event, staff.map((user) => ({ user, values, bookingId, tripId: booking.tripId })));
  }

  async toStaff(db: Db, event: NotificationEvent, permissions: Permission[], values: NotificationValues, options: { exceptUserId?: string; tripId?: string; reportId?: string } = {}) {
    const staff = await this.holders(db, permissions, options.exceptUserId);
    const trip = options.tripId ? await db.trip.findUniqueOrThrow({ where: { id: options.tripId }, select: TRIP_CONTEXT }) : null;
    const all = { ...(trip && tripValues(trip)), ...values };
    await this.send(db, event, staff.map((user) => ({ user, values: all, tripId: options.tripId, reportId: options.reportId })));
  }

  /** Leave userIds out to reach the trip's whole crew. */
  async toTripCrew(db: Db, event: NotificationEvent, tripId: string, options: { userIds?: string[]; exceptUserId?: string; reportId?: string; extra?: NotificationValues } = {}) {
    if (options.userIds?.length === 0) return;
    const trip = await db.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: { ...TRIP_CONTEXT, drivers: { select: { userId: true } }, supervisors: { select: { userId: true } } },
    });
    const ids = options.userIds ?? [...trip.drivers, ...trip.supervisors].map((member) => member.userId);
    const recipients = [...new Set(ids)].filter((id) => id !== options.exceptUserId);
    const crew = await db.user.findMany({ where: { id: { in: recipients } }, select: { id: true, name: true } });
    const values = { ...tripValues(trip), ...options.extra };
    await this.send(db, event, crew.map((user) => ({ user, values, tripId, reportId: options.reportId })));
  }

  /**
   * TEMPORARY for the client's trial: remove with CLIENT_TRIAL_MODE. Reaches only the admins, and never goes through
   * push, so the code does not leave the system. Returns how many admins it reached, and clears codes that have expired.
   */
  async trialLoginCodeToAdmins(db: Db, phone: string, code: string, ttlMinutes: number) {
    await db.notification.deleteMany({ where: { event: TRIAL_LOGIN_CODE_EVENT, createdAt: { lt: new Date(Date.now() - ttlMinutes * MINUTE_MS) } } });
    const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    if (admins.length === 0) return 0;
    await db.notification.createMany({
      data: admins.map(({ id }) => ({
        userId: id,
        event: TRIAL_LOGIN_CODE_EVENT,
        title: 'رمز دخول (نسخة تجريبية)',
        body: `رمز الدخول للرقم ${phone}: ${code}\nصالح لمدة ${ttlMinutes} دقيقة.`,
      })),
    });
    this.realtime.notificationsCreated(admins.map(({ id }) => id));
    return admins.length;
  }

  /** For events tied to the account itself, such as the wallet and points. */
  async toUser(db: Db, event: NotificationEvent, userId: string, values: NotificationValues) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    if (user) await this.send(db, event, [{ user, values }]);
  }
}

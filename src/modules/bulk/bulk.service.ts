import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { TripsService } from '../trips/trips.service';
import { UsersService } from '../users/users.service';
import { DriversService } from '../buses/drivers.service';

/** The tables whose rows can be picked together in the panel and stopped, shown again, or deleted. */
export const BULK_ENTITIES = [
  'trips', 'bookings', 'packages', 'offers', 'coupons', 'hotels', 'buses', 'branches',
  'customers', 'employees', 'drivers', 'busOffices', 'loyaltyRules',
] as const;
export type BulkEntity = (typeof BULK_ENTITIES)[number];

/**
 * One reason a row cannot be deleted. A link the office may break (a bus on a trip, a supervisor, a coupon on an
 * offer) carries `unlink`, which the delete dialog offers as a button; one that holds history or money (bookings,
 * payments, invoices) only points at where to deal with it.
 */
export type Blocker = { key: string; label: string; unlink?: string; href?: string };
export type InspectedRow = { id: string; name: string; hidden: boolean; blockers: Blocker[] };

/** The employee acting, as the auth guard puts them on the request. */
export type BulkActor = { userId: string; role: string; permissions: string[]; name?: string | null };

type Handler = {
  /** Any one of these opens the table's actions; hide and unlink may ask for their own. */
  permission: string | string[];
  hidePermission?: string[];
  unlinkPermission?: string[];
  /** Deleting for good needs this one alone, whatever else the employee holds. */
  deletePermission: string;
  inspect(ids: string[]): Promise<InspectedRow[]>;
  /** Deletes one row already found free of blockers. */
  remove(id: string, actor: BulkActor): Promise<void>;
  /** Stops (hidden) or restores rows; returns those left as they were, with why. */
  setHidden(ids: string[], hidden: boolean, actor: BulkActor, reason?: string): Promise<{ id: string; reason: string }[]>;
  unlink?(id: string, key: string): Promise<void>;
};

const MAX_IDS = 200;
const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

@Injectable()
export class BulkService {
  private handlers: Record<BulkEntity, Handler>;

  constructor(
    private prisma: PrismaService,
    private trips: TripsService,
    private users: UsersService,
    private drivers: DriversService,
  ) {
    this.handlers = {
      trips: this.tripsHandler(),
      bookings: this.bookingsHandler(),
      packages: this.packagesHandler(),
      offers: this.offersHandler(),
      coupons: this.couponsHandler(),
      hotels: this.hotelsHandler(),
      buses: this.busesHandler(),
      branches: this.branchesHandler(),
      customers: this.peopleHandler('customers'),
      employees: this.peopleHandler('employees'),
      drivers: this.driversHandler(),
      busOffices: this.busOfficesHandler(),
      loyaltyRules: this.loyaltyRulesHandler(),
    };
  }

  private handler(entity: string, actor: BulkActor, action?: 'hide' | 'unlink' | 'delete') {
    if (!(BULK_ENTITIES as readonly string[]).includes(entity)) throw new NotFoundException('نوع غير معروف');
    const handler = this.handlers[entity as BulkEntity];
    const base = Array.isArray(handler.permission) ? handler.permission : [handler.permission];
    // Looking rows over (the delete dialog's first step) is open to whoever may act on the table or delete from it.
    const needed =
      (action === 'delete' && [handler.deletePermission]) ||
      (action === 'hide' && handler.hidePermission) ||
      (action === 'unlink' && handler.unlinkPermission) ||
      (action ? base : [...base, handler.deletePermission]);
    if (!needed.some((permission) => actor.permissions?.includes(permission))) throw new ForbiddenException('ليست لديك صلاحية لتنفيذ هذا الإجراء');
    return handler;
  }

  private ids(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new BadRequestException('لم يتم تحديد أي عنصر');
    if (unique.length > MAX_IDS) throw new BadRequestException(`يمكن تنفيذ الإجراء على ${MAX_IDS} عنصر كحد أقصى في المرة الواحدة`);
    return unique;
  }

  async inspect(entity: string, actor: BulkActor, ids: string[]) {
    return { items: await this.handler(entity, actor).inspect(this.ids(ids)) };
  }

  /**
   * Deletes every row that is free, and leaves the rest with the reasons. Each row is checked again just before it
   * goes, so a booking made since the dialog opened still keeps its trip.
   */
  async remove(entity: string, actor: BulkActor, ids: string[]) {
    const handler = this.handler(entity, actor, 'delete');
    const rows = await handler.inspect(this.ids(ids));
    const deleted: string[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const row of rows) {
      if (row.blockers.length) {
        skipped.push({ id: row.id, name: row.name, reason: row.blockers.map((b) => b.label).join('، ') });
        continue;
      }
      try {
        await handler.remove(row.id, actor);
        deleted.push(row.id);
      } catch (err) {
        skipped.push({ id: row.id, name: row.name, reason: reasonOf(err) });
      }
    }
    return { deleted: deleted.length, deletedIds: deleted, skipped };
  }

  async setHidden(entity: string, actor: BulkActor, ids: string[], hidden: boolean, reason?: string) {
    const handler = this.handler(entity, actor, 'hide');
    const unique = this.ids(ids);
    const skipped = await handler.setHidden(unique, hidden, actor, reason);
    return { updated: unique.length - skipped.length, skipped };
  }

  async unlink(entity: string, actor: BulkActor, id: string, key: string) {
    const handler = this.handler(entity, actor, 'unlink');
    const [row] = await handler.inspect([id]);
    if (!row) throw new NotFoundException('العنصر غير موجود');
    if (!handler.unlink || !row.blockers.some((b) => b.unlink === key)) throw new BadRequestException('لا يمكن إلغاء هذا الربط من هنا');
    await handler.unlink(id, key);
    const [after] = await handler.inspect([id]);
    return after;
  }

  // ------------------------------------------------------------------ Trips

  private tripsHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'trips.manage',
      deletePermission: 'trips.delete',
      inspect: async (ids) => {
        const trips = await prisma.trip.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            tripCode: true,
            origin: true,
            destination: true,
            channelApp: true,
            convoyLeadId: true,
            bus: { select: { plateNumber: true } },
            reverseTrip: { select: { id: true, tripCode: true } },
            drivers: { select: { user: { select: { name: true } } } },
            supervisors: { select: { user: { select: { name: true } } } },
            hotelBookings: { where: { status: { not: 'CANCELLED' } }, select: { hotel: { select: { name: true } } } },
            convoyFollowers: { select: { tripCode: true, _count: { select: { bookings: true } } } },
            _count: { select: { bookings: true, invoices: true, accountEntries: true, custodies: true } },
          },
        });
        return trips.map((trip) => {
          const blockers: Blocker[] = [];
          const href = `/trips/${trip.id}`;
          if (trip._count.bookings) blockers.push({ key: 'bookings', label: `عليها ${plural(trip._count.bookings, 'حجز', 'حجوزات')}`, href });
          const followerBookings = trip.convoyFollowers.filter((f) => f._count.bookings > 0);
          if (followerBookings.length) blockers.push({ key: 'convoy', label: `باصات إضافية عليها حجوزات (${followerBookings.map((f) => f.tripCode).join('، ')})`, href });
          if (trip.reverseTrip) blockers.push({ key: 'reverse', label: `فُتحت لها رحلة عودة ${trip.reverseTrip.tripCode}`, href: `/trips/${trip.reverseTrip.id}` });
          if (trip._count.invoices || trip._count.accountEntries || trip._count.custodies) blockers.push({ key: 'finance', label: 'عليها قيود مالية (فواتير أو مصاريف أو عهد)', href });
          if (trip.bus) blockers.push({ key: 'bus', label: `الباص ${trip.bus.plateNumber} مسند لها`, unlink: 'bus' });
          if (trip.drivers.length) blockers.push({ key: 'drivers', label: `السائق: ${trip.drivers.map((d) => d.user.name).join('، ')}`, unlink: 'drivers' });
          if (trip.supervisors.length) blockers.push({ key: 'supervisors', label: `المشرف: ${trip.supervisors.map((s) => s.user.name).join('، ')}`, unlink: 'supervisors' });
          if (trip.hotelBookings.length) blockers.push({ key: 'hotels', label: `فندق مسند: ${[...new Set(trip.hotelBookings.map((h) => h.hotel.name))].join('، ')}`, unlink: 'hotels' });
          return { id: trip.id, name: `${trip.tripCode} · ${trip.origin} ← ${trip.destination}`, hidden: !trip.channelApp, blockers };
        });
      },
      remove: async (id) => {
        await this.trips.deleteTrip(id);
      },
      setHidden: async (ids, hidden) => {
        // A trip off the app channel is neither listed nor sold there; branches still sell it if they did.
        await prisma.trip.updateMany({ where: { id: { in: ids } }, data: { channelApp: !hidden } });
        return [];
      },
      unlink: async (id, key) => {
        await prisma.$transaction(async (tx) => {
          if (key === 'bus') await tx.trip.update({ where: { id }, data: { busId: null } });
          if (key === 'drivers') await tx.tripDriver.deleteMany({ where: { tripId: id } });
          if (key === 'supervisors') await tx.tripSupervisor.deleteMany({ where: { tripId: id } });
          if (key === 'hotels') {
            if ((await tx.booking.count({ where: { tripId: id } })) > 0) throw new BadRequestException('على الرحلة حجوزات، ألغِ الفندق من صفحة التسكين');
            await tx.hotelRoom.deleteMany({ where: { hotelBooking: { tripId: id } } });
            await tx.hotelBooking.deleteMany({ where: { tripId: id } });
          }
        });
      },
    };
  }

  // ------------------------------------------------------------------ Bookings

  private bookingsHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'bookings.manage_records',
      deletePermission: 'bookings.delete',
      inspect: async (ids) => {
        const bookings = await prisma.booking.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            bookingReference: true,
            status: true,
            appHidden: true,
            user: { select: { name: true } },
            payment: { select: { status: true } },
            invoice: { select: { id: true } },
            compensation: { select: { id: true } },
            _count: { select: { paymentTransactions: true, cashMovements: true, collections: true, creditNotes: true, loyaltyTransactions: true } },
          },
        });
        return bookings.map((booking) => {
          const blockers: Blocker[] = [];
          const href = `/bookings/${booking.id}`;
          if (booking.status !== 'CANCELLED') blockers.push({ key: 'active', label: 'الحجز غير ملغى، ألغِه أولًا من صفحته', href });
          const c = booking._count;
          if (c.paymentTransactions || c.cashMovements || c.collections || (booking.payment && booking.payment.status !== 'PENDING' && booking.payment.status !== 'FAILED')) {
            blockers.push({ key: 'payments', label: 'عليه مدفوعات أو حركات صندوق', href });
          }
          if (booking.invoice || c.creditNotes) blockers.push({ key: 'invoice', label: 'صدرت له فاتورة ضريبية', href });
          if (c.loyaltyTransactions || booking.compensation) blockers.push({ key: 'loyalty', label: 'عليه نقاط ولاء أو تعويض', href });
          return { id: booking.id, name: `${booking.bookingReference}${booking.user?.name ? ` · ${booking.user.name}` : ''}`, hidden: booking.appHidden, blockers };
        });
      },
      remove: async (id) => {
        await prisma.$transaction(async (tx) => {
          // Nothing else is worth keeping on a cancelled booking that never held money: its seats were freed when it was cancelled.
          await tx.payment.deleteMany({ where: { bookingId: id } });
          await tx.booking.delete({ where: { id } });
        });
      },
      setHidden: async (ids, hidden) => {
        await prisma.booking.updateMany({ where: { id: { in: ids } }, data: { appHidden: hidden } });
        return [];
      },
    };
  }

  // ------------------------------------------------------------------ Packages

  private packagesHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'packages.manage',
      deletePermission: 'packages.delete',
      inspect: async (ids) => {
        const packages = await prisma.package.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, status: true, _count: { select: { trips: true, bookings: true } } },
        });
        return packages.map((pkg) => {
          const blockers: Blocker[] = [];
          if (pkg._count.bookings) blockers.push({ key: 'bookings', label: `عليها ${plural(pkg._count.bookings, 'حجز', 'حجوزات')}`, href: `/packages` });
          if (pkg._count.trips) blockers.push({ key: 'trips', label: `مرتبطة بـ ${plural(pkg._count.trips, 'رحلة', 'رحلات')}`, unlink: 'trips' });
          return { id: pkg.id, name: pkg.name, hidden: pkg.status !== 'PUBLISHED', blockers };
        });
      },
      remove: async (id) => {
        await prisma.package.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        if (hidden) {
          // Archived is the package's own "stopped" state; a draft is already out of the app.
          await prisma.package.updateMany({ where: { id: { in: ids }, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } });
          return [];
        }
        const drafts = await prisma.package.findMany({ where: { id: { in: ids }, status: 'DRAFT' }, select: { id: true } });
        await prisma.package.updateMany({ where: { id: { in: ids }, status: 'ARCHIVED' }, data: { status: 'PUBLISHED' } });
        return drafts.map((d) => ({ id: d.id, reason: 'مسودة لم تُنشر بعد، انشرها من صفحتها' }));
      },
      unlink: async (id, key) => {
        if (key !== 'trips') return;
        const booked = await prisma.trip.count({ where: { packageId: id, bookings: { some: {} } } });
        if (booked) throw new BadRequestException('بعض رحلات الباقة عليها حجوزات، فلا تُفصل عنها');
        await prisma.trip.updateMany({ where: { packageId: id }, data: { packageId: null } });
      },
    };
  }

  // ------------------------------------------------------------------ Offers

  private offersHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'offers.manage',
      deletePermission: 'offers.delete',
      inspect: async (ids) => {
        const offers = await prisma.promoOffer.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, isActive: true } });
        return offers.map((offer) => ({ id: offer.id, name: offer.title, hidden: !offer.isActive, blockers: [] }));
      },
      remove: async (id) => {
        await prisma.promoOffer.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.promoOffer.updateMany({ where: { id: { in: ids } }, data: { isActive: !hidden } });
        return [];
      },
    };
  }

  // ------------------------------------------------------------------ Coupons

  private couponsHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'coupons.manage',
      deletePermission: 'coupons.delete',
      inspect: async (ids) => {
        const coupons = await prisma.coupon.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, isActive: true, ownerUserId: true, usedCount: true, _count: { select: { bookings: true, promoOffers: true, campaigns: true } } },
        });
        return coupons.map((coupon) => {
          const blockers: Blocker[] = [];
          if (coupon.ownerUserId) blockers.push({ key: 'owner', label: 'قسيمة اشتراها عميل بنقاطه' });
          const used = Math.max(coupon.usedCount, coupon._count.bookings);
          if (used) blockers.push({ key: 'bookings', label: `استُخدم في ${plural(used, 'حجز', 'حجوزات')}` });
          if (coupon._count.promoOffers) blockers.push({ key: 'offers', label: `مرتبط بـ ${plural(coupon._count.promoOffers, 'عرض ترويجي', 'عروض ترويجية')}`, unlink: 'offers' });
          if (coupon._count.campaigns) blockers.push({ key: 'campaigns', label: `مرتبط بـ ${plural(coupon._count.campaigns, 'حملة رسائل', 'حملات رسائل')}`, unlink: 'campaigns' });
          return { id: coupon.id, name: coupon.code, hidden: !coupon.isActive, blockers };
        });
      },
      remove: async (id) => {
        await prisma.coupon.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        // A customer's own voucher is theirs and is never switched off from here.
        const owned = await prisma.coupon.findMany({ where: { id: { in: ids }, ownerUserId: { not: null } }, select: { id: true } });
        await prisma.coupon.updateMany({ where: { id: { in: ids }, ownerUserId: null }, data: { isActive: !hidden } });
        return owned.map((c) => ({ id: c.id, reason: 'قسيمة اشتراها عميل بنقاطه' }));
      },
      unlink: async (id, key) => {
        if (key === 'offers') await prisma.promoOffer.updateMany({ where: { couponId: id }, data: { couponId: null } });
        if (key === 'campaigns') await prisma.campaign.updateMany({ where: { couponId: id }, data: { couponId: null } });
      },
    };
  }

  // ------------------------------------------------------------------ Hotels

  private hotelsHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'hotels.manage',
      deletePermission: 'hotels.delete',
      inspect: async (ids) => {
        const hotels = await prisma.hotel.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, isActive: true, _count: { select: { bookings: true, customerStays: true, complaints: true, packages: true, roomBlocks: true } } },
        });
        return hotels.map((hotel) => {
          const blockers: Blocker[] = [];
          const href = `/hotels/${hotel.id}`;
          const c = hotel._count;
          if (c.bookings) blockers.push({ key: 'bookings', label: `مسند لـ ${plural(c.bookings, 'رحلة', 'رحلات')} (حجوزات غرف)`, href });
          if (c.customerStays) blockers.push({ key: 'stays', label: `عليه ${plural(c.customerStays, 'حجز عميل', 'حجوزات عملاء')}`, href });
          if (c.complaints) blockers.push({ key: 'complaints', label: `عليه ${plural(c.complaints, 'شكوى', 'شكاوى')}`, href });
          if (c.packages) blockers.push({ key: 'packages', label: `مرتبط بـ ${plural(c.packages, 'باقة', 'باقات')}`, href: '/packages' });
          if (c.roomBlocks) blockers.push({ key: 'blocks', label: 'عليه غرف خارج الخدمة', unlink: 'blocks' });
          return { id: hotel.id, name: hotel.name, hidden: !hotel.isActive, blockers };
        });
      },
      remove: async (id) => {
        await prisma.hotel.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.hotel.updateMany({ where: { id: { in: ids } }, data: { isActive: !hidden } });
        return [];
      },
      unlink: async (id, key) => {
        if (key === 'blocks') await prisma.hotelRoomBlock.deleteMany({ where: { hotelId: id } });
      },
    };
  }

  // ------------------------------------------------------------------ Buses

  private busesHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'buses.manage',
      deletePermission: 'buses.delete',
      inspect: async (ids) => {
        const now = new Date();
        const buses = await prisma.bus.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            plateNumber: true,
            model: true,
            status: true,
            fixedDriver: { select: { name: true } },
            trips: { select: { id: true, departureTime: true, tripStatus: true, _count: { select: { bookings: true } } } },
            _count: { select: { maintenanceLogs: true } },
          },
        });
        return buses.map((bus) => {
          const blockers: Blocker[] = [];
          const href = `/buses`;
          // Only upcoming trips without bookings can let the bus go; a trip it already ran keeps it in its history.
          const freeable = bus.trips.filter((t) => t.departureTime > now && t._count.bookings === 0 && t.tripStatus !== 'COMPLETED');
          const kept = bus.trips.length - freeable.length;
          if (kept) blockers.push({ key: 'history', label: `مرتبط بـ ${plural(kept, 'رحلة', 'رحلات')} سابقة أو عليها حجوزات`, href });
          if (freeable.length) blockers.push({ key: 'trips', label: `مسند لـ ${plural(freeable.length, 'رحلة قادمة', 'رحلات قادمة')} بلا حجوزات`, unlink: 'trips' });
          if (bus.fixedDriver) blockers.push({ key: 'driver', label: `السائق الثابت: ${bus.fixedDriver.name}`, unlink: 'driver' });
          if (bus._count.maintenanceLogs) blockers.push({ key: 'maintenance', label: 'له سجلات صيانة بتكاليف', href });
          return { id: bus.id, name: `${bus.plateNumber} · ${bus.model}`, hidden: bus.status === 'INACTIVE', blockers };
        });
      },
      remove: async (id) => {
        await prisma.bus.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.bus.updateMany({ where: { id: { in: ids } }, data: { status: hidden ? 'INACTIVE' : 'ACTIVE' } });
        return [];
      },
      unlink: async (id, key) => {
        if (key === 'driver') await prisma.bus.update({ where: { id }, data: { fixedDriverId: null } });
        if (key === 'trips') {
          await prisma.trip.updateMany({
            where: { busId: id, departureTime: { gt: new Date() }, tripStatus: { not: 'COMPLETED' }, bookings: { none: {} } },
            data: { busId: null },
          });
        }
      },
    };
  }

  // ------------------------------------------------------------------ Branches

  private branchesHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'branches.manage',
      deletePermission: 'branches.delete',
      inspect: async (ids) => {
        const branches = await prisma.branch.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            name: true,
            isActive: true,
            manager: { select: { name: true } },
            _count: {
              select: {
                users: true,
                bookings: true,
                sessions: true,
                custodies: true,
                collections: true,
                refunds: true,
                generalExpenses: true,
                remittances: true,
                fixedExpenses: true,
                fixedExpensePayments: true,
              },
            },
          },
        });
        return branches.map((branch) => {
          const blockers: Blocker[] = [];
          const href = `/branches`;
          const c = branch._count;
          if (c.bookings) blockers.push({ key: 'bookings', label: `عليه ${plural(c.bookings, 'حجز', 'حجوزات')}`, href });
          const money = c.sessions + c.custodies + c.collections + c.refunds + c.generalExpenses + c.remittances + c.fixedExpenses + c.fixedExpensePayments;
          if (money) blockers.push({ key: 'finance', label: 'عليه حركات مالية (صندوق أو مصاريف أو توريدات)', href });
          if (c.users) blockers.push({ key: 'users', label: `فيه ${plural(c.users, 'موظف', 'موظفين')}`, unlink: 'users' });
          if (branch.manager) blockers.push({ key: 'manager', label: `المدير: ${branch.manager.name}`, unlink: 'manager' });
          return { id: branch.id, name: branch.name, hidden: !branch.isActive, blockers };
        });
      },
      remove: async (id) => {
        await prisma.branch.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.branch.updateMany({ where: { id: { in: ids } }, data: { isActive: !hidden } });
        return [];
      },
      unlink: async (id, key) => {
        if (key === 'users') await prisma.user.updateMany({ where: { branchId: id }, data: { branchId: null } });
        if (key === 'manager') await prisma.branch.update({ where: { id }, data: { managerId: null } });
      },
    };
  }

  // ------------------------------------------------------------------ Customers and employees

  /**
   * People are stopped by blocking their account (sessions end at once) and deleted only when nothing of theirs must
   * stay: the users service's own rules decide, so a bulk action never does what one at a time would refuse.
   */
  private peopleHandler(kind: 'customers' | 'employees'): Handler {
    const prisma = this.prisma;
    const customers = kind === 'customers';
    return {
      permission: customers ? ['customers.block', 'customers.manage'] : 'employees.manage',
      hidePermission: customers ? ['customers.block'] : ['employees.manage'],
      unlinkPermission: customers ? ['customers.manage'] : ['employees.manage'],
      deletePermission: customers ? 'customers.delete' : 'employees.delete',
      inspect: async (ids) => {
        const people = await prisma.user.findMany({
          where: { id: { in: ids }, role: customers ? 'PASSENGER' : { not: 'PASSENGER' } },
          select: {
            id: true,
            name: true,
            phone: true,
            blockedAt: true,
            walletBalance: true,
            loyaltyPoints: true,
            employeeProfile: { select: { userId: true } },
            branch: { select: { name: true } },
            _count: { select: { bookings: true, tripSupervisors: true, tripDrivers: true } },
          },
        });
        return people.map((person) => {
          const blockers: Blocker[] = [];
          const href = customers ? `/users/${person.id}` : `/employees`;
          if (person._count.bookings) blockers.push({ key: 'bookings', label: `لديه ${plural(person._count.bookings, 'حجز', 'حجوزات')}`, href });
          if (Number(person.walletBalance) > 0) blockers.push({ key: 'wallet', label: 'في محفظته رصيد', href });
          if (person.loyaltyPoints > 0) blockers.push({ key: 'points', label: 'لديه نقاط ولاء', href });
          if (person.employeeProfile) blockers.push({ key: 'hr', label: 'له ملف وظيفي، أنهِ خدمته بمخالصة نهاية الخدمة', href: '/hr' });
          if (person._count.tripSupervisors || person._count.tripDrivers) blockers.push({ key: 'trips', label: 'مسند لرحلات كمشرف أو سائق', href });
          if (person.branch) blockers.push({ key: 'branch', label: `موظف في فرع ${person.branch.name}`, unlink: 'branch' });
          return { id: person.id, name: [person.name, person.phone].filter(Boolean).join(' · '), hidden: !!person.blockedAt, blockers };
        });
      },
      remove: async (id, actor) => {
        await this.users.deleteUser(actor, id);
      },
      setHidden: async (ids, hidden, actor, reason) => {
        if (hidden && !reason?.trim()) throw new BadRequestException('اكتب سبب الإيقاف');
        const skipped: { id: string; reason: string }[] = [];
        for (const id of ids) {
          try {
            await this.users.setBlocked(actor, id, hidden, reason);
          } catch (err) {
            skipped.push({ id, reason: reasonOf(err) });
          }
        }
        return skipped;
      },
      unlink: async (id, key) => {
        if (key === 'branch') await prisma.user.update({ where: { id }, data: { branchId: null } });
      },
    };
  }

  // ------------------------------------------------------------------ Drivers

  private driversHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'buses.manage',
      // A driver is an employee account, and the users service asks for the employees' delete permission too.
      deletePermission: 'employees.delete',
      inspect: async (ids) => {
        const drivers = await prisma.user.findMany({
          where: { id: { in: ids }, driverProfile: { isNot: null } },
          select: {
            id: true,
            name: true,
            phone: true,
            blockedAt: true,
            driverProfile: { select: { isActive: true } },
            fixedBus: { select: { plateNumber: true } },
            employeeProfile: { select: { userId: true } },
            _count: { select: { tripDrivers: true } },
          },
        });
        return drivers.map((driver) => {
          const blockers: Blocker[] = [];
          if (driver._count.tripDrivers) blockers.push({ key: 'trips', label: `قاد ${plural(driver._count.tripDrivers, 'رحلة', 'رحلات')} أو مسند لها`, href: '/buses' });
          if (driver.employeeProfile) blockers.push({ key: 'hr', label: 'له ملف وظيفي، أنهِ خدمته بمخالصة نهاية الخدمة', href: '/hr' });
          if (driver.fixedBus) blockers.push({ key: 'bus', label: `السائق الثابت للباص ${driver.fixedBus.plateNumber}`, unlink: 'bus' });
          return { id: driver.id, name: [driver.name, driver.phone].filter(Boolean).join(' · '), hidden: driver.driverProfile?.isActive === false, blockers };
        });
      },
      remove: async (id, actor) => {
        await this.users.deleteUser(actor, id);
      },
      setHidden: async (ids, hidden, actor) => {
        const skipped: { id: string; reason: string }[] = [];
        for (const id of ids) {
          try {
            // The drivers service refuses to stop one still on an open trip and lets go of their bus.
            await this.drivers.update(actor, id, { isActive: !hidden });
          } catch (err) {
            skipped.push({ id, reason: reasonOf(err) });
          }
        }
        return skipped;
      },
      unlink: async (id, key) => {
        if (key === 'bus') await prisma.bus.updateMany({ where: { fixedDriverId: id }, data: { fixedDriverId: null } });
      },
    };
  }

  // ------------------------------------------------------------------ Bus offices

  private busOfficesHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'buses.accounts',
      deletePermission: 'buses.delete',
      inspect: async (ids) => {
        const offices = await prisma.busOffice.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, isActive: true, _count: { select: { buses: true, rates: true, payments: true } } },
        });
        return offices.map((office) => {
          const blockers: Blocker[] = [];
          if (office._count.payments) blockers.push({ key: 'payments', label: 'عليه مدفوعات مسجلة', href: '/buses/statement' });
          if (office._count.buses) blockers.push({ key: 'buses', label: `يملك ${plural(office._count.buses, 'باص', 'باصات')}`, unlink: 'buses' });
          if (office._count.rates) blockers.push({ key: 'rates', label: 'له جدول أسعار إيجار', unlink: 'rates' });
          return { id: office.id, name: office.name, hidden: !office.isActive, blockers };
        });
      },
      remove: async (id) => {
        await prisma.busOffice.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.busOffice.updateMany({ where: { id: { in: ids } }, data: { isActive: !hidden } });
        return [];
      },
      unlink: async (id, key) => {
        if (key === 'buses') await prisma.bus.updateMany({ where: { officeId: id }, data: { officeId: null } });
        if (key === 'rates') await prisma.busOfficeRate.deleteMany({ where: { officeId: id } });
      },
    };
  }

  // ------------------------------------------------------------------ Loyalty rules

  private loyaltyRulesHandler(): Handler {
    const prisma = this.prisma;
    return {
      permission: 'loyalty.manage',
      deletePermission: 'loyalty.delete',
      inspect: async (ids) => {
        const rules = await prisma.loyaltyRule.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isActive: true } });
        // Bookings keep the terms they were made under, so a rule never holds anything back.
        return rules.map((rule) => ({ id: rule.id, name: rule.name, hidden: !rule.isActive, blockers: [] }));
      },
      remove: async (id) => {
        await prisma.loyaltyRule.delete({ where: { id } });
      },
      setHidden: async (ids, hidden) => {
        await prisma.loyaltyRule.updateMany({ where: { id: { in: ids } }, data: { isActive: !hidden } });
        return [];
      },
    };
  }
}

/** What the office reads when one row could not go after all. */
function reasonOf(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')) return 'مرتبط بسجلات أخرى في النظام';
  if (err instanceof HttpException) {
    const response = err.getResponse();
    const message = typeof response === 'string' ? response : (response as { message?: string | string[] }).message;
    return Array.isArray(message) ? message.join('، ') : message ?? err.message;
  }
  return 'تعذر الحذف';
}

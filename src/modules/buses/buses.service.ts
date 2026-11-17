import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { BusStatus, Prisma, SoloTravelerPolicy, VehicleKind } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { applyBusServices } from '../../common/utils/bus-services.util';
import { fillContractRent } from '../../common/utils/contract-rent.util';
import { BUS_SEAT_COUNT, seatLayoutFor, seatLimitsFor } from '../../common/utils/bus-layout.util';
import { assertSinglesFitRange, assertValidSinglesRange, singlesRangeFor } from '../../common/utils/singles-seats.util';
import { applySeatLayout } from '../../common/utils/trip-seats.util';
import { PublicService, SERVICE_SELECT } from '../../common/utils/services.util';
import { GALLERY_SELECT, galleryRows } from '../../common/utils/gallery.util';
import { DRIVER_ELIGIBLE } from '../../common/utils/crew-eligibility.util';

interface BusInput {
  plateNumber?: string;
  model?: string;
  color?: string;
  images?: string[];
  imageUrl?: string;
  company?: string;
  serviceIds?: string[];
  officeId?: string | null;
  status?: BusStatus;
  kind?: VehicleKind;
  seatCount?: number;
  singlesFromSeat?: number;
  singlesToSeat?: number;
  soloTravelerPolicy?: SoloTravelerPolicy;
  fixedDriverId?: string | null;
}

const FIXED_DRIVER_SELECT = { select: { id: true, name: true, phone: true } };

/**
 * Makes a driver the fixed one of a bus, or clears the bus's when driverId is null. One driver has one fixed bus at most,
 * so a driver fixed on another bus moves to this one. Only an active driver account can be fixed on a bus.
 */
export async function setFixedDriver(tx: Prisma.TransactionClient, busId: string, driverId: string | null) {
  if (driverId) {
    const driver = await tx.user.findFirst({
      where: { id: driverId, ...DRIVER_ELIGIBLE, blockedAt: null },
      select: { driverProfile: { select: { isActive: true } } },
    });
    if (!driver) throw new BadRequestException('السائق المحدد غير موجود');
    if (driver.driverProfile?.isActive === false) throw new ConflictException('السائق المحدد موقوف');
    await tx.bus.updateMany({ where: { fixedDriverId: driverId, id: { not: busId } }, data: { fixedDriverId: null } });
  }
  await tx.bus.update({ where: { id: busId }, data: { fixedDriverId: driverId } });
}

/**
 * How many a vehicle seats. A bus sent without a count is the standard 49-seat bus, as every bus was before buses had
 * other sizes; a van or minibus always needs its count, and one too big for it is a bus.
 */
function vehicleCapacity(kind: VehicleKind, seatCount: number | undefined) {
  const count = kind === 'BUS' ? seatCount ?? BUS_SEAT_COUNT : seatCount;
  if (!count) throw new BadRequestException('أدخل عدد مقاعد المركبة');
  const limits = seatLimitsFor(kind);
  if (count < limits.min || count > limits.max) {
    throw new BadRequestException(
      kind === 'BUS'
        ? `مقاعد الباص من ${limits.min} إلى ${limits.max}، وللأقل اختر فان أو باص صغير`
        : `مقاعد الفان والباص الصغير من ${limits.min} إلى ${limits.max}، وللأكثر اختر باص`,
    );
  }
  return count;
}

const OFFICE_SELECT = { select: { id: true, name: true } };
const SERVICES_SELECT = SERVICE_SELECT;

/**
 * The gallery a save asks for, or undefined to leave it alone. An admin panel from before galleries sends its one photo
 * as imageUrl, which then stands for the whole gallery, as it did then.
 */
const galleryOf = (dto: BusInput) => {
  if (dto.images) return dto.images;
  if (dto.imageUrl === undefined) return undefined;
  const url = dto.imageUrl.trim();
  return url ? [url] : [];
};

const withServices = <T extends { services: { service: PublicService }[] }>(bus: T) => ({
  ...bus,
  services: bus.services.map((row) => row.service),
});

/** Who is on the road right now and what is still to come, for a bus or a driver. */
export const splitOpenTrips = <T extends { tripCode: string; departureTime: Date; tripStatus: string }>(trips: T[], now = new Date()) => {
  const sorted = [...trips].sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());
  const current = sorted.find((trip) => trip.tripStatus === 'PUBLISHED' && trip.departureTime <= now);
  return {
    currentTrip: current?.tripCode ?? null,
    upcomingTrips: sorted.filter((trip) => trip !== current && trip.departureTime > now).map((trip) => trip.tripCode),
  };
};

export const openTripsWhere = (now = new Date()): Prisma.TripWhereInput => ({ tripStatus: { in: ['DRAFT', 'PUBLISHED'] }, arrivalTime: { gt: now } });

@Injectable()
export class BusesService {
  constructor(private prisma: PrismaService, private appSettings: AppSettingsService) {}

  async getAllBuses() {
    const buses = await this.prisma.bus.findMany({
      include: {
        office: OFFICE_SELECT,
        services: SERVICES_SELECT,
        images: GALLERY_SELECT,
        fixedDriver: FIXED_DRIVER_SELECT,
        trips: { where: openTripsWhere(), select: { tripCode: true, departureTime: true, tripStatus: true } },
        _count: { select: { trips: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return buses.map(({ trips, _count, ...bus }) => ({ ...withServices(bus), tripCount: _count.trips, ...splitOpenTrips(trips) }));
  }

  async getBusById(id: string) {
    const bus = await this.prisma.bus.findUnique({
      where: { id },
      include: {
        office: OFFICE_SELECT,
        services: SERVICES_SELECT,
        images: GALLERY_SELECT,
        fixedDriver: FIXED_DRIVER_SELECT,
        trips: { select: { id: true, tripCode: true, departureTime: true, tripStatus: true } },
      },
    });
    if (!bus) throw new NotFoundException('Bus not found');
    return withServices(bus);
  }

  /** The office's name replaces the free-text company, so the two can never disagree. */
  private async companyOf(officeId: string) {
    const office = await this.prisma.busOffice.findUnique({ where: { id: officeId } });
    if (!office) throw new BadRequestException('مكتب الباصات غير موجود');
    if (!office.isActive) throw new ConflictException('مكتب الباصات موقوف');
    return office.name;
  }

  async createBus(dto: BusInput & { plateNumber: string; model: string }) {
    const existing = await this.prisma.bus.findUnique({
      where: { plateNumber: dto.plateNumber },
    });
    if (existing) {
      throw new ConflictException(`Bus with plate number ${dto.plateNumber} already exists`);
    }

    const kind = dto.kind ?? 'BUS';
    const seatCount = vehicleCapacity(kind, dto.seatCount);
    const defaults = singlesRangeFor(await this.appSettings.singlesRange(null), seatCount);
    const singles = { from: dto.singlesFromSeat ?? defaults.from, to: dto.singlesToSeat ?? defaults.to };
    assertValidSinglesRange(singles, seatCount);
    const serviceIds = await this.knownServices(dto.serviceIds);
    const gallery = galleryOf(dto) ?? [];
    const company = dto.officeId ? await this.companyOf(dto.officeId) : dto.company || 'دروب الهجرة للنقل';
    return this.prisma.$transaction(async (tx) => {
      const bus = await tx.bus.create({
        data: {
          kind,
          seatCount,
          singlesFromSeat: singles.from,
          singlesToSeat: singles.to,
          soloTravelerPolicy: dto.soloTravelerPolicy,
          plateNumber: dto.plateNumber,
          model: dto.model,
          color: dto.color || 'أبيض',
          // The cover is kept on the bus too, for copies of the app that read only it.
          imageUrl: gallery[0] ?? null,
          company,
          officeId: dto.officeId || null,
          status: dto.status ?? 'ACTIVE',
          services: serviceIds?.length ? { create: serviceIds.map((serviceId) => ({ serviceId })) } : undefined,
          images: gallery.length ? { create: galleryRows(gallery) } : undefined,
        },
        select: { id: true },
      });
      if (dto.fixedDriverId) await setFixedDriver(tx, bus.id, dto.fixedDriverId);
      const created = await tx.bus.findUniqueOrThrow({
        where: { id: bus.id },
        include: { services: SERVICES_SELECT, images: GALLERY_SELECT, fixedDriver: FIXED_DRIVER_SELECT },
      });
      return withServices(created);
    });
  }

  private async knownServices(serviceIds?: string[]) {
    if (!serviceIds) return undefined;
    const unique = [...new Set(serviceIds)];
    const found = await this.prisma.service.count({ where: { id: { in: unique } } });
    if (found !== unique.length) throw new BadRequestException('إحدى الخدمات غير موجودة');
    return unique;
  }

  async updateBus(id: string, dto: BusInput) {
    const bus = await this.getBusById(id);
    const kind = dto.kind ?? bus.kind;
    const seatCount = vehicleCapacity(kind, dto.seatCount ?? (kind === bus.kind ? bus.seatCount : undefined));
    const capacityChanges = kind !== bus.kind || seatCount !== bus.seatCount;
    const singles = { from: dto.singlesFromSeat ?? bus.singlesFromSeat, to: dto.singlesToSeat ?? bus.singlesToSeat };
    assertValidSinglesRange(singles, seatCount);
    if (singles.from !== bus.singlesFromSeat || singles.to !== bus.singlesToSeat) {
      await assertSinglesFitRange(this.prisma, { busId: id, ...openTripsWhere() }, singles);
    }
    const officeId = dto.officeId === undefined ? undefined : dto.officeId || null;
    const officeChanges = officeId !== undefined && officeId !== bus.officeId;
    // Statements are built from a bus's current office, so moving it would rewrite what another office was owed.
    if (officeChanges && bus.officeId && bus.trips.some((trip) => trip.tripStatus !== 'CANCELLED')) {
      throw new ConflictException('لا يمكن نقل باص له رحلات إلى مالك آخر لأن ذلك يغيّر كشوف الحساب السابقة');
    }
    const company = !officeChanges
      ? (bus.officeId ? undefined : dto.company)
      : officeId
        ? await this.companyOf(officeId)
        : dto.company || 'دروب الهجرة للنقل';
    const serviceIds = await this.knownServices(dto.serviceIds);
    const gallery = galleryOf(dto);
    return this.prisma.$transaction(async (tx) => {
      if (gallery) {
        await tx.busImage.deleteMany({ where: { busId: id } });
        await tx.busImage.createMany({ data: galleryRows(gallery).map((row) => ({ ...row, busId: id })) });
      }
      if (serviceIds) {
        await tx.busService.deleteMany({ where: { busId: id } });
        await tx.busService.createMany({ data: serviceIds.map((serviceId) => ({ busId: id, serviceId })) });
        // Passengers still choosing a trip see what the bus offers now; finished trips keep their record.
        const openTrips = await tx.trip.findMany({ where: { busId: id, ...openTripsWhere() }, select: { id: true } });
        for (const trip of openTrips) await applyBusServices(tx, trip.id, id);
      }
      if (capacityChanges) {
        // Trips still to run take the new seats; one with a passenger on a seat that goes away stops the change.
        const layout = seatLayoutFor({ kind, seatCount });
        const openTrips = await tx.trip.findMany({ where: { busId: id, ...openTripsWhere() }, select: { id: true } });
        for (const trip of openTrips) await applySeatLayout(tx, trip.id, layout);
      }
      const updated = await tx.bus.update({
        where: { id },
        data: {
          kind,
          seatCount,
          plateNumber: dto.plateNumber,
          model: dto.model,
          color: dto.color,
          imageUrl: gallery ? gallery[0] ?? null : undefined,
          company,
          officeId,
          status: dto.status,
          singlesFromSeat: singles.from,
          singlesToSeat: singles.to,
          soloTravelerPolicy: dto.soloTravelerPolicy,
        },
        select: { id: true },
      });
      if (dto.fixedDriverId !== undefined) await setFixedDriver(tx, updated.id, dto.fixedDriverId || null);
      // A bus newly linked to an office brings its trips' rent onto that office's statement.
      if (officeChanges && officeId) await fillContractRent(tx, { busId: id });
      const saved = await tx.bus.findUniqueOrThrow({
        where: { id },
        include: { services: SERVICES_SELECT, images: GALLERY_SELECT, fixedDriver: FIXED_DRIVER_SELECT },
      });
      return withServices(saved);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async deleteBus(id: string) {
    const bus = await this.getBusById(id);
    if (bus.trips.length > 0) {
      throw new ConflictException('لا يمكن حذف حافلة مرتبطة برحلات، يمكنك تغيير حالتها إلى غير نشطة');
    }
    await this.prisma.bus.delete({ where: { id } });
    return { success: true };
  }
}

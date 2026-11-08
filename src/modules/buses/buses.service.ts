import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { BusStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { applyBusServices } from '../../common/utils/bus-services.util';
import { assertSinglesFitRange, assertValidSinglesRange } from '../../common/utils/singles-seats.util';
import { PublicService, SERVICE_SELECT } from '../../common/utils/services.util';

interface BusInput {
  plateNumber?: string;
  model?: string;
  color?: string;
  imageUrl?: string;
  company?: string;
  serviceIds?: string[];
  officeId?: string | null;
  status?: BusStatus;
  singlesFromSeat?: number;
  singlesToSeat?: number;
}

const OFFICE_SELECT = { select: { id: true, name: true } };
const SERVICES_SELECT = SERVICE_SELECT;

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

    const defaults = await this.appSettings.singlesRange(null);
    const singles = { from: dto.singlesFromSeat ?? defaults.from, to: dto.singlesToSeat ?? defaults.to };
    assertValidSinglesRange(singles);
    const serviceIds = await this.knownServices(dto.serviceIds);
    const bus = await this.prisma.bus.create({
      data: {
        singlesFromSeat: singles.from,
        singlesToSeat: singles.to,
        plateNumber: dto.plateNumber,
        model: dto.model,
        color: dto.color || 'أبيض',
        imageUrl: dto.imageUrl,
        company: dto.officeId ? await this.companyOf(dto.officeId) : dto.company || 'دروب الهجرة للنقل',
        officeId: dto.officeId || null,
        status: dto.status ?? 'ACTIVE',
        services: serviceIds?.length ? { create: serviceIds.map((serviceId) => ({ serviceId })) } : undefined,
      },
      include: { services: SERVICES_SELECT },
    });
    return withServices(bus);
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
    const singles = { from: dto.singlesFromSeat ?? bus.singlesFromSeat, to: dto.singlesToSeat ?? bus.singlesToSeat };
    assertValidSinglesRange(singles);
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
    return this.prisma.$transaction(async (tx) => {
      if (serviceIds) {
        await tx.busService.deleteMany({ where: { busId: id } });
        await tx.busService.createMany({ data: serviceIds.map((serviceId) => ({ busId: id, serviceId })) });
        // Passengers still choosing a trip see what the bus offers now; finished trips keep their record.
        const openTrips = await tx.trip.findMany({ where: { busId: id, ...openTripsWhere() }, select: { id: true } });
        for (const trip of openTrips) await applyBusServices(tx, trip.id, id);
      }
      const updated = await tx.bus.update({
        where: { id },
        data: {
          plateNumber: dto.plateNumber,
          model: dto.model,
          color: dto.color,
          imageUrl: dto.imageUrl,
          company,
          officeId,
          status: dto.status,
          singlesFromSeat: singles.from,
          singlesToSeat: singles.to,
        },
        include: { services: SERVICES_SELECT },
      });
      return withServices(updated);
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

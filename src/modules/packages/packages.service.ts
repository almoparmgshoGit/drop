import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { riyadhDayRange } from '../../common/utils/time.util';
import { packageWindowProblem } from '../../common/utils/package-window.util';
import { PACKAGE_MAX_PERSONS, PackagePrices, packagePriceTiers } from '../../common/utils/package-price.util';
import { appTripWhere, PUBLIC_TRIP_INCLUDE, toPublicTrip } from '../trips/trips.service';
import { CreatePackageDto, PackageSearchQuery, UpdatePackageDto } from './packages.controller';

/** A package reaches customers only through a trip they can book, and only with those trips. */
const publicPackageArgs = (tripWhere: Prisma.TripWhereInput) => ({
  where: { status: 'PUBLISHED' as const, trips: { some: tripWhere } },
  include: {
    images: true,
    services: { include: { service: true } },
    trips: { where: tripWhere, orderBy: { departureTime: 'asc' as const }, include: PUBLIC_TRIP_INCLUDE },
  },
});

const toPublicPackage = <T extends PackagePrices & { trips: object[] }>(pkg: T) => ({
  ...pkg,
  maxPersons: PACKAGE_MAX_PERSONS,
  priceTiers: packagePriceTiers(pkg),
  trips: pkg.trips.map((trip) => toPublicTrip({ ...trip, pricePerSeat: Number(pkg.price), packagePriceTiers: packagePriceTiers(pkg) })),
});

/** A bigger group paying less in total than a smaller one is almost always a typing slip. */
function assertGroupPrices(prices: { price: number; price2: number; price3: number; price4: number }) {
  const totals = [prices.price, prices.price2, prices.price3, prices.price4];
  if (totals.some((total, index) => index > 0 && total < totals[index - 1])) {
    throw new BadRequestException('سعر الباقة لعدد أكبر من الأشخاص لا يقل عن سعرها لعدد أقل');
  }
}

/** undefined leaves the saved date alone, null or an empty value clears it. */
const dateInput = (value: string | null | undefined) => (value === undefined ? undefined : value ? new Date(value) : null);

@Injectable()
export class PackagesService {
  constructor(private prisma: PrismaService) {}

  async getPublishedPackages(search: PackageSearchQuery = {}) {
    const packages = await this.prisma.package.findMany({
      ...publicPackageArgs(appTripWhere(search)),
      orderBy: { createdAt: 'desc' },
    });
    return packages.map(toPublicPackage);
  }

  /** The next day this route has a package trip with seats, for when the chosen day has none. */
  async getNextAvailableDate(search: Pick<PackageSearchQuery, 'origin' | 'destination'> & { after?: string }) {
    const where = appTripWhere({ origin: search.origin, destination: search.destination });
    const after = search.after ? riyadhDayRange(search.after)?.end : undefined;
    const trip = await this.prisma.trip.findFirst({
      where: {
        ...where,
        ...(after && after > new Date() && { departureTime: { gt: after } }),
        availableSeats: { gt: 0 },
        package: { status: 'PUBLISHED' },
      },
      orderBy: { departureTime: 'asc' },
      select: { departureTime: true },
    });
    return { departureTime: trip?.departureTime ?? null };
  }

  async getPublishedPackageById(id: string) {
    const args = publicPackageArgs(appTripWhere({}));
    const pkg = await this.prisma.package.findFirst({ ...args, where: { ...args.where, id } });
    if (!pkg) throw new NotFoundException('Package not found');
    return toPublicPackage(pkg);
  }

  async getAllPackagesAdmin() {
    return this.prisma.package.findMany({
      include: {
        images: true,
        services: { include: { service: true } },
        trips: { select: { id: true, tripCode: true, tripStatus: true, departureTime: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private assertDateOrder(startDate: Date | null, endDate: Date | null) {
    if (startDate && endDate && endDate < startDate) throw new BadRequestException('تاريخ نهاية الباقة قبل تاريخ بدايتها');
  }

  async createPackage(dto: CreatePackageDto) {
    this.assertDateOrder(dateInput(dto.startDate) ?? null, dateInput(dto.endDate) ?? null);
    const prices = { price: dto.price, price2: dto.price2 ?? dto.price * 2, price3: dto.price3 ?? dto.price * 3, price4: dto.price4 ?? dto.price * 4 };
    assertGroupPrices(prices);
    return this.prisma.package.create({
      data: {
        name: dto.name,
        description: dto.description,
        ...prices,
        nights: dto.nights ?? 1,
        type: dto.type || 'OMRA',
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        status: dto.status || 'DRAFT',
        terms: dto.terms,
        images: dto.images?.length ? { create: dto.images.map((url) => ({ url })) } : undefined,
        services: dto.serviceIds?.length ? { create: dto.serviceIds.map((serviceId) => ({ serviceId })) } : undefined,
      },
      include: { images: true, services: { include: { service: true } } },
    });
  }

  async updatePackage(id: string, dto: UpdatePackageDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.package.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Package not found');

      const startDate = dateInput(dto.startDate);
      const endDate = dateInput(dto.endDate);
      const window = { startDate: startDate === undefined ? existing.startDate : startDate, endDate: endDate === undefined ? existing.endDate : endDate };
      this.assertDateOrder(window.startDate, window.endDate);
      assertGroupPrices({
        price: dto.price ?? Number(existing.price),
        price2: dto.price2 ?? Number(existing.price2),
        price3: dto.price3 ?? Number(existing.price3),
        price4: dto.price4 ?? Number(existing.price4),
      });
      if (startDate !== undefined || endDate !== undefined) {
        // Narrowing the dates must not strand a trip that is still to run outside them.
        const trips = await tx.trip.findMany({
          where: { packageId: id, tripStatus: { notIn: ['CANCELLED', 'COMPLETED'] } },
          select: { tripCode: true, departureTime: true },
        });
        const outside = trips.filter((trip) => packageWindowProblem(window, trip.departureTime));
        if (outside.length) {
          throw new ConflictException(`رحلات مرتبطة بالباقة تقع خارج الفترة الجديدة: ${outside.map((trip) => trip.tripCode).join('، ')}`);
        }
      }

      if (dto.images) {
        await tx.packageImage.deleteMany({ where: { packageId: id } });
        await tx.packageImage.createMany({ data: dto.images.map((url) => ({ packageId: id, url })) });
      }
      if (dto.serviceIds) {
        await tx.packageService.deleteMany({ where: { packageId: id } });
        await tx.packageService.createMany({ data: dto.serviceIds.map((serviceId) => ({ packageId: id, serviceId })) });
      }
      return tx.package.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          price: dto.price,
          price2: dto.price2,
          price3: dto.price3,
          price4: dto.price4,
          nights: dto.nights,
          type: dto.type,
          startDate,
          endDate,
          status: dto.status,
          terms: dto.terms,
        },
        include: { images: true, services: { include: { service: true } } },
      });
    });
  }

  async deletePackage(id: string) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    const linkedTrips = await this.prisma.trip.count({ where: { packageId: id } });
    if (linkedTrips > 0) {
      throw new ConflictException('لا يمكن حذف باقة مرتبطة برحلات، يمكنك أرشفتها بدلًا من ذلك');
    }
    await this.prisma.package.delete({ where: { id } });
    return { success: true };
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { riyadhDayRange } from '../../common/utils/time.util';
import { packageWindowProblem } from '../../common/utils/package-window.util';
import { PACKAGE_MAX_PERSONS, PackagePrices, packagePriceTiers } from '../../common/utils/package-price.util';
import { appTripWhere, PUBLIC_TRIP_INCLUDE, toPublicTrip } from '../trips/trips.service';
import { CreatePackageDto, PackageSearchQuery, UpdatePackageDto } from './packages.controller';
import { CUSTOM_PACKAGE_SELECT, toPublicCustomPackage } from '../../common/utils/custom-package.util';

type CustomFields = Pick<CreatePackageDto, 'origin' | 'destination' | 'hotelId' | 'nightlyBedPrice' | 'nightlyRoomPrice' | 'minDepartureHour'>;

/** A custom package needs its route, its hotel and a nightly price for at least one room type. */
function assertCustomFields(fields: CustomFields) {
  if (!fields.origin?.trim() || !fields.destination?.trim()) throw new BadRequestException('حدد مدينة الانطلاق والوجهة للباقة');
  if (fields.origin.trim() === fields.destination.trim()) throw new BadRequestException('الوجهة يجب أن تختلف عن مدينة الانطلاق');
  if (!fields.hotelId) throw new BadRequestException('اختر فندق الباقة');
  if (fields.nightlyBedPrice == null && fields.nightlyRoomPrice == null) throw new BadRequestException('أدخل سعر الليلة للسرير أو للغرفة الخاصة');
}

/** The saved fields of a custom package; a fixed package keeps none of them. */
const customData = (kind: string, fields: CustomFields) =>
  kind === 'CUSTOM'
    ? {
        origin: fields.origin?.trim(),
        destination: fields.destination?.trim(),
        hotelId: fields.hotelId,
        nightlyBedPrice: fields.nightlyBedPrice ?? null,
        nightlyRoomPrice: fields.nightlyRoomPrice ?? null,
        minDepartureHour: fields.minDepartureHour ?? 17,
      }
    : { origin: null, destination: null, hotelId: null, nightlyBedPrice: null, nightlyRoomPrice: null };

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

  /** Packages the customer builds on the searched route: no trips of their own, so they show whenever they are published and in date. */
  async getCustomPackages(search: PackageSearchQuery = {}) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const packages = await this.prisma.package.findMany({
      where: {
        kind: 'CUSTOM',
        status: 'PUBLISHED',
        hotel: { isActive: true },
        ...(search.origin && { origin: { contains: search.origin, mode: 'insensitive' as const } }),
        ...(search.destination && { destination: { contains: search.destination, mode: 'insensitive' as const } }),
        OR: [{ endDate: null }, { endDate: { gte: today } }],
      },
      select: CUSTOM_PACKAGE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return packages.map(toPublicCustomPackage);
  }

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
        hotel: { select: { id: true, name: true, city: true } },
        _count: { select: { bookings: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private assertDateOrder(startDate: Date | null, endDate: Date | null) {
    if (startDate && endDate && endDate < startDate) throw new BadRequestException('تاريخ نهاية الباقة قبل تاريخ بدايتها');
  }

  async createPackage(dto: CreatePackageDto) {
    this.assertDateOrder(dateInput(dto.startDate) ?? null, dateInput(dto.endDate) ?? null);
    const kind = dto.kind ?? 'FIXED';
    if (kind === 'CUSTOM') assertCustomFields(dto);
    // A custom package is priced from its trips and nights, so its group totals stay at zero.
    const prices =
      kind === 'CUSTOM'
        ? { price: 0, price2: 0, price3: 0, price4: 0 }
        : { price: dto.price, price2: dto.price2 ?? dto.price * 2, price3: dto.price3 ?? dto.price * 3, price4: dto.price4 ?? dto.price * 4 };
    if (kind === 'FIXED') assertGroupPrices(prices);
    return this.prisma.package.create({
      data: {
        name: dto.name,
        description: dto.description,
        ...prices,
        kind,
        ...customData(kind, dto),
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
      // The kind is set when the package is made: a fixed package has trips and bookings priced by group size.
      if (dto.kind && dto.kind !== existing.kind) throw new BadRequestException('لا يمكن تغيير نوع الباقة بعد إنشائها، أنشئ باقة جديدة');
      const isCustom = existing.kind === 'CUSTOM';
      const custom: CustomFields = {
        origin: dto.origin ?? existing.origin ?? undefined,
        destination: dto.destination ?? existing.destination ?? undefined,
        hotelId: dto.hotelId ?? existing.hotelId ?? undefined,
        nightlyBedPrice: dto.nightlyBedPrice !== undefined ? dto.nightlyBedPrice : existing.nightlyBedPrice === null ? null : Number(existing.nightlyBedPrice),
        nightlyRoomPrice: dto.nightlyRoomPrice !== undefined ? dto.nightlyRoomPrice : existing.nightlyRoomPrice === null ? null : Number(existing.nightlyRoomPrice),
        minDepartureHour: dto.minDepartureHour ?? existing.minDepartureHour,
      };
      if (isCustom) assertCustomFields(custom);
      else
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
          ...(isCustom ? customData('CUSTOM', custom) : { price: dto.price, price2: dto.price2, price3: dto.price3, price4: dto.price4 }),
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
    const bookings = await this.prisma.booking.count({ where: { customPackageId: id } });
    if (bookings > 0) throw new ConflictException('لا يمكن حذف باقة لها حجوزات، يمكنك أرشفتها بدلًا من ذلك');
    if (linkedTrips > 0) {
      throw new ConflictException('لا يمكن حذف باقة مرتبطة برحلات، يمكنك أرشفتها بدلًا من ذلك');
    }
    await this.prisma.package.delete({ where: { id } });
    return { success: true };
  }
}

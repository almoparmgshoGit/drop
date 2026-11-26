import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { formatRiyadhTime, riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import { seatPricing } from '../../common/utils/dynamic-pricing.util';
import { assertTripFitsPackage, packageWindowProblem } from '../../common/utils/package-window.util';
import { RoomAllocationService } from '../../common/services/room-allocation.service';
import { PACKAGE_MAX_PERSONS, PackagePrices, packagePriceTiers } from '../../common/utils/package-price.util';
import { appTripWhere, bookingTypeWhere, PUBLIC_TRIP_INCLUDE, toPublicTrip } from '../trips/trips.service';
import { CreatePackageDto, CustomJourneyQuery, CustomPreviewDto, PackageDepartureDto, PackageSearchQuery, UpdatePackageDto } from './packages.controller';
import {
  CUSTOM_PACKAGE_MAX_NIGHTS,
  CUSTOM_PACKAGE_SELECT,
  HOTEL_PACKAGE_SELECT,
  customPackageStay,
  customRoomOptions,
  hotelCustomPackage,
  loadCustomPackage,
  riyadhHour,
  toPublicCustomPackage,
} from '../../common/utils/custom-package.util';

/** One city written two ways ("مكة" and "مكة المكرمة") is still one city. */
const sameCity = (a: string | null | undefined, b: string | null | undefined) => {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/** How far ahead the package builder lists days to travel on. */
const JOURNEY_DAYS_AHEAD = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the package builder reads of a trip: enough to list it under its day and price its seats. */
const JOURNEY_TRIP_SELECT = {
  id: true,
  tripCode: true,
  origin: true,
  destination: true,
  departureTime: true,
  departureStation: true,
  busType: true,
  price: true,
  pricingRules: true,
  totalSeats: true,
  availableSeats: true,
  maxSeatsPerBooking: true,
  packageId: true,
  package: { select: { id: true } },
} satisfies Prisma.TripSelect;

type JourneyTrip = Prisma.TripGetPayload<{ select: typeof JOURNEY_TRIP_SELECT }>;

/** Trips grouped by their day in Riyadh, each with its time and the seat price the booking will charge. */
const journeyDays = (trips: JourneyTrip[]) => {
  const days = new Map<string, object[]>();
  for (const trip of trips) {
    const date = riyadhDate(trip.departureTime);
    const list = days.get(date) ?? [];
    list.push({
      id: trip.id,
      tripCode: trip.tripCode,
      departureTime: trip.departureTime,
      time: formatRiyadhTime(trip.departureTime),
      hour: riyadhHour(trip.departureTime),
      departureStation: trip.departureStation,
      busType: trip.busType,
      availableSeats: trip.availableSeats,
      pricePerSeat: seatPricing(trip).price / 100,
    });
    days.set(date, list);
  }
  return [...days.entries()].map(([date, dayTrips]) => ({ date, trips: dayTrips }));
};

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
    // Each outbound with the trip back its package price covers, so the app books the two together.
    trips: { where: tripWhere, orderBy: { departureTime: 'asc' as const }, include: { ...PUBLIC_TRIP_INCLUDE, packageReturn: { include: PUBLIC_TRIP_INCLUDE } } },
  },
});

const toPublicPackage = <T extends PackagePrices & { trips: object[] }>(pkg: T) => ({
  ...pkg,
  maxPersons: PACKAGE_MAX_PERSONS,
  priceTiers: packagePriceTiers(pkg),
  trips: pkg.trips.map((trip) => {
    const { packageReturn, ...outbound } = trip as typeof trip & { packageReturn?: Parameters<typeof toPublicTrip>[0] | null };
    return {
      ...toPublicTrip({ ...outbound, pricePerSeat: Number(pkg.price), packagePriceTiers: packagePriceTiers(pkg) } as Parameters<typeof toPublicTrip>[0]),
      // Included in the package price: the app shows it and books its seats with the outbound's.
      packageReturn: packageReturn ? toPublicTrip(packageReturn) : null,
    };
  }),
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
  constructor(
    private prisma: PrismaService,
    private rooms: RoomAllocationService,
  ) {}

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

  /**
   * The routes a customer can build a package on right now: a published custom package, and on its route an outbound the
   * package takes and a return the other way, both still on sale with a seat. A route without trips is left out.
   */
  async getCustomRoutes() {
    const now = new Date();
    const until = new Date(now.getTime() + JOURNEY_DAYS_AHEAD * DAY_MS);
    const [packages, hotels, pairs] = await Promise.all([
      this.getCustomPackages({}),
      this.hotelsForPackages(),
      // Every route with transport trips on sale: the customer builds a package on any of them that has a hotel.
      this.prisma.trip.findMany({
        where: { ...appTripWhere({}), packageId: null, availableSeats: { gt: 0 }, departureTime: { gt: now, lt: until }, AND: [...(appTripWhere({}).AND as Prisma.TripWhereInput[]), bookingTypeWhere('TRANSPORT_ONLY')] },
        distinct: ['origin', 'destination'],
        select: { origin: true, destination: true },
      }),
    ]);
    const routes = new Map<string, { origin: string; destination: string; minHour: number }>();
    for (const pkg of packages) {
      if (!pkg.origin || !pkg.destination) continue;
      const key = `${pkg.origin}→${pkg.destination}`;
      const known = routes.get(key);
      routes.set(key, { origin: pkg.origin, destination: pkg.destination, minHour: Math.min(known?.minHour ?? 24, pkg.minDepartureHour) });
    }
    // A hotel's own prices take any outbound, at any hour.
    for (const pair of pairs) {
      if (!hotels.some((hotel) => sameCity(hotel.city, pair.destination))) continue;
      routes.set(`${pair.origin}→${pair.destination}`, { origin: pair.origin, destination: pair.destination, minHour: 0 });
    }
    const legWhere = (from: string, to: string): Prisma.TripWhereInput => {
      const base = appTripWhere({});
      return {
        ...base,
        origin: { equals: from, mode: 'insensitive' },
        destination: { equals: to, mode: 'insensitive' },
        packageId: null,
        availableSeats: { gt: 0 },
        departureTime: { gt: now, lt: until },
        AND: [...(base.AND as Prisma.TripWhereInput[]), bookingTypeWhere('TRANSPORT_ONLY')],
      };
    };
    const checked = await Promise.all(
      [...routes.values()].map(async (route) => {
        const [outbound, inbound] = await Promise.all([
          this.prisma.trip.findMany({ where: legWhere(route.origin, route.destination), select: { departureTime: true }, orderBy: { departureTime: 'asc' }, take: 200 }),
          this.prisma.trip.findFirst({ where: legWhere(route.destination, route.origin), select: { id: true } }),
        ]);
        // The outbound must leave at an hour one of the route's packages takes.
        const first = outbound.find((trip) => riyadhHour(trip.departureTime) >= route.minHour);
        return first && inbound ? { origin: route.origin, destination: route.destination, firstDate: riyadhDate(first.departureTime) } : null;
      }),
    );
    return checked.filter((route) => route !== null);
  }

  /**
   * Everything the package builder needs for a route at once: its hotels (one per custom package), and the days that have an
   * outbound or a return with seats for the whole group. The app offers only these days, so the customer never picks an empty one.
   */
  async getCustomJourney(query: CustomJourneyQuery) {
    const persons = query.persons ?? 1;
    const [found, hotels] = await Promise.all([this.getCustomPackages({ origin: query.origin, destination: query.destination }), this.hotelsForPackages()]);
    // The search matches loosely; the trips must run exactly on the route, as the booking checks. An office package names
    // it; without one the app asks with the route it was given.
    const origin = found[0]?.origin ?? query.origin?.trim();
    const destination = found[0]?.destination ?? query.destination?.trim();
    const empty = { origin: origin ?? null, destination: destination ?? null, maxNights: CUSTOM_PACKAGE_MAX_NIGHTS, packages: [], outbound: [], inbound: [] };
    if (!origin || !destination) return empty;
    const published = found.filter((pkg) => pkg.origin === origin && pkg.destination === destination);
    // Every other priced hotel in the destination city, as a package the customer builds on its own prices.
    const taken = new Set(published.map((pkg) => pkg.hotel?.id));
    const fromHotels = hotels
      .filter((hotel) => sameCity(hotel.city, destination) && !taken.has(hotel.id))
      .map((hotel) => ({ ...toPublicCustomPackage(hotelCustomPackage(hotel)), origin, destination }));
    const packages = [...published, ...fromHotels];
    if (packages.length === 0) return empty;
    const now = new Date();
    const until = new Date(now.getTime() + JOURNEY_DAYS_AHEAD * DAY_MS);
    const legWhere = (from: string, to: string): Prisma.TripWhereInput => {
      const base = appTripWhere({});
      return {
        ...base,
        origin: { equals: from, mode: 'insensitive' },
        destination: { equals: to, mode: 'insensitive' },
        // A package's own trips are sold with it; the builder runs on transport trips only.
        packageId: null,
        availableSeats: { gte: persons },
        maxSeatsPerBooking: { gte: persons },
        departureTime: { gt: now, lt: until },
        AND: [...(base.AND as Prisma.TripWhereInput[]), bookingTypeWhere('TRANSPORT_ONLY')],
      };
    };
    const [outbound, inbound] = await Promise.all([
      this.prisma.trip.findMany({ where: legWhere(origin, destination), select: JOURNEY_TRIP_SELECT, orderBy: { departureTime: 'asc' }, take: 600 }),
      this.prisma.trip.findMany({ where: legWhere(destination, origin), select: JOURNEY_TRIP_SELECT, orderBy: { departureTime: 'asc' }, take: 600 }),
    ]);
    // Each hotel has its own earliest outbound hour; a day shows when at least one hotel takes one of its trips.
    const earliestHour = Math.min(...packages.map((pkg) => pkg.minDepartureHour));
    return {
      origin,
      destination,
      maxNights: CUSTOM_PACKAGE_MAX_NIGHTS,
      packages,
      outbound: journeyDays(outbound.filter((trip) => riyadhHour(trip.departureTime) >= earliestHour)),
      inbound: journeyDays(inbound),
    };
  }

  /**
   * The price of a package the customer is building, before any seat is picked: both trips for the group and the stay
   * by the night, with the same rules the booking charges. Coupons, points and the wallet come off later, at review.
   */
  async previewCustomPackage(dto: CustomPreviewDto) {
    const pkg = await loadCustomPackage(this.prisma, dto.packageId);
    if (dto.withoutHousing && dto.roomChoice) throw new BadRequestException('اختر نوع الغرفة أو بدون سكن، لا الاثنين');
    const trips = await this.prisma.trip.findMany({
      where: { ...appTripWhere({}), id: { in: [dto.outboundTripId, dto.returnTripId] } },
      select: JOURNEY_TRIP_SELECT,
    });
    const outbound = trips.find((trip) => trip.id === dto.outboundTripId);
    const inbound = trips.find((trip) => trip.id === dto.returnTripId);
    if (!outbound || !inbound) throw new NotFoundException('الرحلة المختارة لم تعد متاحة للحجز');
    for (const trip of [outbound, inbound]) {
      if (trip.availableSeats < dto.persons) throw new BadRequestException(`لا توجد مقاعد كافية في الرحلة ${trip.tripCode}`);
      if (trip.maxSeatsPerBooking < dto.persons) throw new BadRequestException(`الحد الأقصى في الرحلة ${trip.tripCode} هو ${trip.maxSeatsPerBooking} مقاعد للحجز`);
    }
    const stay = customPackageStay(pkg, { trip: outbound, seats: dto.persons }, { trip: inbound, seats: dto.persons }, dto.withoutHousing ? undefined : dto.roomChoice);
    if (!dto.withoutHousing && !stay.details.choice) throw new BadRequestException('اختر نوع الغرفة');
    const leg = (trip: JourneyTrip) => {
      const price = seatPricing(trip).price;
      return { tripId: trip.id, tripCode: trip.tripCode, departureTime: trip.departureTime, pricePerSeat: price / 100, subtotal: (price * dto.persons) / 100 };
    };
    const out = leg(outbound);
    const back = leg(inbound);
    const stayAmount = dto.withoutHousing ? 0 : stay.amount / 100;
    return {
      persons: dto.persons,
      outbound: out,
      inbound: back,
      nights: stay.nights,
      checkIn: stay.details.checkIn,
      checkOut: stay.details.checkOut,
      stay: dto.withoutHousing ? null : { room: stay.details.choice, amount: stayAmount, hotel: stay.details.name },
      optionAmounts: stay.details.optionAmounts,
      // Prices include VAT, as everywhere in the app.
      total: Math.round((out.subtotal + back.subtotal + stayAmount) * 100) / 100,
    };
  }

  /** Active hotels with a customer price for a room type they offer: each can be built into a package to its city. */
  private async hotelsForPackages() {
    const hotels = await this.prisma.hotel.findMany({
      where: {
        isActive: true,
        OR: [
          { offersSharedRoom: true, bedPrice: { not: null } },
          { offersPrivateRoom: true, privateRoomPrice: { not: null } },
        ],
      },
      select: HOTEL_PACKAGE_SELECT,
      orderBy: { name: 'asc' },
    });
    return hotels.filter((hotel) => customRoomOptions(hotelCustomPackage(hotel)).length > 0);
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
        // The package page lists them to edit or unlink: nearest departure first, with their route.
        // Each with the trip its customers come back on and the nights of its stay.
        trips: {
          select: {
            ...ADMIN_DEPARTURE_SELECT,
            availableSeats: true,
            totalSeats: true,
            packageReturn: { select: ADMIN_DEPARTURE_SELECT },
            accommodations: { select: { nights: true } },
          },
          orderBy: { departureTime: 'asc' },
        },
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
    // The company adds its fixed packages only: the customer builds their own in the app from the hotels' prices.
    if (dto.kind === 'CUSTOM') throw new BadRequestException('الباقة التي يصممها العميل تُبنى في التطبيق من أسعار الفنادق، ولا تُضاف من لوحة التحكم');
    const kind = 'FIXED' as const;
    const prices = { price: dto.price, price2: dto.price2 ?? dto.price * 2, price3: dto.price3 ?? dto.price * 3, price4: dto.price4 ?? dto.price * 4 };
    assertGroupPrices(prices);
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

  /**
   * Puts a trip on a fixed package with the trip its customers come back on, or changes them. The package price covers both
   * trips and the stay; the nights set the outbound's stay, as the trip form's nights do (its hotel's dates follow).
   */
  async setDeparture(packageId: string, dto: PackageDepartureDto) {
    return this.prisma.$transaction(async (tx) => {
      const [outbound, inbound] = await Promise.all([
        tx.trip.findUnique({
          where: { id: dto.outboundTripId },
          select: {
            id: true, tripCode: true, origin: true, destination: true, departureTime: true, arrivalTime: true, tripStatus: true, packageId: true, packageReturnTripId: true,
            accommodations: { select: { nights: true } },
          },
        }),
        tx.trip.findUnique({ where: { id: dto.returnTripId }, select: { id: true, tripCode: true, origin: true, destination: true, departureTime: true, tripStatus: true, packageId: true } }),
      ]);
      if (!outbound) throw new NotFoundException('رحلة الذهاب غير موجودة');
      if (!inbound) throw new NotFoundException('رحلة العودة غير موجودة');
      if (outbound.packageId && outbound.packageId !== packageId) throw new ConflictException(`الرحلة ${outbound.tripCode} مرتبطة بباقة أخرى`);
      if (inbound.packageId) throw new BadRequestException(`رحلة العودة ${inbound.tripCode} مرتبطة بباقة كرحلة ذهاب، اختر رحلة عودة عادية`);
      if ([outbound, inbound].some((trip) => trip.tripStatus === 'CANCELLED')) throw new BadRequestException('لا تُسند رحلة ملغاة للباقة');
      if (!sameCity(inbound.origin, outbound.destination) || !sameCity(inbound.destination, outbound.origin)) {
        throw new BadRequestException(`رحلة العودة يجب أن تكون من ${outbound.destination} إلى ${outbound.origin}`);
      }
      if (inbound.departureTime <= outbound.arrivalTime) throw new BadRequestException('رحلة العودة يجب أن تنطلق بعد وصول رحلة الذهاب');
      await assertTripFitsPackage(tx, packageId, outbound.departureTime);
      // Who already bought the package rides back on the return they were sold.
      if (outbound.packageReturnTripId && outbound.packageReturnTripId !== inbound.id) {
        const sold = await tx.booking.count({ where: { tripId: outbound.id, status: { not: 'CANCELLED' } } });
        if (sold > 0) throw new ConflictException('لا يمكن تغيير رحلة العودة بعد بيع مقاعد في هذه الرحلة');
      }

      await tx.trip.update({ where: { id: outbound.id }, data: { packageId, packageReturnTripId: inbound.id } });
      // The stay's length, kept with the hotel's dates as the trip form keeps them. A trip without a stay has no nights.
      const nights = dto.nights;
      if (nights !== undefined && outbound.accommodations.length && nights !== outbound.accommodations[0].nights) {
        await tx.accommodation.update({ where: { tripId: outbound.id }, data: { nights } });
        const stays = await tx.hotelBooking.findMany({ where: { tripId: outbound.id, status: 'CONFIRMED' }, select: { id: true } });
        for (const stay of stays) await tx.hotelBooking.update({ where: { id: stay.id }, data: this.rooms.stayDates(outbound.departureTime, nights) });
      }
      return { success: true };
    });
  }

  /** Takes a trip off the package: it stays as it is and sells at its own price again. */
  async removeDeparture(packageId: string, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { packageId: true } });
    if (!trip || trip.packageId !== packageId) throw new NotFoundException('الرحلة غير مرتبطة بهذه الباقة');
    await this.prisma.trip.update({ where: { id: tripId }, data: { packageId: null, packageReturnTripId: null } });
    return { success: true };
  }
}

const ADMIN_DEPARTURE_SELECT = {
  id: true,
  tripCode: true,
  tripStatus: true,
  departureTime: true,
  arrivalTime: true,
  origin: true,
  destination: true,
} satisfies Prisma.TripSelect;

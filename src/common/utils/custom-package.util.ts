import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, RoomType } from '@prisma/client';
import { riyadhDate } from './time.util';
import { SERVICE_SELECT, withHotelServices } from './services.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
/** A custom package is a round journey with a stay between; a longer stay is booked at a branch. */
export const CUSTOM_PACKAGE_MAX_NIGHTS = 30;

/** Everything a custom package's price and page need, with the hotel as the customer reads it. */
export const CUSTOM_PACKAGE_SELECT = {
  id: true,
  name: true,
  description: true,
  terms: true,
  kind: true,
  status: true,
  origin: true,
  destination: true,
  startDate: true,
  endDate: true,
  nightlyBedPrice: true,
  nightlyRoomPrice: true,
  minDepartureHour: true,
  images: { select: { url: true } },
  services: { select: { service: { select: { id: true, name: true, icon: true } } } },
  hotel: {
    select: {
      id: true,
      name: true,
      city: true,
      address: true,
      description: true,
      isActive: true,
      offersSharedRoom: true,
      offersPrivateRoom: true,
      services: SERVICE_SELECT,
    },
  },
} satisfies Prisma.PackageSelect;

export type CustomPackage = Prisma.PackageGetPayload<{ select: typeof CUSTOM_PACKAGE_SELECT }>;

const halalas = (value: Prisma.Decimal | number | null) => Math.round(Number(value ?? 0) * 100);
const sar = (value: number) => value / 100;

/** The hour of the day in Riyadh a trip leaves at. */
export const riyadhHour = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).getUTCHours();

/** The room types a customer can pick: the hotel must offer it and the package must have a price for it. */
export const customRoomOptions = (pkg: CustomPackage): RoomType[] => [
  ...(pkg.hotel?.offersSharedRoom && pkg.nightlyBedPrice !== null ? (['SHARED'] as const) : []),
  ...(pkg.hotel?.offersPrivateRoom && pkg.nightlyRoomPrice !== null ? (['PRIVATE'] as const) : []),
];

/** Halalas for the stay: a shared room charges each person's bed, a private room is one price a night for the group. */
export const customStayCharge = (pkg: CustomPackage, room: RoomType, persons: number, nights: number) =>
  room === 'SHARED' ? halalas(pkg.nightlyBedPrice) * persons * nights : halalas(pkg.nightlyRoomPrice) * nights;

/** What the app shows for a custom package: its route, hotel and nightly prices. */
export function toPublicCustomPackage(pkg: CustomPackage) {
  const { hotel, nightlyBedPrice, nightlyRoomPrice, ...rest } = pkg;
  return {
    ...rest,
    nightlyBedPrice: nightlyBedPrice === null ? null : Number(nightlyBedPrice),
    nightlyRoomPrice: nightlyRoomPrice === null ? null : Number(nightlyRoomPrice),
    roomOptions: customRoomOptions(pkg),
    services: pkg.services.map((row) => row.service),
    hotel: hotel && (({ isActive, offersSharedRoom, offersPrivateRoom, ...place }) => place)(withHotelServices(hotel)),
  };
}

export async function loadCustomPackage(db: Prisma.TransactionClient, id: string) {
  const pkg = await db.package.findUnique({ where: { id }, select: CUSTOM_PACKAGE_SELECT });
  if (!pkg || pkg.kind !== 'CUSTOM' || pkg.status !== 'PUBLISHED') throw new NotFoundException('الباقة غير متاحة');
  if (!pkg.hotel?.isActive) throw new BadRequestException('فندق الباقة غير متاح حاليًا');
  return pkg;
}

type JourneyTrip = { origin: string; destination: string; departureTime: Date; package: unknown; tripCode: string };

/**
 * Checks the customer's own journey against the package: an outbound on its route leaving at its hour or later, a return
 * the other way after it, the same group on both, and dates inside the package's window. Returns the stay it makes.
 */
export function customPackageStay(
  pkg: CustomPackage,
  outbound: { trip: JourneyTrip; seats: number },
  inbound: { trip: JourneyTrip; seats: number },
  roomChoice: RoomType | undefined,
) {
  const same = (a: string, b: string | null) => a.trim() === (b ?? '').trim();
  if (outbound.trip.package || inbound.trip.package) throw new BadRequestException('رحلات الباقة المصممة تكون من رحلات النقل، لا من باقة أخرى');
  if (!same(outbound.trip.origin, pkg.origin) || !same(outbound.trip.destination, pkg.destination)) {
    throw new BadRequestException(`رحلة الذهاب يجب أن تكون من ${pkg.origin} إلى ${pkg.destination}`);
  }
  if (!same(inbound.trip.origin, pkg.destination) || !same(inbound.trip.destination, pkg.origin)) {
    throw new BadRequestException(`رحلة العودة يجب أن تكون من ${pkg.destination} إلى ${pkg.origin}`);
  }
  if (riyadhHour(outbound.trip.departureTime) < pkg.minDepartureHour) {
    throw new BadRequestException(`رحلة الذهاب في هذه الباقة تبدأ من الساعة ${pkg.minDepartureHour}:00`);
  }
  if (outbound.seats !== inbound.seats) throw new BadRequestException('عدد المقاعد يجب أن يتساوى في الذهاب والعودة');

  const checkIn = riyadhDate(outbound.trip.departureTime);
  const checkOut = riyadhDate(inbound.trip.departureTime);
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS);
  if (nights < 1) throw new BadRequestException('اختر رحلة عودة في يوم بعد يوم الذهاب، فالباقة تشمل ليلة سكن على الأقل');
  if (nights > CUSTOM_PACKAGE_MAX_NIGHTS) throw new BadRequestException(`الحد الأقصى للسكن في الباقة ${CUSTOM_PACKAGE_MAX_NIGHTS} ليلة`);
  const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
  if (pkg.startDate && checkIn < day(pkg.startDate)!) throw new BadRequestException(`الباقة متاحة من ${day(pkg.startDate)}`);
  if (pkg.endDate && checkOut > day(pkg.endDate)!) throw new BadRequestException(`الباقة متاحة حتى ${day(pkg.endDate)}`);

  const options = customRoomOptions(pkg);
  if (options.length === 0) throw new BadRequestException('لا يوجد سعر سكن لهذه الباقة بعد');
  if (roomChoice && !options.includes(roomChoice)) throw new BadRequestException('نوع الغرفة المختار غير متاح في هذه الباقة');
  const choice = roomChoice ?? (options.length === 1 ? options[0] : null);
  const persons = outbound.seats;
  const place = toPublicCustomPackage(pkg).hotel!;
  return {
    hotelId: pkg.hotel!.id,
    checkIn: new Date(`${checkIn}T00:00:00Z`),
    checkOut: new Date(`${checkOut}T00:00:00Z`),
    nights,
    amount: choice ? customStayCharge(pkg, choice, persons, nights) : 0,
    details: {
      ...place,
      customPackageId: pkg.id,
      packageName: pkg.name,
      nights,
      checkIn,
      checkOut,
      options,
      choice,
      optionAmounts: Object.fromEntries(options.map((room) => [room, sar(customStayCharge(pkg, room, persons, nights))])),
    },
  };
}

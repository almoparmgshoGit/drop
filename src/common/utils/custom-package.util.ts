import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, RoomType } from '@prisma/client';
import { riyadhDate } from './time.util';
import { SERVICE_SELECT, withHotelServices } from './services.util';
import { GALLERY_SELECT } from './gallery.util';
import { HousingTerms, hotelHousingTerms, housingCharge, privateRoomsNeeded } from './housing-price.util';
import { familyRooms } from './family-room.util';

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
      privateRoomCapacity: true,
      services: SERVICE_SELECT,
      images: GALLERY_SELECT,
    },
  },
} satisfies Prisma.PackageSelect;

/**
 * A package the customer builds. Either one the office published (its route, hotel and nightly prices), or one made on the
 * spot from any active hotel at the destination, with no record of its own: then `hotelTerms` holds the hotel's own customer
 * prices, charged the way the counter charges them, and the route is whatever the customer's two trips run on.
 */
export type CustomPackage = Prisma.PackageGetPayload<{ select: typeof CUSTOM_PACKAGE_SELECT }> & { hotelTerms?: HousingTerms | null };

/** The id of a package made from a hotel: no package row, so nothing points to one. */
export const HOTEL_PACKAGE_PREFIX = 'hotel.';
export const isHotelPackageId = (id: string | null | undefined) => !!id && id.startsWith(HOTEL_PACKAGE_PREFIX);

/** What a hotel needs to be built into a package: the package's hotel fields and the hotel's customer prices. */
export const HOTEL_PACKAGE_SELECT = {
  ...CUSTOM_PACKAGE_SELECT.hotel.select,
  bedPrice: true,
  privateRoomPrice: true,
  privateRoomPriceBasis: true,
  housingPricePeriod: true,
} satisfies Prisma.HotelSelect;

type HotelForPackage = Prisma.HotelGetPayload<{ select: typeof HOTEL_PACKAGE_SELECT }>;

/** A hotel as a package the customer builds on any route to its city. Its prices are the hotel's own, as at the counter. */
export function hotelCustomPackage(hotel: HotelForPackage): CustomPackage {
  const { bedPrice, privateRoomPrice, privateRoomPriceBasis, housingPricePeriod, ...place } = hotel;
  const terms = hotelHousingTerms({ bedPrice, privateRoomPrice, privateRoomCapacity: hotel.privateRoomCapacity, privateRoomPriceBasis, housingPricePeriod });
  return {
    id: `${HOTEL_PACKAGE_PREFIX}${hotel.id}`,
    name: hotel.name,
    description: hotel.description,
    terms: null,
    kind: 'CUSTOM',
    status: 'PUBLISHED',
    origin: null,
    destination: hotel.city,
    startDate: null,
    endDate: null,
    nightlyBedPrice: bedPrice,
    nightlyRoomPrice: privateRoomPrice,
    // Any outbound the customer likes: no office set an hour for it.
    minDepartureHour: 0,
    images: [],
    services: [],
    hotel: place,
    hotelTerms: terms,
  };
}

const halalas = (value: Prisma.Decimal | number | null) => Math.round(Number(value ?? 0) * 100);
const sar = (value: number) => value / 100;

/** The hour of the day in Riyadh a trip leaves at. */
export const riyadhHour = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).getUTCHours();

/** The room types a customer can pick: the hotel must offer it and the package must have a price for it. */
export const customRoomOptions = (pkg: CustomPackage): RoomType[] => [
  // A hotel's own prices: a room type is sold where the hotel offers it and has a price for it.
  ...(pkg.hotelTerms
    ? [
        ...(pkg.hotel?.offersSharedRoom && pkg.hotelTerms.housingPrice !== null ? (['SHARED'] as const) : []),
        ...(pkg.hotel?.offersPrivateRoom && pkg.hotelTerms.privateRoomPrice !== null ? (['PRIVATE'] as const) : []),
      ]
    : []),
  ...(pkg.hotelTerms ? [] : customPackageRooms(pkg)),
];

const customPackageRooms = (pkg: CustomPackage): RoomType[] => [
  ...(pkg.hotel?.offersSharedRoom && pkg.nightlyBedPrice !== null ? (['SHARED'] as const) : []),
  ...(pkg.hotel?.offersPrivateRoom && pkg.nightlyRoomPrice !== null ? (['PRIVATE'] as const) : []),
];

/** Halalas for the stay: a shared room charges each person's bed, a private room is one price a night for the group. */
export const customStayCharge = (pkg: CustomPackage, room: RoomType, persons: number, nights: number, privateRooms = 1) =>
  pkg.hotelTerms
    ? housingCharge(pkg.hotelTerms, room, persons, nights, privateRooms)
    : room === 'SHARED' ? halalas(pkg.nightlyBedPrice) * persons * nights : halalas(pkg.nightlyRoomPrice) * nights * Math.max(1, privateRooms);

/** What the app shows for a custom package: its route, hotel and nightly prices. */
export function toPublicCustomPackage(pkg: CustomPackage) {
  const { hotel, nightlyBedPrice, nightlyRoomPrice, hotelTerms, ...rest } = pkg;
  return {
    ...rest,
    // A hotel priced for the whole stay charges its bed once, not each night; the app says so beside the price.
    bedPriceForStay: !!hotelTerms && hotelTerms.housingPricePeriod !== 'PER_NIGHT',
    nightlyBedPrice: nightlyBedPrice === null ? null : Number(nightlyBedPrice),
    nightlyRoomPrice: nightlyRoomPrice === null ? null : Number(nightlyRoomPrice),
    roomOptions: customRoomOptions(pkg),
    services: pkg.services.map((row) => row.service),
    hotel: hotel && (({ isActive, offersSharedRoom, offersPrivateRoom, ...place }) => place)(withHotelServices(hotel)),
  };
}

export async function loadCustomPackage(db: Prisma.TransactionClient, id: string) {
  if (isHotelPackageId(id)) {
    const hotel = await db.hotel.findUnique({ where: { id: id.slice(HOTEL_PACKAGE_PREFIX.length) }, select: HOTEL_PACKAGE_SELECT });
    if (!hotel?.isActive) throw new BadRequestException('الفندق غير متاح حاليًا');
    return hotelCustomPackage(hotel);
  }
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
  pickedRoom: RoomType | undefined,
  privateRooms = 1,
  family = false,
) {
  const same = (a: string, b: string | null) => a.trim() === (b ?? '').trim();
  if (outbound.trip.package || inbound.trip.package) throw new BadRequestException('رحلات الباقة المصممة تكون من رحلات النقل، لا من باقة أخرى');
  // A hotel's package runs on whatever route the customer picked: the trip back only has to reverse the trip there.
  const origin = pkg.hotelTerms ? outbound.trip.origin : pkg.origin;
  const destination = pkg.hotelTerms ? outbound.trip.destination : pkg.destination;
  if (!same(outbound.trip.origin, origin) || !same(outbound.trip.destination, destination)) {
    throw new BadRequestException(`رحلة الذهاب يجب أن تكون من ${origin} إلى ${destination}`);
  }
  if (!same(inbound.trip.origin, destination) || !same(inbound.trip.destination, origin)) {
    throw new BadRequestException(`رحلة العودة يجب أن تكون من ${destination} إلى ${origin}`);
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

  const sold = customRoomOptions(pkg);
  if (sold.length === 0) throw new BadRequestException('لا يوجد سعر سكن لهذه الباقة بعد');
  const { options, choice: roomChoice } = familyRooms(sold, pickedRoom, family);
  if (roomChoice && !options.includes(roomChoice)) throw new BadRequestException('نوع الغرفة المختار غير متاح في هذه الباقة');
  const choice = roomChoice ?? (options.length === 1 ? options[0] : null);
  const persons = outbound.seats;
  if (privateRooms > persons) throw new BadRequestException('عدد الغرف أكثر من عدد المسافرين');
  const rooms = choice === 'PRIVATE' ? privateRooms : 1;
  const place = toPublicCustomPackage(pkg).hotel!;
  return {
    hotelId: pkg.hotel!.id,
    checkIn: new Date(`${checkIn}T00:00:00Z`),
    checkOut: new Date(`${checkOut}T00:00:00Z`),
    nights,
    amount: choice ? customStayCharge(pkg, choice, persons, nights, rooms) : 0,
    details: {
      ...place,
      // A hotel's package has no row: the booking keeps its hotel and dates, and no package.
      customPackageId: pkg.hotelTerms ? null : pkg.id,
      packageName: pkg.name,
      nights,
      checkIn,
      checkOut,
      options,
      choice,
      optionAmounts: Object.fromEntries(options.map((room) => [room, sar(customStayCharge(pkg, room, persons, nights, rooms))])),
      // A group larger than a private room is told so, and may take more rooms, each at one room's price.
      privateRoomCapacity: pkg.hotel?.privateRoomCapacity ?? null,
      privateRoomsNeeded: privateRoomsNeeded(pkg.hotel?.privateRoomCapacity, persons),
      privateRoomAmount: sar(customStayCharge(pkg, 'PRIVATE', persons, nights)),
      privateRooms: rooms,
    },
  };
}

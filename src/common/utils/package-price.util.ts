import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** A package is sold to one to four people; a bigger group books it more than once. */
export const PACKAGE_MAX_PERSONS = 4;

type Money = Prisma.Decimal | number;
export type PackagePrices = { price: Money; price2: Money; price3: Money; price4: Money };

/** The Prisma select that carries everything a package's price needs. */
export const PACKAGE_PRICE_SELECT = { price: true, price2: true, price3: true, price4: true } as const;

const halalas = (value: Money) => Math.round(Number(value) * 100);

/** What the whole group pays for the package, in halalas: each group size has its own total, not a price per head. */
export function packageGroupTotal(pkg: PackagePrices, persons: number) {
  if (persons < 1 || persons > PACKAGE_MAX_PERSONS) {
    throw new BadRequestException(`الباقة تُحجز من شخص واحد إلى ${PACKAGE_MAX_PERSONS} أشخاص`);
  }
  return halalas([pkg.price, pkg.price2, pkg.price3, pkg.price4][persons - 1]);
}

/** The totals customers choose from, in riyals, one per group size. */
export const packagePriceTiers = (pkg: PackagePrices) =>
  [pkg.price, pkg.price2, pkg.price3, pkg.price4].map((total, index) => ({ persons: index + 1, total: Number(total) }));

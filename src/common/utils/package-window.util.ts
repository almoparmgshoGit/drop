import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { riyadhDate } from './time.util';

/** A package date is a calendar day, saved at midnight UTC by the panel's date field. */
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Null when the trip departs inside the package's dates, otherwise why it does not. */
export function packageWindowProblem(pkg: { startDate: Date | null; endDate: Date | null }, departure: Date) {
  const day = riyadhDate(departure);
  if (pkg.startDate && day < dayOf(pkg.startDate)) return `الباقة تبدأ في ${dayOf(pkg.startDate)}`;
  if (pkg.endDate && day > dayOf(pkg.endDate)) return `الباقة تنتهي في ${dayOf(pkg.endDate)}`;
  return null;
}

/** A trip sold under a package must depart inside the package's dates. Returns the package, for its other defaults. */
export async function assertTripFitsPackage(db: Prisma.TransactionClient, packageId: string, departure: Date) {
  const pkg = await db.package.findUnique({ where: { id: packageId }, select: { nights: true, startDate: true, endDate: true, kind: true } });
  if (!pkg) throw new NotFoundException('الباقة غير موجودة');
  // A custom package is built by the customer from transport trips; no trip belongs to it.
  if (pkg.kind === 'CUSTOM') throw new BadRequestException('لا تُربط الرحلات بباقة يصممها العميل، بل يختار العميل رحلاته بنفسه');
  const problem = packageWindowProblem(pkg, departure);
  if (problem) throw new BadRequestException(`موعد الرحلة خارج فترة الباقة: ${problem}`);
  return pkg;
}

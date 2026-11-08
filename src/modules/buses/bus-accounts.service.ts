import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { riyadhMonth, riyadhMonthRange } from '../../common/utils/time.util';
import { toHalalas, toSar } from '../bookings/bookings.service';
import { CreateBusOfficeDto, CreateOfficePaymentDto, UpdateBusOfficeDto, UpdateTripCostDto } from './buses.dto';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const routeKey = (origin: string, destination: string) => `${origin.trim()}→${destination.trim()}`;

const assertDistinctRoutes = (rates: { origin: string; destination: string }[] = []) => {
  const routes = rates.map((rate) => routeKey(rate.origin, rate.destination));
  if (new Set(routes).size !== routes.length) throw new BadRequestException('يوجد مسار مكرر في جدول الأسعار');
};

/** Everything an office is owed for a month, in halalas so the totals add up exactly. */
const fetchMonthTrips = (db: Prisma.TransactionClient, officeId: string, month: string) =>
  db.trip.findMany({
    where: { bus: { officeId }, departureTime: riyadhMonthRange(month), tripStatus: { in: ['PUBLISHED', 'COMPLETED'] } },
    orderBy: { departureTime: 'asc' },
    select: {
      id: true,
      tripCode: true,
      origin: true,
      destination: true,
      departureTime: true,
      tripStatus: true,
      busRentalPrice: true,
      busCost: true,
      bus: { select: { id: true, plateNumber: true } },
      drivers: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true, phone: true } } } },
    },
  });

const dueOf = (trip: { busRentalPrice: Prisma.Decimal | null; busCost: { driverExpense: Prisma.Decimal; delegationExpense: Prisma.Decimal } | null }) => {
  const rental = toHalalas(trip.busRentalPrice ?? 0);
  const driverExpense = toHalalas(trip.busCost?.driverExpense ?? 0);
  const delegationExpense = toHalalas(trip.busCost?.delegationExpense ?? 0);
  return { rental, driverExpense, delegationExpense, expenses: driverExpense + delegationExpense, due: rental - driverExpense - delegationExpense };
};

@Injectable()
export class BusAccountsService {
  constructor(private prisma: PrismaService) {}

  async listOffices(actor: { permissions: string[] }) {
    if (!actor.permissions.includes('buses.rates')) {
      // The bus form only needs names; contracts and prices are purchase terms.
      return this.prisma.busOffice.findMany({ select: { id: true, name: true, isActive: true }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    }
    const offices = await this.prisma.busOffice.findMany({
      include: { rates: { orderBy: { origin: 'asc' } }, _count: { select: { buses: true } } },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return offices.map(({ _count, ...office }) => ({ ...office, busCount: _count.buses }));
  }

  createOffice({ rates, ...dto }: CreateBusOfficeDto) {
    assertDistinctRoutes(rates);
    return this.prisma.busOffice.create({ data: { ...dto, rates: rates?.length ? { create: rates } : undefined } });
  }

  async updateOffice(id: string, { rates, ...dto }: UpdateBusOfficeDto) {
    assertDistinctRoutes(rates);
    const office = await this.prisma.busOffice.findUnique({ where: { id } });
    if (!office) throw new NotFoundException('مكتب الباصات غير موجود');
    return this.prisma.$transaction(async (tx) => {
      if (rates) {
        await tx.busOfficeRate.deleteMany({ where: { officeId: id } });
        await tx.busOfficeRate.createMany({ data: rates.map((rate) => ({ ...rate, officeId: id })) });
      }
      // Buses show their owner through this text, including to customers in the app.
      if (dto.name && dto.name !== office.name) await tx.bus.updateMany({ where: { officeId: id }, data: { company: dto.name } });
      return tx.busOffice.update({ where: { id }, data: dto });
    }, TX_OPTIONS);
  }

  async statement(id: string, month = riyadhMonth(new Date())) {
    const office = await this.prisma.busOffice.findUnique({ where: { id }, include: { rates: { orderBy: { origin: 'asc' } } } });
    if (!office) throw new NotFoundException('مكتب الباصات غير موجود');
    const [trips, payments, buses] = await Promise.all([
      fetchMonthTrips(this.prisma, id, month),
      this.prisma.busOfficePayment.findMany({ where: { officeId: id, month }, orderBy: { paidAt: 'asc' } }),
      this.prisma.bus.findMany({ where: { officeId: id }, select: { id: true, plateNumber: true }, orderBy: { plateNumber: 'asc' } }),
    ]);

    const rateOf = new Map(office.rates.map((rate) => [routeKey(rate.origin, rate.destination), Number(rate.price)]));
    const totals = { rental: 0, driverExpense: 0, delegationExpense: 0, expenses: 0, due: 0 };
    const rows = trips.map((trip) => {
      const amounts = dueOf(trip);
      (Object.keys(totals) as (keyof typeof totals)[]).forEach((key) => { totals[key] += amounts[key]; });
      return {
        tripId: trip.id,
        tripCode: trip.tripCode,
        departureTime: trip.departureTime,
        tripStatus: trip.tripStatus,
        origin: trip.origin,
        destination: trip.destination,
        busPlate: trip.bus?.plateNumber ?? null,
        rentalMissing: trip.busRentalPrice === null,
        suggestedRental: rateOf.get(routeKey(trip.origin, trip.destination)) ?? null,
        rental: toSar(amounts.rental),
        driverExpense: toSar(amounts.driverExpense),
        delegationExpense: toSar(amounts.delegationExpense),
        expenses: toSar(amounts.expenses),
        due: toSar(amounts.due),
        notes: trip.busCost?.notes ?? null,
      };
    });

    const paid = payments.filter((p) => !p.voidedAt).reduce((sum, p) => sum + toHalalas(p.amount), 0);
    // The driver who actually drove each bus this month, latest trip winning.
    const driverOfBus = new Map(trips.filter((t) => t.bus && t.drivers[0]).map((t) => [t.bus!.id, t.drivers[0].user]));

    return {
      month,
      office,
      buses: buses.map((bus) => ({ ...bus, driver: driverOfBus.get(bus.id) ?? null })),
      rows,
      payments,
      summary: {
        trips: rows.length,
        rental: toSar(totals.rental),
        expenses: toSar(totals.expenses),
        due: toSar(totals.due),
        paid: toSar(paid),
        remaining: toSar(totals.due - paid),
        missingRental: rows.filter((r) => r.rentalMissing).map((r) => r.tripCode),
      },
    };
  }

  async updateTripCost(tripId: string, { busRentalPrice, ...cost }: UpdateTripCostDto) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { tripStatus: true, bus: { select: { officeId: true } } } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (!trip.bus?.officeId) throw new ConflictException('باص هذه الرحلة لا يتبع مكتب باصات');
    if (trip.tripStatus === 'CANCELLED') throw new ConflictException('هذه الرحلة ملغاة');

    await this.prisma.$transaction(async (tx) => {
      if (busRentalPrice !== undefined) await tx.trip.update({ where: { id: tripId }, data: { busRentalPrice } });
      await tx.tripBusCost.upsert({ where: { tripId }, create: { tripId, ...cost }, update: cost });
    }, TX_OPTIONS);
    return { success: true };
  }

  async addPayment(actorId: string, officeId: string, dto: CreateOfficePaymentDto) {
    const paidAt = new Date(`${dto.paidAt}T00:00:00.000Z`);
    if (paidAt.toISOString().slice(0, 10) !== dto.paidAt) throw new BadRequestException('تاريخ السداد غير صحيح');

    return this.prisma.$transaction(async (tx) => {
      // One payment per office at a time, so two employees cannot both settle the same balance.
      const [office] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BusOffice" WHERE "id" = ${officeId} FOR UPDATE`;
      if (!office) throw new NotFoundException('مكتب الباصات غير موجود');

      const [trips, active] = await Promise.all([
        fetchMonthTrips(tx, officeId, dto.month),
        tx.busOfficePayment.findMany({ where: { officeId, month: dto.month, voidedAt: null }, select: { amount: true } }),
      ]);
      const due = trips.reduce((sum, trip) => sum + dueOf(trip).due, 0);
      const paid = active.reduce((sum, p) => sum + toHalalas(p.amount), 0);
      if (toHalalas(dto.amount) > due - paid) {
        throw new ConflictException(`المبلغ يتجاوز المتبقي لهذا الشهر (${toSar(Math.max(0, due - paid))} ر.س)`);
      }
      return tx.busOfficePayment.create({
        data: {
          officeId,
          month: dto.month,
          amount: dto.amount,
          method: dto.method,
          paidAt,
          reference: dto.reference || null,
          notes: dto.notes || null,
          createdById: actorId,
        },
      });
    }, TX_OPTIONS);
  }

  async voidPayment(id: string, reason: string) {
    const payment = await this.prisma.busOfficePayment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException('السداد غير موجود');
    if (payment.voidedAt) throw new ConflictException('هذا السداد ملغى مسبقًا');
    await this.prisma.busOfficePayment.update({ where: { id }, data: { voidedAt: new Date(), voidReason: reason } });
    return { success: true };
  }
}

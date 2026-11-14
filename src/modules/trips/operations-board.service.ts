import { BadRequestException, Injectable } from '@nestjs/common';
import { TripStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { servedCity, tripInCity } from '../../common/utils/branch-city.util';
import { riyadhDate, riyadhDayRange } from '../../common/utils/time.util';
import {
  SCHEDULED_TRIP_STATUSES,
  approvedLeaveWhere,
  leaveCoversTrip,
  scheduleOverlapWhere,
  tripsOverlap,
} from '../../common/utils/schedule-conflict.util';

/** The longest window the availability check or the board looks at in one request. */
const MAX_AVAILABILITY_DAYS = 62;
const MAX_BOARD_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

type Actor = { userId?: string; permissions: string[] };

const PERSON_SELECT = { userId: true, isPrimary: true, user: { select: { name: true, phone: true } } } as const;

const BOARD_TRIP_SELECT = {
  id: true,
  tripCode: true,
  title: true,
  origin: true,
  destination: true,
  departureTime: true,
  arrivalTime: true,
  tripStatus: true,
  executionStatus: true,
  reverseOfTripId: true,
  reverseTrip: { select: { id: true } },
  busId: true,
  bus: { select: { id: true, plateNumber: true, model: true } },
  drivers: { select: PERSON_SELECT },
  supervisors: { select: PERSON_SELECT },
} as const;

type TripRef = { id: string; tripCode: string; origin: string; destination: string; departureTime: Date; arrivalTime: Date; tripStatus: TripStatus };
type BoardTripRow = TripRef & {
  reverseOfTripId: string | null;
  reverseTrip: { id: string } | null;
  busId: string | null;
  bus: { id: string; plateNumber: string; model: string } | null;
  drivers: { userId: string; isPrimary: boolean; user: { name: string | null; phone: string } }[];
  supervisors: { userId: string; isPrimary: boolean; user: { name: string | null; phone: string } }[];
};

export type BoardConflictKind = 'BUS' | 'DRIVER' | 'DRIVER_SUPERVISING' | 'LEAVE';

const refOf = (trip: TripRef): TripRef => ({
  id: trip.id,
  tripCode: trip.tripCode,
  origin: trip.origin,
  destination: trip.destination,
  departureTime: trip.departureTime,
  arrivalTime: trip.arrivalTime,
  tripStatus: trip.tripStatus,
});

const personName = (person: { user: { name: string | null; phone: string } }) => person.user.name || person.user.phone;

/** A trip and its reverse share the bus and crew by design, so they never clash with each other. */
const pairedReverse = (a: BoardTripRow, b: BoardTripRow) => a.reverseOfTripId === b.id || b.reverseOfTripId === a.id;

const parseInstant = (value: string | undefined, label: string) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new BadRequestException(`${label} غير صحيح`);
  return date;
};

/**
 * Who and what is free for a trip's time, and the day-to-day operations board. Both read the same rules as the save-time
 * check in TripsService.assertNoScheduleConflict (schedule-conflict.util), which stays the final guard.
 */
@Injectable()
export class OperationsBoardService {
  constructor(private prisma: PrismaService) {}

  /**
   * The buses and people already taken between start and end, with the trip that takes them, and who is on approved
   * leave on those days. A bus on another trip cannot be chosen; someone driving another trip can neither drive nor
   * supervise this one; someone supervising another trip may supervise this one too, but not drive it.
   */
  async availability(query: { start?: string; end?: string; excludeTripId?: string }) {
    const start = parseInstant(query.start, 'وقت البداية');
    const end = parseInstant(query.end, 'وقت النهاية');
    if (end <= start) throw new BadRequestException('وقت النهاية يجب أن يكون بعد وقت البداية');
    if (end.getTime() - start.getTime() > MAX_AVAILABILITY_DAYS * DAY_MS) throw new BadRequestException(`الفترة لا تتجاوز ${MAX_AVAILABILITY_DAYS} يومًا`);

    // A trip being edited never clashes with itself or with its reverse, as on saving.
    let excludeTripIds: string[] | undefined;
    if (query.excludeTripId) {
      const own = await this.prisma.trip.findUnique({ where: { id: query.excludeTripId }, select: { id: true, reverseOfTripId: true, reverseTrip: { select: { id: true } } } });
      excludeTripIds = [query.excludeTripId, own?.reverseOfTripId, own?.reverseTrip?.id].filter((id): id is string => !!id);
    }

    const [trips, leaves] = await Promise.all([
      this.prisma.trip.findMany({
        where: scheduleOverlapWhere(start, end, excludeTripIds),
        orderBy: { departureTime: 'asc' },
        select: BOARD_TRIP_SELECT,
      }),
      this.prisma.leaveRequest.findMany({
        where: approvedLeaveWhere(start, end),
        orderBy: { startDate: 'asc' },
        select: { userId: true, startDate: true, endDate: true, user: { select: { name: true, phone: true } }, type: { select: { name: true } } },
      }),
    ]);

    const buses = trips.filter((trip) => trip.bus).map((trip) => ({ busId: trip.bus!.id, plateNumber: trip.bus!.plateNumber, trip: refOf(trip) }));
    const drivers = trips.flatMap((trip) => trip.drivers.map((person) => ({ userId: person.userId, name: personName(person), trip: refOf(trip) })));
    const supervisors = trips.flatMap((trip) => trip.supervisors.map((person) => ({ userId: person.userId, name: personName(person), trip: refOf(trip) })));
    return {
      start,
      end,
      buses,
      drivers,
      supervisors,
      leaves: leaves.map((leave) => ({
        userId: leave.userId,
        name: leave.user.name || leave.user.phone,
        type: leave.type?.name ?? null,
        startDate: leave.startDate.toISOString().slice(0, 10),
        endDate: leave.endDate.toISOString().slice(0, 10),
      })),
    };
  }

  /**
   * The trips of the Riyadh days from..to on a timeline: rows per bus, per driver and per supervisor, the trips still
   * without a bus or a driver, and every pair of trips that holds the same bus or driver at once. A branch employee sees
   * their city's trips, but a clash with another city's trip is still reported, by its code.
   */
  async board(actor: Actor, query: { from?: string; to?: string }) {
    const today = riyadhDate(new Date());
    const from = query.from || today;
    const to = query.to || from;
    const first = riyadhDayRange(from);
    const last = riyadhDayRange(to);
    if (!first || !last) throw new BadRequestException('التاريخ غير صحيح');
    if (last.start < first.start) throw new BadRequestException('تاريخ البداية بعد تاريخ النهاية');
    if (last.end.getTime() - first.start.getTime() > MAX_BOARD_DAYS * DAY_MS) throw new BadRequestException(`الفترة لا تتجاوز ${MAX_BOARD_DAYS} يومًا`);
    const start = first.start;
    const end = last.end;

    const city = actor.userId ? await servedCity(this.prisma, { userId: actor.userId, permissions: actor.permissions }) : null;

    const [all, buses] = await Promise.all([
      this.prisma.trip.findMany({
        where: { tripStatus: { not: 'CANCELLED' }, departureTime: { lt: end }, arrivalTime: { gt: start } },
        orderBy: { departureTime: 'asc' },
        select: BOARD_TRIP_SELECT,
      }),
      this.prisma.bus.findMany({ where: { status: 'ACTIVE' }, orderBy: { plateNumber: 'asc' }, select: { id: true, plateNumber: true, model: true } }),
    ]);

    const crewIds = [...new Set(all.flatMap((trip) => [...trip.drivers, ...trip.supervisors].map((person) => person.userId)))];
    const leaves = crewIds.length
      ? await this.prisma.leaveRequest.findMany({
          where: { userId: { in: crewIds }, ...approvedLeaveWhere(start, end) },
          select: { userId: true, startDate: true, endDate: true, user: { select: { name: true, phone: true } } },
        })
      : [];

    const conflicts = this.conflictsAmong(all, leaves);
    const shown = city ? all.filter((trip) => tripInCity(trip, city)) : all;
    const shownIds = new Set(shown.map((trip) => trip.id));
    const visibleConflicts = conflicts.filter((conflict) => conflict.trips.some((trip) => shownIds.has(trip.id)));

    const conflictsOf = new Map<string, number[]>();
    visibleConflicts.forEach((conflict, index) => conflict.trips.forEach((trip) => conflictsOf.set(trip.id, [...(conflictsOf.get(trip.id) ?? []), index])));

    const rows = <K extends 'drivers' | 'supervisors'>(key: K) => {
      const byPerson = new Map<string, { id: string; name: string; tripIds: string[] }>();
      for (const trip of shown) {
        for (const person of trip[key]) {
          const row = byPerson.get(person.userId) ?? { id: person.userId, name: personName(person), tripIds: [] };
          row.tripIds.push(trip.id);
          byPerson.set(person.userId, row);
        }
      }
      return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    };

    // Every active bus gets a row, so an idle bus shows as free; a bus taken off service still shows while it has trips.
    const busRows = new Map(buses.map((bus) => [bus.id, { ...bus, tripIds: [] as string[] }]));
    for (const trip of shown) {
      if (!trip.bus) continue;
      const row = busRows.get(trip.bus.id) ?? { ...trip.bus, tripIds: [] as string[] };
      row.tripIds.push(trip.id);
      busRows.set(trip.bus.id, row);
    }

    const scheduled = shown.filter((trip) => SCHEDULED_TRIP_STATUSES.includes(trip.tripStatus));
    return {
      from: riyadhDate(start),
      to: riyadhDate(new Date(end.getTime() - 1)),
      start,
      end,
      trips: shown.map(({ reverseTrip, drivers, supervisors, ...trip }) => ({
        ...trip,
        reverseTripId: reverseTrip?.id ?? null,
        drivers: drivers.map((person) => ({ id: person.userId, name: personName(person), isPrimary: person.isPrimary })),
        supervisors: supervisors.map((person) => ({ id: person.userId, name: personName(person), isPrimary: person.isPrimary })),
        conflictIndexes: conflictsOf.get(trip.id) ?? [],
      })),
      buses: [...busRows.values()],
      drivers: rows('drivers'),
      supervisors: rows('supervisors'),
      unassigned: {
        noBus: scheduled.filter((trip) => !trip.busId).map((trip) => trip.id),
        noDriver: scheduled.filter((trip) => trip.drivers.length === 0).map((trip) => trip.id),
      },
      conflicts: visibleConflicts,
    };
  }

  /** Every clash among the scheduled trips, by the rules of the save-time check, and crew on approved leave. */
  private conflictsAmong(
    trips: BoardTripRow[],
    leaves: { userId: string; startDate: Date; endDate: Date; user: { name: string | null; phone: string } }[],
  ) {
    const conflicts: { kind: BoardConflictKind; resourceId: string; resourceName: string; trips: TripRef[]; message: string }[] = [];
    const scheduled = trips.filter((trip) => SCHEDULED_TRIP_STATUSES.includes(trip.tripStatus));

    for (let i = 0; i < scheduled.length; i++) {
      for (let j = i + 1; j < scheduled.length; j++) {
        const a = scheduled[i];
        const b = scheduled[j];
        if (!tripsOverlap(a, b) || pairedReverse(a, b)) continue;
        const pair = [refOf(a), refOf(b)];
        if (a.bus && a.busId === b.busId) {
          conflicts.push({ kind: 'BUS', resourceId: a.bus.id, resourceName: a.bus.plateNumber, trips: pair, message: `الباص ${a.bus.plateNumber} مسند للرحلتين ${a.tripCode} و${b.tripCode} في وقت متداخل` });
        }
        for (const driver of a.drivers) {
          if (b.drivers.some((other) => other.userId === driver.userId)) {
            conflicts.push({ kind: 'DRIVER', resourceId: driver.userId, resourceName: personName(driver), trips: pair, message: `السائق ${personName(driver)} يقود الرحلتين ${a.tripCode} و${b.tripCode} في وقت متداخل` });
          }
        }
        // A driver cannot supervise another trip at the same time; two trips may share a supervisor.
        for (const [driving, supervising] of [[a, b], [b, a]] as const) {
          for (const driver of driving.drivers) {
            if (supervising.supervisors.some((other) => other.userId === driver.userId)) {
              conflicts.push({
                kind: 'DRIVER_SUPERVISING',
                resourceId: driver.userId,
                resourceName: personName(driver),
                trips: [refOf(driving), refOf(supervising)],
                message: `${personName(driver)} يقود الرحلة ${driving.tripCode} ومشرف على الرحلة ${supervising.tripCode} في وقت متداخل`,
              });
            }
          }
        }
      }
    }

    for (const trip of scheduled) {
      // Someone on the crew twice is still one person away.
      const crew = [...trip.drivers, ...trip.supervisors].filter((person, index, list) => list.findIndex((other) => other.userId === person.userId) === index);
      for (const person of crew) {
        const away = leaves.find((leave) => leave.userId === person.userId && leaveCoversTrip(leave, trip));
        if (!away) continue;
        const range = `${away.startDate.toISOString().slice(0, 10)} إلى ${away.endDate.toISOString().slice(0, 10)}`;
        conflicts.push({ kind: 'LEAVE', resourceId: person.userId, resourceName: personName(person), trips: [refOf(trip)], message: `${personName(person)} في إجازة معتمدة من ${range} وهو ضمن طاقم الرحلة ${trip.tripCode}` });
      }
    }
    return conflicts;
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { permissionsOf } from '../../common/permissions';
import { PrismaService } from '../../common/services/prisma.service';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { legacyIdentity, staffIdentityData } from '../../common/utils/staff-identity.util';
import { CreateDriverDto, UpdateDriverDto } from './buses.dto';
import { openTripsWhere, splitOpenTrips } from './buses.service';

export interface DriverActor {
  userId: string;
  permissions: string[];
}

const toDate = (value: string, message = 'تاريخ انتهاء الرخصة غير صحيح') => {
  const date = new Date(`${value}T00:00:00.000Z`);
  // Rejects dates like 02-31, which JavaScript would otherwise roll over silently.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(message);
  return date;
};

/** Both the account and the driver registry hold the number uniquely; either clash means the same thing. */
const identityConflict = (err: unknown): never => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
    if (target.includes('phone')) throw new ConflictException('رقم الجوال هذا مسجل في حساب آخر');
    throw new ConflictException('رقم الهوية هذا مسجل في حساب آخر');
  }
  throw err;
};

const DRIVER_WHERE = { rank: { job: { tripRole: 'DRIVER' as const } } };

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

  async list() {
    const drivers = await this.prisma.user.findMany({
      where: DRIVER_WHERE,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        rank: { select: { name: true } },
        driverProfile: true,
        gender: true,
        birthDate: true,
        idType: true,
        idNumber: true,
        idIssueDate: true,
        idExpiryDate: true,
        tripDrivers: { where: { trip: openTripsWhere() }, select: { trip: { select: { tripCode: true, departureTime: true, tripStatus: true } } } },
      },
    });
    return drivers.map(({ driverProfile, tripDrivers, rank, ...driver }) => ({
      ...driver,
      rankName: rank?.name ?? null,
      iqamaNumber: driverProfile?.iqamaNumber ?? null,
      nationality: driverProfile?.nationality ?? null,
      licenseExpiry: driverProfile?.licenseExpiry ?? null,
      isActive: driverProfile?.isActive ?? true,
      ...splitOpenTrips(tripDrivers.map((t) => t.trip)),
    }));
  }

  /** Same rule as the employees screen: nobody hands out, or takes over an account holding, access beyond their own. */
  private assertWithinOwnAccess(actor: DriverActor, permissions: string[]) {
    if (!permissions.every((permission) => actor.permissions.includes(permission))) {
      throw new ForbiddenException('لا يمكنك إدارة حساب يتجاوز صلاحياتك');
    }
  }

  async create(actor: DriverActor, dto: CreateDriverDto) {
    const rank = await this.prisma.rank.findFirst({
      where: { job: { tripRole: 'DRIVER' }, permissions: { has: 'crew.trips' } },
      orderBy: { createdAt: 'asc' },
    });
    if (!rank) throw new ConflictException('أضف رتبة لوظيفة السائق من صفحة الوظائف والرتب أولًا');
    this.assertWithinOwnAccess(actor, permissionsOf({ role: rank.role, rank }));
    // A driver is registered with the same official details as every other employee.
    const identity = staffIdentityData({ ...dto, ...(!dto.idType && legacyIdentity(dto.iqamaNumber)) }, { required: true });
    const hireDate = dto.hireDate ? toDate(dto.hireDate, 'تاريخ التعيين غير صحيح') : null;

    const created = await this.prisma.user.create({
      data: {
        ...identity.user,
        ...(hireDate && { employeeProfile: { create: { hireDate } } }),
        name: dto.name,
        phone: normalizeSaudiPhone(dto.phone),
        role: rank.role,
        rankId: rank.id,
        passwordHash: await argon2.hash(dto.password),
        isVerified: true,
        driverProfile: { create: { iqamaNumber: identity.driverNumber, nationality: identity.nationality ?? dto.nationality, licenseExpiry: toDate(dto.licenseExpiry) } },
      },
      select: { id: true },
    }).catch(identityConflict);
    return created;
  }

  async update(actor: DriverActor, id: string, dto: UpdateDriverDto) {
    const driver = await this.prisma.user.findFirst({ where: { id, ...DRIVER_WHERE }, include: { rank: true, driverProfile: { select: { nationality: true } } } });
    if (!driver) throw new NotFoundException('السائق غير موجود');
    this.assertWithinOwnAccess(actor, permissionsOf(driver));

    if (dto.isActive === false) {
      const open = await this.prisma.tripDriver.findFirst({ where: { userId: id, trip: openTripsWhere() }, select: { trip: { select: { tripCode: true } } } });
      if (open) throw new ConflictException(`السائق مسند للرحلة ${open.trip.tripCode}، غيّر إسنادها قبل إيقافه`);
    }

    const givenId = dto.idType || dto.idNumber || dto.iqamaNumber;
    const identity = staffIdentityData({
      nationality: dto.nationality,
      gender: dto.gender,
      birthDate: dto.birthDate,
      idIssueDate: dto.idIssueDate,
      idExpiryDate: dto.idExpiryDate,
      ...(givenId && (dto.idType ? { idType: dto.idType, idNumber: dto.idNumber } : legacyIdentity(dto.iqamaNumber))),
    }, { existing: { ...driver, nationality: driver.nationality ?? driver.driverProfile?.nationality } });
    const profile = {
      iqamaNumber: identity.driverNumber,
      nationality: identity.nationality ?? undefined,
      licenseExpiry: dto.licenseExpiry ? toDate(dto.licenseExpiry) : undefined,
      isActive: dto.isActive,
    };
    const passwordHash = dto.password ? await argon2.hash(dto.password) : undefined;
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          ...identity.user,
          name: dto.name,
          phone: dto.phone ? normalizeSaudiPhone(dto.phone) : undefined,
          passwordHash,
          driverProfile: { upsert: { create: profile, update: profile } },
        },
      });
      // A changed password or a stopped driver must not leave older sessions usable.
      if (passwordHash || dto.isActive === false) await tx.refreshToken.updateMany({ where: { userId: id }, data: { revoked: true } });
    });
    return { success: true };
  }
}

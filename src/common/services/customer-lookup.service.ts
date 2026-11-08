import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CustomerLookup } from '../utils/identity.util';
import { riyadhDate } from '../utils/time.util';
import { AppSettingsService } from './app-settings.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

/** Most rows a search-only employee gets back for one search; a name that matches more must be typed in full. */
export const LOOKUP_RESULT_LIMIT = 10;

export const LOOKUP_KIND_LABELS: Record<CustomerLookup['kind'], string> = {
  phone: 'رقم الجوال',
  idNumber: 'رقم الهوية',
  name: 'الاسم',
  code: 'رقم الحجز أو التذكرة',
};

export interface LookupActor {
  userId: string;
  permissions: string[];
}

/**
 * Employees who may not browse customers or bookings reach them one search at a time. Each search counts against
 * a daily allowance shared by both pages and is written to the audit log, so pulling data out by searching
 * repeatedly is both slow and visible.
 */
@Injectable()
export class CustomerLookupService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private appSettings: AppSettingsService,
  ) {}

  /** Counted before the search runs, so searches that find nothing still use the allowance. */
  async consume(actor: LookupActor) {
    const limit = await this.appSettings.number('customerLookupDailyLimit');
    const count = await this.redis.incr(`customer_lookups:${actor.userId}:${riyadhDate(new Date())}`, 26 * 60 * 60);
    if (count > limit) {
      throw new HttpException(`وصلت إلى حدك اليومي للبحث عن العملاء والحجوزات (${limit} عملية). راجع مديرك إن احتجت أكثر`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async record(actor: LookupActor, action: string, lookup: CustomerLookup, results: number, ip?: string) {
    await this.prisma.auditLog.create({
      data: {
        userId: actor.userId,
        action,
        entity: 'CustomerLookup',
        ip,
        details: { by: LOOKUP_KIND_LABELS[lookup.kind], rows: results } as Prisma.InputJsonValue,
      },
    });
  }
}

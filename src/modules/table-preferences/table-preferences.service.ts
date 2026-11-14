import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export const TABLE_KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;
/** Settings are a few column names; anything far larger is not a table arrangement. */
const MAX_SETTINGS_BYTES = 8 * 1024;

@Injectable()
export class TablePreferencesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.userTablePreference.findMany({ where: { userId }, select: { tableKey: true, settings: true } });
    return Object.fromEntries(rows.map((row) => [row.tableKey, row.settings]));
  }

  async save(userId: string, tableKey: string, settings: Record<string, unknown>) {
    this.checkKey(tableKey);
    if (JSON.stringify(settings).length > MAX_SETTINGS_BYTES) throw new BadRequestException('إعدادات الجدول أكبر من المسموح');
    const value = settings as Prisma.InputJsonObject;
    const row = await this.prisma.userTablePreference.upsert({
      where: { userId_tableKey: { userId, tableKey } },
      create: { userId, tableKey, settings: value },
      update: { settings: value },
      select: { tableKey: true, settings: true },
    });
    return row;
  }

  async reset(userId: string, tableKey: string) {
    this.checkKey(tableKey);
    await this.prisma.userTablePreference.deleteMany({ where: { userId, tableKey } });
    return { tableKey, settings: null };
  }

  private checkKey(tableKey: string) {
    if (!TABLE_KEY_PATTERN.test(tableKey)) throw new BadRequestException('اسم الجدول غير صالح');
  }
}

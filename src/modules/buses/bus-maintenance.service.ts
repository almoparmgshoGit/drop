import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { CreateMaintenanceDto, UpdateMaintenanceDto } from './bus-maintenance.dto';

const LOG_SELECT = {
  id: true,
  busId: true,
  tripId: true,
  tripCode: true,
  reportId: true,
  report: { select: { id: true, number: true, category: true, status: true } },
  type: true,
  status: true,
  description: true,
  cost: true,
  reportedAt: true,
  resolvedAt: true,
  createdByName: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusMaintenanceLogSelect;

const reportCode = (number: number) => `BL-${String(number).padStart(4, '0')}`;

type LogRow = Prisma.BusMaintenanceLogGetPayload<{ select: typeof LOG_SELECT }>;
const toView = ({ report, cost, ...row }: LogRow) => ({
  ...row,
  cost: cost === null ? null : Number(cost),
  report: report && { ...report, code: reportCode(report.number) },
});

/** A bus's maintenance log: entries opened by crew breakdown reports, and those the office adds by hand. */
@Injectable()
export class BusMaintenanceService {
  constructor(private prisma: PrismaService) {}

  async list(busId: string) {
    const bus = await this.prisma.bus.findUnique({ where: { id: busId }, select: { id: true } });
    if (!bus) throw new NotFoundException('الحافلة غير موجودة');
    const rows = await this.prisma.busMaintenanceLog.findMany({ where: { busId }, orderBy: { reportedAt: 'desc' }, select: LOG_SELECT });
    const items = rows.map(toView);
    return {
      items,
      summary: {
        open: items.filter((row) => row.status === 'OPEN').length,
        inProgress: items.filter((row) => row.status === 'IN_PROGRESS').length,
        done: items.filter((row) => row.status === 'DONE').length,
        totalCost: items.reduce((sum, row) => sum + (row.cost ?? 0), 0),
      },
    };
  }

  async create(busId: string, actorId: string, dto: CreateMaintenanceDto) {
    const bus = await this.prisma.bus.findUnique({ where: { id: busId }, select: { id: true } });
    if (!bus) throw new NotFoundException('الحافلة غير موجودة');
    const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
    const status = dto.status ?? 'OPEN';
    const reportedAt = dto.reportedAt ? new Date(dto.reportedAt) : new Date();
    const resolvedAt = status === 'DONE' ? (dto.resolvedAt ? new Date(dto.resolvedAt) : new Date()) : null;
    if (resolvedAt && resolvedAt < reportedAt) throw new BadRequestException('تاريخ الإنجاز قبل تاريخ البلاغ');
    const row = await this.prisma.busMaintenanceLog.create({
      data: {
        busId,
        type: dto.type ?? 'REPAIR',
        status,
        description: dto.description,
        cost: dto.cost ?? null,
        reportedAt,
        resolvedAt,
        createdById: actorId,
        createdByName: actor?.name ?? null,
      },
      select: LOG_SELECT,
    });
    return toView(row);
  }

  async update(logId: string, dto: UpdateMaintenanceDto) {
    const current = await this.prisma.busMaintenanceLog.findUnique({ where: { id: logId } });
    if (!current) throw new NotFoundException('سجل الصيانة غير موجود');
    const status = dto.status ?? current.status;
    const reportedAt = dto.reportedAt ? new Date(dto.reportedAt) : current.reportedAt;
    // Finishing stamps the time unless one is given; reopening clears it.
    let resolvedAt: Date | null;
    if (status !== 'DONE') resolvedAt = null;
    else if (dto.resolvedAt) resolvedAt = new Date(dto.resolvedAt);
    else resolvedAt = current.resolvedAt ?? new Date();
    if (resolvedAt && resolvedAt < reportedAt) throw new BadRequestException('تاريخ الإنجاز قبل تاريخ البلاغ');
    const row = await this.prisma.busMaintenanceLog.update({
      where: { id: logId },
      data: {
        ...(dto.type && { type: dto.type }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.cost !== undefined && { cost: dto.cost }),
        status,
        reportedAt,
        resolvedAt,
      },
      select: LOG_SELECT,
    });
    return toView(row);
  }

  async remove(logId: string) {
    const current = await this.prisma.busMaintenanceLog.findUnique({ where: { id: logId }, select: { id: true } });
    if (!current) throw new NotFoundException('سجل الصيانة غير موجود');
    await this.prisma.busMaintenanceLog.delete({ where: { id: logId } });
    return { success: true };
  }
}

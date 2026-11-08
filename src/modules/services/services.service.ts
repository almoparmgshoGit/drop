import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { suggestServiceIcon } from '../../common/service-icons';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async getAllServices() {
    return this.prisma.service.findMany({ orderBy: { name: 'asc' } });
  }

  async createService(dto: { name: string; description?: string; icon?: string }) {
    const existing = await this.prisma.service.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('توجد خدمة بهذا الاسم');

    return this.prisma.service.create({ data: { ...dto, icon: dto.icon === undefined ? suggestServiceIcon(dto.name) : dto.icon || null } });
  }

  /** An empty description or icon clears it. */
  async updateService(id: string, dto: { name?: string; description?: string; icon?: string }) {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw new NotFoundException('الخدمة غير موجودة');
    const name = dto.name?.trim();
    if (name && name !== service.name && (await this.prisma.service.findUnique({ where: { name } }))) {
      throw new ConflictException('توجد خدمة بهذا الاسم');
    }
    return this.prisma.service.update({
      where: { id },
      data: {
        name: name || undefined,
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        icon: dto.icon === undefined ? undefined : dto.icon.trim() || null,
      },
    });
  }

  async deleteService(id: string) {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw new NotFoundException('الخدمة غير موجودة');
    return this.prisma.service.delete({ where: { id } });
  }
}

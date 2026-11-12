import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength, ValidateIf } from 'class-validator';
import { SERVICE_ICONS } from '../../common/service-icons';
import { ServicesService } from './services.service';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';

class CreateServiceDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** A name from the icon catalog; empty clears it. Left out on create, one is guessed from the name. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsIn(SERVICE_ICONS, { message: 'أيقونة غير معروفة' })
  icon?: string;
}

class UpdateServiceDto extends PartialType(CreateServiceDto) {}

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private servicesService: ServicesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all services' })
  async getAllServices() {
    return this.servicesService.getAllServices();
  }

  @Post()
  @RequirePermission('packages.manage', 'trips.manage', 'buses.manage', 'hotels.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create new service' })
  async createService(@Body() dto: CreateServiceDto) {
    return this.servicesService.createService(dto);
  }

  /** Renaming changes the service everywhere it appears: trips, packages, buses and hotels, so whoever manages any of them may. */
  @Put(':id')
  @RequirePermission('packages.manage', 'trips.manage', 'buses.manage', 'hotels.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update service' })
  async updateService(@Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.servicesService.updateService(id, dto);
  }

  @Delete(':id')
  @RequirePermission('packages.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete service' })
  async deleteService(@Param('id') id: string) {
    return this.servicesService.deleteService(id);
  }
}

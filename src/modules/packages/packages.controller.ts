import { Controller, Get, Post, Put, Delete, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, PartialType } from '@nestjs/swagger';
import { IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PackageStatus } from '@prisma/client';
import { PackagesService } from './packages.service';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';

export class CreatePackageDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'سعر الباقة يجب أن يكون أكبر من صفر' })
  @Max(1000000)
  price: number;

  /** The total for two people together. Left out, it is the one-person price twice. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'سعر الباقة لشخصين يجب أن يكون أكبر من صفر' })
  @Max(1000000)
  price2?: number;

  /** The total for three people together. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'سعر الباقة لثلاثة أشخاص يجب أن يكون أكبر من صفر' })
  @Max(1000000)
  price3?: number;

  /** The total for four people together. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'سعر الباقة لأربعة أشخاص يجب أن يكون أكبر من صفر' })
  @Max(1000000)
  price4?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  nights?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsEnum(PackageStatus)
  status?: PackageStatus;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  terms?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceIds?: string[];
}

export class UpdatePackageDto extends PartialType(CreatePackageDto) {}

export class PackageSearchQuery {
  @IsOptional() @IsString() @MaxLength(100) origin?: string;
  @IsOptional() @IsString() @MaxLength(100) destination?: string;
  @IsOptional() @IsString() @MaxLength(20) date?: string;
}

class NextPackageQuery {
  @IsOptional() @IsString() @MaxLength(100) origin?: string;
  @IsOptional() @IsString() @MaxLength(100) destination?: string;
  @IsOptional() @IsString() @MaxLength(20) after?: string;
}

@ApiTags('Packages')
@Controller('packages')
export class PackagesController {
  constructor(private packagesService: PackagesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Published packages that have a bookable trip matching the search, with only those trips' })
  async getPublishedPackages(@Query() query: PackageSearchQuery) {
    return this.packagesService.getPublishedPackages(query);
  }

  @Public()
  @Get('next-available')
  @ApiOperation({ summary: 'Next departure on a route that belongs to a published package and still has seats' })
  async getNextAvailable(@Query() query: NextPackageQuery) {
    return this.packagesService.getNextAvailableDate(query);
  }

  @Get('admin/all')
  @RequirePermission('packages.view', 'trips.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get every package for management' })
  async getAllPackagesAdmin() {
    return this.packagesService.getAllPackagesAdmin();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get published package by ID' })
  async getPackageById(@Param('id') id: string) {
    return this.packagesService.getPublishedPackageById(id);
  }

  @Post()
  @RequirePermission('packages.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create new package' })
  async createPackage(@Body() dto: CreatePackageDto) {
    return this.packagesService.createPackage(dto);
  }

  @Put(':id')
  @RequirePermission('packages.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update package' })
  async updatePackage(@Param('id') id: string, @Body() dto: UpdatePackageDto) {
    return this.packagesService.updatePackage(id, dto);
  }

  @Delete(':id')
  @RequirePermission('packages.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete package' })
  async deletePackage(@Param('id') id: string) {
    return this.packagesService.deletePackage(id);
  }
}

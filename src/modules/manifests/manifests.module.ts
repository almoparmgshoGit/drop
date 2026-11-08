import { Body, Controller, Get, Module, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { ManifestsService } from './manifests.service';

class SaveHousingSheetDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  columns: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsObject()
  passengerNotes?: Record<string, unknown>;
}

@ApiTags('Manifests')
@Controller('manifests')
@ApiBearerAuth()
class ManifestsController {
  constructor(private manifests: ManifestsService) {}

  @Get(':tripId')
  @RequirePermission('manifests.view')
  @ApiOperation({ summary: 'Passenger, housing and seat sheets of a trip' })
  getManifest(@Req() req, @Param('tripId') tripId: string) {
    return this.manifests.getManifest(req.user, tripId);
  }

  @Put(':tripId/housing-sheet')
  @RequirePermission('hotels.book')
  @ApiOperation({ summary: 'Choose what the housing sheet sent to the hotel shows, and add notes to it' })
  saveHousingSheet(@Param('tripId') tripId: string, @Body() dto: SaveHousingSheetDto) {
    return this.manifests.saveHousingSheet(tripId, dto);
  }

  @Get(':tripId/inventory')
  @RequirePermission('manifests.inventory')
  @ApiOperation({ summary: 'Financial inventory of a trip (Admin only)' })
  getInventory(@Param('tripId') tripId: string) {
    return this.manifests.getInventory(tripId);
  }
}

@Module({
  controllers: [ManifestsController],
  providers: [ManifestsService],
})
export class ManifestsModule {}

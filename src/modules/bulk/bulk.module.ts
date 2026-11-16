import { Body, Controller, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { TripsModule } from '../trips/trips.module';
import { UsersModule } from '../users/users.module';
import { BusesModule } from '../buses/buses.module';
import { BulkService } from './bulk.service';

class BulkIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  // Record ids are plain text ids: rows created by imports or older seeds are not all UUIDs, and a strict check refused the whole batch.
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids: string[];
}

class BulkVisibilityDto extends BulkIdsDto {
  /** true stops the rows (hidden from the app), false shows them again. */
  @IsBoolean()
  hidden: boolean;

  /** Why accounts are stopped; required when blocking customers or employees. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

class BulkUnlinkDto {
  @IsString()
  @MaxLength(64)
  id: string;

  @IsString()
  @MaxLength(40)
  link: string;
}

/**
 * Actions on several rows of one admin table at once. Each table needs its own manage permission (and its delete permission to delete), checked by the
 * service since the table comes in the path.
 */
@ApiTags('bulk')
@ApiBearerAuth()
@Controller('bulk')
export class BulkController {
  constructor(private bulk: BulkService) {}

  @Post(':entity/inspect')
  @HttpCode(200)
  @ApiOperation({ summary: 'What keeps each picked row from being deleted' })
  inspect(@Req() req, @Param('entity') entity: string, @Body() dto: BulkIdsDto) {
    return this.bulk.inspect(entity, req.user, dto.ids);
  }

  @Post(':entity/delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete the picked rows that nothing holds' })
  remove(@Req() req, @Param('entity') entity: string, @Body() dto: BulkIdsDto) {
    return this.bulk.remove(entity, req.user, dto.ids);
  }

  @Post(':entity/visibility')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the picked rows (hide them from the app) or show them again' })
  visibility(@Req() req, @Param('entity') entity: string, @Body() dto: BulkVisibilityDto) {
    return this.bulk.setHidden(entity, req.user, dto.ids, dto.hidden, dto.reason);
  }

  @Post(':entity/unlink')
  @HttpCode(200)
  @ApiOperation({ summary: 'Break one link that keeps a row from being deleted' })
  unlink(@Req() req, @Param('entity') entity: string, @Body() dto: BulkUnlinkDto) {
    return this.bulk.unlink(entity, req.user, dto.id, dto.link);
  }
}

@Module({
  imports: [TripsModule, UsersModule, BusesModule],
  controllers: [BulkController],
  providers: [BulkService],
})
export class BulkModule {}

import { Body, Controller, Delete, ForbiddenException, Get, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { SkipAudit } from '../../common/decorators/auth.decorators';
import { TablePreferencesService } from './table-preferences.service';

class SaveTablePreferenceDto {
  @IsObject()
  settings: Record<string, unknown>;
}

/** Each staff member's own arrangement of the admin tables: which columns show and whether the first stays pinned. */
@ApiTags('Table preferences')
@ApiBearerAuth()
@Controller('users/me/table-preferences')
export class TablePreferencesController {
  constructor(private service: TablePreferencesService) {}

  @Get()
  @ApiOperation({ summary: "List the current staff member's saved table settings, keyed by table" })
  list(@Req() req) {
    this.assertStaff(req);
    return this.service.list(req.user.userId);
  }

  @Put(':tableKey')
  @SkipAudit()
  @ApiOperation({ summary: "Save the current staff member's settings for one table" })
  save(@Req() req, @Param('tableKey') tableKey: string, @Body() dto: SaveTablePreferenceDto) {
    this.assertStaff(req);
    return this.service.save(req.user.userId, tableKey, dto.settings);
  }

  @Delete(':tableKey')
  @SkipAudit()
  @ApiOperation({ summary: 'Reset one table to its default columns' })
  reset(@Req() req, @Param('tableKey') tableKey: string) {
    this.assertStaff(req);
    return this.service.reset(req.user.userId, tableKey);
  }

  private assertStaff(req) {
    if (!req.user || req.user.role === 'PASSENGER') throw new ForbiddenException('هذه الإعدادات لموظفي لوحة التحكم فقط');
  }
}



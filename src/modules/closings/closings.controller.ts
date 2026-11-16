import { Body, Controller, Get, Param, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { MAX_INVOICE_BYTES, MAX_INVOICES, UploadedInvoice } from '../cash/cash.service';
import { ApproveClosingDto, ClosingQuery, ClosingsListQuery, CreateGeneralExpenseDto, GeneralExpensesQuery, VoidClosingDto, VoidGeneralExpenseDto } from './closings.dto';
import { ClosingsService } from './closings.service';
import { GeneralExpensesService } from './general-expenses.service';

@ApiTags('Closings')
@Controller('closings')
@ApiBearerAuth()
export class ClosingsController {
  constructor(private closings: ClosingsService) {}

  @Get('preview')
  @RequirePermission('closings.view')
  // A year's closing reads every trip and payment of the year, so a burst of them is refused.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'A closing of the accounts (trips, employees or everything) for a trip, month, quarter, year or period, worked out now' })
  preview(@Query() query: ClosingQuery) {
    return this.closings.preview(query);
  }

  @Get()
  @RequirePermission('closings.view')
  @ApiOperation({ summary: 'Approved closings, newest first' })
  list(@Query() query: ClosingsListQuery) {
    return this.closings.list(query);
  }

  @Post()
  @RequirePermission('closings.approve')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Approve a closing: its figures are saved as they stand and cannot change afterwards' })
  approve(@Req() req, @Body() dto: ApproveClosingDto) {
    return this.closings.approve(req.user, dto);
  }

  @Get(':id')
  @RequirePermission('closings.view')
  @ApiOperation({ summary: 'An approved closing as it was saved' })
  get(@Param('id') id: string) {
    return this.closings.get(id);
  }

  @Post(':id/void')
  @RequirePermission('closings.approve')
  @ApiOperation({ summary: 'Void an approved closing so its period can be closed again; it stays on record with the reason' })
  void(@Req() req, @Param('id') id: string, @Body() dto: VoidClosingDto) {
    return this.closings.void(req.user, id, dto.reason);
  }
}

@ApiTags('Closings')
@Controller('general-expenses')
@ApiBearerAuth()
export class GeneralExpensesController {
  constructor(private expenses: GeneralExpensesService) {}

  @Get()
  @RequirePermission('expenses.view', 'expenses.manage')
  @ApiOperation({ summary: 'Premises rents and office expenses in a period, with their totals by category' })
  list(@Query() query: GeneralExpensesQuery) {
    return this.expenses.list(query);
  }

  @Post()
  @RequirePermission('expenses.manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('invoices', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Record a premises rent or an office expense, with its invoices' })
  create(@Req() req, @Body() dto: CreateGeneralExpenseDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.expenses.create(req.user, dto, files);
  }

  @Post(':id/void')
  @RequirePermission('expenses.manage')
  @ApiOperation({ summary: 'Void an expense; it stays on record with the reason' })
  void(@Req() req, @Param('id') id: string, @Body() dto: VoidGeneralExpenseDto) {
    return this.expenses.void(req.user, id, dto.reason);
  }

  @Get('attachments/:id')
  @RequirePermission('expenses.view', 'expenses.manage')
  @ApiOperation({ summary: 'Download an invoice attached to an expense' })
  async attachment(@Param('id') id: string) {
    const file = await this.expenses.attachment(id);
    return new StreamableFile(Buffer.from(file.data), {
      type: file.mimeType,
      length: file.size,
      // Always a download, so a crafted file can never run inside the API's origin.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }
}

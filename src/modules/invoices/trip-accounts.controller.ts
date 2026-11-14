import { Body, Controller, Get, Param, Patch, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { MAX_INVOICE_BYTES, MAX_INVOICES, UploadedInvoice } from '../cash/cash.service';
import { CreateCategoryDto, CreateEntryDto, TripAccountsQuery, UpdateCategoryDto, UpdateTaxFlagsDto, VoidEntryDto } from './trip-accounts.dto';
import { TripAccountsService } from './trip-accounts.service';

@ApiTags('Trip accounts')
@Controller('trip-accounts')
@ApiBearerAuth()
export class TripAccountsController {
  constructor(private accounts: TripAccountsService) {}

  @Get()
  @RequirePermission('trip_accounts.view')
  @ApiOperation({ summary: 'Revenue, costs and net of each trip in a period' })
  list(@Query() query: TripAccountsQuery) {
    return this.accounts.list(query);
  }

  // Before ':id', or Nest would read "current-profits" as a trip id.
  @Get('current-profits')
  @RequirePermission('trip_accounts.view')
  @ApiOperation({ summary: "Each live or finished trip's money actually paid so far, its costs, and the profit on that paid money" })
  currentProfits() {
    return this.accounts.currentProfits();
  }

  @Get('categories')
  @RequirePermission('trip_accounts.view')
  @ApiOperation({ summary: 'The expense and income lines every trip can use' })
  categories() {
    return this.accounts.categories();
  }

  @Post('categories')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: 'Add a line for all trips' })
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.accounts.createCategory(dto);
  }

  @Patch('categories/:id')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: 'Stop or resume offering a line; entries already made stay' })
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.accounts.updateCategory(id, dto);
  }

  @Post('entries/:id/void')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: 'Void an entry; it stays on record with the reason' })
  voidEntry(@Req() req, @Param('id') id: string, @Body() dto: VoidEntryDto) {
    return this.accounts.voidEntry(req.user, id, dto.reason);
  }

  @Post('entries/:id/settle')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: "Mark a line that was due at the month's end as paid" })
  settleEntry(@Req() req, @Param('id') id: string) {
    return this.accounts.settleEntry(req.user, id);
  }

  @Get('attachments/:id')
  @RequirePermission('trip_accounts.view')
  @ApiOperation({ summary: 'Download an invoice attached to an entry' })
  async attachment(@Param('id') id: string) {
    const file = await this.accounts.attachment(id);
    return new StreamableFile(Buffer.from(file.data), {
      type: file.mimeType,
      length: file.size,
      // Always a download, so a crafted file can never run inside the API's origin.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @Get(':id')
  @RequirePermission('trip_accounts.view')
  @ApiOperation({ summary: "One trip's own account, line by line" })
  detail(@Param('id') id: string) {
    return this.accounts.detail(id);
  }

  @Post(':id/entries')
  @RequirePermission('trip_accounts.manage')
  @UseInterceptors(FilesInterceptor('invoices', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Record an expense or other income on a trip, with its invoices' })
  addEntry(@Req() req, @Param('id') id: string, @Body() dto: CreateEntryDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.accounts.addEntry(req.user, id, dto, files);
  }

  @Post(':id/close')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: "Close an executed trip's account (financial closing); its lines are then final until reopened" })
  close(@Req() req, @Param('id') id: string) {
    return this.accounts.close(req.user, id);
  }

  @Post(':id/reopen')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: 'Reopen a closed trip account' })
  reopen(@Param('id') id: string) {
    return this.accounts.reopen(id);
  }

  @Patch(':id/tax-flags')
  @RequirePermission('trip_accounts.manage')
  @ApiOperation({ summary: 'Say whether the bus rent and hotel bills came with tax invoices' })
  updateTaxFlags(@Param('id') id: string, @Body() dto: UpdateTaxFlagsDto) {
    return this.accounts.updateTaxFlags(id, dto);
  }
}

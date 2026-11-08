import { Body, Controller, Get, Param, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CreateCustodyExpenseDto, VoidCustodyExpenseDto } from './cash.dto';
import { MAX_INVOICE_BYTES, MAX_INVOICES, UploadedInvoice } from './cash.service';
import { CustodyExpensesService } from './custody-expenses.service';

@ApiTags('Crew custody')
@Controller('crew/custodies')
@ApiBearerAuth()
export class CrewCustodyController {
  constructor(private expenses: CustodyExpensesService) {}

  @Get()
  @RequirePermission('crew.custody')
  @ApiOperation({ summary: "The caller's own custodies with what is left of each, optionally for one trip" })
  list(@Req() req, @Query('tripId') tripId?: string) {
    return this.expenses.listMine(req.user, tripId);
  }

  @Post('expenses/:id/void')
  @RequirePermission('crew.custody')
  @ApiOperation({ summary: 'Void an expense the caller recorded; it stays in the log with the reason' })
  voidExpense(@Req() req, @Param('id') id: string, @Body() dto: VoidCustodyExpenseDto) {
    return this.expenses.voidMine(req.user, id, dto.reason);
  }

  @Get('attachments/:id')
  @RequirePermission('crew.custody')
  @ApiOperation({ summary: 'Fetch an invoice from one of the caller’s own custodies' })
  async attachment(@Req() req, @Param('id') id: string) {
    const file = await this.expenses.attachmentMine(req.user, id);
    return new StreamableFile(Buffer.from(file.data), {
      type: file.mimeType,
      length: file.size,
      // Always a download, so a crafted file can never run inside the API's origin.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @Get(':id')
  @RequirePermission('crew.custody')
  @ApiOperation({ summary: 'One of the caller’s custodies with its log of expenses' })
  detail(@Req() req, @Param('id') id: string) {
    return this.expenses.detailMine(req.user, id);
  }

  @Post(':id/expenses')
  @RequirePermission('crew.custody')
  // Each request holds its invoices in memory, so a burst of them is refused before they are read.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('invoices', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Record money spent from the custody, with its invoices' })
  addExpense(@Req() req, @Param('id') id: string, @Body() dto: CreateCustodyExpenseDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.expenses.addExpense(req.user, id, dto, files);
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CloseSessionDto, IssueCustodyDto, OpenSessionDto, PageQuery, SaveBranchDto, SettleCustodyDto, UpdateBranchDto, VoidCustodyExpenseDto } from './cash.dto';
import { CustodyExpensesService } from './custody-expenses.service';
import { CashService, MAX_INVOICE_BYTES, MAX_INVOICES, UploadedInvoice } from './cash.service';

@ApiTags('Cash')
@Controller('cash')
@ApiBearerAuth()
export class CashController {
  constructor(
    private cash: CashService,
    private expenses: CustodyExpensesService,
  ) {}

  @Get('branches')
  @RequirePermission('cash.view', 'collections.view', 'branches.manage', 'employees.manage')
  @ApiOperation({ summary: 'Branches whose drawer the caller can open; all=true lists every branch for managers' })
  listBranches(@Req() req, @Query('all') all?: string) {
    return this.cash.listBranches(req.user, all === 'true');
  }

  @Post('branches')
  @RequirePermission('branches.manage')
  @ApiOperation({ summary: 'Add a branch' })
  createBranch(@Body() dto: SaveBranchDto) {
    return this.cash.createBranch(dto);
  }

  @Patch('branches/:id')
  @RequirePermission('branches.manage')
  @ApiOperation({ summary: 'Rename or deactivate a branch' })
  updateBranch(@Param('id') id: string, @Body() dto: UpdateBranchDto) {
    return this.cash.updateBranch(id, dto);
  }

  @Get('branches/:branchId/overview')
  @RequirePermission('cash.view')
  @ApiOperation({ summary: "The branch's latest drawer with its balance lines, plus custody figures" })
  overview(@Req() req, @Param('branchId') branchId: string) {
    return this.cash.overview(req.user, branchId);
  }

  @Get('branches/:branchId/custodies')
  @RequirePermission('cash.view')
  @ApiOperation({ summary: "The branch's custody register, newest first" })
  listCustodies(@Req() req, @Param('branchId') branchId: string, @Query() query: PageQuery) {
    return this.cash.listCustodies(req.user, branchId, query.page, query.limit);
  }

  @Get('branches/:branchId/sessions')
  @RequirePermission('cash.view')
  @ApiOperation({ summary: "The branch's closing history" })
  listSessions(@Req() req, @Param('branchId') branchId: string, @Query() query: PageQuery) {
    return this.cash.listSessions(req.user, branchId, query.page, query.limit);
  }

  @Post('branches/:branchId/sessions')
  @RequirePermission('cash.operate')
  @ApiOperation({ summary: "Open today's drawer" })
  openSession(@Req() req, @Param('branchId') branchId: string, @Body() dto: OpenSessionDto) {
    return this.cash.openSession(req.user, branchId, dto);
  }

  @Post('sessions/:id/close')
  @RequirePermission('cash.operate')
  @ApiOperation({ summary: 'Close a drawer against the counted cash' })
  closeSession(@Req() req, @Param('id') id: string, @Body() dto: CloseSessionDto) {
    return this.cash.closeSession(req.user, id, dto);
  }

  @Get('custody-options')
  @RequirePermission('custody.issue')
  @ApiOperation({ summary: 'Eligible recipients and trips for the issue form' })
  custodyOptions() {
    return this.cash.custodyOptions();
  }

  @Post('branches/:branchId/custodies')
  @RequirePermission('custody.issue')
  @ApiOperation({ summary: "Hand out a custody from the branch's open drawer" })
  issueCustody(@Req() req, @Param('branchId') branchId: string, @Body() dto: IssueCustodyDto) {
    return this.cash.issueCustody(req.user, branchId, dto);
  }

  @Post('custodies/:id/settle')
  @RequirePermission('custody.settle')
  // Each request holds its invoices in memory, so a burst of them is refused before they are read.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('invoices', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Settle a custody with its invoices; the unspent part returns to the drawer' })
  settleCustody(@Req() req, @Param('id') id: string, @Body() dto: SettleCustodyDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.cash.settleCustody(req.user, id, dto, files);
  }

  @Post('custody-expenses/:id/void')
  @RequirePermission('custody.settle')
  @ApiOperation({ summary: 'Refuse an expense the holder recorded; it stays on record with the reason' })
  voidExpense(@Req() req, @Param('id') id: string, @Body() dto: VoidCustodyExpenseDto) {
    return this.expenses.voidAsOffice(req.user, id, dto.reason);
  }

  @Get('attachments/:id')
  @RequirePermission('cash.view')
  @ApiOperation({ summary: 'Download a custody invoice' })
  async attachment(@Req() req, @Param('id') id: string) {
    const file = await this.cash.attachment(req.user, id);
    return new StreamableFile(Buffer.from(file.data), {
      type: file.mimeType,
      length: file.size,
      // Always a download, so a crafted file can never run inside the API's origin.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }
}

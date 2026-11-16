import { Body, Controller, Get, Param, Post, Put, Query, Req, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { MAX_INVOICE_BYTES, MAX_INVOICES, UploadedInvoice } from '../cash/cash.service';
import { FixedExpensesService } from './fixed-expenses.service';
import { RemittancesService } from './remittances.service';
import {
  ApproveSettlementDto,
  ConfirmRemittanceDto,
  CreateRemittanceDto,
  MatchRemittanceDto,
  MonthQuery,
  PaymentsQuery,
  PerformanceQuery,
  ReasonDto,
  RecordPaymentDto,
  RejectRemittanceDto,
  RemittancesQuery,
  SaveFixedExpenseDto,
  StopFixedExpenseDto,
} from './settlement.dto';
import { SettlementService } from './settlement.service';

/** A stored file, always as a download so a crafted file can never run inside the API's origin. */
const download = (file: { data: Uint8Array; mimeType: string; size: number; fileName: string }) =>
  new StreamableFile(Buffer.from(file.data), { type: file.mimeType, length: file.size, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });

@ApiTags('Settlement')
@Controller('settlement')
@ApiBearerAuth()
export class SettlementController {
  constructor(private settlement: SettlementService) {}

  @Get('monthly')
  @RequirePermission('closings.view', 'owner.confirm')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "A month's settlement: its figures, the branch statement, where the cash went and the eight checks" })
  monthly(@Query() query: MonthQuery) {
    return this.settlement.monthly(query.month);
  }

  @Post('approve')
  @RequirePermission('closings.approve')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The accountant approves the month once every check passed; the owner is asked to close it' })
  approve(@Req() req, @Body() dto: ApproveSettlementDto) {
    return this.settlement.approve(req.user, dto.month, dto.note);
  }

  @Post('owner-approve')
  @RequirePermission('owner.confirm')
  @ApiOperation({ summary: "The owner's final approval: the month is closed" })
  ownerApprove(@Req() req, @Body() dto: ApproveSettlementDto) {
    return this.settlement.ownerApprove(req.user, dto.month);
  }

  @Get('performance')
  @RequirePermission('performance.view', 'owner.confirm')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Each branch's revenue, costs and profit for a month, quarter or year, against the period before and last year" })
  performance(@Query() query: PerformanceQuery) {
    return this.settlement.performance(query.period, query.month);
  }

  @Get('owner')
  @RequirePermission('owner.confirm')
  @ApiOperation({ summary: "The owner's phone page: what reached him, what waits for his confirmation, and the last statements" })
  owner(@Req() req) {
    return this.settlement.ownerHome(req.user);
  }
}

@ApiTags('Settlement')
@Controller('remittances')
@ApiBearerAuth()
export class RemittancesController {
  constructor(private remittances: RemittancesService) {}

  @Get('summary')
  @RequirePermission('remittances.view', 'remittances.create', 'remittances.match', 'owner.confirm')
  summary(@Req() req, @Query() query: MonthQuery) {
    return this.remittances.summary(req.user, query.month);
  }

  @Get()
  @RequirePermission('remittances.view', 'remittances.create', 'remittances.match', 'owner.confirm')
  @ApiOperation({ summary: 'Remittances, newest first' })
  list(@Req() req, @Query() query: RemittancesQuery) {
    return this.remittances.list(req.user, query);
  }

  @Get('unremitted/:branchId')
  @RequirePermission('remittances.create')
  @ApiOperation({ summary: "A branch's closed drawers not yet remitted" })
  unremitted(@Req() req, @Param('branchId') branchId: string) {
    return this.remittances.unremitted(req.user, branchId);
  }

  @Get('attachments/:id')
  @RequirePermission('remittances.view', 'remittances.create', 'remittances.match', 'owner.confirm')
  async attachment(@Req() req, @Param('id') id: string) {
    return download(await this.remittances.attachment(req.user, id));
  }

  @Get(':id')
  @RequirePermission('remittances.view', 'remittances.create', 'remittances.match', 'owner.confirm')
  get(@Req() req, @Param('id') id: string) {
    return this.remittances.get(req.user, id);
  }

  @Post()
  @RequirePermission('remittances.create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('receipts', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: "Remit a branch's closed drawers to the owner or the bank" })
  create(@Req() req, @Body() dto: CreateRemittanceDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.remittances.create(req.user, dto, files);
  }

  @Post(':id/cancel')
  @RequirePermission('remittances.create', 'remittances.match')
  cancel(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.remittances.cancel(req.user, id, dto.reason);
  }

  @Post(':id/code')
  @RequirePermission('owner.confirm')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send the owner a WhatsApp code to confirm or refuse this remittance' })
  code(@Req() req, @Param('id') id: string) {
    return this.remittances.sendCode(req.user, id);
  }

  @Post(':id/confirm')
  @RequirePermission('owner.confirm')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  confirm(@Req() req, @Param('id') id: string, @Body() dto: ConfirmRemittanceDto) {
    return this.remittances.confirm(req.user, id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('owner.confirm')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reject(@Req() req, @Param('id') id: string, @Body() dto: RejectRemittanceDto) {
    return this.remittances.reject(req.user, id, dto);
  }

  @Post(':id/match')
  @RequirePermission('remittances.match')
  match(@Req() req, @Param('id') id: string, @Body() dto: MatchRemittanceDto) {
    return this.remittances.match(req.user, id, dto.bankAmount);
  }

  @Post(':id/justify')
  @RequirePermission('remittances.match')
  justify(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.remittances.justify(req.user, id, dto.reason);
  }
}

@ApiTags('Settlement')
@Controller('fixed-expenses')
@ApiBearerAuth()
export class FixedExpensesController {
  constructor(private fixed: FixedExpensesService) {}

  @Get()
  @RequirePermission('fixed_expenses.view', 'fixed_expenses.manage', 'fixed_expenses.pay')
  @ApiOperation({ summary: 'Rents and recurring expenses, with the monthly total, dues soon and contracts ending soon' })
  list() {
    return this.fixed.list();
  }

  @Get('dues')
  @RequirePermission('fixed_expenses.view', 'fixed_expenses.manage', 'fixed_expenses.pay')
  dues() {
    return this.fixed.dues();
  }

  @Get('schedule')
  @RequirePermission('fixed_expenses.view', 'fixed_expenses.manage', 'fixed_expenses.pay')
  schedule(@Query() query: MonthQuery) {
    return this.fixed.schedule(query.month);
  }

  @Get('payments')
  @RequirePermission('fixed_expenses.view', 'fixed_expenses.manage', 'fixed_expenses.pay')
  payments(@Query() query: PaymentsQuery) {
    return this.fixed.payments(query.page);
  }

  @Post('payments')
  @RequirePermission('fixed_expenses.pay')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('receipts', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Record money paid on a due, with its receipt; cash leaves the branch drawer today' })
  record(@Req() req, @Body() dto: RecordPaymentDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.fixed.record(req.user, dto, files);
  }

  @Post('payments/:id/void')
  @RequirePermission('fixed_expenses.pay')
  voidPayment(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.fixed.void(req.user, id, dto.reason);
  }

  @Get('attachments/:id')
  @RequirePermission('fixed_expenses.view', 'fixed_expenses.manage', 'fixed_expenses.pay', 'owner.confirm')
  async attachment(@Param('id') id: string) {
    return download(await this.fixed.attachment(id));
  }

  @Post()
  @RequirePermission('fixed_expenses.manage')
  @UseInterceptors(FilesInterceptor('contract', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  @ApiOperation({ summary: 'Add a rent contract or a recurring expense; its monthly share posts automatically' })
  create(@Req() req, @Body() dto: SaveFixedExpenseDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.fixed.create(req.user, dto, files);
  }

  @Put(':id')
  @RequirePermission('fixed_expenses.manage')
  update(@Param('id') id: string, @Body() dto: SaveFixedExpenseDto) {
    return this.fixed.update(id, dto);
  }

  @Post(':id/stop')
  @RequirePermission('fixed_expenses.manage')
  stop(@Req() req, @Param('id') id: string, @Body() dto: StopFixedExpenseDto) {
    return this.fixed.stop(req.user, id, dto.reason, dto.stopOn);
  }

  @Post(':id/attachments')
  @RequirePermission('fixed_expenses.manage')
  @UseInterceptors(FilesInterceptor('contract', MAX_INVOICES, { limits: { fileSize: MAX_INVOICE_BYTES } }))
  attach(@Req() req, @Param('id') id: string, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.fixed.attach(req.user, id, files);
  }
}

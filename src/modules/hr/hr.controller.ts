import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, Req, StreamableFile, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { MAX_INVOICE_BYTES, UploadedInvoice } from '../cash/cash.service';
import { AdjustmentsService } from './adjustments.service';
import { AdvancesService } from './advances.service';
import { DocumentsService, MAX_DOCUMENT_BYTES } from './documents.service';
import { EmployeeFilesService } from './employee-files.service';
import { HrActor, HrCoreService } from './hr-core.service';
import {
  AdjustmentDto,
  AdjustmentsQuery,
  AdvanceDecisionDto,
  AdvanceRecordDto,
  AdvanceRequestDto,
  AdvancesQuery,
  DocumentDto,
  EmployeesQuery,
  LeaveAdjustmentDto,
  LeaveDecisionDto,
  LeavePreviewQuery,
  LeaveRecordDto,
  LeaveRequestDto,
  LeavesQuery,
  LeaveTypeDto,
  PaymentDto,
  PayrollCreateDto,
  PayrollApprovePayDto,
  PayrollPayDto,
  ProfileDto,
  ReasonDto,
  RepayDto,
  ReturnDto,
  SalaryDto,
  SettlementCreateDto,
  SettlementDto,
  SettlementPreviewQuery,
  SkipMonthDto,
  StatusDto,
  StatusQuery,
} from './hr.dto';
import { LeavesService, MAX_LEAVE_FILES } from './leaves.service';
import { PayrollService } from './payroll.service';
import { SettlementsService } from './settlements.service';

/** Always a download, so a crafted file can never run inside the API's origin. */
const download = (file: { data: Uint8Array; mimeType: string; size: number; fileName: string }) =>
  new StreamableFile(Buffer.from(file.data), { type: file.mimeType, length: file.size, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });

/** Shown in place as an image; only stored photos, whose type was checked from their own bytes, come through here. */
const inline = (file: { data: Uint8Array; mimeType: string; size: number }) =>
  new StreamableFile(Buffer.from(file.data), { type: file.mimeType, length: file.size, disposition: 'inline' });

const leaveFiles = () => UseInterceptors(FilesInterceptor('files', MAX_LEAVE_FILES, { limits: { fileSize: MAX_INVOICE_BYTES } }));

/** Salary figures need hr.salaries on top of the permission to act. */
const assertSalaries = (actor: HrActor) => {
  if (!actor.permissions.includes('hr.salaries')) throw new ForbiddenException('عرض الرواتب وتعديلها يحتاج صلاحية الرواتب');
};

// ================================================================ the employee's own

@ApiTags('HR · self service')
@Controller('hr/me')
@ApiBearerAuth()
export class HrSelfController {
  constructor(
    private files: EmployeeFilesService,
    private leaves: LeavesService,
    private advances: AdvancesService,
    private payroll: PayrollService,
    private documents: DocumentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My employment file, leave balances, requests, advances and payslips' })
  mine(@Req() req) {
    return this.files.mine(req.user.userId);
  }

  @Get('leaves/preview')
  @ApiOperation({ summary: 'How a leave I am about to ask for would count' })
  preview(@Req() req, @Query() query: LeaveRequestDto) {
    return this.leaves.preview(req.user.userId, query);
  }

  @Post('leaves')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @leaveFiles()
  @ApiOperation({ summary: 'Ask for leave, with supporting documents' })
  requestLeave(@Req() req, @Body() dto: LeaveRequestDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.leaves.request(req.user, dto, files);
  }

  @Post('leaves/:id/attachments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @leaveFiles()
  @ApiOperation({ summary: 'Add documents to one of my leave requests' })
  attach(@Req() req, @Param('id') id: string, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.leaves.addAttachments(req.user, id, files ?? [], true);
  }

  @Get('leaves/attachments/:id')
  @ApiOperation({ summary: 'A document of one of my leave requests' })
  async attachment(@Req() req, @Param('id') id: string) {
    return download(await this.leaves.attachment(req.user, id, true));
  }

  @Delete('leaves/:id')
  @ApiOperation({ summary: 'Take back a leave request nobody decided yet' })
  withdrawLeave(@Req() req, @Param('id') id: string) {
    return this.leaves.withdraw(req.user, id);
  }

  @Post('advances')
  @ApiOperation({ summary: 'Ask for a salary advance' })
  requestAdvance(@Req() req, @Body() dto: AdvanceRequestDto) {
    return this.advances.request(req.user, dto);
  }

  @Delete('advances/:id')
  @ApiOperation({ summary: 'Take back an advance request nobody decided yet' })
  withdrawAdvance(@Req() req, @Param('id') id: string) {
    return this.advances.withdraw(req.user, id);
  }

  @Get('photo')
  @ApiOperation({ summary: 'My personal photo as HR filed it' })
  async photo(@Req() req) {
    const photo = await this.documents.photo(null, req.user.userId);
    if (!photo) throw new NotFoundException('لا توجد صورة');
    return inline(photo);
  }

  @Get('payslips/:lineId')
  @ApiOperation({ summary: 'One of my payslips' })
  payslip(@Req() req, @Param('lineId') lineId: string) {
    return this.payroll.myPayslip(req.user.userId, lineId);
  }
}

// ================================================================ employment files

@ApiTags('HR · employees')
@Controller('hr/employees')
@ApiBearerAuth()
export class HrEmployeesController {
  constructor(
    private files: EmployeeFilesService,
    private documents: DocumentsService,
    private core: HrCoreService,
  ) {}

  @Get()
  // Every HR role picks employees from this list; salaries in it still need hr.salaries.
  @RequirePermission('hr.view', 'leaves.approve', 'advances.approve', 'deductions.manage', 'settlements.manage')
  @ApiOperation({ summary: 'Staff with their employment status, leave today and, with hr.salaries, salary' })
  list(@Req() req, @Query() query: EmployeesQuery) {
    return this.files.list(req.user, query);
  }

  @Get('overview')
  @RequirePermission('hr.view', 'leaves.approve', 'advances.approve')
  @ApiOperation({ summary: 'Counts for the top of the HR pages' })
  overview(@Req() req) {
    return this.files.overview(req.user);
  }

  @Get('expiring')
  @RequirePermission('hr.view', 'employees.view')
  @ApiOperation({ summary: 'Identity documents, licences and papers that ran out or will within 60 days' })
  expiring(@Req() req) {
    return this.documents.expiring(req.user);
  }

  @Get('documents/:id/file')
  @RequirePermission('hr.view', 'employees.view')
  @ApiOperation({ summary: 'Download one filed document' })
  async documentFile(@Req() req, @Param('id') id: string) {
    return download(await this.documents.file(req.user, id));
  }

  @Delete('documents/:id')
  @RequirePermission('hr.manage', 'employees.manage')
  @ApiOperation({ summary: 'Remove a filed document' })
  removeDocument(@Req() req, @Param('id') id: string) {
    return this.documents.remove(req.user, id);
  }

  @Get(':userId/documents')
  @RequirePermission('hr.view', 'employees.view')
  @ApiOperation({ summary: 'The official papers filed for an employee' })
  listDocuments(@Req() req, @Param('userId') userId: string) {
    return this.documents.list(req.user, userId);
  }

  @Post(':userId/documents')
  @RequirePermission('hr.manage', 'employees.manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  @ApiOperation({ summary: 'File a document or the personal photo of an employee' })
  uploadDocument(@Req() req, @Param('userId') userId: string, @Body() dto: DocumentDto, @UploadedFile() file?: UploadedInvoice) {
    return this.documents.upload(req.user, userId, dto, file);
  }

  @Get(':userId/photo')
  @RequirePermission('hr.view', 'employees.view', 'trips.manage')
  @ApiOperation({ summary: 'The employee’s current personal photo' })
  async photo(@Req() req, @Param('userId') userId: string) {
    // Whoever assigns crews sees their faces, without needing access to the rest of the file.
    const photo = await this.documents.photo(this.core.can(req.user, 'hr.view', 'employees.view') ? req.user : null, userId);
    if (!photo) throw new NotFoundException('لا توجد صورة');
    return inline(photo);
  }

  @Get(':userId')
  @RequirePermission('hr.view')
  @ApiOperation({ summary: 'One employee’s whole employment file' })
  file(@Req() req, @Param('userId') userId: string) {
    return this.files.file(req.user, userId);
  }

  @Put(':userId/profile')
  @RequirePermission('hr.manage')
  @ApiOperation({ summary: 'Create or change the employment record: hire date, contract and bank' })
  saveProfile(@Req() req, @Param('userId') userId: string, @Body() dto: ProfileDto) {
    return this.files.saveProfile(req.user, userId, dto);
  }

  @Post(':userId/salaries')
  @RequirePermission('hr.manage')
  @ApiOperation({ summary: 'A salary from a date onward' })
  addSalary(@Req() req, @Param('userId') userId: string, @Body() dto: SalaryDto) {
    assertSalaries(req.user);
    return this.files.addSalary(req.user, userId, dto);
  }

  @Delete(':userId/salaries/:salaryId')
  @RequirePermission('hr.manage')
  @ApiOperation({ summary: 'Remove a salary row no approved payroll used' })
  removeSalary(@Req() req, @Param('userId') userId: string, @Param('salaryId') salaryId: string) {
    assertSalaries(req.user);
    return this.files.removeSalary(req.user, userId, salaryId);
  }

  @Put(':userId/status')
  @RequirePermission('hr.manage')
  @ApiOperation({ summary: 'Suspend an employee or reinstate them' })
  setStatus(@Req() req, @Param('userId') userId: string, @Body() dto: StatusDto) {
    return this.files.setStatus(req.user, userId, dto.status, dto.note);
  }
}

// ================================================================ leaves

@ApiTags('HR · leaves')
@Controller('hr/leave-types')
@ApiBearerAuth()
export class LeaveTypesController {
  constructor(private leaves: LeavesService) {}

  @Get()
  @ApiOperation({ summary: 'Kinds of leave, with their rules' })
  list(@Query('all') all?: string) {
    return this.leaves.types(all === 'true');
  }

  @Post()
  @RequirePermission('leaves.manage')
  @ApiOperation({ summary: 'Add a kind of leave' })
  create(@Body() dto: LeaveTypeDto) {
    return this.leaves.saveType(null, dto);
  }

  @Put(':id')
  @RequirePermission('leaves.manage')
  @ApiOperation({ summary: 'Change the rules of a kind of leave' })
  update(@Param('id') id: string, @Body() dto: LeaveTypeDto) {
    return this.leaves.saveType(id, dto);
  }
}

@ApiTags('HR · leaves')
@Controller('hr/leaves')
@ApiBearerAuth()
export class LeavesController {
  constructor(
    private leaves: LeavesService,
    private core: HrCoreService,
  ) {}

  @Get()
  @RequirePermission('hr.view', 'leaves.approve')
  @ApiOperation({ summary: 'Leave requests of the staff in reach' })
  list(@Req() req, @Query() query: LeavesQuery) {
    return this.leaves.list(req.user, query);
  }

  @Get('away-today')
  @RequirePermission('hr.view', 'leaves.approve')
  @ApiOperation({ summary: 'Who is on leave today' })
  awayToday(@Req() req) {
    return this.leaves.awayToday(req.user);
  }

  @Get('preview')
  @RequirePermission('leaves.approve')
  @ApiOperation({ summary: 'How a leave would count for an employee, before recording it' })
  async preview(@Req() req, @Query() query: LeavePreviewQuery) {
    await this.core.employee(req.user, query.userId ?? '');
    return this.leaves.preview(query.userId!, query);
  }

  @Get('attachments/:id')
  @RequirePermission('hr.view', 'leaves.approve')
  @ApiOperation({ summary: 'A document attached to a leave request' })
  async attachment(@Req() req, @Param('id') id: string) {
    return download(await this.leaves.attachment(req.user, id, false));
  }

  @Get(':id')
  @RequirePermission('hr.view', 'leaves.approve')
  @ApiOperation({ summary: 'One leave request' })
  async detail(@Req() req, @Param('id') id: string) {
    const row = await this.leaves.detail(id);
    await this.core.employee(req.user, row.user.id);
    return row;
  }

  @Post()
  @RequirePermission('leaves.approve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @leaveFiles()
  @ApiOperation({ summary: 'Record an approved leave for an employee' })
  record(@Req() req, @Body() dto: LeaveRecordDto, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.leaves.recordFor(req.user, dto.userId, dto, files);
  }

  @Post('adjustments')
  @RequirePermission('leaves.manage')
  @ApiOperation({ summary: 'Correct an annual leave balance by hand, with the reason' })
  adjust(@Req() req, @Body() dto: LeaveAdjustmentDto) {
    return this.leaves.adjustBalance(req.user, dto);
  }

  @Post(':id/decision')
  @RequirePermission('leaves.approve')
  @ApiOperation({ summary: 'Approve or refuse a leave request' })
  decide(@Req() req, @Param('id') id: string, @Body() dto: LeaveDecisionDto) {
    return this.leaves.decide(req.user, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('leaves.approve')
  @ApiOperation({ summary: 'Cancel a leave that has not started' })
  cancel(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.leaves.cancel(req.user, id, dto.reason);
  }

  @Post(':id/return')
  @RequirePermission('leaves.approve')
  @ApiOperation({ summary: 'Record an early return; the days after go back to the balance' })
  returnEarly(@Req() req, @Param('id') id: string, @Body() dto: ReturnDto) {
    return this.leaves.returnEarly(req.user, id, dto.returnDate);
  }

  @Post(':id/attachments')
  @RequirePermission('leaves.approve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @leaveFiles()
  @ApiOperation({ summary: 'Attach documents to a leave request' })
  attach(@Req() req, @Param('id') id: string, @UploadedFiles() files?: UploadedInvoice[]) {
    return this.leaves.addAttachments(req.user, id, files ?? [], false);
  }
}

// ================================================================ advances

@ApiTags('HR · advances')
@Controller('hr/advances')
@ApiBearerAuth()
export class AdvancesController {
  constructor(private advances: AdvancesService) {}

  @Get()
  @RequirePermission('hr.view', 'advances.approve')
  @ApiOperation({ summary: 'Salary advances of the staff in reach, with what is left of each' })
  list(@Req() req, @Query() query: AdvancesQuery) {
    return this.advances.list(req.user, query);
  }

  @Get(':id')
  @RequirePermission('hr.view', 'advances.approve')
  @ApiOperation({ summary: 'One advance with its repayments and schedule' })
  detail(@Req() req, @Param('id') id: string) {
    return this.advances.detailFor(req.user, id);
  }

  @Post()
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Record an approved advance for an employee' })
  record(@Req() req, @Body() dto: AdvanceRecordDto) {
    return this.advances.recordFor(req.user, dto.userId, dto);
  }

  @Post(':id/decision')
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Approve, possibly spread differently, or refuse an advance request' })
  decide(@Req() req, @Param('id') id: string, @Body() dto: AdvanceDecisionDto) {
    return this.advances.decide(req.user, id, dto);
  }

  @Post(':id/disburse')
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Hand the advance over in cash from a drawer or by transfer' })
  disburse(@Req() req, @Param('id') id: string, @Body() dto: PaymentDto) {
    return this.advances.disburse(req.user, id, dto);
  }

  @Post(':id/skip')
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Skip one month’s installment' })
  skip(@Req() req, @Param('id') id: string, @Body() dto: SkipMonthDto) {
    return this.advances.skipMonth(req.user, id, dto.month);
  }

  @Post(':id/repay')
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Take a cash repayment into a drawer' })
  repay(@Req() req, @Param('id') id: string, @Body() dto: RepayDto) {
    return this.advances.repayCash(req.user, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('advances.approve')
  @ApiOperation({ summary: 'Cancel an advance not yet handed over' })
  cancel(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.advances.cancel(req.user, id, dto.reason);
  }
}

// ================================================================ additions and deductions

@ApiTags('HR · salary adjustments')
@Controller('hr/adjustments')
@ApiBearerAuth()
export class AdjustmentsController {
  constructor(private adjustments: AdjustmentsService) {}

  @Get()
  @RequirePermission('deductions.manage', 'hr.salaries')
  @ApiOperation({ summary: 'Bonuses and deductions, with what payrolls already took' })
  list(@Req() req, @Query() query: AdjustmentsQuery) {
    return this.adjustments.list(req.user, query);
  }

  @Post()
  @RequirePermission('deductions.manage')
  @ApiOperation({ summary: 'Add a bonus or deduction to an employee’s salary' })
  create(@Req() req, @Body() dto: AdjustmentDto) {
    return this.adjustments.create(req.user, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('deductions.manage')
  @ApiOperation({ summary: 'Drop what no approved payroll has taken yet' })
  cancel(@Req() req, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.adjustments.cancel(req.user, id, dto.reason);
  }
}

// ================================================================ payroll

@ApiTags('HR · payroll')
@Controller('hr/payroll')
@ApiBearerAuth()
export class PayrollController {
  constructor(
    private payroll: PayrollService,
    private core: HrCoreService,
  ) {}

  @Get()
  @RequirePermission('payroll.prepare', 'payroll.approve', 'payroll.pay', 'hr.salaries')
  @ApiOperation({ summary: 'Payrolls by month' })
  list() {
    return this.payroll.list();
  }

  @Post()
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Start a month’s payroll and work it out' })
  create(@Req() req, @Body() dto: PayrollCreateDto) {
    return this.payroll.create(req.user, dto.month);
  }

  @Get('lines/:lineId')
  @RequirePermission('payroll.prepare', 'payroll.approve', 'payroll.pay', 'hr.salaries')
  @ApiOperation({ summary: 'A payslip with every item behind it' })
  payslip(@Param('lineId') lineId: string) {
    return this.payroll.payslip(lineId);
  }

  @Get(':id')
  @RequirePermission('payroll.prepare', 'payroll.approve', 'payroll.pay', 'hr.salaries')
  @ApiOperation({ summary: 'One payroll with its lines and warnings' })
  detail(@Param('id') id: string) {
    return this.payroll.detail(id);
  }

  @Post(':id/calculate')
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Work a draft payroll out again' })
  calculate(@Req() req, @Param('id') id: string) {
    return this.payroll.calculate(req.user, id);
  }

  @Delete(':id')
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Delete a draft payroll' })
  remove(@Param('id') id: string) {
    return this.payroll.remove(id);
  }

  @Post(':id/approve')
  @RequirePermission('payroll.approve')
  @ApiOperation({ summary: 'Approve and freeze the payroll' })
  approve(@Req() req, @Param('id') id: string) {
    return this.payroll.approve(req.user, id);
  }

  @Get(':id/payment-needs')
  @RequirePermission('payroll.approve', 'payroll.pay')
  @ApiOperation({ summary: 'How many salaries go by transfer and how many in cash, before approving and paying' })
  paymentNeeds(@Param('id') id: string) {
    return this.payroll.paymentNeeds(id);
  }

  @Post(':id/approve-and-pay')
  @RequirePermission('payroll.approve')
  @ApiOperation({ summary: 'Approve the payroll and pay every salary the way each employee is paid, in one step' })
  approveAndPay(@Req() req, @Param('id') id: string, @Body() dto: PayrollApprovePayDto) {
    return this.payroll.approveAndPay(req.user, id, dto);
  }

  @Post(':id/pay')
  @RequirePermission('payroll.pay')
  @ApiOperation({ summary: 'Record salaries as paid by transfer or in cash from a drawer' })
  pay(@Req() req, @Param('id') id: string, @Body() dto: PayrollPayDto) {
    return this.payroll.pay(req.user, id, dto);
  }

  @Get(':id/bank-file')
  @RequirePermission('payroll.pay')
  @ApiOperation({ summary: 'The transfers still to make, as a CSV for the bank' })
  async bankFile(@Req() req, @Param('id') id: string) {
    const file = await this.payroll.bankFile(id);
    // Reads go unlogged, but this file carries every IBAN and salary, so taking it is recorded by hand.
    await this.core.db.auditLog.create({ data: { userId: req.user.userId, action: 'GET /hr/payroll/:id/bank-file', entity: 'PayrollRun', entityId: id, ip: req.ip, details: { name: file.fileName } } });
    const data = Buffer.from(file.content, 'utf8');
    return new StreamableFile(data, { type: 'text/csv; charset=utf-8', length: data.length, disposition: `attachment; filename="${file.fileName}"` });
  }
}

// ================================================================ final settlements

@ApiTags('HR · final settlements')
@Controller('hr/settlements')
@ApiBearerAuth()
export class SettlementsController {
  constructor(
    private settlements: SettlementsService,
    private core: HrCoreService,
  ) {}

  @Get()
  @RequirePermission('settlements.manage', 'payroll.approve', 'payroll.pay')
  @ApiOperation({ summary: 'Final settlements' })
  list(@Req() req, @Query() query: StatusQuery) {
    return this.settlements.list(req.user, query.status);
  }

  @Get('preview')
  @RequirePermission('settlements.manage')
  @ApiOperation({ summary: 'What a settlement would come to, without saving it' })
  async preview(@Req() req, @Query() query: SettlementPreviewQuery) {
    await this.core.activeEmployee(req.user, query.userId);
    return this.settlements.compute(this.core.db, query.userId, query);
  }

  @Get(':id')
  @RequirePermission('settlements.manage', 'payroll.approve', 'payroll.pay')
  @ApiOperation({ summary: 'One settlement with every figure behind it' })
  async detail(@Req() req, @Param('id') id: string) {
    const row = await this.settlements.detail(id);
    await this.core.employee(req.user, (row.user as { id: string }).id);
    return row;
  }

  @Post()
  @RequirePermission('settlements.manage')
  @ApiOperation({ summary: 'Prepare a final settlement' })
  create(@Req() req, @Body() dto: SettlementCreateDto) {
    return this.settlements.create(req.user, dto.userId, dto);
  }

  @Put(':id')
  @RequirePermission('settlements.manage')
  @ApiOperation({ summary: 'Change a draft settlement and work it out again' })
  update(@Req() req, @Param('id') id: string, @Body() dto: SettlementDto) {
    return this.settlements.update(req.user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settlements.manage')
  @ApiOperation({ summary: 'Delete a draft settlement' })
  remove(@Req() req, @Param('id') id: string) {
    return this.settlements.remove(req.user, id);
  }

  @Post(':id/approve')
  @RequirePermission('payroll.approve')
  @ApiOperation({ summary: 'Approve the settlement and end the employment' })
  approve(@Req() req, @Param('id') id: string) {
    return this.settlements.approve(req.user, id);
  }

  @Post(':id/pay')
  @RequirePermission('payroll.pay')
  @ApiOperation({ summary: 'Record the settlement as paid or collected' })
  pay(@Req() req, @Param('id') id: string, @Body() dto: PaymentDto) {
    return this.settlements.pay(req.user, id, dto);
  }
}

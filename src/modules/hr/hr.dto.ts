import { AdvanceStatus, ContractType, EmployeeDocumentKind, LeaveStatus, PayrollAdjustmentCategory, PayrollAdjustmentStatus, SalaryPaymentMethod, TerminationReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Multipart forms send everything as text; an empty field means "not given". */
const optionalText = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value));
const asBoolean = () => Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MESSAGE = { message: 'التاريخ بالشكل 2026-11-30' };
const MONTH_MESSAGE = { message: 'الشهر بالشكل 2026-11' };
const MONEY = { maxDecimalPlaces: 2 };

// ---------------------------------------------------------------- employment file

export class ProfileDto {
  @Matches(DAY, DAY_MESSAGE) hireDate: string;
  @IsOptional() @IsEnum(ContractType) contractType?: ContractType;
  @IsOptional() @Matches(DAY, DAY_MESSAGE) contractEndDate?: string | null;
  @IsOptional() @Matches(DAY, DAY_MESSAGE) probationEndDate?: string | null;
  @IsOptional() @IsEnum(SalaryPaymentMethod) paymentMethod?: SalaryPaymentMethod;
  @IsOptional() @trimmed() @IsString() @MaxLength(80) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(40) iban?: string | null;
  @IsOptional() @IsBoolean() gosiRegistered?: boolean;
}

export class SalaryDto {
  @Matches(DAY, DAY_MESSAGE) effectiveFrom: string;
  @IsNumber(MONEY) @Min(1) @Max(1_000_000) basic: number;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(1_000_000) housing?: number;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(1_000_000) transport?: number;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(1_000_000) other?: number;
  @IsOptional() @trimmed() @IsString() @MaxLength(300) note?: string;
}

export class StatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status: 'ACTIVE' | 'SUSPENDED';
  @IsOptional() @trimmed() @IsString() @MaxLength(300) note?: string;
}

export class EmployeesQuery {
  @IsOptional() @trimmed() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @IsString() @MaxLength(64) branchId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'TERMINATED']) status?: string;
  @IsOptional() @asBoolean() @IsBoolean() withoutFile?: boolean;
}

// ---------------------------------------------------------------- leaves

export class LeaveRequestDto {
  @IsString() @MaxLength(64) typeId: string;
  @Matches(DAY, DAY_MESSAGE) startDate: string;
  @Matches(DAY, DAY_MESSAGE) endDate: string;
  @IsOptional() @optionalText() @IsString() @MaxLength(500) reason?: string;
}

export class LeaveRecordDto extends LeaveRequestDto {
  @IsString() @MaxLength(64) userId: string;
  @IsOptional() @optionalText() @IsString() @MaxLength(300) crewConflictNote?: string;
}

export class LeavePreviewQuery extends LeaveRequestDto {
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
}

export class LeaveDecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  @IsOptional() @trimmed() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(300) crewConflictNote?: string;
}

export class ReasonDto {
  @trimmed() @IsString() @Length(3, 500, { message: 'اكتب السبب' }) reason: string;
}

export class ReturnDto {
  @Matches(DAY, DAY_MESSAGE) returnDate: string;
}

export class LeavesQuery {
  @IsOptional() @IsEnum(LeaveStatus) status?: LeaveStatus;
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
  @IsOptional() @IsString() @MaxLength(64) typeId?: string;
  @IsOptional() @Matches(DAY, DAY_MESSAGE) from?: string;
  @IsOptional() @Matches(DAY, DAY_MESSAGE) to?: string;
}

export class LeaveAdjustmentDto {
  @IsString() @MaxLength(64) userId: string;
  @IsString() @MaxLength(64) typeId: string;
  @IsNumber(MONEY) @Min(-365) @Max(365) days: number;
  @trimmed() @IsString() @Length(3, 300, { message: 'اكتب سبب التعديل' }) reason: string;
}

export class LeaveTypeDto {
  @IsOptional() @trimmed() @IsString() @Length(2, 60) name?: string;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(365) maxDaysPerYear?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) maxDaysPerRequest?: number | null;
  @IsOptional() @IsBoolean() oncePerService?: boolean;
  @IsOptional() @IsBoolean() requiresAttachment?: boolean;
  @IsOptional() @IsIn(['MALE', 'FEMALE', null]) gender?: 'MALE' | 'FEMALE' | null;
  @IsOptional() @IsInt() @Min(0) @Max(240) minServiceMonths?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

// ---------------------------------------------------------------- advances

export class AdvanceRequestDto {
  @IsNumber(MONEY) @Min(1) @Max(1_000_000) amount: number;
  @IsInt() @Min(1) @Max(60) installments: number;
  @IsOptional() @Matches(MONTH, MONTH_MESSAGE) firstMonth?: string;
  @trimmed() @IsString() @Length(3, 500, { message: 'اكتب سبب السلفة' }) reason: string;
}

export class AdvanceRecordDto extends AdvanceRequestDto {
  @IsString() @MaxLength(64) userId: string;
}

export class AdvanceDecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  @IsOptional() @trimmed() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) installments?: number;
  @IsOptional() @Matches(MONTH, MONTH_MESSAGE) firstMonth?: string;
}

export class PaymentDto {
  @IsEnum(SalaryPaymentMethod) method: SalaryPaymentMethod;
  @IsOptional() @IsString() @MaxLength(64) branchId?: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(100) bankReference?: string;
}

export class SkipMonthDto {
  @Matches(MONTH, MONTH_MESSAGE) month: string;
}

export class RepayDto {
  @IsNumber(MONEY) @Min(0.01) @Max(1_000_000) amount: number;
  @IsString() @MaxLength(64) branchId: string;
}

export class AdvancesQuery {
  @IsOptional() @IsEnum(AdvanceStatus) status?: AdvanceStatus;
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
}

// ---------------------------------------------------------------- additions and deductions

export class AdjustmentDto {
  @IsString() @MaxLength(64) userId: string;
  @IsEnum(PayrollAdjustmentCategory) category: PayrollAdjustmentCategory;
  @IsOptional() @IsNumber(MONEY) @Min(0.01) @Max(1_000_000) amount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(30) days?: number;
  @IsOptional() @Matches(MONTH, MONTH_MESSAGE) month?: string;
  @trimmed() @IsString() @Length(3, 300, { message: 'اكتب السبب' }) reason: string;
}

export class AdjustmentsQuery {
  @IsOptional() @IsEnum(PayrollAdjustmentStatus) status?: PayrollAdjustmentStatus;
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
  @IsOptional() @Matches(MONTH, MONTH_MESSAGE) month?: string;
  @IsOptional() @IsIn(['EARNING', 'DEDUCTION']) kind?: 'EARNING' | 'DEDUCTION';
}

// ---------------------------------------------------------------- payroll

export class PayrollCreateDto {
  @Matches(MONTH, MONTH_MESSAGE) month: string;
}

/** The drawer for cash salaries, and the transfer reference once the bank has executed the transfers. */
export class PayrollApprovePayDto {
  @IsOptional() @IsString() @MaxLength(64) branchId?: string;
  @IsOptional() @trimmed() @IsString() @MaxLength(100) bankReference?: string;
}

export class PayrollPayDto extends PaymentDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsString({ each: true }) lineIds: string[];
}

// ---------------------------------------------------------------- settlements

export class SettlementDto {
  @Matches(DAY, DAY_MESSAGE) terminationDate: string;
  @IsEnum(TerminationReason) reason: TerminationReason;
  @IsOptional() @asBoolean() @IsBoolean() fullAwardOverride?: boolean;
  @IsOptional() @trimmed() @IsString() @MaxLength(500) note?: string;
}

export class SettlementCreateDto extends SettlementDto {
  @IsString() @MaxLength(64) userId: string;
}

export class SettlementPreviewQuery extends SettlementCreateDto {}

export class StatusQuery {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
}


// ---------------------------------------------------------------- documents

export class DocumentDto {
  @IsEnum(EmployeeDocumentKind, { message: 'نوع الوثيقة غير معروف' }) kind: EmployeeDocumentKind;
  @IsOptional() @optionalText() @IsString() @MaxLength(40) number?: string;
  @IsOptional() @optionalText() @Matches(DAY, DAY_MESSAGE) issueDate?: string;
  @IsOptional() @optionalText() @Matches(DAY, DAY_MESSAGE) expiryDate?: string;
  @IsOptional() @optionalText() @IsString() @MaxLength(300) note?: string;
}

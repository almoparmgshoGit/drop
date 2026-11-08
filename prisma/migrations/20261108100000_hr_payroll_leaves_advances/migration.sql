-- Human resources: employment files, salaries, leaves, advances, salary adjustments, payroll and final settlements.

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('UNLIMITED', 'FIXED_TERM');

-- CreateEnum
CREATE TYPE "SalaryPaymentMethod" AS ENUM ('BANK', 'CASH');

-- CreateEnum
CREATE TYPE "TerminationReason" AS ENUM ('RESIGNATION', 'EMPLOYER_TERMINATION', 'CONTRACT_END', 'ARTICLE_80', 'RETIREMENT', 'DEATH', 'FORCE_MAJEURE', 'MUTUAL_AGREEMENT');

-- CreateEnum
CREATE TYPE "LeaveKind" AS ENUM ('ANNUAL', 'SICK', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'DISBURSED', 'SETTLED');

-- CreateEnum
CREATE TYPE "AdvanceRepaymentSource" AS ENUM ('PAYROLL', 'CASH', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentCategory" AS ENUM ('BONUS', 'OVERTIME', 'OTHER_EARNING', 'PENALTY', 'ABSENCE', 'CASH_SHORTAGE', 'DAMAGE', 'OTHER_DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentStatus" AS ENUM ('PENDING', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollItemKind" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CashMovementType" ADD VALUE 'ADVANCE_ISSUE';
ALTER TYPE "CashMovementType" ADD VALUE 'ADVANCE_REPAYMENT';
ALTER TYPE "CashMovementType" ADD VALUE 'SALARY_PAYMENT';

-- AlterTable
ALTER TABLE "Rank" ADD COLUMN     "tripAllowance" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "advanceId" TEXT,
ADD COLUMN     "employeeId" TEXT;

-- CreateTable
CREATE TABLE "EmployeeProfile" (
    "userId" TEXT NOT NULL,
    "employeeNumber" SERIAL NOT NULL,
    "hireDate" DATE NOT NULL,
    "contractType" "ContractType" NOT NULL DEFAULT 'UNLIMITED',
    "contractEndDate" DATE,
    "probationEndDate" DATE,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusNote" TEXT,
    "paymentMethod" "SalaryPaymentMethod" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "iban" TEXT,
    "gosiRegistered" BOOLEAN NOT NULL DEFAULT true,
    "terminationDate" DATE,
    "terminationReason" "TerminationReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "housing" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transport" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "other" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LeaveKind" NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "maxDaysPerYear" INTEGER,
    "maxDaysPerRequest" INTEGER,
    "oncePerService" BOOLEAN NOT NULL DEFAULT false,
    "requiresAttachment" BOOLEAN NOT NULL DEFAULT false,
    "gender" "Gender",
    "minServiceMonths" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "fullPayDays" INTEGER NOT NULL DEFAULT 0,
    "partialPayDays" INTEGER NOT NULL DEFAULT 0,
    "partialPayPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "unpaidDays" INTEGER NOT NULL DEFAULT 0,
    "crewConflictNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "cancelReason" TEXT,
    "plannedEndDate" DATE,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveAdjustment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryAdvance" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "installments" INTEGER NOT NULL,
    "installmentAmount" DECIMAL(12,2) NOT NULL,
    "firstMonth" TEXT NOT NULL,
    "skippedMonths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "disbursedByName" TEXT,
    "disbursedMethod" "SalaryPaymentMethod",
    "bankReference" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SalaryAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceRepayment" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" "AdvanceRepaymentSource" NOT NULL,
    "payrollRunId" TEXT,
    "settlementId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "category" "PayrollAdjustmentCategory" NOT NULL,
    "amount" DECIMAL(12,2),
    "days" DECIMAL(5,2),
    "month" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PayrollAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "penaltyId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalEmployerGosi" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" TEXT,
    "calculatedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "paidAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "jobName" TEXT,
    "rankName" TEXT,
    "branchId" TEXT,
    "branchName" TEXT,
    "isSaudi" BOOLEAN NOT NULL,
    "iban" TEXT,
    "bankName" TEXT,
    "paymentMethod" "SalaryPaymentMethod" NOT NULL,
    "workedDays" DECIMAL(5,2) NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "housing" DECIMAL(12,2) NOT NULL,
    "transport" DECIMAL(12,2) NOT NULL,
    "other" DECIMAL(12,2) NOT NULL,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "tripAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "additions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(12,2) NOT NULL,
    "leaveDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gosiEmployee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gosiEmployer" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "advanceDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deferred" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidByName" TEXT,
    "paidMethod" "SalaryPaymentMethod",
    "bankReference" TEXT,
    "cashSessionId" TEXT,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLineItem" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "kind" "PayrollItemKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "adjustmentId" TEXT,
    "advanceId" TEXT,
    "leaveRequestId" TEXT,

    CONSTRAINT "PayrollLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinalSettlement" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "terminationDate" DATE NOT NULL,
    "reason" "TerminationReason" NOT NULL,
    "fullAwardOverride" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "serviceDays" INTEGER NOT NULL,
    "monthlyWage" DECIMAL(12,2) NOT NULL,
    "awardShare" DECIMAL(5,4) NOT NULL,
    "eosAward" DECIMAL(12,2) NOT NULL,
    "leaveDays" DECIMAL(6,2) NOT NULL,
    "leaveEncashment" DECIMAL(12,2) NOT NULL,
    "salaryDays" DECIMAL(6,2) NOT NULL,
    "salaryDue" DECIMAL(12,2) NOT NULL,
    "additions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "advanceBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pendingDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL,
    "totalDue" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidByName" TEXT,
    "paidMethod" "SalaryPaymentMethod",
    "bankReference" TEXT,
    "cashSessionId" TEXT,

    CONSTRAINT "FinalSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeProfile_employeeNumber_key" ON "EmployeeProfile"("employeeNumber");

-- CreateIndex
CREATE INDEX "EmployeeProfile_status_idx" ON "EmployeeProfile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructure_userId_effectiveFrom_key" ON "SalaryStructure"("userId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_code_key" ON "LeaveType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_name_key" ON "LeaveType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_number_key" ON "LeaveRequest"("number");

-- CreateIndex
CREATE INDEX "LeaveRequest_userId_startDate_idx" ON "LeaveRequest"("userId", "startDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_status_startDate_idx" ON "LeaveRequest"("status", "startDate");

-- CreateIndex
CREATE INDEX "LeaveAttachment_requestId_idx" ON "LeaveAttachment"("requestId");

-- CreateIndex
CREATE INDEX "LeaveAdjustment_userId_typeId_idx" ON "LeaveAdjustment"("userId", "typeId");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryAdvance_number_key" ON "SalaryAdvance"("number");

-- CreateIndex
CREATE INDEX "SalaryAdvance_userId_status_idx" ON "SalaryAdvance"("userId", "status");

-- CreateIndex
CREATE INDEX "SalaryAdvance_status_createdAt_idx" ON "SalaryAdvance"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_advanceId_idx" ON "AdvanceRepayment"("advanceId");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_payrollRunId_idx" ON "AdvanceRepayment"("payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdjustment_number_key" ON "PayrollAdjustment"("number");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdjustment_penaltyId_key" ON "PayrollAdjustment"("penaltyId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_userId_status_idx" ON "PayrollAdjustment"("userId", "status");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_month_idx" ON "PayrollAdjustment"("month");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_month_key" ON "PayrollRun"("month");

-- CreateIndex
CREATE INDEX "PayrollLine_userId_idx" ON "PayrollLine"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLine_runId_userId_key" ON "PayrollLine"("runId", "userId");

-- CreateIndex
CREATE INDEX "PayrollLineItem_lineId_idx" ON "PayrollLineItem"("lineId");

-- CreateIndex
CREATE INDEX "PayrollLineItem_adjustmentId_idx" ON "PayrollLineItem"("adjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinalSettlement_number_key" ON "FinalSettlement"("number");

-- CreateIndex
CREATE INDEX "FinalSettlement_userId_idx" ON "FinalSettlement"("userId");

-- CreateIndex
CREATE INDEX "FinalSettlement_status_idx" ON "FinalSettlement"("status");

-- CreateIndex
CREATE INDEX "CashMovement_advanceId_idx" ON "CashMovement"("advanceId");

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "SalaryAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "EmployeeProfile"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveAttachment" ADD CONSTRAINT "LeaveAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveAdjustment" ADD CONSTRAINT "LeaveAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveAdjustment" ADD CONSTRAINT "LeaveAdjustment_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "SalaryAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_penaltyId_fkey" FOREIGN KEY ("penaltyId") REFERENCES "StaffPenalty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLineItem" ADD CONSTRAINT "PayrollLineItem_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "PayrollLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLineItem" ADD CONSTRAINT "PayrollLineItem_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "PayrollAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSettlement" ADD CONSTRAINT "FinalSettlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ------------------------------------------------------------ Rules the data itself keeps

ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_amounts_valid" CHECK (
  "basic" > 0 AND "housing" >= 0 AND "transport" >= 0 AND "other" >= 0
);

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_dates_valid" CHECK (
  "endDate" >= "startDate" AND "days" > 0
  AND "fullPayDays" >= 0 AND "partialPayDays" >= 0 AND "unpaidDays" >= 0
);

ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_amounts_valid" CHECK (
  "amount" > 0 AND "installments" > 0 AND "installmentAmount" > 0
);

ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_value_given" CHECK (
  ("amount" IS NOT NULL AND "amount" > 0) OR ("days" IS NOT NULL AND "days" > 0)
);

-- Repayments are the ledger an advance's balance is summed from.
CREATE FUNCTION "reject_advance_repayment_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AdvanceRepayment is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdvanceRepayment_append_only"
BEFORE UPDATE OR DELETE ON "AdvanceRepayment"
FOR EACH ROW EXECUTE FUNCTION "reject_advance_repayment_change"();

-- An approved payroll keeps its figures. Only moving it to PAID and stamping that is allowed.
CREATE FUNCTION "reject_approved_payroll_run_change"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An approved PayrollRun cannot be deleted';
  END IF;
  IF NEW."status" = 'DRAFT'
     OR (to_jsonb(NEW) - 'status' - 'paidAt' - 'note') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paidAt' - 'note') THEN
    RAISE EXCEPTION 'An approved PayrollRun is frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRun_approved_frozen"
BEFORE UPDATE OR DELETE ON "PayrollRun"
FOR EACH ROW EXECUTE FUNCTION "reject_approved_payroll_run_change"();

CREATE FUNCTION "reject_approved_payroll_line_change"() RETURNS trigger AS $$
DECLARE
  run_status TEXT;
BEGIN
  SELECT "status" INTO run_status FROM "PayrollRun" WHERE "id" = COALESCE(NEW."runId", OLD."runId");
  IF run_status IS NULL OR run_status = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'The lines of an approved PayrollRun are frozen';
  END IF;
  IF (to_jsonb(NEW) - 'paidAt' - 'paidByName' - 'paidMethod' - 'bankReference' - 'cashSessionId')
     IS DISTINCT FROM (to_jsonb(OLD) - 'paidAt' - 'paidByName' - 'paidMethod' - 'bankReference' - 'cashSessionId') THEN
    RAISE EXCEPTION 'The figures of an approved PayrollRun are frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollLine_approved_frozen"
BEFORE INSERT OR UPDATE OR DELETE ON "PayrollLine"
FOR EACH ROW EXECUTE FUNCTION "reject_approved_payroll_line_change"();

CREATE FUNCTION "reject_approved_payroll_item_change"() RETURNS trigger AS $$
DECLARE
  run_status TEXT;
BEGIN
  SELECT r."status" INTO run_status FROM "PayrollLine" l JOIN "PayrollRun" r ON r."id" = l."runId"
    WHERE l."id" = COALESCE(NEW."lineId", OLD."lineId");
  IF run_status IS NOT NULL AND run_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'The items of an approved PayrollRun are frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollLineItem_approved_frozen"
BEFORE INSERT OR UPDATE OR DELETE ON "PayrollLineItem"
FOR EACH ROW EXECUTE FUNCTION "reject_approved_payroll_item_change"();

-- An approved settlement ended the employment on its figures; only paying it can follow.
CREATE FUNCTION "reject_approved_settlement_change"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An approved FinalSettlement cannot be deleted';
  END IF;
  IF NEW."status" = 'DRAFT'
     OR (to_jsonb(NEW) - 'status' - 'paidAt' - 'paidByName' - 'paidMethod' - 'bankReference' - 'cashSessionId' - 'updatedAt')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paidAt' - 'paidByName' - 'paidMethod' - 'bankReference' - 'cashSessionId' - 'updatedAt') THEN
    RAISE EXCEPTION 'An approved FinalSettlement is frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinalSettlement_approved_frozen"
BEFORE UPDATE OR DELETE ON "FinalSettlement"
FOR EACH ROW EXECUTE FUNCTION "reject_approved_settlement_change"();

-- One settlement in progress or approved per employee.
CREATE UNIQUE INDEX "FinalSettlement_one_open_key" ON "FinalSettlement"("userId") WHERE "status" IN ('DRAFT', 'APPROVED');

-- ------------------------------------------------------------ Leave types of the labour law

INSERT INTO "LeaveType" ("id", "code", "name", "kind", "paid", "maxDaysPerYear", "maxDaysPerRequest", "oncePerService", "requiresAttachment", "gender", "minServiceMonths", "isSystem", "sortOrder") VALUES
  ('leave-annual',      'ANNUAL',      'إجازة سنوية',        'ANNUAL', true,  NULL, NULL, false, false, NULL,     0,  true,  1),
  ('leave-sick',        'SICK',        'إجازة مرضية',        'SICK',   true,  NULL, NULL, false, true,  NULL,     0,  true,  2),
  ('leave-unpaid',      'UNPAID',      'إجازة بدون راتب',    'UNPAID', false, NULL, NULL, false, false, NULL,     0,  true,  3),
  ('leave-emergency',   'EMERGENCY',   'إجازة اضطرارية',     'OTHER',  true,  5,    3,    false, false, NULL,     0,  false, 4),
  ('leave-hajj',        'HAJJ',        'إجازة الحج',         'OTHER',  true,  NULL, 15,   true,  false, NULL,     24, false, 5),
  ('leave-marriage',    'MARRIAGE',    'إجازة زواج',         'OTHER',  true,  NULL, 5,    false, true,  NULL,     0,  false, 6),
  ('leave-bereavement', 'BEREAVEMENT', 'إجازة وفاة قريب',    'OTHER',  true,  NULL, 5,    false, false, NULL,     0,  false, 7),
  ('leave-paternity',   'PATERNITY',   'إجازة مولود',        'OTHER',  true,  NULL, 3,    false, true,  'MALE',   0,  false, 8),
  ('leave-maternity',   'MATERNITY',   'إجازة وضع',          'OTHER',  true,  NULL, 84,   false, true,  'FEMALE', 0,  false, 9),
  ('leave-exam',        'EXAM',        'إجازة امتحانات',     'OTHER',  true,  NULL, NULL, false, true,  NULL,     0,  false, 10);

-- ------------------------------------------------------------ Who gets the new permissions

-- Accountants already run the money; they now also prepare and pay salaries. Approving a payroll stays with management.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['hr.view', 'hr.salaries', 'hr.all_branches', 'payroll.prepare', 'payroll.pay', 'deductions.manage'])
  WHERE "id" = 'rank-accountant' AND NOT 'hr.view' = ANY("permissions");

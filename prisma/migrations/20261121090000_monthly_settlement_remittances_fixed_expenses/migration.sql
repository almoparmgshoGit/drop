-- The monthly settlement (التصفية الشهرية): cash remittances to the owner, fixed expenses with their monthly postings
-- and payments, the owner's final approval of a month, and a manual marketer-commission expense category.

-- CreateEnum
CREATE TYPE "RemittanceMethod" AS ENUM ('BANK_DEPOSIT', 'CASH_HANDOVER');

-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('PENDING', 'RECEIVED', 'MATCHED', 'DIFFERENCE', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FixedExpenseCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'VARIABLE');

-- CreateEnum
CREATE TYPE "FixedPaymentSource" AS ENUM ('BANK_TRANSFER', 'BRANCH_CASH', 'OWNER_PERSONAL');

-- AlterEnum

ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_PAYMENT';
ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_REVERSAL';
ALTER TYPE "CashMovementType" ADD VALUE 'REMITTANCE_OUT';
ALTER TYPE "CashMovementType" ADD VALUE 'REMITTANCE_RETURN';

-- AlterEnum
ALTER TYPE "GeneralExpenseCategory" ADD VALUE 'MARKETER_COMMISSION';

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "fixedPaymentId" TEXT,
ADD COLUMN     "remittanceId" TEXT;

-- CreateTable
CREATE TABLE "MonthSettlementApproval" (
    "id" TEXT NOT NULL,
    "closingId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthSettlementApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashRemittance" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "branchId" TEXT NOT NULL,
    "method" "RemittanceMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "status" "RemittanceStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAmount" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedVia" TEXT,
    "confirmedById" TEXT,
    "confirmedByName" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "justification" TEXT,
    "justifiedByName" TEXT,
    "justifiedAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "CashRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemittedSession" (
    "sessionId" TEXT NOT NULL,
    "remittanceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "RemittedSession_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "CashRemittanceAttachment" (
    "id" TEXT NOT NULL,
    "remittanceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashRemittanceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedExpense" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "category" "GeneralExpenseCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "branchId" TEXT,
    "allBranches" BOOLEAN NOT NULL DEFAULT false,
    "lessorName" TEXT,
    "lessorPhone" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "cycle" "FixedExpenseCycle" NOT NULL,
    "dueDay" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" DATE,
    "stoppedByName" TEXT,
    "stopReason" TEXT,

    CONSTRAINT "FixedExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedExpensePosting" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedExpensePosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedExpensePayment" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "expenseId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "source" "FixedPaymentSource" NOT NULL,
    "branchId" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedByName" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "FixedExpensePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedExpenseAttachment" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT,
    "paymentId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedExpenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthSettlementApproval_closingId_key" ON "MonthSettlementApproval"("closingId");

-- CreateIndex
CREATE INDEX "MonthSettlementApproval_month_idx" ON "MonthSettlementApproval"("month");

-- CreateIndex
CREATE UNIQUE INDEX "CashRemittance_number_key" ON "CashRemittance"("number");

-- CreateIndex
CREATE UNIQUE INDEX "CashRemittance_idempotencyKey_key" ON "CashRemittance"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashRemittance_branchId_createdAt_idx" ON "CashRemittance"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "CashRemittance_status_idx" ON "CashRemittance"("status");

-- CreateIndex
CREATE INDEX "RemittedSession_remittanceId_idx" ON "RemittedSession"("remittanceId");

-- CreateIndex
CREATE INDEX "CashRemittanceAttachment_remittanceId_idx" ON "CashRemittanceAttachment"("remittanceId");

-- CreateIndex
CREATE UNIQUE INDEX "FixedExpense_number_key" ON "FixedExpense"("number");

-- CreateIndex
CREATE INDEX "FixedExpense_branchId_idx" ON "FixedExpense"("branchId");

-- CreateIndex
CREATE INDEX "FixedExpensePosting_month_idx" ON "FixedExpensePosting"("month");

-- CreateIndex
CREATE UNIQUE INDEX "FixedExpensePosting_expenseId_month_key" ON "FixedExpensePosting"("expenseId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "FixedExpensePayment_number_key" ON "FixedExpensePayment"("number");

-- CreateIndex
CREATE UNIQUE INDEX "FixedExpensePayment_idempotencyKey_key" ON "FixedExpensePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "FixedExpensePayment_expenseId_period_idx" ON "FixedExpensePayment"("expenseId", "period");

-- CreateIndex
CREATE INDEX "FixedExpensePayment_paidOn_idx" ON "FixedExpensePayment"("paidOn");

-- CreateIndex
CREATE INDEX "FixedExpenseAttachment_expenseId_idx" ON "FixedExpenseAttachment"("expenseId");

-- CreateIndex
CREATE INDEX "FixedExpenseAttachment_paymentId_idx" ON "FixedExpenseAttachment"("paymentId");

-- AddForeignKey
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemittedSession" ADD CONSTRAINT "RemittedSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemittedSession" ADD CONSTRAINT "RemittedSession_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CashRemittance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRemittanceAttachment" ADD CONSTRAINT "CashRemittanceAttachment_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CashRemittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpensePosting" ADD CONSTRAINT "FixedExpensePosting_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "FixedExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpensePayment" ADD CONSTRAINT "FixedExpensePayment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "FixedExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpensePayment" ADD CONSTRAINT "FixedExpensePayment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpenseAttachment" ADD CONSTRAINT "FixedExpenseAttachment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "FixedExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedExpenseAttachment" ADD CONSTRAINT "FixedExpenseAttachment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "FixedExpensePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Amounts are always positive; a due day stays inside every month.
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_dueDay_range" CHECK ("dueDay" BETWEEN 1 AND 28);
ALTER TABLE "FixedExpensePayment" ADD CONSTRAINT "FixedExpensePayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "FixedExpensePosting" ADD CONSTRAINT "FixedExpensePosting_amount_positive" CHECK ("amount" > 0);

-- A month's posting is written once: changing or deleting it would rewrite a month's profit after the fact.
CREATE FUNCTION "guard_fixed_expense_posting"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FixedExpensePosting is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FixedExpensePosting_guard"
BEFORE UPDATE OR DELETE ON "FixedExpensePosting"
FOR EACH ROW EXECUTE FUNCTION "guard_fixed_expense_posting"();

-- A payment is never deleted and its figures never change; it can only be voided, once.
CREATE FUNCTION "guard_fixed_expense_payment"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FixedExpensePayment cannot be deleted';
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL
     OR NEW."expenseId" IS DISTINCT FROM OLD."expenseId"
     OR NEW."period" IS DISTINCT FROM OLD."period"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A FixedExpensePayment can only be voided';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FixedExpensePayment_guard"
BEFORE UPDATE OR DELETE ON "FixedExpensePayment"
FOR EACH ROW EXECUTE FUNCTION "guard_fixed_expense_payment"();

-- A remittance is never deleted, and what was declared never changes after it was sent to the owner.
CREATE FUNCTION "guard_cash_remittance"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CashRemittance cannot be deleted';
  END IF;
  IF NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."fromDate" IS DISTINCT FROM OLD."fromDate"
     OR NEW."toDate" IS DISTINCT FROM OLD."toDate"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'What a CashRemittance declared cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashRemittance_guard"
BEFORE UPDATE OR DELETE ON "CashRemittance"
FOR EACH ROW EXECUTE FUNCTION "guard_cash_remittance"();

-- Company expenses outside the trips (premises rent, utilities, supplies) and approved closings of the accounts.
CREATE TYPE "GeneralExpenseCategory" AS ENUM ('OFFICE_RENT', 'UTILITIES', 'TELECOM', 'SUPPLIES', 'MAINTENANCE', 'GOVERNMENT', 'MARKETING', 'HOSPITALITY', 'OTHER');
CREATE TYPE "ClosingKind" AS ENUM ('TRIPS', 'EMPLOYEES', 'COMPREHENSIVE');
CREATE TYPE "ClosingPeriod" AS ENUM ('TRIP', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM');

CREATE TABLE "GeneralExpense" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "category" "GeneralExpenseCategory" NOT NULL,
    "branchId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "vat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hasTaxInvoice" BOOLEAN NOT NULL DEFAULT false,
    "method" "CollectionMethod" NOT NULL DEFAULT 'CASH',
    "supplierName" TEXT,
    "description" TEXT NOT NULL,
    "notes" TEXT,
    "spentOn" DATE NOT NULL,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedByName" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "GeneralExpense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GeneralExpense_amount_positive" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "GeneralExpense_number_key" ON "GeneralExpense"("number");
CREATE UNIQUE INDEX "GeneralExpense_idempotencyKey_key" ON "GeneralExpense"("idempotencyKey");
CREATE INDEX "GeneralExpense_spentOn_idx" ON "GeneralExpense"("spentOn");
CREATE INDEX "GeneralExpense_branchId_spentOn_idx" ON "GeneralExpense"("branchId", "spentOn");
ALTER TABLE "GeneralExpense" ADD CONSTRAINT "GeneralExpense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GeneralExpenseAttachment" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneralExpenseAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GeneralExpenseAttachment_expenseId_idx" ON "GeneralExpenseAttachment"("expenseId");
ALTER TABLE "GeneralExpenseAttachment" ADD CONSTRAINT "GeneralExpenseAttachment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "GeneralExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AccountClosing" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" "ClosingKind" NOT NULL,
    "period" "ClosingPeriod" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "tripId" TEXT,
    "label" TEXT NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "expenses" DECIMAL(14,2) NOT NULL,
    "net" DECIMAL(14,2) NOT NULL,
    "report" JSONB NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedByName" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "AccountClosing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AccountClosing_number_key" ON "AccountClosing"("number");
CREATE INDEX "AccountClosing_kind_fromDate_idx" ON "AccountClosing"("kind", "fromDate");
CREATE INDEX "AccountClosing_tripId_idx" ON "AccountClosing"("tripId");
-- One standing closing per kind and period (or trip): approving the same period again needs the old one voided first.
CREATE UNIQUE INDEX "AccountClosing_standing_key" ON "AccountClosing"("kind", "period", "fromDate", "toDate", COALESCE("tripId", '')) WHERE "voidedAt" IS NULL;

-- An approved closing is final: its figures cannot change and it cannot be deleted; it can only be voided, once.
CREATE FUNCTION "guard_account_closing"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AccountClosing cannot be deleted';
  END IF;
  IF OLD."voidedAt" IS NOT NULL
     OR NEW."voidedAt" IS NULL
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."period" IS DISTINCT FROM OLD."period"
     OR NEW."fromDate" IS DISTINCT FROM OLD."fromDate"
     OR NEW."toDate" IS DISTINCT FROM OLD."toDate"
     OR NEW."tripId" IS DISTINCT FROM OLD."tripId"
     OR NEW."label" IS DISTINCT FROM OLD."label"
     OR NEW."revenue" IS DISTINCT FROM OLD."revenue"
     OR NEW."expenses" IS DISTINCT FROM OLD."expenses"
     OR NEW."net" IS DISTINCT FROM OLD."net"
     OR NEW."report" IS DISTINCT FROM OLD."report"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'An approved AccountClosing can only be voided';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountClosing_guard"
BEFORE UPDATE OR DELETE ON "AccountClosing"
FOR EACH ROW EXECUTE FUNCTION "guard_account_closing"();

-- CreateTable
CREATE TABLE "CustodyExpense" (
    "id" TEXT NOT NULL,
    "custodyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "vat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hasTaxInvoice" BOOLEAN NOT NULL DEFAULT false,
    "supplierName" TEXT NOT NULL,
    "notes" TEXT,
    "spentOn" DATE NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedByName" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "CustodyExpense_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CustodyAttachment" ADD COLUMN     "expenseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CustodyExpense_idempotencyKey_key" ON "CustodyExpense"("idempotencyKey");
CREATE INDEX "CustodyExpense_custodyId_idx" ON "CustodyExpense"("custodyId");
CREATE INDEX "CustodyExpense_spentOn_idx" ON "CustodyExpense"("spentOn");
CREATE INDEX "CustodyAttachment_expenseId_idx" ON "CustodyAttachment"("expenseId");

-- AddForeignKey
ALTER TABLE "CustodyExpense" ADD CONSTRAINT "CustodyExpense_custodyId_fkey" FOREIGN KEY ("custodyId") REFERENCES "Custody"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustodyExpense" ADD CONSTRAINT "CustodyExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AccountCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustodyAttachment" ADD CONSTRAINT "CustodyAttachment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "CustodyExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustodyExpense" ADD CONSTRAINT "CustodyExpense_amount_positive" CHECK ("amount" > 0);

-- Whoever works trips from the app can hold a custody for them.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'crew.custody')
  WHERE 'crew.trips' = ANY("permissions") AND NOT 'crew.custody' = ANY("permissions");

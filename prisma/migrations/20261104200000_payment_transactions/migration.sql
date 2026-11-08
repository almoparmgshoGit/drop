-- CreateEnum
CREATE TYPE "PaymentTransactionType" AS ENUM ('CHARGE', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundDestination" AS ENUM ('WALLET', 'ORIGINAL');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "externalRefunded" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "type" "PaymentTransactionType" NOT NULL,
    "status" "PaymentTransactionStatus" NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT,
    "destination" "RefundDestination",
    "branchId" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "gatewayReference" TEXT,
    "failureReason" TEXT,
    "processedById" TEXT,
    "processedByName" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_number_key" ON "PaymentTransaction"("number");

-- CreateIndex
CREATE INDEX "PaymentTransaction_createdAt_idx" ON "PaymentTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_bookingId_idx" ON "PaymentTransaction"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_type_status_idx" ON "PaymentTransaction"("type", "status");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Past online payments and wallet refunds, in the order they happened, so the register starts complete.
INSERT INTO "PaymentTransaction" ("id", "type", "status", "bookingId", "amount", "method", "destination", "simulated", "processedAt", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text)::uuid::text, "kind"::"PaymentTransactionType", 'SUCCEEDED', "bookingId", "amount", "method", "goesTo"::"RefundDestination", "simulated", "at", "at"
FROM (
  SELECT 'CHARGE' AS "kind", p."bookingId", p."amount", p."method", NULL AS "goesTo", p."status" = 'SIMULATED' AS "simulated", p."createdAt" AS "at"
  FROM "Payment" p
  WHERE p."status" IN ('COMPLETED', 'SIMULATED') AND p."amount" > 0 AND p."method" IN ('mada', 'card')
  UNION ALL
  SELECT 'REFUND', b."id", b."refundAmount", 'wallet_balance', 'WALLET', false, COALESCE(b."cancelReviewedAt", b."updatedAt")
  FROM "Booking" b
  WHERE b."refundAmount" > 0
  ORDER BY "at"
) past;

-- Only a refund still in progress can change; once settled a row is a financial record.
CREATE FUNCTION "reject_settled_transaction_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'A settled payment transaction cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentTransaction_settled_frozen"
BEFORE UPDATE OR DELETE ON "PaymentTransaction"
FOR EACH ROW EXECUTE FUNCTION "reject_settled_transaction_change"();

-- Accountants already handle refunds; everyone else keeps exactly the access they had.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['payments.view', 'refunds.execute'])
  WHERE "id" = 'rank-accountant' AND NOT 'payments.view' = ANY("permissions");

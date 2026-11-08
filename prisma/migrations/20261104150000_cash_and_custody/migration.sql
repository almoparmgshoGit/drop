-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('BOOKING_RECEIPT', 'BOOKING_REFUND', 'CUSTODY_ISSUE', 'CUSTODY_RETURN');

-- CreateEnum
CREATE TYPE "CustodyStatus" AS ENUM ('OPEN', 'SETTLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "branchId" TEXT;

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "businessDate" DATE NOT NULL,
    "openingBalance" DECIMAL(12,2) NOT NULL,
    "carriedBalance" DECIMAL(12,2),
    "openingNote" TEXT,
    "openedById" TEXT NOT NULL,
    "openedByName" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedBalance" DECIMAL(12,2),
    "countedCash" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "closeNote" TEXT,
    "closedById" TEXT,
    "closedByName" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "custodyId" TEXT,
    "bookingId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Custody" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "branchId" TEXT NOT NULL,
    "issuedSessionId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "recipientName" TEXT,
    "recipientJob" TEXT,
    "purpose" TEXT NOT NULL,
    "tripId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "CustodyStatus" NOT NULL DEFAULT 'OPEN',
    "spentAmount" DECIMAL(12,2),
    "returnedAmount" DECIMAL(12,2),
    "settlementNote" TEXT,
    "idempotencyKey" TEXT,
    "issuedById" TEXT NOT NULL,
    "issuedByName" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledById" TEXT,
    "settledByName" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Custody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyAttachment" (
    "id" TEXT NOT NULL,
    "custodyId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");

-- CreateIndex
CREATE INDEX "CashSession_branchId_openedAt_idx" ON "CashSession"("branchId", "openedAt");

-- CreateIndex
CREATE INDEX "CashMovement_sessionId_type_idx" ON "CashMovement"("sessionId", "type");

-- CreateIndex
CREATE INDEX "CashMovement_custodyId_idx" ON "CashMovement"("custodyId");

-- CreateIndex
CREATE INDEX "CashMovement_bookingId_idx" ON "CashMovement"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Custody_number_key" ON "Custody"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Custody_idempotencyKey_key" ON "Custody"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Custody_branchId_status_idx" ON "Custody"("branchId", "status");

-- CreateIndex
CREATE INDEX "Custody_branchId_issuedAt_idx" ON "Custody"("branchId", "issuedAt");

-- CreateIndex
CREATE INDEX "Custody_branchId_settledAt_idx" ON "Custody"("branchId", "settledAt");

-- CreateIndex
CREATE INDEX "Custody_recipientId_idx" ON "Custody"("recipientId");

-- CreateIndex
CREATE INDEX "Custody_tripId_idx" ON "Custody"("tripId");

-- CreateIndex
CREATE INDEX "CustodyAttachment_custodyId_idx" ON "CustodyAttachment"("custodyId");

-- CreateIndex
CREATE INDEX "User_branchId_idx" ON "User"("branchId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_custodyId_fkey" FOREIGN KEY ("custodyId") REFERENCES "Custody"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_issuedSessionId_fkey" FOREIGN KEY ("issuedSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyAttachment" ADD CONSTRAINT "CustodyAttachment_custodyId_fkey" FOREIGN KEY ("custodyId") REFERENCES "Custody"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Prisma cannot express these, and they are the last line of defence if application code ever gets a check wrong.
CREATE UNIQUE INDEX "CashSession_one_open_per_branch" ON "CashSession"("branchId") WHERE "status" = 'OPEN';

ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_opening_not_negative" CHECK ("openingBalance" >= 0);
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closed_is_complete" CHECK (
  "status" = 'OPEN' OR ("expectedBalance" IS NOT NULL AND "countedCash" IS NOT NULL AND "closedAt" IS NOT NULL AND "difference" = "countedCash" - "expectedBalance")
);
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_settlement_adds_up" CHECK (
  "status" = 'OPEN' OR ("spentAmount" >= 0 AND "returnedAmount" >= 0 AND "spentAmount" + "returnedAmount" = "amount")
);

CREATE FUNCTION "reject_cash_movement_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CashMovement is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashMovement_append_only"
BEFORE UPDATE OR DELETE ON "CashMovement"
FOR EACH ROW EXECUTE FUNCTION "reject_cash_movement_change"();

CREATE FUNCTION "reject_movement_on_closed_session"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "status" FROM "CashSession" WHERE "id" = NEW."sessionId") = 'CLOSED' THEN
    RAISE EXCEPTION 'CashSession is closed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashMovement_session_open"
BEFORE INSERT ON "CashMovement"
FOR EACH ROW EXECUTE FUNCTION "reject_movement_on_closed_session"();

CREATE FUNCTION "reject_closed_cash_session_change"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed CashSession cannot change';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CashSession cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashSession_closed_frozen"
BEFORE UPDATE OR DELETE ON "CashSession"
FOR EACH ROW EXECUTE FUNCTION "reject_closed_cash_session_change"();

-- Accountants already handle refunds and supplier payments; everyone else keeps exactly the access they had.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['cash.view', 'cash.operate', 'cash.all_branches', 'custody.issue', 'custody.settle', 'branches.manage'])
  WHERE "id" = 'rank-accountant' AND NOT 'cash.view' = ANY("permissions");

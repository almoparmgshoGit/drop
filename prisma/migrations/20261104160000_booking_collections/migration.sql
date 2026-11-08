-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('CASH', 'NETWORK', 'TRANSFER');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "followUpNote" TEXT;

-- CreateTable
CREATE TABLE "BookingCollection" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "method" "CollectionMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "branchId" TEXT,
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingCollection_idempotencyKey_key" ON "BookingCollection"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BookingCollection_bookingId_idx" ON "BookingCollection"("bookingId");

-- CreateIndex
CREATE INDEX "BookingCollection_branchId_createdAt_idx" ON "BookingCollection"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_branchId_idx" ON "Booking"("branchId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "BookingCollection" ADD CONSTRAINT "BookingCollection_amount_positive" CHECK ("amount" > 0);

CREATE FUNCTION "reject_booking_collection_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BookingCollection is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BookingCollection_append_only"
BEFORE UPDATE OR DELETE ON "BookingCollection"
FOR EACH ROW EXECUTE FUNCTION "reject_booking_collection_change"();

-- Accountants already hold the drawer; everyone else keeps exactly the access they had.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['collections.view', 'collections.collect'])
  WHERE "id" = 'rank-accountant' AND NOT 'collections.view' = ANY("permissions");

-- Each trip account line now says whose account it is posted to (bus company, hotel or the office) and whether it is paid,
-- due at the month's end, or a prepayment to be offset. Existing lines keep their meaning: all paid, posted to the office,
-- except an expense whose supplier is a hotel booked on that same trip, which is posted to that hotel. Both still count in the net.

-- CreateEnum
CREATE TYPE "AccountParty" AS ENUM ('BUS_COMPANY', 'HOTEL', 'OFFICE');
CREATE TYPE "EntrySettlement" AS ENUM ('PAID', 'DUE_MONTH_END', 'PREPAID');

-- AlterTable
ALTER TABLE "TripAccountEntry"
    ADD COLUMN "chargedTo" "AccountParty" NOT NULL DEFAULT 'OFFICE',
    ADD COLUMN "settlement" "EntrySettlement" NOT NULL DEFAULT 'PAID',
    ADD COLUMN "settledAt" TIMESTAMP(3),
    ADD COLUMN "settledByName" TEXT;

-- Everything recorded so far was paid when it was entered.
UPDATE "TripAccountEntry" SET "settledAt" = "createdAt";

UPDATE "TripAccountEntry" e
SET "chargedTo" = 'HOTEL'
FROM "AccountCategory" c
WHERE c."id" = e."categoryId"
  AND c."group" <> 'INCOME'
  AND e."supplierName" IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM "HotelBooking" b
      JOIN "Hotel" h ON h."id" = b."hotelId"
      WHERE b."tripId" = e."tripId"
        AND b."status" = 'CONFIRMED'
        AND lower(btrim(h."name")) = lower(btrim(e."supplierName"))
  );

-- CreateIndex
CREATE INDEX "TripAccountEntry_settlement_idx" ON "TripAccountEntry"("settlement");

-- A closed journey's profit posted to the branches, once, with adjustments for later changes.
CREATE TYPE "TripPostingKind" AS ENUM ('CLOSE', 'ADJUSTMENT');

CREATE TABLE "TripProfitPosting" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "columnKey" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "kind" "TripPostingKind" NOT NULL,
    "revenue" DECIMAL(12,2) NOT NULL,
    "costs" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByName" TEXT,
    CONSTRAINT "TripProfitPosting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TripProfitPosting_postedAt_idx" ON "TripProfitPosting"("postedAt");
CREATE INDEX "TripProfitPosting_tripId_idx" ON "TripProfitPosting"("tripId");
CREATE INDEX "TripProfitPosting_columnKey_postedAt_idx" ON "TripProfitPosting"("columnKey", "postedAt");

ALTER TABLE "TripProfitPosting" ADD CONSTRAINT "TripProfitPosting_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

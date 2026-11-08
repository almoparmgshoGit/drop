-- CreateEnum
CREATE TYPE "TripReportType" AS ENUM ('DELAY', 'BREAKDOWN', 'ACCIDENT', 'PASSENGER', 'OTHER');

-- CreateTable
CREATE TABLE "TripReport" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "type" "TripReportType" NOT NULL,
    "details" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripReport_tripId_idx" ON "TripReport"("tripId");

-- CreateIndex
CREATE INDEX "TripReport_createdAt_idx" ON "TripReport"("createdAt");

-- AddForeignKey
ALTER TABLE "TripReport" ADD CONSTRAINT "TripReport_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Crew who can already read a trip's manifest keep working: they also get the new permission to notify its passengers.
UPDATE "Rank"
SET "permissions" = array_append("permissions", 'crew.notify')
WHERE 'crew.manifest' = ANY("permissions") AND NOT ('crew.notify' = ANY("permissions"));

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "crewOpensBeforeMinutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "boardingOpensBeforeMinutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "boardingClosesAfterMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "crewOpenAnnouncedAt" TIMESTAMP(3),
ADD COLUMN     "boardingOpenAnnouncedAt" TIMESTAMP(3),
ADD COLUMN     "boardingCloseAnnouncedAt" TIMESTAMP(3);

-- Trips that already ended have nothing left to announce.
UPDATE "Trip"
SET "crewOpenAnnouncedAt" = CURRENT_TIMESTAMP,
    "boardingOpenAnnouncedAt" = CURRENT_TIMESTAMP,
    "boardingCloseAnnouncedAt" = CURRENT_TIMESTAMP
WHERE "tripStatus" <> 'PUBLISHED' OR "departureTime" < CURRENT_TIMESTAMP;

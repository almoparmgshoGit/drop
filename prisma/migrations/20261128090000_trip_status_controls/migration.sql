-- Trip status controls: why a trip is stopped, closing it to new bookings, and its delay.
CREATE TYPE "TripStopReason" AS ENUM ('OFFICE', 'BREAKDOWN', 'EMERGENCY');

ALTER TABLE "Trip"
  ADD COLUMN IF NOT EXISTS "stopReason" "TripStopReason",
  ADD COLUMN IF NOT EXISTS "stopNote" TEXT,
  ADD COLUMN IF NOT EXISTS "salesClosedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "salesClosedByName" TEXT,
  ADD COLUMN IF NOT EXISTS "originalDepartureTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "delayReason" TEXT;

-- Trips stopped before reasons existed were stopped by the office.
UPDATE "Trip" SET "stopReason" = 'OFFICE' WHERE "liveStatus" = 'STOPPED' AND "stopReason" IS NULL;

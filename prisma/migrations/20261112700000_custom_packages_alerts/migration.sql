-- Customer-built packages, passenger gender and nationality, and repeating reminders before the miqat and gathering point.
CREATE TYPE "PackageKind" AS ENUM ('FIXED', 'CUSTOM');

ALTER TABLE "Package" ADD COLUMN "kind" "PackageKind" NOT NULL DEFAULT 'FIXED',
ADD COLUMN "origin" TEXT,
ADD COLUMN "destination" TEXT,
ADD COLUMN "hotelId" TEXT,
ADD COLUMN "nightlyBedPrice" DECIMAL(10,2),
ADD COLUMN "nightlyRoomPrice" DECIMAL(10,2),
ADD COLUMN "minDepartureHour" INTEGER NOT NULL DEFAULT 17;
ALTER TABLE "Package" ADD CONSTRAINT "Package_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Booking" ADD COLUMN "customPackageId" TEXT;
CREATE INDEX "Booking_customPackageId_idx" ON "Booking"("customPackageId");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customPackageId_fkey" FOREIGN KEY ("customPackageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingPassenger" ADD COLUMN "gender" "Gender",
ADD COLUMN "nationality" TEXT;

ALTER TABLE "User" ADD COLUMN "tripAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "alertLeadMinutes" INTEGER,
ADD COLUMN "alertRepeatMinutes" INTEGER;

ALTER TABLE "Trip" ADD COLUMN "alertLeadMinutes" INTEGER,
ADD COLUMN "alertRepeatMinutes" INTEGER;

CREATE TABLE "TripReminderLog" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripReminderLog_pkey" PRIMARY KEY ("key")
);

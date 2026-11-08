-- Fixed trips repeat yearly on the calendar the employee picks.
CREATE TYPE "TripScheduleType" AS ENUM ('TEMPORARY', 'FIXED');
CREATE TYPE "TripCalendar" AS ENUM ('HIJRI', 'GREGORIAN');
ALTER TABLE "Trip"
  ADD COLUMN "scheduleType" "TripScheduleType" NOT NULL DEFAULT 'TEMPORARY',
  ADD COLUMN "recurrenceCalendar" "TripCalendar",
  ADD COLUMN "recurrenceDoneAt" TIMESTAMP(3);

-- Hotels state what customers may choose and what the rate is charged on, instead of holding a room count.
CREATE TYPE "HotelRateUnit" AS ENUM ('ROOM', 'BED');
ALTER TABLE "Hotel"
  ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "offersSharedRoom" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "offersPrivateRoom" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "rateUnit" "HotelRateUnit" NOT NULL DEFAULT 'ROOM';
UPDATE "Hotel" SET "offersSharedRoom" = "allowsSharing";
ALTER TABLE "Hotel" DROP COLUMN "roomCount", DROP COLUMN "roomCapacity", DROP COLUMN "allowsSharing";

ALTER TABLE "HotelBooking" ADD COLUMN "rateUnit" "HotelRateUnit" NOT NULL DEFAULT 'ROOM';

-- The customer now states a room type; staff place them in rooms afterwards.
ALTER TABLE "Booking" ADD COLUMN "roomChoice" "RoomType";

-- Pre-made stock nobody sleeps in has no meaning any more. Rooms with guests stay as they are.
DELETE FROM "HotelRoom" r
WHERE r."fromInventory" = true
  AND NOT EXISTS (SELECT 1 FROM "BookingPassenger" p WHERE p."hotelRoomId" = r."id");
ALTER TABLE "HotelRoom" DROP COLUMN "fromInventory", DROP COLUMN "sharedCategory";

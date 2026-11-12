-- The office sends the passenger manifest to the crew, and a private room is charged once per booking, to its owner.

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "manifestSentAt" TIMESTAMP(3),
ADD COLUMN "manifestSentByName" TEXT;

-- AlterTable
ALTER TABLE "BookingPassenger" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Hotel" ALTER COLUMN "privateRoomPriceBasis" SET DEFAULT 'PER_BOOKING';
ALTER TABLE "Trip" ALTER COLUMN "privateRoomPriceBasis" SET DEFAULT 'PER_BOOKING';

-- A private room is now always one price per booking.
UPDATE "Hotel" SET "privateRoomPriceBasis" = 'PER_BOOKING';
UPDATE "Trip" SET "privateRoomPriceBasis" = 'PER_BOOKING';

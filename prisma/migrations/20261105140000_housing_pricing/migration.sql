-- CreateEnum
CREATE TYPE "HousingPriceMode" AS ENUM ('ADDED_TO_BASE', 'INCLUDED_IN_BASE');

-- CreateEnum
CREATE TYPE "PrivateRoomPriceBasis" AS ENUM ('PER_ROOM', 'PER_PERSON', 'PER_BOOKING');

-- CreateEnum
CREATE TYPE "HousingPricePeriod" AS ENUM ('PER_STAY', 'PER_NIGHT');

-- AlterTable: trips keep charging exactly what they charge today, because housing stays included in the base price.
ALTER TABLE "Trip"
  ADD COLUMN "privateRoomPrice" DECIMAL(10,2),
  ADD COLUMN "privateRoomCapacity" INTEGER,
  ADD COLUMN "housingPriceMode" "HousingPriceMode" NOT NULL DEFAULT 'INCLUDED_IN_BASE',
  ADD COLUMN "privateRoomPriceBasis" "PrivateRoomPriceBasis" NOT NULL DEFAULT 'PER_ROOM',
  ADD COLUMN "housingPricePeriod" "HousingPricePeriod" NOT NULL DEFAULT 'PER_STAY';

-- AlterTable
ALTER TABLE "Hotel"
  ADD COLUMN "bedPrice" DECIMAL(10,2),
  ADD COLUMN "privateRoomPrice" DECIMAL(10,2),
  ADD COLUMN "privateRoomCapacity" INTEGER,
  ADD COLUMN "housingPriceMode" "HousingPriceMode" NOT NULL DEFAULT 'INCLUDED_IN_BASE',
  ADD COLUMN "privateRoomPriceBasis" "PrivateRoomPriceBasis" NOT NULL DEFAULT 'PER_ROOM',
  ADD COLUMN "housingPricePeriod" "HousingPricePeriod" NOT NULL DEFAULT 'PER_STAY';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "housingAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

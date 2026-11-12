-- Vans and minibuses with their own seat count, and trips that repeat on chosen weekdays.

-- CreateEnum
CREATE TYPE "VehicleKind" AS ENUM ('BUS', 'VAN', 'MINIBUS');

-- AlterTable
ALTER TABLE "Bus" ADD COLUMN "kind" "VehicleKind" NOT NULL DEFAULT 'BUS',
ADD COLUMN "seatCount" INTEGER NOT NULL DEFAULT 49;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "repeatWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "repeatUntil" TIMESTAMP(3),
ADD COLUMN "seriesId" TEXT,
ADD COLUMN "seatLayout" JSONB;

-- CreateIndex
CREATE INDEX "Trip_seriesId_idx" ON "Trip"("seriesId");

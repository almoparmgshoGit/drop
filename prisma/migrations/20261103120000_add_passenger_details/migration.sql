-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('SHARED', 'PRIVATE');

-- AlterTable
ALTER TABLE "BookingPassenger" ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "roomLabel" TEXT,
ADD COLUMN     "roomType" "RoomType";


-- CreateEnum
CREATE TYPE "HotelRoomBlockType" AS ENUM ('MAINTENANCE', 'OUT_OF_SERVICE');

-- AlterTable
ALTER TABLE "HotelComplaint" ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "submittedByTraveler" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HotelRoomBlock" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "type" "HotelRoomBlockType" NOT NULL,
    "fromDate" DATE NOT NULL,
    "untilDate" DATE,
    "notes" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelRoomBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotelRoomBlock_hotelId_roomNumber_idx" ON "HotelRoomBlock"("hotelId", "roomNumber");

-- CreateIndex
CREATE INDEX "HotelComplaint_bookingId_idx" ON "HotelComplaint"("bookingId");

-- AddForeignKey
ALTER TABLE "HotelComplaint" ADD CONSTRAINT "HotelComplaint_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelRoomBlock" ADD CONSTRAINT "HotelRoomBlock_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

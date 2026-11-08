-- CreateEnum
CREATE TYPE "HotelBookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- AlterTable
ALTER TABLE "BookingPassenger" DROP COLUMN "roomLabel",
DROP COLUMN "roomType",
ADD COLUMN     "hotelRoomId" TEXT,
ADD COLUMN     "roomNote" TEXT;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "busRentalPrice" DECIMAL(10,2),
ADD COLUMN     "housingPrice" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "address" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelBooking" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "tripId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "extraCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "supplierReference" TEXT,
    "mealPlan" TEXT,
    "notes" TEXT,
    "status" "HotelBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelRoom" (
    "id" TEXT NOT NULL,
    "hotelBookingId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "RoomType" NOT NULL DEFAULT 'SHARED',
    "capacity" INTEGER NOT NULL DEFAULT 4,

    CONSTRAINT "HotelRoom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Hotel_name_key" ON "Hotel"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HotelBooking_number_key" ON "HotelBooking"("number");

-- CreateIndex
CREATE INDEX "HotelBooking_hotelId_idx" ON "HotelBooking"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "HotelBooking_tripId_hotelId_key" ON "HotelBooking"("tripId", "hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "HotelRoom_hotelBookingId_number_key" ON "HotelRoom"("hotelBookingId", "number");

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_hotelRoomId_fkey" FOREIGN KEY ("hotelRoomId") REFERENCES "HotelRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelBooking" ADD CONSTRAINT "HotelBooking_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelBooking" ADD CONSTRAINT "HotelBooking_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelRoom" ADD CONSTRAINT "HotelRoom_hotelBookingId_fkey" FOREIGN KEY ("hotelBookingId") REFERENCES "HotelBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;


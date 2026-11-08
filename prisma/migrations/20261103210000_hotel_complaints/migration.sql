-- CreateEnum
CREATE TYPE "HotelComplaintSource" AS ENUM ('TRAVELER', 'HOTEL');

-- CreateEnum
CREATE TYPE "HotelComplaintStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "HotelComplaint" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "hotelId" TEXT NOT NULL,
    "source" "HotelComplaintSource" NOT NULL,
    "status" "HotelComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "hotelBookingId" TEXT,
    "passengerId" TEXT,
    "travelerName" TEXT,
    "roomNumber" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByName" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelComplaint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelComplaint_number_key" ON "HotelComplaint"("number");

-- CreateIndex
CREATE INDEX "HotelComplaint_hotelId_status_idx" ON "HotelComplaint"("hotelId", "status");

-- CreateIndex
CREATE INDEX "HotelComplaint_passengerId_idx" ON "HotelComplaint"("passengerId");

-- AddForeignKey
ALTER TABLE "HotelComplaint" ADD CONSTRAINT "HotelComplaint_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelComplaint" ADD CONSTRAINT "HotelComplaint_hotelBookingId_fkey" FOREIGN KEY ("hotelBookingId") REFERENCES "HotelBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelComplaint" ADD CONSTRAINT "HotelComplaint_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "BookingPassenger"("id") ON DELETE SET NULL ON UPDATE CASCADE;


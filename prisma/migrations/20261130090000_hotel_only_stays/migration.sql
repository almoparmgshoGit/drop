-- Hotel-only stays ("سكن فقط"): a customer books a hotel from the app with no trip, then rates it after check-out. Hotels get a star class.
-- CreateEnum
CREATE TYPE "StayBookingStatus" AS ENUM ('CONFIRMED', 'CANCEL_REQUESTED', 'CANCELLED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "stars" INTEGER;

-- CreateTable
CREATE TABLE "StayBooking" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "roomChoice" "RoomType" NOT NULL,
    "guests" INTEGER NOT NULL,
    "rooms" INTEGER NOT NULL DEFAULT 1,
    "guestNames" JSONB,
    "notes" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "vatAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "walletAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "paidOnline" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "status" "StayBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "idempotencyKey" TEXT,
    "cancelReason" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelReviewedAt" TIMESTAMP(3),
    "cancelReviewedById" TEXT,
    "cancelReviewNote" TEXT,
    "refundAmount" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StayBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelRating" (
    "id" TEXT NOT NULL,
    "stayBookingId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_reference_key" ON "StayBooking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_number_key" ON "StayBooking"("number");

-- CreateIndex
CREATE UNIQUE INDEX "StayBooking_idempotencyKey_key" ON "StayBooking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StayBooking_userId_idx" ON "StayBooking"("userId");

-- CreateIndex
CREATE INDEX "StayBooking_hotelId_checkIn_idx" ON "StayBooking"("hotelId", "checkIn");

-- CreateIndex
CREATE UNIQUE INDEX "HotelRating_stayBookingId_key" ON "HotelRating"("stayBookingId");

-- CreateIndex
CREATE INDEX "HotelRating_hotelId_idx" ON "HotelRating"("hotelId");

-- AddForeignKey
ALTER TABLE "StayBooking" ADD CONSTRAINT "StayBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StayBooking" ADD CONSTRAINT "StayBooking_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelRating" ADD CONSTRAINT "HotelRating_stayBookingId_fkey" FOREIGN KEY ("stayBookingId") REFERENCES "StayBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelRating" ADD CONSTRAINT "HotelRating_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelRating" ADD CONSTRAINT "HotelRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "trackingToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_trackingToken_key" ON "Booking"("trackingToken");

-- CreateTable
CREATE TABLE "TripRating" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "busRating" INTEGER,
    "supervisorRating" INTEGER,
    "driverRating" INTEGER,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripRating_bookingId_key" ON "TripRating"("bookingId");

-- CreateIndex
CREATE INDEX "TripRating_tripId_createdAt_idx" ON "TripRating"("tripId", "createdAt");

-- AddForeignKey
ALTER TABLE "TripRating" ADD CONSTRAINT "TripRating_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripRating" ADD CONSTRAINT "TripRating_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

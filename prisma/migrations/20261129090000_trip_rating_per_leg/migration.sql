-- A round-trip booking rates the way back on its reverse apart from the outbound.
DROP INDEX "TripRating_bookingId_key";

-- CreateIndex
CREATE UNIQUE INDEX "TripRating_bookingId_tripId_key" ON "TripRating"("bookingId", "tripId");

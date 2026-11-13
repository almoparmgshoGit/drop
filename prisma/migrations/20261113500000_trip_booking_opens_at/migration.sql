-- When booking on a trip opens; null opens it as soon as the trip is published, as before.
ALTER TABLE "Trip" ADD COLUMN "bookingOpensAt" TIMESTAMP(3);

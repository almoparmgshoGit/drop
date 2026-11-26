-- A fixed package's outbound names the trip its customers come back on.
ALTER TABLE "Trip" ADD COLUMN "packageReturnTripId" TEXT;

CREATE INDEX "Trip_packageReturnTripId_idx" ON "Trip"("packageReturnTripId");

ALTER TABLE "Trip" ADD CONSTRAINT "Trip_packageReturnTripId_fkey" FOREIGN KEY ("packageReturnTripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

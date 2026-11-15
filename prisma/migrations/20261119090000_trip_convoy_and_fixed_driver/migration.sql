-- A trip may run on several buses: each extra bus is its own trip pointing at the first.
ALTER TABLE "Trip" ADD COLUMN "convoyLeadId" TEXT;
ALTER TABLE "Trip" ADD COLUMN "convoyOrder" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "Trip_convoyLeadId_idx" ON "Trip"("convoyLeadId");
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_convoyLeadId_fkey" FOREIGN KEY ("convoyLeadId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The driver a bus usually has, optional; a driver has one such bus at most.
ALTER TABLE "Bus" ADD COLUMN "fixedDriverId" TEXT;
CREATE UNIQUE INDEX "Bus_fixedDriverId_key" ON "Bus"("fixedDriverId");
ALTER TABLE "Bus" ADD CONSTRAINT "Bus_fixedDriverId_fkey" FOREIGN KEY ("fixedDriverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

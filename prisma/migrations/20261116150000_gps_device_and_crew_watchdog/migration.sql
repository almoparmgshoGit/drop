-- A position can now come from the bus's fixed GPS device, which has no crew member behind it.
ALTER TABLE "TripLocation" ALTER COLUMN "reportedById" DROP NOT NULL;
ALTER TABLE "TripLocation" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PHONE',
ADD COLUMN "accuracy" DOUBLE PRECISION,
ADD COLUMN "heading" DOUBLE PRECISION;

-- The last time a crew member's app was open, for the "supervisor did not open the app" alert.
ALTER TABLE "User" ADD COLUMN "crewAppSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BusGpsDevice" (
    "busId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT,
    "tokenHint" TEXT,
    "tokenIssuedAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "lastLat" DOUBLE PRECISION,
    "lastLng" DOUBLE PRECISION,
    "lastSpeed" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusGpsDevice_pkey" PRIMARY KEY ("busId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusGpsDevice_deviceId_key" ON "BusGpsDevice"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "BusGpsDevice_tokenHash_key" ON "BusGpsDevice"("tokenHash");

-- AddForeignKey
ALTER TABLE "BusGpsDevice" ADD CONSTRAINT "BusGpsDevice_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TripCrewAlert" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "TripCrewAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripCrewAlert_tripId_kind_key" ON "TripCrewAlert"("tripId", "kind");

-- CreateIndex
CREATE INDEX "TripCrewAlert_createdAt_idx" ON "TripCrewAlert"("createdAt");

-- AddForeignKey
ALTER TABLE "TripCrewAlert" ADD CONSTRAINT "TripCrewAlert_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

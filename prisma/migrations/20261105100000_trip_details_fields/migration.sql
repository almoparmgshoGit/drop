-- What the trip details screen shows and the admin panel could not enter.
ALTER TABLE "Trip"
  ADD COLUMN "departureStation" TEXT,
  ADD COLUMN "estimatedArrivalAt" TIMESTAMP(3);

-- Stops are entered in road order, which clock times cannot give once a trip passes midnight.
ALTER TABLE "ItineraryStop"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STOP',
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Photos customers see without signing in, such as trip and bus pictures.
CREATE TABLE "PublicImage" (
  "id" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "uploadedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicImage_pkey" PRIMARY KEY ("id")
);

-- Room card designs staff build in the panel; housed travelers see theirs in the app.
CREATE TABLE "RoomCardTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hotelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "background" TEXT NOT NULL DEFAULT '#0F2A5C',
    "backgroundImage" TEXT,
    "elements" JSONB NOT NULL DEFAULT '[]',
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomCardTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoomCardTemplate_hotelId_isActive_idx" ON "RoomCardTemplate"("hotelId", "isActive");

ALTER TABLE "RoomCardTemplate" ADD CONSTRAINT "RoomCardTemplate_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

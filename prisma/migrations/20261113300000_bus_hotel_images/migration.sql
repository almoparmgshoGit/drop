-- Photo galleries for buses and hotels, shown to customers with the trip. A bus's single photo becomes the first of its gallery.
-- "Bus"."imageUrl" stays: the API keeps it equal to the gallery's cover, so copies of the app that read only it still show a photo.

-- CreateTable
CREATE TABLE "BusImage" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelImage" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HotelImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusImage_busId_sortOrder_idx" ON "BusImage"("busId", "sortOrder");
CREATE INDEX "HotelImage_hotelId_sortOrder_idx" ON "HotelImage"("hotelId", "sortOrder");

-- AddForeignKey
ALTER TABLE "BusImage" ADD CONSTRAINT "BusImage_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelImage" ADD CONSTRAINT "HotelImage_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: each bus's existing photo becomes its cover. A blank value was never a photo, so it is skipped and cleared, and stray spaces are trimmed on both sides.
INSERT INTO "BusImage" ("id", "busId", "url", "sortOrder")
SELECT gen_random_uuid()::text, b."id", btrim(b."imageUrl"), 0
FROM "Bus" b
WHERE btrim(coalesce(b."imageUrl", '')) <> '';

UPDATE "Bus" SET "imageUrl" = NULLIF(btrim("imageUrl"), '') WHERE "imageUrl" IS DISTINCT FROM NULLIF(btrim("imageUrl"), '');

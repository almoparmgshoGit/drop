-- AlterTable
ALTER TABLE "TripService" ADD COLUMN "fromBus" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BusService" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,

    CONSTRAINT "BusService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusService_busId_serviceId_key" ON "BusService"("busId", "serviceId");

-- AddForeignKey
ALTER TABLE "BusService" ADD CONSTRAINT "BusService_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusService" ADD CONSTRAINT "BusService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Wi-Fi becomes the first entry of the shared service list, the default a new bus starts with.
INSERT INTO "Service" ("id", "name") VALUES ('service-wifi', 'واي فاي') ON CONFLICT ("name") DO NOTHING;

-- Buses keep what they had, and their open trips start showing it to passengers.
INSERT INTO "BusService" ("id", "busId", "serviceId")
  SELECT b."id" || '-wifi', b."id", s."id" FROM "Bus" b CROSS JOIN "Service" s WHERE b."hasWifi" AND s."name" = 'واي فاي';

INSERT INTO "TripService" ("id", "tripId", "serviceId", "fromBus")
  SELECT t."id" || '-wifi', t."id", bs."serviceId", true
  FROM "Trip" t JOIN "BusService" bs ON bs."busId" = t."busId"
  WHERE t."tripStatus" IN ('DRAFT', 'PUBLISHED')
  ON CONFLICT ("tripId", "serviceId") DO NOTHING;

-- AlterTable
ALTER TABLE "Bus" DROP COLUMN "hasWifi";

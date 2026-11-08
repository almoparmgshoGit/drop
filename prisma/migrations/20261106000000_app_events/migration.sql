CREATE TYPE "AppEventType" AS ENUM ('APP_OPEN', 'TRIP_SEARCH', 'TRIP_VIEW', 'BOOKING_START', 'BOOKING_PAID');

CREATE TABLE "AppEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" "AppEventType" NOT NULL,
    "platform" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "origin" TEXT NOT NULL DEFAULT '',
    "destination" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppEvent_deviceId_type_day_origin_destination_key" ON "AppEvent"("deviceId", "type", "day", "origin", "destination");
CREATE INDEX "AppEvent_day_type_idx" ON "AppEvent"("day", "type");

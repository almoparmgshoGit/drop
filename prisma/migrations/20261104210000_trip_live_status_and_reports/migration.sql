-- CreateEnum
CREATE TYPE "TripLiveStatus" AS ENUM ('NOT_STARTED', 'AT_POINT', 'ON_ROAD', 'ARRIVED');

-- CreateEnum
CREATE TYPE "TripReportCategory" AS ENUM ('STATUS', 'HELP', 'SOS');

-- CreateEnum
CREATE TYPE "TripReportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "liveStatus" "TripLiveStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "liveStatusAt" TIMESTAMP(3),
ADD COLUMN     "currentBoardingPointId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "reportId" TEXT;

-- AlterTable: every report so far stays readable, and the numbers follow the order they were made.
ALTER TABLE "TripReport" ADD COLUMN     "number" SERIAL NOT NULL,
ADD COLUMN     "category" "TripReportCategory" NOT NULL DEFAULT 'STATUS',
ADD COLUMN     "status" "TripReportStatus" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "accuracy" DOUBLE PRECISION,
ADD COLUMN     "liveStatusAtReport" "TripLiveStatus",
ADD COLUMN     "pointNameAtReport" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "TripStatusUpdate" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "status" "TripLiveStatus" NOT NULL,
    "boardingPointId" TEXT,
    "pointName" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripStatusUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripReportUpdate" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "status" "TripReportStatus",
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "fromOffice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripReportUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripReportAttachment" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripReportAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripReport_number_key" ON "TripReport"("number");

-- CreateIndex
CREATE UNIQUE INDEX "TripReport_idempotencyKey_key" ON "TripReport"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TripReport_status_createdAt_idx" ON "TripReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TripStatusUpdate_tripId_createdAt_idx" ON "TripStatusUpdate"("tripId", "createdAt");

-- CreateIndex
CREATE INDEX "TripReportUpdate_reportId_createdAt_idx" ON "TripReportUpdate"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "TripReportAttachment_reportId_idx" ON "TripReportAttachment"("reportId");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_currentBoardingPointId_fkey" FOREIGN KEY ("currentBoardingPointId") REFERENCES "BoardingPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStatusUpdate" ADD CONSTRAINT "TripStatusUpdate_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripReportUpdate" ADD CONSTRAINT "TripReportUpdate_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TripReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripReportAttachment" ADD CONSTRAINT "TripReportAttachment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TripReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A report may be evidence, so deleting a trip no longer takes its reports with it.
ALTER TABLE "TripReport" DROP CONSTRAINT "TripReport_tripId_fkey";
ALTER TABLE "TripReport" ADD CONSTRAINT "TripReport_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Whoever could board passengers and read the incident list keeps doing the same under the new names.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'crew.status')
  WHERE 'crew.board' = ANY("permissions") AND NOT 'crew.status' = ANY("permissions");
UPDATE "Rank" SET "permissions" = array_append("permissions", 'reports.view')
  WHERE 'manifests.view' = ANY("permissions") AND NOT 'reports.view' = ANY("permissions");
UPDATE "Rank" SET "permissions" = array_append("permissions", 'reports.manage')
  WHERE "id" = 'rank-operations' AND NOT 'reports.manage' = ANY("permissions");

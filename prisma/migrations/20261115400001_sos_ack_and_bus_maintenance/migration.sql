-- CreateEnum
CREATE TYPE "BusMaintenanceType" AS ENUM ('BREAKDOWN', 'REPAIR', 'PREVENTIVE', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "BusMaintenanceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE');

-- AlterTable: acknowledgement and escalation of an SOS
ALTER TABLE "TripReport" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" TEXT,
ADD COLUMN     "acknowledgedByName" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- A report the office already answered or moved on was evidently received.
UPDATE "TripReport" r SET "acknowledgedAt" = r."updatedAt"
WHERE r."status" <> 'OPEN'
   OR EXISTS (SELECT 1 FROM "TripReportUpdate" u WHERE u."reportId" = r."id" AND u."fromOffice" = true);

-- An SOS sent before this existed is not escalated after the fact; it still shows as unacknowledged until someone takes it.
UPDATE "TripReport" SET "escalatedAt" = CURRENT_TIMESTAMP WHERE "category" = 'SOS' AND "acknowledgedAt" IS NULL;

-- CreateIndex
CREATE INDEX "TripReport_category_acknowledgedAt_escalatedAt_idx" ON "TripReport"("category", "acknowledgedAt", "escalatedAt");

-- CreateTable
CREATE TABLE "BusMaintenanceLog" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "tripId" TEXT,
    "tripCode" TEXT,
    "reportId" TEXT,
    "type" "BusMaintenanceType" NOT NULL DEFAULT 'BREAKDOWN',
    "status" "BusMaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "cost" DECIMAL(10,2),
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusMaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusMaintenanceLog_reportId_key" ON "BusMaintenanceLog"("reportId");

-- CreateIndex
CREATE INDEX "BusMaintenanceLog_busId_reportedAt_idx" ON "BusMaintenanceLog"("busId", "reportedAt");

-- CreateIndex
CREATE INDEX "BusMaintenanceLog_status_idx" ON "BusMaintenanceLog"("status");

-- AddForeignKey
ALTER TABLE "BusMaintenanceLog" ADD CONSTRAINT "BusMaintenanceLog_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusMaintenanceLog" ADD CONSTRAINT "BusMaintenanceLog_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TripReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

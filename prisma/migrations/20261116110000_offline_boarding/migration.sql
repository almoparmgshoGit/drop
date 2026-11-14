-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "boardedOffline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "returnBoardedOffline" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OfflineBoardingSync" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "ticketNumber" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineBoardingSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfflineBoardingSync_actorId_clientId_key" ON "OfflineBoardingSync"("actorId", "clientId");

-- CreateIndex
CREATE INDEX "OfflineBoardingSync_tripId_createdAt_idx" ON "OfflineBoardingSync"("tripId", "createdAt");

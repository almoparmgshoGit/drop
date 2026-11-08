-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "channelApp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "channelBranch" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reverseDepartureAt" TIMESTAMP(3),
ADD COLUMN     "reverseEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reverseOfTripId" TEXT,
ADD COLUMN     "reverseOpenPercent" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "reversePrice" DECIMAL(10,2);

-- CreateIndex
CREATE UNIQUE INDEX "Trip_reverseOfTripId_key" ON "Trip"("reverseOfTripId");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_reverseOfTripId_fkey" FOREIGN KEY ("reverseOfTripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

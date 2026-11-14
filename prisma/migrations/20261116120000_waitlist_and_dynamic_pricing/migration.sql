-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'CANCELLED');

-- AlterTable: flexible pricing rules per trip. Null keeps every existing trip on its fixed price.
ALTER TABLE "Trip" ADD COLUMN     "pricingRules" JSONB;

-- AlterTable: the seat price charged at booking time and the listed price it came from.
ALTER TABLE "Booking" ADD COLUMN     "seatBasePrice" DECIMAL(10,2),
ADD COLUMN     "seatPrice" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "position" INTEGER NOT NULL,
    "offeredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "heldSeats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bookedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "handledByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistEntry_tripId_status_position_idx" ON "WaitlistEntry"("tripId", "status", "position");

-- CreateIndex
CREATE INDEX "WaitlistEntry_userId_status_idx" ON "WaitlistEntry"("userId", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_status_expiresAt_idx" ON "WaitlistEntry"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "LoyaltyRuleType" AS ENUM ('MULTIPLIER', 'BONUS_POINTS', 'BONUS_PERCENT');

-- AlterEnum
ALTER TYPE "CouponType" ADD VALUE 'FIXED_TOTAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'BONUS';
ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'REFERRAL';
ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'REFUNDED';
ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'EXPIRED';
ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'VOUCHER';

-- DropIndex
DROP INDEX "LoyaltyTransaction_bookingId_type_key";

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "loyaltyPlan" JSONB,
ADD COLUMN     "loyaltySettledAt" TIMESTAMP(3),
ADD COLUMN     "pointsDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "pointsRedeemed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "ownerUserId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyTransaction" ADD COLUMN     "createdByName" TEXT,
ADD COLUMN     "uniqueKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "loyaltyActivityAt" TIMESTAMP(3),
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referredById" TEXT;

-- CreateTable
CREATE TABLE "LoyaltyRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LoyaltyRuleType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "weekdays" INTEGER[],
    "tripId" TEXT,
    "minDaysBefore" INTEGER,
    "minSeats" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyVoucher" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "validDays" INTEGER NOT NULL DEFAULT 90,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Coupon_ownerUserId_idx" ON "Coupon"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_uniqueKey_key" ON "LoyaltyTransaction"("uniqueKey");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_bookingId_idx" ON "LoyaltyTransaction"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRule" ADD CONSTRAINT "LoyaltyRule_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Earlier awards keep their protection against being paid twice, and start the inactivity clock today.
UPDATE "LoyaltyTransaction" SET "uniqueKey" = 'earn:' || "bookingId" WHERE "type" = 'EARNED' AND "bookingId" IS NOT NULL;
UPDATE "Booking" b SET "loyaltySettledAt" = t."createdAt" FROM "LoyaltyTransaction" t WHERE t."bookingId" = b."id" AND t."type" = 'EARNED';
UPDATE "User" SET "loyaltyActivityAt" = CURRENT_TIMESTAMP WHERE "loyaltyPoints" > 0;

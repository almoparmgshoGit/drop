-- Popups the app shows when a customer opens it, managed from the panel.

-- CreateEnum
CREATE TYPE "PromoAction" AS ENUM ('NONE', 'SEARCH', 'PACKAGES', 'URL');

-- CreateEnum
CREATE TYPE "PromoFrequency" AS ENUM ('ONCE', 'DAILY', 'EVERY_OPEN');

-- CreateTable
CREATE TABLE "PromoOffer" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "ctaLabel" TEXT,
    "translations" JSONB,
    "imageUrl" TEXT,
    "couponId" TEXT,
    "action" "PromoAction" NOT NULL DEFAULT 'SEARCH',
    "actionUrl" TEXT,
    "frequency" "PromoFrequency" NOT NULL DEFAULT 'ONCE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "copyCount" INTEGER NOT NULL DEFAULT 0,
    "dismissCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoOffer_isActive_priority_idx" ON "PromoOffer"("isActive", "priority");

-- AddForeignKey
ALTER TABLE "PromoOffer" ADD CONSTRAINT "PromoOffer_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

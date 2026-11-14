-- Vouchers become top-up cards: bought with money or points, each card has its own code and QR,
-- and whoever redeems it gets wallet balance and bonus points.
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'VOUCHER_TOPUP';
ALTER TYPE "LoyaltyTransactionType" ADD VALUE IF NOT EXISTS 'VOUCHER_BONUS';

CREATE TYPE "VoucherPayMethod" AS ENUM ('MONEY', 'POINTS');

ALTER TABLE "LoyaltyVoucher" ALTER COLUMN "pointsCost" DROP NOT NULL;
ALTER TABLE "LoyaltyVoucher" ALTER COLUMN "value" SET DEFAULT 0;
ALTER TABLE "LoyaltyVoucher"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "price" DECIMAL(10,2),
  ADD COLUMN "bonusPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditTransportOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stockTotal" INTEGER,
  ADD COLUMN "soldCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxPerPurchase" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "imageUrl" TEXT,
  ADD COLUMN "design" JSONB;

-- The old vouchers were discounts bought with points; their value now means wallet balance, so none goes on sale
-- until staff review it. Discount codes customers already hold stay valid (they are coupons).
UPDATE "LoyaltyVoucher" SET "isActive" = false;

CREATE TABLE "VoucherPurchase" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "method" "VoucherPayMethod" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "paymentStatus" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoucherPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VoucherCard" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "bonusPoints" INTEGER NOT NULL DEFAULT 0,
    "transportOnly" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "design" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedById" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoucherCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VoucherPurchase_reference_key" ON "VoucherPurchase"("reference");
CREATE INDEX "VoucherPurchase_buyerId_createdAt_idx" ON "VoucherPurchase"("buyerId", "createdAt");
CREATE INDEX "VoucherPurchase_voucherId_idx" ON "VoucherPurchase"("voucherId");
CREATE UNIQUE INDEX "VoucherCard_code_key" ON "VoucherCard"("code");
CREATE INDEX "VoucherCard_buyerId_createdAt_idx" ON "VoucherCard"("buyerId", "createdAt");
CREATE INDEX "VoucherCard_voucherId_idx" ON "VoucherCard"("voucherId");

ALTER TABLE "VoucherPurchase" ADD CONSTRAINT "VoucherPurchase_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "LoyaltyVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoucherPurchase" ADD CONSTRAINT "VoucherPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoucherCard" ADD CONSTRAINT "VoucherCard_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "LoyaltyVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoucherCard" ADD CONSTRAINT "VoucherCard_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "VoucherPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoucherCard" ADD CONSTRAINT "VoucherCard_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

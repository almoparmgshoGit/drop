-- Wallet credit that pays for transport only (compensations, promotional credit, staff credit marked so).
ALTER TABLE "User" ADD COLUMN "walletTransportBalance" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "walletTransportAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "WalletTransaction" ADD COLUMN "transportAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Existing promotional credit still unspent becomes transport-only, never more than the wallet holds.
UPDATE "User" u
SET "walletTransportBalance" = LEAST(u."walletBalance", p.remaining)
FROM (
  SELECT "userId", SUM("promoRemaining") AS remaining
  FROM "WalletTransaction"
  WHERE "type" = 'PROMO_CREDIT' AND "promoRemaining" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  GROUP BY "userId"
) p
WHERE p."userId" = u."id" AND u."walletBalance" > 0;

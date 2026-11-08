-- CreateEnum
CREATE TYPE "AccountCategoryGroup" AS ENUM ('HOTEL', 'BUS', 'DRIVER', 'ADMIN', 'OTHER', 'INCOME');

-- AlterTable
ALTER TABLE "TripBusCost" ADD COLUMN     "rentHasTaxInvoice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "HotelBooking" ADD COLUMN     "hasTaxInvoice" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "tripCode" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "tripDate" TIMESTAMP(3) NOT NULL,
    "passengerName" TEXT,
    "nationalId" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "taxable" DECIMAL(12,2) NOT NULL,
    "vat" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "seller" JSONB,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tripCode" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "taxable" DECIMAL(12,2) NOT NULL,
    "vat" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" "AccountCategoryGroup" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripAccountEntry" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "vat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hasTaxInvoice" BOOLEAN NOT NULL DEFAULT false,
    "supplierName" TEXT,
    "invoiceNumber" TEXT,
    "notes" TEXT,
    "spentOn" DATE NOT NULL,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedByName" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "TripAccountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_bookingId_key" ON "Invoice"("bookingId");
CREATE INDEX "Invoice_issuedAt_idx" ON "Invoice"("issuedAt");
CREATE INDEX "Invoice_tripId_issuedAt_idx" ON "Invoice"("tripId", "issuedAt");
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");
CREATE INDEX "CreditNote_issuedAt_idx" ON "CreditNote"("issuedAt");
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");
CREATE UNIQUE INDEX "AccountCategory_name_key" ON "AccountCategory"("name");
CREATE UNIQUE INDEX "TripAccountEntry_idempotencyKey_key" ON "TripAccountEntry"("idempotencyKey");
CREATE INDEX "TripAccountEntry_tripId_idx" ON "TripAccountEntry"("tripId");
CREATE INDEX "TripAccountEntry_spentOn_idx" ON "TripAccountEntry"("spentOn");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripAccountEntry" ADD CONSTRAINT "TripAccountEntry_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TripAccountEntry" ADD CONSTRAINT "TripAccountEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AccountCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_total_positive" CHECK ("total" > 0);
ALTER TABLE "TripAccountEntry" ADD CONSTRAINT "TripAccountEntry_amount_positive" CHECK ("amount" > 0);

-- Bookings made before this release get their invoices dated when they were booked, numbered in that order.
INSERT INTO "Invoice" ("id", "bookingId", "tripId", "tripCode", "destination", "tripDate", "passengerName", "nationalId", "subtotal", "total", "taxable", "vat", "vatRate", "issuedAt")
SELECT
  'inv-' || b."id", b."id", t."id", t."tripCode", t."destination", t."departureTime",
  COALESCE(p."fullName", u."name"), p."nationalId",
  GREATEST(b."subtotal", b."totalPrice"), b."totalPrice",
  b."totalPrice" - v."vat", v."vat", r."rate", b."createdAt"
FROM "Booking" b
JOIN "Trip" t ON t."id" = b."tripId"
JOIN "User" u ON u."id" = b."userId"
CROSS JOIN (SELECT COALESCE((SELECT "value"::numeric FROM "Setting" WHERE "key" = 'vatRate'), 15) AS "rate") r
CROSS JOIN LATERAL (
  SELECT CASE WHEN b."vatAmount" > 0 THEN b."vatAmount" ELSE ROUND(b."totalPrice" * r."rate" / (100 + r."rate"), 2) END AS "vat"
) v
LEFT JOIN LATERAL (
  SELECT "fullName", "nationalId" FROM "BookingPassenger" WHERE "bookingId" = b."id" ORDER BY LENGTH("seatNumber"), "seatNumber" LIMIT 1
) p ON TRUE
ORDER BY b."createdAt", b."id";

-- A cancelled booking keeps only what the company held on to; the rest of its invoice is reversed.
INSERT INTO "CreditNote" ("id", "invoiceId", "bookingId", "tripCode", "total", "taxable", "vat", "reason", "createdById", "issuedAt")
SELECT
  'cn-' || i."bookingId", i."id", i."bookingId", i."tripCode", c."credit",
  c."credit" - ROUND(i."vat" * c."credit" / i."total", 2), ROUND(i."vat" * c."credit" / i."total", 2),
  b."cancelReviewNote", b."cancelReviewedById", COALESCE(b."cancelReviewedAt", b."updatedAt")
FROM "Invoice" i
JOIN "Booking" b ON b."id" = i."bookingId"
LEFT JOIN "Payment" pay ON pay."bookingId" = b."id"
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN pay."status" IN ('COMPLETED', 'SIMULATED') THEN pay."amount"
         ELSE COALESCE((SELECT SUM("amount") FROM "BookingCollection" WHERE "bookingId" = b."id"), 0) END
    + COALESCE(pay."walletAmount", 0) AS "paid"
) m
CROSS JOIN LATERAL (
  SELECT LEAST(i."total", i."total" - GREATEST(0,
    m."paid" - COALESCE(b."refundAmount", 0)
    - COALESCE((SELECT SUM("amount") FROM "CashMovement" WHERE "bookingId" = b."id" AND "type" = 'BOOKING_REFUND'), 0)
  )) AS "credit"
) c
WHERE b."status" = 'CANCELLED' AND c."credit" > 0
ORDER BY COALESCE(b."cancelReviewedAt", b."updatedAt"), b."id";

CREATE FUNCTION "reject_tax_document_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Invoice_append_only"
BEFORE UPDATE OR DELETE ON "Invoice"
FOR EACH ROW EXECUTE FUNCTION "reject_tax_document_change"();

CREATE TRIGGER "CreditNote_append_only"
BEFORE UPDATE OR DELETE ON "CreditNote"
FOR EACH ROW EXECUTE FUNCTION "reject_tax_document_change"();

INSERT INTO "AccountCategory" ("id", "name", "group", "isSystem") VALUES
  ('acct-hotel', 'تكاليف الفنادق', 'HOTEL', true),
  ('acct-bus', 'إيجار الباص', 'BUS', true),
  ('acct-fuel', 'الوقود', 'OTHER', true),
  ('acct-driver', 'أجرة السائق', 'DRIVER', true),
  ('acct-meals', 'وجبات', 'OTHER', true),
  ('acct-parking', 'رسوم مواقف', 'OTHER', true),
  ('acct-admin', 'مصاريف إدارية (حصة)', 'ADMIN', true),
  ('acct-maintenance', 'صيانة (حصة)', 'ADMIN', true),
  ('acct-other', 'أخرى', 'OTHER', true),
  ('acct-income', 'إيرادات أخرى', 'INCOME', true);

-- Accountants already hold the drawer and collections; everyone else keeps exactly the access they had.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['invoices.view', 'tax.view', 'trip_accounts.view', 'trip_accounts.manage'])
  WHERE "id" = 'rank-accountant' AND NOT 'invoices.view' = ANY("permissions");

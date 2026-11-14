-- What the customer bought is stored on the booking itself, so every screen shows the same type.
CREATE TYPE "BookingServiceType" AS ENUM ('TRANSPORT_ONLY', 'WITH_HOTEL', 'WITH_VISITS', 'WITH_HOTEL_VISITS');

ALTER TABLE "Booking" ADD COLUMN "serviceType" "BookingServiceType" NOT NULL DEFAULT 'TRANSPORT_ONLY';

-- A price typed by staff instead of the listed one: the difference, the reason and the employee.
ALTER TABLE "Booking" ADD COLUMN "priceAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN "priceAdjustmentReason" TEXT;
ALTER TABLE "Booking" ADD COLUMN "priceAdjustedById" TEXT;
ALTER TABLE "Booking" ADD COLUMN "priceAdjustedByName" TEXT;

-- One booking number for the app and the branches: DH-YYMM-NNNN, counted per month.
CREATE TABLE "BookingNumberCounter" (
    "period" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BookingNumberCounter_pkey" PRIMARY KEY ("period")
);

-- Backfill the type from what each booking actually holds, the same rule the rooming sheet already used:
-- a stay is a hotel chosen, a room type asked for, a package kind with a stay, or a housing trip booked without a transport kind.
-- Visits are part of the trip's programme, so a booking on a trip with visits had them.
UPDATE "Booking" b
SET "serviceType" = (
  CASE
    WHEN s.has_stay AND s.has_visits THEN 'WITH_HOTEL_VISITS'
    WHEN s.has_stay THEN 'WITH_HOTEL'
    WHEN s.has_visits THEN 'WITH_VISITS'
    ELSE 'TRANSPORT_ONLY'
  END
)::"BookingServiceType"
FROM (
  SELECT
    x."id",
    (
      x."stayHotelId" IS NOT NULL
      OR x."roomChoice" IS NOT NULL
      OR x."kind" IN ('PACKAGE_ROUND_STAY', 'PACKAGE_OUTBOUND_STAY', 'PACKAGE_STAY_RETURN')
      OR (t."bookingType" IN ('WITH_HOTEL', 'WITH_HOTEL_VISITS') AND x."kind" IS NULL)
    ) AS has_stay,
    (t."bookingType" IN ('WITH_VISITS', 'WITH_HOTEL_VISITS')) AS has_visits
  FROM "Booking" x
  JOIN "Trip" t ON t."id" = x."tripId"
) s
WHERE s."id" = b."id";

-- A branch price typed by hand was kept as a discount (and a higher one was lost). It becomes the manual adjustment,
-- credited to whoever the history says changed it, else whoever registered the booking. Old ones have no reason on record.
UPDATE "Booking" b
SET "priceAdjustment" = b."totalPrice" - b."subtotal",
    "discountAmount" = 0,
    "priceAdjustedById" = COALESCE(e."actorId", b."createdById"),
    "priceAdjustedByName" = COALESCE(e."actorName", b."createdByName")
FROM "Booking" x
LEFT JOIN LATERAL (
  SELECT ev."actorId", ev."actorName"
  FROM "BookingEvent" ev
  WHERE ev."bookingId" = x."id" AND ev."action" = 'PRICE_OVERRIDDEN'
  ORDER BY ev."createdAt" DESC
  LIMIT 1
) e ON TRUE
WHERE x."id" = b."id"
  AND b."source" = 'BRANCH'
  AND b."totalPrice" <> b."subtotal";

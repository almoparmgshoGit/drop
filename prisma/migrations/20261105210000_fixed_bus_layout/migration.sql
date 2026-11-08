-- Every bus now has the client's fixed 49-seat plan, so a bus no longer stores a seat count.
ALTER TABLE "Bus" DROP COLUMN "totalSeats";
ALTER TABLE "Trip" ALTER COLUMN "totalSeats" SET DEFAULT 49;
ALTER TABLE "Trip" ALTER COLUMN "busType" SET DEFAULT 'VIP 2+2';

-- Trips still ahead move onto the plan. Finished and cancelled trips keep the record of what they were.
CREATE TEMP TABLE "_open_trip" ON COMMIT DROP AS
  SELECT t."id", t."reverseOfTripId", o."direction" AS "outboundDirection"
  FROM "Trip" t
  LEFT JOIN "Trip" o ON o."id" = t."reverseOfTripId"
  WHERE t."tripStatus" IN ('DRAFT', 'PUBLISHED') AND t."arrivalTime" > NOW();

-- An outbound, or the reverse of a one-way trip, sells the whole bus.
INSERT INTO "Seat" ("id", "tripId", "seatNumber")
  SELECT gen_random_uuid()::text, t."id", n::text
  FROM "_open_trip" t
  CROSS JOIN generate_series(1, 49) AS n
  WHERE t."reverseOfTripId" IS NULL OR t."outboundDirection" = 'ONE_WAY'
ON CONFLICT ("tripId", "seatNumber") DO NOTHING;

-- The reverse of a round trip sells only what is free on its outbound, which now includes the new seats.
INSERT INTO "Seat" ("id", "tripId", "seatNumber")
  SELECT gen_random_uuid()::text, t."id", s."seatNumber"
  FROM "_open_trip" t
  JOIN "Seat" s ON s."tripId" = t."reverseOfTripId" AND s."isBooked" = false
  WHERE t."outboundDirection" = 'ROUND_TRIP'
ON CONFLICT ("tripId", "seatNumber") DO NOTHING;

-- A seat past the plan goes unless someone holds it. A booking on such a seat stays until staff move the passenger.
DELETE FROM "Seat" s
  USING "_open_trip" t
  WHERE s."tripId" = t."id" AND s."isBooked" = false AND s."seatNumber" ~ '^[0-9]+$' AND s."seatNumber"::int > 49;

UPDATE "Trip" t
  SET "totalSeats" = (SELECT COUNT(*) FROM "Seat" s WHERE s."tripId" = t."id"),
      "availableSeats" = (SELECT COUNT(*) FROM "Seat" s WHERE s."tripId" = t."id" AND s."isBooked" = false),
      "busType" = regexp_replace(t."busType", '[0-9]\s*\+\s*[0-9]', '2+2')
  WHERE t."id" IN (SELECT "id" FROM "_open_trip");

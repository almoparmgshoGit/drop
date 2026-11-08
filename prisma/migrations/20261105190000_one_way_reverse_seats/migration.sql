-- One-way passengers get off at the destination, so an upcoming reverse of a one-way trip now sells the whole bus
-- and the two directions no longer block each other's seats. Round trips keep sharing seats and are left alone.
CREATE TEMP TABLE "_one_way_reverse" ON COMMIT DROP AS
  SELECT r."id" AS "reverseId", o."id" AS "outboundId"
  FROM "Trip" r
  JOIN "Trip" o ON o."id" = r."reverseOfTripId"
  WHERE o."direction" = 'ONE_WAY'
    AND r."tripStatus" IN ('DRAFT', 'PUBLISHED')
    AND r."departureTime" > NOW();

-- Seats sold on the outbound before the reverse opened were never created on it.
INSERT INTO "Seat" ("id", "tripId", "seatNumber")
  SELECT gen_random_uuid()::text, pair."reverseId", s."seatNumber"
  FROM "_one_way_reverse" pair
  JOIN "Seat" s ON s."tripId" = pair."outboundId"
ON CONFLICT ("tripId", "seatNumber") DO NOTHING;

-- A booked seat with no passenger was only blocked by the link. Nothing else books a seat without one.
UPDATE "Seat" s
  SET "isBooked" = false, "heldByUserId" = NULL, "heldUntil" = NULL
  WHERE s."isBooked" = true
    AND s."tripId" IN (SELECT "reverseId" FROM "_one_way_reverse" UNION SELECT "outboundId" FROM "_one_way_reverse")
    AND NOT EXISTS (
      SELECT 1 FROM "BookingPassenger" p
      JOIN "Booking" b ON b."id" = p."bookingId"
      WHERE b."tripId" = s."tripId" AND p."seatNumber" = s."seatNumber" AND b."status" <> 'CANCELLED'
    );

UPDATE "Trip" t
  SET "totalSeats" = (SELECT COUNT(*) FROM "Seat" s WHERE s."tripId" = t."id"),
      "availableSeats" = (SELECT COUNT(*) FROM "Seat" s WHERE s."tripId" = t."id" AND s."isBooked" = false)
  WHERE t."id" IN (SELECT "reverseId" FROM "_one_way_reverse");

UPDATE "Trip" t
  SET "availableSeats" = (SELECT COUNT(*) FROM "Seat" s WHERE s."tripId" = t."id" AND s."isBooked" = false)
  WHERE t."id" IN (SELECT "outboundId" FROM "_one_way_reverse");

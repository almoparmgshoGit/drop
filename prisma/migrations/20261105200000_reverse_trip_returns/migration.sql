-- A round trip's passengers ride back on the reverse with their outbound ticket, so the return boarding has its own record.
ALTER TABLE "Ticket" ADD COLUMN "returnBoardedAt" TIMESTAMP(3);

-- Staff are told once when a trip reaches the percent that opens its reverse.
ALTER TABLE "Trip" ADD COLUMN "reverseReadyAnnouncedAt" TIMESTAMP(3);

-- Trips already past their percent, or already opened, are not news.
UPDATE "Trip" SET "reverseReadyAnnouncedAt" = NOW()
  WHERE "reverseEnabled" = true
    AND ("id" IN (SELECT "reverseOfTripId" FROM "Trip" WHERE "reverseOfTripId" IS NOT NULL)
      OR ("totalSeats" > 0 AND ("totalSeats" - "availableSeats") * 100 >= "reverseOpenPercent" * "totalSeats"));

-- A trip that is itself a way back never has a way back of its own.
UPDATE "Trip" SET "reverseEnabled" = false WHERE "reverseOfTripId" IS NOT NULL AND "reverseEnabled" = true;

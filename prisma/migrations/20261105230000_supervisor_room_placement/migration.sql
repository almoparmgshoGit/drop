ALTER TABLE "Trip" ADD COLUMN "sharedRoomCapacity" INTEGER NOT NULL DEFAULT 4;

CREATE TABLE "TripHousingSheet" (
    "tripId" TEXT NOT NULL,
    "columns" TEXT[],
    "note" TEXT,
    "passengerNotes" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripHousingSheet_pkey" PRIMARY KEY ("tripId")
);

ALTER TABLE "TripHousingSheet" ADD CONSTRAINT "TripHousingSheet_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Placing passengers in rooms belongs to trip supervisors, so only their ranks receive it.
UPDATE "Rank"
SET "permissions" = array_append("permissions", 'crew.housing')
FROM "JobType"
WHERE "JobType"."id" = "Rank"."jobId" AND "JobType"."tripRole" = 'SUPERVISOR' AND NOT ('crew.housing' = ANY("Rank"."permissions"));

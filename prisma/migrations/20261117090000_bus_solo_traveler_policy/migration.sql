-- Where a booking of one traveller may sit on each bus.
CREATE TYPE "SoloTravelerPolicy" AS ENUM ('SINGLES_ONLY', 'WOMEN_ALLOWED');

ALTER TABLE "Bus" ADD COLUMN "soloTravelerPolicy" "SoloTravelerPolicy" NOT NULL DEFAULT 'SINGLES_ONLY';

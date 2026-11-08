-- Where singles may sit is now set on each bus, from seat to seat. Existing buses start on the old default: seat 26 to the back of the bus.
ALTER TABLE "Bus" ADD COLUMN "singlesFromSeat" INTEGER NOT NULL DEFAULT 26;
ALTER TABLE "Bus" ADD COLUMN "singlesToSeat" INTEGER NOT NULL DEFAULT 49;

-- A trip takes the range from its bus, or from the settings until it has one.
ALTER TABLE "Trip" DROP COLUMN "singlesFromSeat";

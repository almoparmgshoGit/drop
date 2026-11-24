-- Families may sit anywhere; singles take family seats once their section is full and the bus is booked to this percent.
-- Empty follows the settings.
ALTER TABLE "Trip" ADD COLUMN "singlesOverflowPercent" INTEGER;

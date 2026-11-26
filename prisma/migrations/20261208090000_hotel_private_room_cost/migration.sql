-- A separate cost a night for private rooms; null means they cost the same as shared ones (nightlyRate).
ALTER TABLE "Hotel" ADD COLUMN "privateNightlyRate" DECIMAL(10,2);
ALTER TABLE "HotelBooking" ADD COLUMN "privateNightlyRate" DECIMAL(10,2);

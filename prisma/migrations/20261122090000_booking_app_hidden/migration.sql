-- Staff can hide a booking from the customer's list in the app without changing it.
ALTER TABLE "Booking" ADD COLUMN "appHidden" BOOLEAN NOT NULL DEFAULT false;

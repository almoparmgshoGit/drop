-- A group larger than one private room can take more rooms, each charged at the hotel's price for one.
ALTER TABLE "Booking" ADD COLUMN "privateRooms" INTEGER NOT NULL DEFAULT 1;

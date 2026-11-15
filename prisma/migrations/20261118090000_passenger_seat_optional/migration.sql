-- A counter booking may be saved without seats; the office assigns them later.
ALTER TABLE "BookingPassenger" ALTER COLUMN "seatNumber" DROP NOT NULL;

-- The automatic rooming: the options kept per hotel, and each room's floor for families and elderly travellers.
ALTER TABLE "Hotel" ADD COLUMN "roomingOptions" JSONB;
ALTER TABLE "HotelRoom" ADD COLUMN "floor" INTEGER;

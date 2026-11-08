-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "allowsSharing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "roomCapacity" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "roomCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "HotelRoom" ADD COLUMN     "fromInventory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sharedCategory" "BookingCategory";

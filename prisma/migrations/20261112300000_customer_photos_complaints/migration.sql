-- A customer's photo, and complaints customers send from the app about the app, a trip, a supervisor or anything else.

-- CreateEnum
CREATE TYPE "CustomerComplaintCategory" AS ENUM ('APP', 'TRIP', 'SUPERVISOR', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomerComplaintStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "photoUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserPhoto" (
    "userId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPhoto_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CustomerComplaint" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT,
    "category" "CustomerComplaintCategory" NOT NULL,
    "status" "CustomerComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "details" TEXT NOT NULL,
    "bookingId" TEXT,
    "tripId" TEXT,
    "tripCode" TEXT,
    "supervisorNames" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerComplaint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerComplaint_number_key" ON "CustomerComplaint"("number");

-- CreateIndex
CREATE INDEX "CustomerComplaint_status_category_idx" ON "CustomerComplaint"("status", "category");

-- CreateIndex
CREATE INDEX "CustomerComplaint_userId_idx" ON "CustomerComplaint"("userId");

-- AddForeignKey
ALTER TABLE "UserPhoto" ADD CONSTRAINT "UserPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

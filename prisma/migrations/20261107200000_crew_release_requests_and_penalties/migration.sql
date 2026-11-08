-- CreateEnum
CREATE TYPE "CrewReleaseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "StaffPenaltyType" AS ENUM ('NOTICE', 'WARNING', 'DEDUCTION', 'SANCTION');

-- CreateTable
CREATE TABLE "CrewReleaseRequest" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "tripId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CrewReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewReleaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPenalty" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "StaffPenaltyType" NOT NULL,
    "amount" DECIMAL(10,2),
    "reason" TEXT NOT NULL,
    "tripId" TEXT,
    "requestId" TEXT,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPenalty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrewReleaseRequest_number_key" ON "CrewReleaseRequest"("number");

-- CreateIndex
CREATE INDEX "CrewReleaseRequest_status_createdAt_idx" ON "CrewReleaseRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CrewReleaseRequest_tripId_userId_idx" ON "CrewReleaseRequest"("tripId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPenalty_number_key" ON "StaffPenalty"("number");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPenalty_requestId_key" ON "StaffPenalty"("requestId");

-- CreateIndex
CREATE INDEX "StaffPenalty_userId_createdAt_idx" ON "StaffPenalty"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrewReleaseRequest" ADD CONSTRAINT "CrewReleaseRequest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewReleaseRequest" ADD CONSTRAINT "CrewReleaseRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewReleaseRequest" ADD CONSTRAINT "CrewReleaseRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPenalty" ADD CONSTRAINT "StaffPenalty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPenalty" ADD CONSTRAINT "StaffPenalty_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPenalty" ADD CONSTRAINT "StaffPenalty_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CrewReleaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPenalty" ADD CONSTRAINT "StaffPenalty_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One open request per person and trip, so two taps cannot leave staff deciding twice.
CREATE UNIQUE INDEX "CrewReleaseRequest_one_pending_key" ON "CrewReleaseRequest"("tripId", "userId") WHERE "status" = 'PENDING';

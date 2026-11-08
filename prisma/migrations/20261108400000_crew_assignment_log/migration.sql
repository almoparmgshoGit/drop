-- A history of who joined and left each trip's crew.

-- CreateEnum
CREATE TYPE "CrewAssignmentAction" AS ENUM ('ASSIGNED', 'UNASSIGNED');

-- CreateTable
CREATE TABLE "CrewAssignmentLog" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" "CrewAssignmentAction" NOT NULL,
    "reason" TEXT,
    "byId" TEXT,
    "byName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewAssignmentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrewAssignmentLog_userId_createdAt_idx" ON "CrewAssignmentLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CrewAssignmentLog_tripId_createdAt_idx" ON "CrewAssignmentLog"("tripId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrewAssignmentLog" ADD CONSTRAINT "CrewAssignmentLog_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewAssignmentLog" ADD CONSTRAINT "CrewAssignmentLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The crews standing today become the first entries, dated when their trip was created, so no history starts empty.
INSERT INTO "CrewAssignmentLog" ("id", "tripId", "userId", "role", "action", "reason", "createdAt")
  SELECT gen_random_uuid()::text, s."tripId", s."userId", 'SUPERVISOR', 'ASSIGNED', 'قبل تفعيل سجل الإسناد', t."createdAt"
  FROM "TripSupervisor" s JOIN "Trip" t ON t."id" = s."tripId";
INSERT INTO "CrewAssignmentLog" ("id", "tripId", "userId", "role", "action", "reason", "createdAt")
  SELECT gen_random_uuid()::text, d."tripId", d."userId", 'DRIVER', 'ASSIGNED', 'قبل تفعيل سجل الإسناد', t."createdAt"
  FROM "TripDriver" d JOIN "Trip" t ON t."id" = d."tripId";

-- Complaints remember who closed them by id, so each employee's record counts the problems they solved.

-- AlterTable
ALTER TABLE "CustomerComplaint" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "HotelComplaint" ADD COLUMN "resolvedById" TEXT;

-- Earlier closures kept only the name: credit them where exactly one staff account bears it.
UPDATE "CustomerComplaint" c SET "resolvedById" = u."id"
FROM "User" u
WHERE c."status" = 'RESOLVED' AND c."resolvedByName" IS NOT NULL AND u."name" = c."resolvedByName" AND u."role" <> 'PASSENGER'
  AND (SELECT COUNT(*) FROM "User" o WHERE o."name" = c."resolvedByName" AND o."role" <> 'PASSENGER') = 1;

UPDATE "HotelComplaint" c SET "resolvedById" = u."id"
FROM "User" u
WHERE c."status" = 'RESOLVED' AND c."resolvedByName" IS NOT NULL AND u."name" = c."resolvedByName" AND u."role" <> 'PASSENGER'
  AND (SELECT COUNT(*) FROM "User" o WHERE o."name" = c."resolvedByName" AND o."role" <> 'PASSENGER') = 1;

-- CreateIndex
CREATE INDEX "CustomerComplaint_resolvedById_idx" ON "CustomerComplaint"("resolvedById");
CREATE INDEX "HotelComplaint_resolvedById_idx" ON "HotelComplaint"("resolvedById");

-- Counted per employee.
CREATE INDEX "Booking_createdById_idx" ON "Booking"("createdById");
CREATE INDEX "Booking_cancelReviewedById_idx" ON "Booking"("cancelReviewedById");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

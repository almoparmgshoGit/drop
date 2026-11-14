-- A duplicate customer merged into another keeps a pointer to it.
ALTER TABLE "User" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "User" ADD COLUMN "mergedAt" TIMESTAMP(3);

CREATE INDEX "User_mergedIntoId_idx" ON "User"("mergedIntoId");

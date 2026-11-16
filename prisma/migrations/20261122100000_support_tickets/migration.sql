-- Customer complaints become support tickets: an employee takes or is assigned each one, it has a priority, and the
-- customer and staff exchange messages (with images) instead of a single reply.
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "ComplaintMessageKind" AS ENUM ('CUSTOMER', 'STAFF', 'NOTE', 'EVENT');

ALTER TABLE "CustomerComplaint"
    ADD COLUMN "assignedToId" TEXT,
    ADD COLUMN "assignedToName" TEXT,
    ADD COLUMN "assignedAt" TIMESTAMP(3),
    ADD COLUMN "priority" "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "awaitingReply" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "customerUnread" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "CustomerComplaint_status_assignedToId_idx" ON "CustomerComplaint"("status", "assignedToId");

CREATE TABLE "ComplaintMessage" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "kind" "ComplaintMessageKind" NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "authorId" TEXT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplaintMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplaintMessage_complaintId_createdAt_idx" ON "ComplaintMessage"("complaintId", "createdAt");
ALTER TABLE "ComplaintMessage" ADD CONSTRAINT "ComplaintMessage_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "CustomerComplaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComplaintAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplaintAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplaintAttachment_messageId_idx" ON "ComplaintAttachment"("messageId");
ALTER TABLE "ComplaintAttachment" ADD CONSTRAINT "ComplaintAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ComplaintMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing complaints keep their story: the customer's text opens the thread, and an earlier reply follows it.
INSERT INTO "ComplaintMessage" ("id", "complaintId", "kind", "body", "authorId", "authorName", "createdAt")
SELECT gen_random_uuid()::text, c."id", 'CUSTOMER', c."details", c."userId", c."customerName", c."createdAt"
FROM "CustomerComplaint" c;

INSERT INTO "ComplaintMessage" ("id", "complaintId", "kind", "body", "authorId", "authorName", "createdAt")
SELECT gen_random_uuid()::text, c."id", 'STAFF', c."resolution", c."resolvedById", c."resolvedByName", COALESCE(c."resolvedAt", c."updatedAt")
FROM "CustomerComplaint" c
WHERE c."resolution" IS NOT NULL AND c."resolution" <> '';

-- Whoever answered a closed complaint is its handler; open ones wait in «جديدة».
UPDATE "CustomerComplaint"
SET "assignedToId" = "resolvedById",
    "assignedToName" = "resolvedByName",
    "assignedAt" = "resolvedAt",
    "awaitingReply" = false,
    "lastActivityAt" = COALESCE("resolvedAt", "updatedAt")
WHERE "status" = 'RESOLVED';

UPDATE "CustomerComplaint" SET "lastActivityAt" = "createdAt" WHERE "status" = 'OPEN';

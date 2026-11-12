-- Monthly trip numbers (D001 / R001 / DR001), bus complaints, Google sign-in and the customer's chat with their trip's crew.

-- AlterEnum
ALTER TYPE "CustomerComplaintCategory" ADD VALUE 'BUS';

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "codePeriod" TEXT, ADD COLUMN "codeNumber" INTEGER;
CREATE INDEX "Trip_codePeriod_codeNumber_idx" ON "Trip"("codePeriod", "codeNumber");

ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateEnum
CREATE TYPE "TripChatSender" AS ENUM ('CUSTOMER', 'CREW');

-- CreateTable
CREATE TABLE "TripChatThread" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',
    "lastSender" "TripChatSender",
    "crewUnread" INTEGER NOT NULL DEFAULT 0,
    "customerUnread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TripChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sender" "TripChatSender" NOT NULL,
    "senderId" TEXT,
    "senderName" TEXT,
    "body" TEXT NOT NULL,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripChatThread_tripId_customerId_key" ON "TripChatThread"("tripId", "customerId");
CREATE INDEX "TripChatThread_tripId_lastMessageAt_idx" ON "TripChatThread"("tripId", "lastMessageAt");
CREATE INDEX "TripChatThread_customerId_idx" ON "TripChatThread"("customerId");
CREATE UNIQUE INDEX "TripChatMessage_threadId_clientId_key" ON "TripChatMessage"("threadId", "clientId");
CREATE INDEX "TripChatMessage_threadId_createdAt_idx" ON "TripChatMessage"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "TripChatThread" ADD CONSTRAINT "TripChatThread_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TripChatThread" ADD CONSTRAINT "TripChatThread_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TripChatMessage" ADD CONSTRAINT "TripChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "TripChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

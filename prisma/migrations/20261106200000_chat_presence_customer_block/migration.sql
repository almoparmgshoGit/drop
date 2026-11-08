ALTER TABLE "User" ADD COLUMN "blockedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "blockedReason" TEXT;

CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "ChatSender" AS ENUM ('CUSTOMER', 'STAFF');

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "assignedToName" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" TEXT NOT NULL DEFAULT '',
    "lastSender" "ChatSender",
    "staffUnread" INTEGER NOT NULL DEFAULT 0,
    "customerUnread" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conversation_customerId_key" ON "Conversation"("customerId");
CREATE INDEX "Conversation_status_lastMessageAt_idx" ON "Conversation"("status", "lastMessageAt");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sender" "ChatSender" NOT NULL,
    "staffId" TEXT,
    "staffName" TEXT,
    "body" TEXT NOT NULL,
    "couponCode" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChatMessage_conversationId_clientId_key" ON "ChatMessage"("conversationId", "clientId");
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AppPresence" (
    "userId" TEXT NOT NULL,
    "screen" TEXT NOT NULL,
    "tripId" TEXT,
    "bookingId" TEXT,
    "platform" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentSeenAt" TIMESTAMP(3),
    CONSTRAINT "AppPresence_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX "AppPresence_lastSeenAt_idx" ON "AppPresence"("lastSeenAt");
ALTER TABLE "AppPresence" ADD CONSTRAINT "AppPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "WalletTransactionType" ADD VALUE 'PROMO_CREDIT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'PROMO_EXPIRED';
ALTER TABLE "WalletTransaction" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "WalletTransaction" ADD COLUMN "promoRemaining" DECIMAL(10,2);
CREATE INDEX "WalletTransaction_expiresAt_idx" ON "WalletTransaction"("expiresAt") WHERE "promoRemaining" > 0;

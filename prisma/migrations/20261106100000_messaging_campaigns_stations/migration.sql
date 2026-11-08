-- What the customers' audience filters and per-language alerts read.
ALTER TABLE "User" ADD COLUMN "nationality" TEXT;
ALTER TABLE "User" ADD COLUMN "messageLanguage" TEXT NOT NULL DEFAULT 'ar';
ALTER TABLE "User" ADD COLUMN "marketingOptOutAt" TIMESTAMP(3);

ALTER TABLE "Trip" ADD COLUMN "reminder24hAnnouncedAt" TIMESTAMP(3);
-- Trips already close to leaving are not announced late.
UPDATE "Trip" SET "reminder24hAnnouncedAt" = CURRENT_TIMESTAMP WHERE "departureTime" <= CURRENT_TIMESTAMP + INTERVAL '24 hours';

ALTER TABLE "NotificationTemplate" ADD COLUMN "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationTemplate" ADD COLUMN "crewCanSend" BOOLEAN NOT NULL DEFAULT true;

CREATE TYPE "MessageDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED');
CREATE TYPE "WhatsAppTemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "sendInApp" BOOLEAN NOT NULL DEFAULT true,
    "sendWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "couponId" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "isMarketing" BOOLEAN NOT NULL DEFAULT true,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "whatsappQueued" INTEGER NOT NULL DEFAULT 0,
    "confirmedCount" INTEGER,
    "cursor" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "sentById" TEXT,
    "sentByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt");
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt");
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ar',
    "templateName" TEXT NOT NULL,
    "params" JSONB,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "campaignId" TEXT,
    "tripId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageDelivery_providerMessageId_key" ON "MessageDelivery"("providerMessageId");
CREATE INDEX "MessageDelivery_status_nextAttemptAt_idx" ON "MessageDelivery"("status", "nextAttemptAt");
CREATE INDEX "MessageDelivery_event_createdAt_idx" ON "MessageDelivery"("event", "createdAt");
CREATE INDEX "MessageDelivery_createdAt_idx" ON "MessageDelivery"("createdAt");
CREATE INDEX "MessageDelivery_campaignId_idx" ON "MessageDelivery"("campaignId");
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "status" "WhatsAppTemplateStatus" NOT NULL DEFAULT 'PENDING',
    "bodySnapshot" TEXT NOT NULL,
    "paramOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metaId" TEXT,
    "rejectedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsAppTemplate_name_key" ON "WhatsAppTemplate"("name");
CREATE UNIQUE INDEX "WhatsAppTemplate_event_language_key" ON "WhatsAppTemplate"("event", "language");
CREATE INDEX "WhatsAppTemplate_metaId_idx" ON "WhatsAppTemplate"("metaId");

CREATE TABLE "StationAlertRule" (
    "key" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "minutes" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StationAlertRule_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "TripStationRule" (
    "tripId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    CONSTRAINT "TripStationRule_pkey" PRIMARY KEY ("tripId", "ruleKey")
);
ALTER TABLE "TripStationRule" ADD CONSTRAINT "TripStationRule_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StationAlert" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "stopKey" TEXT NOT NULL,
    "stopName" TEXT NOT NULL,
    "ruleKey" TEXT,
    "manualType" TEXT,
    "message" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "senderId" TEXT,
    "senderName" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StationAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StationAlert_dedupeKey_key" ON "StationAlert"("dedupeKey");
CREATE INDEX "StationAlert_tripId_createdAt_idx" ON "StationAlert"("tripId", "createdAt");
ALTER TABLE "StationAlert" ADD CONSTRAINT "StationAlert_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

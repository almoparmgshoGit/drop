-- Per-language wording for admin-edited action notifications and for messages to customers.

-- AlterTable
ALTER TABLE "NotificationTemplate" ADD COLUMN "translations" JSONB;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "content" JSONB;

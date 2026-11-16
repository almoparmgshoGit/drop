-- Notifications sent through a provider that needs no approved template (UltraMsg) carry their whole text.
ALTER TABLE "MessageDelivery" ADD COLUMN "text" TEXT;

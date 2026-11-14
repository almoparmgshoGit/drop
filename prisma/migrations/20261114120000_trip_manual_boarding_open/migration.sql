-- When staff opened boarding by hand ahead of its usual time; null keeps the usual window.
ALTER TABLE "Trip" ADD COLUMN "boardingOpenedManuallyAt" TIMESTAMP(3);

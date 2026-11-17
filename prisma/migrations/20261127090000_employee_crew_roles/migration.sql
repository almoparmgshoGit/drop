-- Any employee can be marked as able to supervise or drive trips, on top of their rank's job.
ALTER TABLE "User" ADD COLUMN "canSupervise" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "canDrive" BOOLEAN NOT NULL DEFAULT false;

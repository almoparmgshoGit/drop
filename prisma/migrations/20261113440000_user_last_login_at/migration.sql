-- When a person last signed in or refreshed their session, shown to admins as "last login".
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

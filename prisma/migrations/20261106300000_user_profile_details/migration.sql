CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

ALTER TABLE "User" ADD COLUMN "gender" "Gender";
ALTER TABLE "User" ADD COLUMN "nativeLanguage" TEXT;

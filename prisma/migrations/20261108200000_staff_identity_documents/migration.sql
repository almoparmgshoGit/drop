-- Official details of staff: identity expiry, birth date, and a file of their documents and photo.

-- CreateEnum
CREATE TYPE "EmployeeDocumentKind" AS ENUM ('PHOTO', 'NATIONAL_ID', 'IQAMA', 'PASSPORT', 'DRIVING_LICENSE', 'CONTRACT', 'CERTIFICATE', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "idExpiryDate" DATE;

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "EmployeeDocumentKind" NOT NULL,
    "number" TEXT,
    "expiryDate" DATE,
    "note" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeDocument_userId_kind_idx" ON "EmployeeDocument"("userId", "kind");

-- CreateIndex
CREATE INDEX "EmployeeDocument_expiryDate_idx" ON "EmployeeDocument"("expiryDate");

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


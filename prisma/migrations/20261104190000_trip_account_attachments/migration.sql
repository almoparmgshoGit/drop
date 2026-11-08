-- An uploaded invoice replaces the typed invoice number.
ALTER TABLE "TripAccountEntry" DROP COLUMN "invoiceNumber";

-- CreateTable
CREATE TABLE "TripAccountAttachment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripAccountAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripAccountAttachment_entryId_idx" ON "TripAccountAttachment"("entryId");

-- AddForeignKey
ALTER TABLE "TripAccountAttachment" ADD CONSTRAINT "TripAccountAttachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TripAccountEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

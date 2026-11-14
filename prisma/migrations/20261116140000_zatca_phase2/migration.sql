-- ZATCA phase 2 (integration): signed documents, their hash chain and the reporting queue.
CREATE TYPE "ZatcaDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

CREATE TYPE "ZatcaStatus" AS ENUM ('PENDING', 'REPORTED', 'WARNING', 'REJECTED', 'FAILED');

CREATE TABLE "ZatcaDocument" (
    "id" TEXT NOT NULL,
    "kind" "ZatcaDocumentKind" NOT NULL,
    "invoiceId" TEXT,
    "creditNoteId" TEXT,
    "environment" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "icv" INTEGER,
    "invoiceHash" TEXT,
    "previousHash" TEXT,
    "xml" TEXT,
    "qr" TEXT,
    "signedAt" TIMESTAMP(3),
    "status" "ZatcaStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "response" JSONB,
    "errorMessage" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZatcaDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZatcaDocument_invoiceId_key" ON "ZatcaDocument"("invoiceId");

CREATE UNIQUE INDEX "ZatcaDocument_creditNoteId_key" ON "ZatcaDocument"("creditNoteId");

CREATE UNIQUE INDEX "ZatcaDocument_uuid_key" ON "ZatcaDocument"("uuid");

CREATE UNIQUE INDEX "ZatcaDocument_environment_icv_key" ON "ZatcaDocument"("environment", "icv");

CREATE INDEX "ZatcaDocument_status_nextAttemptAt_idx" ON "ZatcaDocument"("status", "nextAttemptAt");

CREATE INDEX "ZatcaDocument_environment_signedAt_idx" ON "ZatcaDocument"("environment", "signedAt");

ALTER TABLE "ZatcaDocument" ADD CONSTRAINT "ZatcaDocument_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ZatcaDocument" ADD CONSTRAINT "ZatcaDocument_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

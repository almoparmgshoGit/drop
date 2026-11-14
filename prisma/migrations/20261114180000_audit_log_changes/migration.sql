-- The audit log keeps what a write changed: the record compared and each field's value before and after it.
ALTER TABLE "AuditLog" ADD COLUMN "recordType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "recordId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "changes" JSONB;

CREATE INDEX "AuditLog_recordId_idx" ON "AuditLog"("recordId");
CREATE INDEX "AuditLog_recordType_createdAt_idx" ON "AuditLog"("recordType", "createdAt");

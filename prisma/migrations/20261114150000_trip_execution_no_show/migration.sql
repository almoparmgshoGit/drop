-- A trip is executed (منفذة) once its boarding closes, an hour after departure at the earliest; passengers who had not boarded are then no-shows (لم يحضر).
ALTER TABLE "Trip" ADD COLUMN "executedAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "financeClosedAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "financeClosedByName" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "noShowAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "returnNoShowAt" TIMESTAMP(3);

-- The sweep looks for published or completed trips not yet executed.
CREATE INDEX "Trip_executedAt_idx" ON "Trip"("executedAt");

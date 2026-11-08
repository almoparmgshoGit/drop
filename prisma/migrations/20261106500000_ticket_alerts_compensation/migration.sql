ALTER TYPE "WalletTransactionType" ADD VALUE 'COMPENSATION';

ALTER TABLE "Booking" ADD COLUMN "lateAlertAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "stoppedAlertAt" TIMESTAMP(3);

CREATE TABLE "TicketCompensation" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketCompensation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketCompensation_bookingId_key" ON "TicketCompensation"("bookingId");
CREATE INDEX "TicketCompensation_createdAt_idx" ON "TicketCompensation"("createdAt");

ALTER TABLE "TicketCompensation" ADD CONSTRAINT "TicketCompensation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Whoever may already decide refunds starts with this; the manager can change it per rank.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'bookings.compensate')
  WHERE 'cancellations.approve' = ANY("permissions") AND NOT 'bookings.compensate' = ANY("permissions");

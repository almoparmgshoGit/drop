-- A status for each ticket (مؤكدة / ملغية), with who cancelled it, when and why.
CREATE TYPE "TicketStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

ALTER TABLE "Ticket"
  ADD COLUMN "status" "TicketStatus" NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "cancelledByName" TEXT,
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledSeatNumber" TEXT,
  ADD COLUMN "refundAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "keptAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "BookingPassenger" ADD COLUMN "cancelled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Ticket_status_cancelledAt_idx" ON "Ticket"("status", "cancelledAt");
CREATE INDEX "BookingPassenger_bookingId_cancelled_idx" ON "BookingPassenger"("bookingId", "cancelled");

-- Tickets of bookings already cancelled read as cancelled, with the booking's review as their record.
UPDATE "Ticket" t
SET "status" = 'CANCELLED',
    "cancelledAt" = COALESCE(b."cancelReviewedAt", b."updatedAt"),
    "cancelledById" = b."cancelReviewedById",
    "cancelledByName" = u."name",
    "cancelReason" = COALESCE(b."cancelReviewNote", b."cancelReason")
FROM "Booking" b
LEFT JOIN "User" u ON u."id" = b."cancelReviewedById"
WHERE t."bookingId" = b."id" AND b."status" = 'CANCELLED';

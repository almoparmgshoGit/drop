-- What the customer may read about a cancellation, kept apart from the staff's internal reason.
ALTER TABLE "Booking" ADD COLUMN "cancelCustomerNote" TEXT;

-- A rejection's note was always written for the customer. Approved requests cannot be told apart from admin cancellations, so they stay hidden.
UPDATE "Booking" SET "cancelCustomerNote" = "cancelReviewNote" WHERE "status" <> 'CANCELLED' AND "cancelReviewNote" IS NOT NULL;

-- Daily limits on manual point changes are counted per employee.
ALTER TABLE "LoyaltyTransaction" ADD COLUMN "createdById" TEXT;

-- Whoever could already approve refunds keeps deciding above the policy, until the manager turns it off for that rank.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'refunds.override_policy')
  WHERE 'cancellations.approve' = ANY("permissions") AND NOT 'refunds.override_policy' = ANY("permissions");

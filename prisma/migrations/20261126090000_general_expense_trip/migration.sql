-- A branch expense can name the trip it was spent on; it shows on that trip's account as a reference.
ALTER TABLE "GeneralExpense" ADD COLUMN "tripId" TEXT;
CREATE INDEX "GeneralExpense_tripId_idx" ON "GeneralExpense"("tripId");
ALTER TABLE "GeneralExpense" ADD CONSTRAINT "GeneralExpense_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

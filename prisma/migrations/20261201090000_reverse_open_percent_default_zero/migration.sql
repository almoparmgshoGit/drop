-- A new trip reminds staff about its reverse from the start unless another percent is set; existing trips keep theirs.
ALTER TABLE "Trip" ALTER COLUMN "reverseOpenPercent" SET DEFAULT 0;

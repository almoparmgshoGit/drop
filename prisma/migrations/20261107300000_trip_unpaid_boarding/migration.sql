-- Whether a passenger who still owes money may board, chosen per trip by whoever creates it.
CREATE TYPE "UnpaidBoardingPolicy" AS ENUM ('BLOCK', 'WARN');

ALTER TABLE "Trip" ADD COLUMN "unpaidBoarding" "UnpaidBoardingPolicy" NOT NULL DEFAULT 'BLOCK';

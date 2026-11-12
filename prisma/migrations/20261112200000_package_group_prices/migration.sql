-- A package is sold to one to four people, each group size at its own total. Existing packages keep charging per person.
ALTER TABLE "Package" ADD COLUMN "price2" DECIMAL(10,2);
ALTER TABLE "Package" ADD COLUMN "price3" DECIMAL(10,2);
ALTER TABLE "Package" ADD COLUMN "price4" DECIMAL(10,2);

UPDATE "Package" SET "price2" = "price" * 2, "price3" = "price" * 3, "price4" = "price" * 4;

ALTER TABLE "Package" ALTER COLUMN "price2" SET NOT NULL;
ALTER TABLE "Package" ALTER COLUMN "price3" SET NOT NULL;
ALTER TABLE "Package" ALTER COLUMN "price4" SET NOT NULL;

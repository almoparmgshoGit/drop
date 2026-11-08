-- The document a customer registers with: national ID, iqama or passport.
CREATE TYPE "IdType" AS ENUM ('NATIONAL_ID', 'IQAMA', 'PASSPORT');

ALTER TABLE "User" ADD COLUMN "idType" "IdType";
ALTER TABLE "User" ADD COLUMN "idNumber" TEXT;

-- One account per document; rows without one are not compared (NULLs are distinct).
CREATE UNIQUE INDEX "User_idType_idNumber_key" ON "User"("idType", "idNumber");
CREATE INDEX "User_idNumber_idx" ON "User"("idNumber");

-- Browsing the customers and bookings tables is now its own permission. Everyone who could browse them
-- before keeps that ability; a manager removes it from a rank or an employee to leave them search only.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'customers.list')
  WHERE 'customers.view' = ANY("permissions") AND NOT ('customers.list' = ANY("permissions"));
UPDATE "Rank" SET "permissions" = array_append("permissions", 'bookings.list')
  WHERE 'bookings.view' = ANY("permissions") AND NOT ('bookings.list' = ANY("permissions"));
UPDATE "User" SET "extraPermissions" = array_append("extraPermissions", 'customers.list')
  WHERE 'customers.view' = ANY("extraPermissions") AND NOT ('customers.list' = ANY("extraPermissions"));
UPDATE "User" SET "extraPermissions" = array_append("extraPermissions", 'bookings.list')
  WHERE 'bookings.view' = ANY("extraPermissions") AND NOT ('bookings.list' = ANY("extraPermissions"));

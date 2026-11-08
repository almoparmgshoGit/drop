-- CreateEnum
CREATE TYPE "BookingKind" AS ENUM ('TRANSPORT_ROUND', 'TRANSPORT_OUTBOUND', 'TRANSPORT_RETURN', 'PACKAGE_ROUND_STAY', 'PACKAGE_OUTBOUND_STAY', 'PACKAGE_STAY_RETURN', 'PACKAGE_ROUND_NO_STAY');
CREATE TYPE "BookingLeg" AS ENUM ('OUTBOUND', 'RETURN');

-- A branch is now a full record, not only a drawer's name.
ALTER TABLE "Branch"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "workingHours" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "managerId" TEXT;
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");
CREATE INDEX "Branch_managerId_idx" ON "Branch"("managerId");
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What one employee holds beyond their rank, or does not get from it.
ALTER TABLE "User"
  ADD COLUMN "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "revokedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Booking"
  ADD COLUMN "kind" "BookingKind",
  ADD COLUMN "leg" "BookingLeg",
  ADD COLUMN "stayHotelId" TEXT,
  ADD COLUMN "stayCheckIn" DATE,
  ADD COLUMN "stayCheckOut" DATE,
  ADD COLUMN "stayNights" INTEGER,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "createdByName" TEXT;
CREATE INDEX "Booking_stayHotelId_idx" ON "Booking"("stayHotelId");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_stayHotelId_fkey" FOREIGN KEY ("stayHotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Branch receipts read DR-1001, DR-1002 and so on. Numbers lost to a failed save are harmless: tax documents have their own series.
CREATE SEQUENCE "BranchReceiptNumber" START WITH 1001;

-- Anyone who could read every booking keeps doing so, until the manager limits that rank to its branch.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'bookings.all_branches')
  WHERE 'bookings.view' = ANY("permissions") AND NOT 'bookings.all_branches' = ANY("permissions");
-- Whoever already takes money at a counter is who the new booking screen is for.
UPDATE "Rank" SET "permissions" = array_append("permissions", 'bookings.create')
  WHERE 'collections.collect' = ANY("permissions") AND NOT 'bookings.create' = ANY("permissions");
UPDATE "Rank" SET "permissions" = array_append("permissions", 'branches.view')
  WHERE ('branches.manage' = ANY("permissions") OR 'employees.manage' = ANY("permissions")) AND NOT 'branches.view' = ANY("permissions");
UPDATE "Rank" SET "permissions" = array_append("permissions", 'branches.all')
  WHERE 'branches.manage' = ANY("permissions") AND NOT 'branches.all' = ANY("permissions");

-- Starting ranks for branch work. They are ordinary ranks: the manager can edit or delete them.
INSERT INTO "JobType" ("id", "name", "description", "tripRole", "isSystem") VALUES
  ('job-branch', 'موظفو الفروع', 'العمل على كاونتر الفرع: الحجز والتحصيل والصندوق', 'NONE', false)
  ON CONFLICT DO NOTHING;

INSERT INTO "Rank" ("id", "name", "description", "role", "jobId", "permissions")
SELECT ranks."id", ranks."name", ranks."description", 'STAFF', job."id", ranks."permissions"
FROM (VALUES
  ('rank-branch-manager', 'مدير فرع', 'يدير فرعه: موظفيه وصندوقه وحجوزاته وتعديل الأسعار', ARRAY[
    'trips.view', 'bookings.view', 'bookings.create', 'bookings.price_override', 'bookings.edit', 'bookings.cancel', 'bookings.export', 'cancellations.review',
    'manifests.view', 'hotels.view', 'packages.view', 'cash.view', 'cash.operate', 'custody.issue', 'custody.settle', 'collections.view', 'collections.collect',
    'invoices.view', 'customers.view', 'branches.view', 'branches.staff'
  ]),
  ('rank-branch-clerk', 'موظف حجوزات فرع', 'يسجل الحجوزات والباقات ويحصّل قيمتها في فرعه', ARRAY[
    'trips.view', 'bookings.view', 'bookings.create', 'bookings.edit', 'manifests.view', 'hotels.view', 'packages.view', 'cash.view', 'collections.view', 'collections.collect',
    'invoices.view', 'customers.view', 'branches.view'
  ]),
  ('rank-branch-cashier', 'أمين صندوق', 'يفتح صندوق فرعه ويقفله ويحصّل المتبقي ويصرف العهد', ARRAY[
    'bookings.view', 'cash.view', 'cash.operate', 'custody.issue', 'custody.settle', 'collections.view', 'collections.collect', 'invoices.view', 'branches.view'
  ])
) AS ranks("id", "name", "description", "permissions")
CROSS JOIN (SELECT "id" FROM "JobType" WHERE "name" = 'موظفو الفروع') AS job
ON CONFLICT DO NOTHING;

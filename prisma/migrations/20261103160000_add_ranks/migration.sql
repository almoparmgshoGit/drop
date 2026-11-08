-- CreateTable
CREATE TABLE "Rank" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "role" "Role" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rank_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Rank_name_key" ON "Rank"("name");

-- AlterTable
ALTER TABLE "User" ADD COLUMN "rankId" TEXT;

-- CreateIndex
CREATE INDEX "User_rankId_idx" ON "User"("rankId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "Rank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- "موظف تشغيل" and "سائق" grant exactly what those roles could already do, so nobody's access changes when this runs.
INSERT INTO "Rank" ("id", "name", "description", "role", "permissions", "isSystem") VALUES
  ('rank-admin', 'مدير عام', 'كل الصلاحيات، ولا يمكن تعديلها', 'ADMIN', ARRAY[]::TEXT[], true),
  ('rank-staff', 'موظف تشغيل', 'صلاحيات الموظف قبل نظام الرتب', 'STAFF', ARRAY[
    'dashboard.view', 'trips.view', 'bookings.view', 'bookings.edit', 'cancellations.review', 'manifests.view',
    'hotels.view', 'hotels.book', 'buses.view', 'packages.view', 'customers.view', 'loyalty.view', 'employees.view',
    'crew.trips', 'crew.manifest', 'crew.board', 'crew.track'
  ], false),
  ('rank-driver', 'سائق', 'الرحلات المسندة إليه في التطبيق', 'DRIVER', ARRAY['crew.trips', 'crew.manifest', 'crew.board', 'crew.track'], false),
  ('rank-supervisor', 'مشرف رحلة', 'الرحلات المسندة إليه في التطبيق فقط، دون لوحة الإدارة', 'STAFF', ARRAY['crew.trips', 'crew.manifest', 'crew.board', 'crew.track'], false),
  ('rank-operations', 'مدير عمليات', 'إدارة التشغيل اليومي', 'STAFF', ARRAY[
    'dashboard.view', 'trips.view', 'trips.manage', 'bookings.view', 'bookings.edit', 'bookings.unboard', 'bookings.cancel', 'bookings.export',
    'cancellations.review', 'manifests.view', 'manifests.inventory', 'hotels.view', 'hotels.book', 'hotels.rates', 'hotels.manage',
    'buses.view', 'buses.manage', 'packages.view', 'packages.manage', 'customers.view', 'loyalty.view', 'coupons.manage',
    'employees.view', 'audit.view', 'crew.trips', 'crew.manifest', 'crew.board', 'crew.track'
  ], false),
  ('rank-bookings', 'موظف حجوزات', 'الحجوزات وخدمة العملاء', 'STAFF', ARRAY[
    'dashboard.view', 'trips.view', 'bookings.view', 'bookings.edit', 'manifests.view', 'hotels.view', 'buses.view', 'packages.view',
    'customers.view', 'loyalty.view'
  ], false),
  ('rank-accountant', 'محاسب', 'الاسترداد والمحافظ والتكاليف', 'STAFF', ARRAY[
    'dashboard.view', 'trips.view', 'bookings.view', 'bookings.export', 'cancellations.review', 'cancellations.approve',
    'hotels.view', 'hotels.rates', 'packages.view', 'customers.view', 'wallet.adjust', 'loyalty.view', 'loyalty.adjust'
  ], false);

UPDATE "User" SET "rankId" = 'rank-admin' WHERE "role" = 'ADMIN';
UPDATE "User" SET "rankId" = 'rank-staff' WHERE "role" = 'STAFF';
UPDATE "User" SET "rankId" = 'rank-driver' WHERE "role" = 'DRIVER';

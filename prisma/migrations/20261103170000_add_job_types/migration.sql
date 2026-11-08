-- CreateEnum
CREATE TYPE "JobTripRole" AS ENUM ('NONE', 'DRIVER', 'SUPERVISOR');

-- CreateTable
CREATE TABLE "JobType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tripRole" "JobTripRole" NOT NULL DEFAULT 'NONE',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobType_name_key" ON "JobType"("name");

INSERT INTO "JobType" ("id", "name", "description", "tripRole", "isSystem") VALUES
  ('job-admin', 'إدارة عليا', 'وظيفة المدير العام، ولا يمكن تعديلها', 'NONE', true),
  ('job-operations', 'إدارة التشغيل', 'يمكن إسناد الرحلات إليها كمشرفين', 'SUPERVISOR', false),
  ('job-supervisor', 'مشرف رحلات', 'يعمل على الرحلات من التطبيق', 'SUPERVISOR', false),
  ('job-driver', 'سائق', 'يقود الحافلات في الرحلات المسندة إليه', 'DRIVER', false),
  ('job-office', 'موظف مكتب', 'عمل مكتبي دون إسناد رحلات', 'NONE', false);

-- AlterTable
ALTER TABLE "Rank" ADD COLUMN "jobId" TEXT;

-- Ranks already able to board passengers stay assignable as supervisors, so the trip screen offers the same people as before.
UPDATE "Rank" SET "jobId" = CASE
  WHEN "role" = 'ADMIN' THEN 'job-admin'
  WHEN "role" = 'DRIVER' THEN 'job-driver'
  WHEN "id" = 'rank-supervisor' THEN 'job-supervisor'
  WHEN 'crew.board' = ANY("permissions") THEN 'job-operations'
  ELSE 'job-office'
END;

ALTER TABLE "Rank" ALTER COLUMN "jobId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Rank_jobId_idx" ON "Rank"("jobId");

-- AddForeignKey
ALTER TABLE "Rank" ADD CONSTRAINT "Rank_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "JobType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

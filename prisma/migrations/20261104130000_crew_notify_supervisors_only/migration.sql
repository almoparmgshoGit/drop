-- Notifying passengers belongs to trip supervisors, so ranks of any other job lose the permission granted with the feature.
UPDATE "Rank"
SET "permissions" = array_remove("permissions", 'crew.notify')
FROM "JobType"
WHERE "JobType"."id" = "Rank"."jobId" AND "JobType"."tripRole" <> 'SUPERVISOR';

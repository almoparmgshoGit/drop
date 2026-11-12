-- Data only: the Wi-Fi service seeded by 20261104160000_bus_services is named "واي فاي مجاني" (free Wi-Fi), as customers
-- see it, and carries the Wi-Fi icon. Only a service still carrying the exact seeded name is renamed, and never onto a name
-- another service already uses ("name" is unique). Services staff named differently are left alone.
UPDATE "Service"
SET "name" = 'واي فاي مجاني'
WHERE "name" = 'واي فاي'
  AND NOT EXISTS (SELECT 1 FROM "Service" WHERE "name" = 'واي فاي مجاني');

UPDATE "Service"
SET "icon" = 'Wifi'
WHERE "name" = 'واي فاي مجاني'
  AND "icon" IS NULL;

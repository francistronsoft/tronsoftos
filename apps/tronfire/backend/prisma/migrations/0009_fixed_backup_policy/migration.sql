ALTER TABLE "ManagedDatabase" ALTER COLUMN "backupFrequencyMinutes" SET DEFAULT 10;
ALTER TABLE "ManagedDatabase" ALTER COLUMN "retentionDays" SET DEFAULT 30;
UPDATE "ManagedDatabase"
SET
  "backupFrequencyMinutes" = 10,
  "retentionDays" = 30,
  "backupScheduleUpdatedAt" = NOW()
WHERE
  "backupFrequencyMinutes" IS DISTINCT FROM 10
  OR "retentionDays" IS DISTINCT FROM 30;

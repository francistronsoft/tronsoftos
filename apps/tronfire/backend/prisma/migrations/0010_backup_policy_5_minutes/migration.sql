ALTER TABLE "ManagedDatabase" ALTER COLUMN "backupFrequencyMinutes" SET DEFAULT 5;
UPDATE "ManagedDatabase"
SET
  "backupFrequencyMinutes" = 5,
  "backupScheduleUpdatedAt" = NOW()
WHERE
  "backupFrequencyMinutes" IS DISTINCT FROM 5;

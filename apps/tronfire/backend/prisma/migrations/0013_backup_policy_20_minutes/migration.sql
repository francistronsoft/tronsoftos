ALTER TABLE "ManagedDatabase" ALTER COLUMN "backupFrequencyMinutes" SET DEFAULT 20;

UPDATE "ManagedDatabase"
SET
  "backupFrequencyMinutes" = 20,
  "backupScheduleUpdatedAt" = NOW()
WHERE
  "backupFrequencyMinutes" IS DISTINCT FROM 20;

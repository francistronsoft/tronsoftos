ALTER TABLE "ManagedDatabase" ALTER COLUMN "backupFrequencyMinutes" SET DEFAULT 15;

UPDATE "ManagedDatabase"
SET
  "backupFrequencyMinutes" = 15,
  "backupScheduleUpdatedAt" = NOW()
WHERE
  "backupFrequencyMinutes" IS DISTINCT FROM 15;

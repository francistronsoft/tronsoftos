ALTER TABLE "ManagedDatabase" ALTER COLUMN "backupFrequencyMinutes" SET DEFAULT 20;
UPDATE "ManagedDatabase" SET "backupFrequencyMinutes" = 20 WHERE "backupFrequencyMinutes" = 60;

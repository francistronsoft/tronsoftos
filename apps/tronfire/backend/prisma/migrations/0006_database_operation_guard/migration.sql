ALTER TABLE "ManagedDatabase" ADD COLUMN "operationStatus" TEXT NOT NULL DEFAULT 'IDLE';
ALTER TABLE "ManagedDatabase" ADD COLUMN "operationKind" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN "operationToken" TEXT;
ALTER TABLE "ManagedDatabase" ADD COLUMN "operationStartedAt" TIMESTAMP(3);
ALTER TABLE "ManagedDatabase" ADD COLUMN "operationExpiresAt" TIMESTAMP(3);
ALTER TABLE "ManagedDatabase" ADD COLUMN "operationMessage" TEXT;

CREATE TABLE "FirebirdConnectionSnapshot" (
  "id" TEXT NOT NULL,
  "databaseId" TEXT NOT NULL,
  "totalConnections" INTEGER NOT NULL,
  "sourceNode" TEXT,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FirebirdConnectionSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FirebirdSession" (
  "id" TEXT NOT NULL,
  "sessionKey" TEXT NOT NULL,
  "databaseId" TEXT NOT NULL,
  "attachmentId" INTEGER,
  "user" TEXT,
  "remoteAddress" TEXT,
  "remoteProcess" TEXT,
  "remotePid" INTEGER,
  "connectedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "disconnectedAt" TIMESTAMP(3),
  "lastState" TEXT,
  "sourceNode" TEXT,
  CONSTRAINT "FirebirdSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FirebirdSession_sessionKey_key" ON "FirebirdSession"("sessionKey");
CREATE INDEX "FirebirdConnectionSnapshot_databaseId_collectedAt_idx" ON "FirebirdConnectionSnapshot"("databaseId", "collectedAt");
CREATE INDEX "FirebirdSession_databaseId_lastSeenAt_idx" ON "FirebirdSession"("databaseId", "lastSeenAt");
CREATE INDEX "FirebirdSession_databaseId_disconnectedAt_idx" ON "FirebirdSession"("databaseId", "disconnectedAt");
CREATE INDEX "FirebirdSession_remoteAddress_idx" ON "FirebirdSession"("remoteAddress");
CREATE INDEX "FirebirdSession_remoteProcess_idx" ON "FirebirdSession"("remoteProcess");

ALTER TABLE "FirebirdConnectionSnapshot"
  ADD CONSTRAINT "FirebirdConnectionSnapshot_databaseId_fkey"
  FOREIGN KEY ("databaseId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FirebirdSession"
  ADD CONSTRAINT "FirebirdSession_databaseId_fkey"
  FOREIGN KEY ("databaseId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

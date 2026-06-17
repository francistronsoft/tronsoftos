#!/usr/bin/env bash
set -euo pipefail

POSTGRES_CONTAINER="${TRONFIRE_POSTGRES_CONTAINER:-tronfire_postgres}"
POSTGRES_DB="${TRONFIRE_POSTGRES_DB:-tronfire}"
POSTGRES_USER="${TRONFIRE_POSTGRES_USER:-tronfire}"
DUMP_FILE="${1:-${TRONFIRE_CATALOG_DUMP:-/opt/tronsoftos/state/tronfire-catalog/tronfire_catalog_latest.dump}}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump nao encontrado: $DUMP_FILE" >&2
  exit 66
fi

docker exec -i "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 <<'SQL' || true
DROP TABLE IF EXISTS "_tronsoftos_ha_standby_state";
CREATE TABLE "_tronsoftos_ha_standby_state" AS
SELECT
  id,
  "standbyPath",
  "standbyStatus",
  "lastStandbyBackupAt",
  "lastStandbyValidatedAt",
  "lastStandbyBackupSha256"
FROM "ManagedDatabase";
SQL

cat "$DUMP_FILE" | docker exec -i "$POSTGRES_CONTAINER" pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner

docker exec -i "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  UPDATE "BackupJob"
  SET
    "status" = 'FAILED',
    "finishedAt" = COALESCE("finishedAt", NOW())
  WHERE "status" = 'RUNNING';

  IF to_regclass('"_tronsoftos_ha_standby_state"') IS NOT NULL THEN
    UPDATE "ManagedDatabase" db
    SET
      "standbyPath" = state."standbyPath",
      "standbyStatus" = state."standbyStatus",
      "lastStandbyBackupAt" = state."lastStandbyBackupAt",
      "lastStandbyValidatedAt" = state."lastStandbyValidatedAt",
      "lastStandbyBackupSha256" = state."lastStandbyBackupSha256"
    FROM "_tronsoftos_ha_standby_state" state
    WHERE db.id = state.id
      AND state."standbyStatus" IS NOT NULL
      AND state."standbyStatus" <> 'DISABLED';

    DROP TABLE "_tronsoftos_ha_standby_state";
  END IF;
END $$;
SQL

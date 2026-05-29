#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronos}"
STANDBY_HOST="${HA_SYNC_STANDBY_HOST:?missing HA_SYNC_STANDBY_HOST}"
SSH_USER="${HA_SYNC_SSH_USER:-tronsoftos}"
SSH_PORT="${HA_SYNC_SSH_PORT:-22}"
REMOTE_BACKUP_DIR="${HA_SYNC_REMOTE_BACKUP_DIR:-/opt/tronfire-storage/firebird/backups}"
REMOTE_CATALOG_DIR="${HA_SYNC_REMOTE_CATALOG_DIR:-/opt/tronos/state/tronfire-catalog}"
BACKUP_DIR="${FIREBIRD_BACKUP_DIR:-/opt/tronfire-storage/firebird/backups}"
CATALOG_DIR="${TRONFIRE_CATALOG_EXPORT_DIR:-${APP_DIR}/state/tronfire-catalog}"
LOG_DIR="${TRONSOFTOS_LOG_DIR:-${APP_DIR}/logs}/ha-sync"
STAMP="$(date +%Y%m%d%H%M%S)"
LOG_FILE="${LOG_DIR}/ha-sync-${STAMP}.log"
KNOWN_HOSTS="${TRONSOFTOS_SSH_KNOWN_HOSTS:-${APP_DIR}/state/known_hosts}"
SSH_BASE_OPTS="-p ${SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}"
RSYNC_SSH="ssh ${SSH_BASE_OPTS}"

mkdir -p "$LOG_DIR" "$CATALOG_DIR" "$(dirname "$KNOWN_HOSTS")"
touch "$KNOWN_HOSTS"
chmod 700 "$(dirname "$KNOWN_HOSTS")" 2>/dev/null || true
chmod 600 "$KNOWN_HOSTS" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[ha-sync] inicio $(date -Is)"
echo "[ha-sync] destino ${SSH_USER}@${STANDBY_HOST}:${REMOTE_BACKUP_DIR}"

echo "[ha-sync] exportando catalogo PostgreSQL do TronFire"
TRONSOFTOS_APP_DIR="$APP_DIR" TRONFIRE_CATALOG_EXPORT_DIR="$CATALOG_DIR" bash "$APP_DIR/scripts/tronfire-catalog-export.sh"

echo "[ha-sync] preparando diretorios no standby"
ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" "mkdir -p '$REMOTE_BACKUP_DIR' '$REMOTE_CATALOG_DIR'"

echo "[ha-sync] sincronizando backups Firebird"
rsync -aHAX --numeric-ids \
  -e "$RSYNC_SSH" \
  --include='*.gbk' \
  --include='*.fbk' \
  --include='*.gbk.gz' \
  --include='*.fbk.gz' \
  --include='*.manifest.json' \
  --exclude='*' \
  "${BACKUP_DIR%/}/" \
  "${SSH_USER}@${STANDBY_HOST}:${REMOTE_BACKUP_DIR%/}/"

echo "[ha-sync] sincronizando catalogo TronFire/PostgreSQL"
rsync -aHAX --numeric-ids \
  -e "$RSYNC_SSH" \
  --include='*.dump' \
  --include='*.sha256' \
  --exclude='*' \
  "${CATALOG_DIR%/}/" \
  "${SSH_USER}@${STANDBY_HOST}:${REMOTE_CATALOG_DIR%/}/"

echo "[ha-sync] concluido $(date -Is)"
echo "[ha-sync] log $LOG_FILE"

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
AUTO_RESTORE_STANDBY="${HA_SYNC_AUTO_RESTORE_STANDBY:-true}"
STANDBY_TRONFIRE_URL="${HA_SYNC_STANDBY_TRONFIRE_URL:-http://127.0.0.1:${TRONFIRE_PANEL_PORT:-8081}}"
INTERNAL_TOKEN="${TRONSOFTOS_INTERNAL_TOKEN:-}"
if [ -z "$INTERNAL_TOKEN" ] && [ -f "${TRONSOFTOS_CLUSTER_SECRETS:-${APP_DIR}/state/cluster-secrets.env}" ]; then
  INTERNAL_TOKEN="$(grep '^TRONSOFTOS_INTERNAL_TOKEN=' "${TRONSOFTOS_CLUSTER_SECRETS:-${APP_DIR}/state/cluster-secrets.env}" | tail -n1 | cut -d= -f2- || true)"
fi
LOG_DIR="${TRONSOFTOS_LOG_DIR:-${APP_DIR}/logs}/ha-sync"
STAMP="$(date +%Y%m%d%H%M%S)"
LOG_FILE="${LOG_DIR}/ha-sync-${STAMP}.log"
KNOWN_HOSTS="${TRONSOFTOS_SSH_KNOWN_HOSTS:-${APP_DIR}/state/known_hosts}"
IDENTITY_FILE="${TRONSOFTOS_SSH_IDENTITY_FILE:-${APP_DIR}/state/ssh/id_ed25519}"
SSH_BASE_OPTS="-p ${SSH_PORT} -i ${IDENTITY_FILE} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}"
RSYNC_SSH="ssh ${SSH_BASE_OPTS}"

mkdir -p "$LOG_DIR" "$CATALOG_DIR" "$(dirname "$KNOWN_HOSTS")"
[ -f "$IDENTITY_FILE" ] || { echo "[ha-sync] chave SSH nao encontrada: $IDENTITY_FILE" >&2; exit 1; }
touch "$KNOWN_HOSTS"
chmod 700 "$(dirname "$KNOWN_HOSTS")" 2>/dev/null || true
chmod 600 "$KNOWN_HOSTS" 2>/dev/null || true
chmod 600 "$IDENTITY_FILE" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[ha-sync] inicio $(date -Is)"
echo "[ha-sync] destino ${SSH_USER}@${STANDBY_HOST}:${REMOTE_BACKUP_DIR}"

echo "[ha-sync] exportando catalogo PostgreSQL do TronFire"
TRONSOFTOS_APP_DIR="$APP_DIR" TRONFIRE_CATALOG_EXPORT_DIR="$CATALOG_DIR" bash "$APP_DIR/scripts/tronfire-catalog-export.sh"

echo "[ha-sync] preparando diretorios no standby"
ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" "mkdir -p '$REMOTE_BACKUP_DIR' '$REMOTE_CATALOG_DIR'"

VALID_BACKUP_LIST="$(mktemp)"
RESTORE_LIST="$(mktemp)"
trap 'rm -f "$VALID_BACKUP_LIST" "$RESTORE_LIST"' EXIT
declare -A latest_backup_by_alias=()
declare -A latest_manifest_by_alias=()
declare -A latest_key_by_alias=()
while IFS= read -r manifest; do
  if ! grep -q '"validation"' "$manifest" || ! grep -q '"ok": true' "$manifest"; then
    continue
  fi
  backup_path="$(sed -n 's/.*"backupPath": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  alias="$(sed -n 's/.*"databaseAlias": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  finished_at="$(sed -n 's/.*"backupFinishedAt": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  key="${finished_at:-$(basename "$manifest")}"
  [ -f "$backup_path" ] || continue
  [ -n "$alias" ] || continue
  printf '%s\n' "$(basename "$backup_path")" "$(basename "$manifest")" >> "$VALID_BACKUP_LIST"
  if [ -z "${latest_key_by_alias[$alias]:-}" ] || [[ "$key" > "${latest_key_by_alias[$alias]}" ]]; then
    latest_key_by_alias[$alias]="$key"
    latest_backup_by_alias[$alias]="$backup_path"
    latest_manifest_by_alias[$alias]="$manifest"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.manifest.json')

for alias in "${!latest_backup_by_alias[@]}"; do
  printf '%s|%s|%s\n' \
    "$alias" \
    "${REMOTE_BACKUP_DIR%/}/$(basename "${latest_backup_by_alias[$alias]}")" \
    "${REMOTE_BACKUP_DIR%/}/$(basename "${latest_manifest_by_alias[$alias]}")" \
    >> "$RESTORE_LIST"
done

echo "[ha-sync] sincronizando backups Firebird"
if [ -s "$VALID_BACKUP_LIST" ]; then
  rsync -aHAX --numeric-ids \
    -e "$RSYNC_SSH" \
    --files-from="$VALID_BACKUP_LIST" \
    "${BACKUP_DIR%/}/" \
    "${SSH_USER}@${STANDBY_HOST}:${REMOTE_BACKUP_DIR%/}/"
else
  echo "[ha-sync] nenhum backup validado para sincronizar"
fi

echo "[ha-sync] sincronizando catalogo TronFire/PostgreSQL"
rsync -aHAX --numeric-ids \
  -e "$RSYNC_SSH" \
  --include='*.dump' \
  --include='*.sha256' \
  --exclude='*' \
  "${CATALOG_DIR%/}/" \
  "${SSH_USER}@${STANDBY_HOST}:${REMOTE_CATALOG_DIR%/}/"

echo "[ha-sync] importando catalogo TronFire no standby"
ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
  "TRONSOFTOS_APP_DIR='$APP_DIR' bash '$APP_DIR/scripts/tronfire-catalog-import.sh' '${REMOTE_CATALOG_DIR%/}/tronfire_catalog_latest.dump'"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$AUTO_RESTORE_STANDBY" = "true" ]; then
  if [ -z "$INTERNAL_TOKEN" ]; then
    echo "[ha-sync] restore standby automatico habilitado, mas TRONSOFTOS_INTERNAL_TOKEN nao esta configurado" >&2
    exit 2
  fi
  if [ -s "$RESTORE_LIST" ]; then
    echo "[ha-sync] restaurando backups validados no standby"
    while IFS='|' read -r alias remote_backup remote_manifest; do
      [ -n "$alias" ] || continue
      body="{\"databaseAlias\":\"$(json_escape "$alias")\",\"backupPath\":\"$(json_escape "$remote_backup")\",\"manifestPath\":\"$(json_escape "$remote_manifest")\",\"logToken\":\"ha_sync_${STAMP}\"}"
      echo "[ha-sync] restore standby ${alias}: ${remote_backup}"
      ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
        "curl -fsS -X POST '${STANDBY_TRONFIRE_URL%/}/api/ha/standby/restore' -H 'content-type: application/json' -H 'x-tronsoftos-token: $INTERNAL_TOKEN' --data-binary '$body'"
    done < "$RESTORE_LIST"
  else
    echo "[ha-sync] nenhum backup validado para restaurar no standby"
  fi
else
  echo "[ha-sync] restore standby automatico desabilitado"
fi

echo "[ha-sync] concluido $(date -Is)"
echo "[ha-sync] log $LOG_FILE"

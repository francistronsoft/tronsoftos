#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronsoftos}"
STANDBY_HOST="${HA_SYNC_STANDBY_HOST:?missing HA_SYNC_STANDBY_HOST}"
HA_SYNC_MODE="${HA_SYNC_MODE:-physical}"
SSH_USER="${HA_SYNC_SSH_USER:-tronsoft}"
SSH_PORT="${HA_SYNC_SSH_PORT:-22}"
REMOTE_BACKUP_DIR="${HA_SYNC_REMOTE_BACKUP_DIR:-/opt/tronfire-storage/firebird/backups}"
REMOTE_RESTORE_DIR="${HA_SYNC_REMOTE_RESTORE_DIR:-/opt/tronfire-storage/firebird/restore-work}"
REMOTE_CATALOG_DIR="${HA_SYNC_REMOTE_CATALOG_DIR:-/tmp/tronfire-catalog}"
BACKUP_DIR="${FIREBIRD_BACKUP_DIR:-/opt/tronfire-storage/firebird/backups}"
DATA_DIR="${FIREBIRD_DATA_DIR:-/opt/tronfire-storage/firebird/data}"
CATALOG_DIR="${TRONFIRE_CATALOG_EXPORT_DIR:-${APP_DIR}/state/tronfire-catalog}"
AUTO_RESTORE_STANDBY="${HA_SYNC_AUTO_RESTORE_STANDBY:-true}"
STANDBY_TRONFIRE_URL="${HA_SYNC_STANDBY_TRONFIRE_URL:-http://127.0.0.1:${TRONFIRE_PANEL_PORT:-8081}}"
FIREBIRD_BIN="${FIREBIRD_BIN:-/usr/local/firebird/bin}"
FIREBIRD_PASSWORD="${FIREBIRD_PASSWORD:-masterkey}"
INTERNAL_TOKEN="${TRONSOFTOS_INTERNAL_TOKEN:-}"
if [ -z "$INTERNAL_TOKEN" ] && [ -f "${TRONSOFTOS_CLUSTER_SECRETS:-${APP_DIR}/state/cluster-secrets.env}" ]; then
  INTERNAL_TOKEN="$(grep '^TRONSOFTOS_INTERNAL_TOKEN=' "${TRONSOFTOS_CLUSTER_SECRETS:-${APP_DIR}/state/cluster-secrets.env}" | tail -n1 | cut -d= -f2- || true)"
fi
LOG_DIR="${TRONSOFTOS_LOG_DIR:-${APP_DIR}/logs}/ha-sync"
LOCK_FILE="${TRONSOFTOS_HA_SYNC_LOCK:-${APP_DIR}/state/ha-sync.lock}"
STAMP="$(date +%Y%m%d%H%M%S)"
LOG_FILE="${LOG_DIR}/ha-sync-${STAMP}.log"
KNOWN_HOSTS="${TRONSOFTOS_SSH_KNOWN_HOSTS:-${APP_DIR}/state/known_hosts}"
IDENTITY_FILE="${TRONSOFTOS_SSH_IDENTITY_FILE:-${APP_DIR}/state/ssh/id_ed25519}"
SSH_BASE_OPTS="-p ${SSH_PORT} -i ${IDENTITY_FILE} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS}"
RSYNC_SSH="ssh ${SSH_BASE_OPTS}"

mkdir -p "$LOG_DIR" "$CATALOG_DIR" "$(dirname "$KNOWN_HOSTS")" "$(dirname "$LOCK_FILE")"
[ -f "$IDENTITY_FILE" ] || { echo "[ha-sync] chave SSH nao encontrada: $IDENTITY_FILE" >&2; exit 1; }
touch "$KNOWN_HOSTS"
chmod 700 "$(dirname "$KNOWN_HOSTS")" 2>/dev/null || true
chmod 600 "$KNOWN_HOSTS" 2>/dev/null || true
chmod 600 "$IDENTITY_FILE" 2>/dev/null || true
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[ha-sync] outro sync/restore HA ja esta em execucao; ignorando esta rodada"
  exit 0
fi
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[ha-sync] inicio $(date -Is)"
echo "[ha-sync] modo ${HA_SYNC_MODE}"
echo "[ha-sync] destino ${SSH_USER}@${STANDBY_HOST}"

echo "[ha-sync] exportando catalogo PostgreSQL do TronFire"
TRONSOFTOS_APP_DIR="$APP_DIR" TRONFIRE_CATALOG_EXPORT_DIR="$CATALOG_DIR" bash "$APP_DIR/scripts/tronfire-catalog-export.sh"

echo "[ha-sync] preparando diretorios no standby"
ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" "mkdir -p '$REMOTE_BACKUP_DIR' '$REMOTE_RESTORE_DIR' '$REMOTE_CATALOG_DIR'"

VALID_BACKUP_LIST="$(mktemp)"
RESTORE_LIST="$(mktemp)"
SKIP_RESTORE_LIST="$(mktemp)"
trap 'rm -f "$VALID_BACKUP_LIST" "$RESTORE_LIST" "$SKIP_RESTORE_LIST"' EXIT
declare -A latest_backup_by_alias=()
declare -A latest_manifest_by_alias=()
declare -A latest_sha_by_alias=()
declare -A latest_key_by_alias=()
while IFS= read -r manifest; do
  if ! grep -q '"validation"' "$manifest" || ! grep -q '"ok": true' "$manifest"; then
    continue
  fi
  backup_path="$(sed -n 's/.*"backupPath": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  alias="$(sed -n 's/.*"databaseAlias": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  finished_at="$(sed -n 's/.*"backupFinishedAt": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  sha256="$(sed -n 's/.*"backupSha256": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  key="${finished_at:-$(basename "$manifest")}"
  [ -f "$backup_path" ] || continue
  [ -n "$alias" ] || continue
  printf '%s\n' "$(basename "$backup_path")" "$(basename "$manifest")" >> "$VALID_BACKUP_LIST"
  if [ -z "${latest_key_by_alias[$alias]:-}" ] || [[ "$key" > "${latest_key_by_alias[$alias]}" ]]; then
    latest_key_by_alias[$alias]="$key"
    latest_backup_by_alias[$alias]="$backup_path"
    latest_manifest_by_alias[$alias]="$manifest"
    latest_sha_by_alias[$alias]="$sha256"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.manifest.json')

for alias in "${!latest_backup_by_alias[@]}"; do
  printf '%s|%s|%s|%s\n' \
    "$alias" \
    "/firebird/backups/$(basename "${latest_backup_by_alias[$alias]}")" \
    "/firebird/backups/$(basename "${latest_manifest_by_alias[$alias]}")" \
    "${latest_sha_by_alias[$alias]:-}" \
    >> "$RESTORE_LIST"
done

echo "[ha-sync] sincronizando backups Firebird"
if [ "$HA_SYNC_MODE" != "backup_restore" ]; then
  echo "[ha-sync] modo ${HA_SYNC_MODE}: backup GBK nao sera sincronizado nesta rodada"
elif [ -s "$VALID_BACKUP_LIST" ]; then
  rsync -aHAX --no-owner --no-group \
    -e "$RSYNC_SSH" \
    --files-from="$VALID_BACKUP_LIST" \
    "${BACKUP_DIR%/}/" \
    "${SSH_USER}@${STANDBY_HOST}:${REMOTE_BACKUP_DIR%/}/"
else
  echo "[ha-sync] nenhum backup validado para sincronizar"
fi

echo "[ha-sync] sincronizando catalogo TronFire/PostgreSQL"
rsync -aHAX --no-owner --no-group \
  -e "$RSYNC_SSH" \
  --include='*.dump' \
  --include='*.sha256' \
  --exclude='*' \
  "${CATALOG_DIR%/}/" \
  "${SSH_USER}@${STANDBY_HOST}:${REMOTE_CATALOG_DIR%/}/"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

nbackup_cmd() {
  local nbackup_bin="${FIREBIRD_BIN%/}/nbackup"
  if [ "$(id -u)" -eq 0 ]; then
    "$nbackup_bin" "$@"
  else
    sudo -n "$nbackup_bin" "$@"
  fi
}

run_physical_sync() {
  local found=0
  local db_file
  local alias
  local temp_name
  local remote_tmp_path
  local api_tmp_path
  shopt -s nullglob
  for db_file in "${DATA_DIR%/}"/*.fdb; do
    found=1
    alias="$(basename "$db_file" .fdb)"
    temp_name="${alias}_physical_${STAMP}.fdb"
    remote_tmp_path="${REMOTE_RESTORE_DIR%/}/${temp_name}"
    api_tmp_path="/firebird/restore-work/${temp_name}"
    echo "[ha-sync] sync fisico ${alias}: bloqueando banco para copia"
    nbackup_cmd -user SYSDBA -password "$FIREBIRD_PASSWORD" -L "$db_file"
    if ! rsync -aHAX --no-owner --no-group --inplace -e "$RSYNC_SSH" "$db_file" "${SSH_USER}@${STANDBY_HOST}:${remote_tmp_path}"; then
      nbackup_cmd -user SYSDBA -password "$FIREBIRD_PASSWORD" -N "$db_file" || true
      echo "[ha-sync] falha no rsync fisico ${alias}" >&2
      exit 31
    fi
    nbackup_cmd -user SYSDBA -password "$FIREBIRD_PASSWORD" -N "$db_file"
    echo "[ha-sync] sync fisico ${alias}: finalizando no standby"
    body="{\"databaseAlias\":\"$(json_escape "$alias")\",\"physicalPath\":\"$(json_escape "$api_tmp_path")\",\"logToken\":\"ha_physical_${STAMP}\"}"
    ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
      "response=\$(curl -sS -w '\n%{http_code}' -X POST '${STANDBY_TRONFIRE_URL%/}/api/ha/standby/physical-restore' -H 'content-type: application/json' -H 'x-tronsoftos-token: $INTERNAL_TOKEN' --data-binary '$body'); status=\$(printf '%s' \"\$response\" | tail -n1); payload=\$(printf '%s' \"\$response\" | sed '\$d'); printf '%s\n' \"\$payload\"; case \"\$status\" in 2*) exit 0 ;; *) exit 22 ;; esac"
  done
  shopt -u nullglob
  if [ "$found" -eq 0 ]; then
    echo "[ha-sync] nenhum banco .fdb encontrado para sync fisico em ${DATA_DIR}"
  fi
}

standby_backup_ready() {
  local alias="$1"
  local backup_sha="$2"
  local status_json
  local alias_json
  local sha_json

  [ -n "$backup_sha" ] || return 1
  status_json="$(ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
    "curl -fsS '${STANDBY_TRONFIRE_URL%/}/api/ha/status'" 2>/dev/null || true)"
  [ -n "$status_json" ] || return 1

  alias_json="$(json_escape "$alias")"
  sha_json="$(json_escape "$backup_sha")"
  printf '%s' "$status_json" | grep -q "\"alias\":\"${alias_json}\"" \
    && printf '%s' "$status_json" | grep -q '"standbyStatus":"READY"' \
    && printf '%s' "$status_json" | grep -q "\"lastStandbyBackupSha256\":\"${sha_json}\""
}

if [ -s "$RESTORE_LIST" ]; then
  while IFS='|' read -r alias _remote_backup _remote_manifest backup_sha; do
    [ -n "$alias" ] || continue
    if standby_backup_ready "$alias" "$backup_sha"; then
      printf '%s|%s\n' "$alias" "$backup_sha" >> "$SKIP_RESTORE_LIST"
    fi
  done < "$RESTORE_LIST"
fi

echo "[ha-sync] importando catalogo TronFire no standby"
ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
  "TRONSOFTOS_APP_DIR='$APP_DIR' bash '$APP_DIR/scripts/tronfire-catalog-import.sh' '${REMOTE_CATALOG_DIR%/}/tronfire_catalog_latest.dump'"

if [ "$AUTO_RESTORE_STANDBY" = "true" ] && [ "$HA_SYNC_MODE" = "physical" ]; then
  if [ -z "$INTERNAL_TOKEN" ]; then
    echo "[ha-sync] sync fisico habilitado, mas TRONSOFTOS_INTERNAL_TOKEN nao esta configurado" >&2
    exit 2
  fi
  run_physical_sync
elif [ "$AUTO_RESTORE_STANDBY" = "true" ]; then
  if [ -z "$INTERNAL_TOKEN" ]; then
    echo "[ha-sync] restore standby automatico habilitado, mas TRONSOFTOS_INTERNAL_TOKEN nao esta configurado" >&2
    exit 2
  fi
  if [ -s "$RESTORE_LIST" ]; then
    echo "[ha-sync] restaurando backups validados no standby"
    while IFS='|' read -r alias remote_backup remote_manifest backup_sha; do
      [ -n "$alias" ] || continue
      echo "[ha-sync] candidato restore ${alias}: backupSha256=${backup_sha:-sem-sha}"
      if grep -Fxq "${alias}|${backup_sha}" "$SKIP_RESTORE_LIST"; then
        echo "[ha-sync] restore standby ${alias} ignorado: backup ${backup_sha} ja estava READY antes do import do catalogo"
        body="{\"databaseAlias\":\"$(json_escape "$alias")\",\"backupSha256\":\"$(json_escape "$backup_sha")\"}"
        ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
          "response=\$(curl -sS -w '\n%{http_code}' -X POST '${STANDBY_TRONFIRE_URL%/}/api/ha/standby/validate' -H 'content-type: application/json' -H 'x-tronsoftos-token: $INTERNAL_TOKEN' --data-binary '$body'); status=\$(printf '%s' \"\$response\" | tail -n1); payload=\$(printf '%s' \"\$response\" | sed '\$d'); printf '%s\n' \"\$payload\"; case \"\$status\" in 2*) exit 0 ;; *) exit 22 ;; esac"
        continue
      fi
      body="{\"databaseAlias\":\"$(json_escape "$alias")\",\"backupPath\":\"$(json_escape "$remote_backup")\",\"manifestPath\":\"$(json_escape "$remote_manifest")\",\"logToken\":\"ha_sync_${STAMP}\"}"
      echo "[ha-sync] restore standby ${alias}: ${remote_backup}"
      ssh ${SSH_BASE_OPTS} "${SSH_USER}@${STANDBY_HOST}" \
        "response=\$(curl -sS -w '\n%{http_code}' -X POST '${STANDBY_TRONFIRE_URL%/}/api/ha/standby/restore' -H 'content-type: application/json' -H 'x-tronsoftos-token: $INTERNAL_TOKEN' --data-binary '$body'); status=\$(printf '%s' \"\$response\" | tail -n1); payload=\$(printf '%s' \"\$response\" | sed '\$d'); printf '%s\n' \"\$payload\"; case \"\$status\" in 2*) exit 0 ;; *) exit 22 ;; esac"
    done < "$RESTORE_LIST"
  else
    echo "[ha-sync] nenhum backup validado para restaurar no standby"
  fi
else
  echo "[ha-sync] restore standby automatico desabilitado"
fi

echo "[ha-sync] concluido $(date -Is)"
echo "[ha-sync] log $LOG_FILE"

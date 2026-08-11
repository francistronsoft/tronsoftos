#!/usr/bin/env bash
set -euo pipefail

RCLONE_BIN="${RCLONE_BIN:-/usr/bin/rclone}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/tronsoftos/config/rclone/rclone.conf}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
RCLONE_BACKUP_PATH="${RCLONE_BACKUP_PATH:-tronsoftos/backups}"
RCLONE_BIND="${RCLONE_BIND:-0.0.0.0}"
RCLONE_REMOTE_RETENTION_DAYS="${RCLONE_REMOTE_RETENTION_DAYS:-30}"
FIREBIRD_BACKUP_DIR="${FIREBIRD_BACKUP_DIR:-/opt/tronfire-storage/firebird/backups}"
NODE_ROLE="${TRONFIRE_NODE_ROLE:-${TRONSOFTOS_NODE_ROLE:-primary}}"
UPLOAD_ONLY_ROLE="${RCLONE_UPLOAD_ONLY_ROLE:-primary}"
LOG_DIR="${TRONSOFTOS_LOG_DIR:-/opt/tronsoftos/logs}/rclone"
RCLONE_SETTINGS="${TRONSOFTOS_RCLONE_SETTINGS:-${TRONSOFTOS_STATE_DIR:-/opt/tronsoftos/state}/rclone-settings.json}"
RCLONE_CONFIG_OWNER="${RCLONE_CONFIG_OWNER:-tronsoftos:tronsoftos}"

fix_rclone_config_permissions() {
  [ "$(id -u)" = "0" ] || return 0
  [ -n "${RCLONE_CONFIG:-}" ] || return 0
  [ -f "$RCLONE_CONFIG" ] || return 0
  case "$RCLONE_CONFIG" in
    /opt/tronsoftos/config/rclone/*)
      chown "$RCLONE_CONFIG_OWNER" "$RCLONE_CONFIG" 2>/dev/null || true
      chmod 600 "$RCLONE_CONFIG" 2>/dev/null || true
      ;;
  esac
}

if [ -f "$RCLONE_SETTINGS" ] && command -v node >/dev/null 2>&1; then
  eval "$(node - "$RCLONE_SETTINGS" <<'NODE'
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const q = value => `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
if (settings.enabled !== true) console.log('RCLONE_DISABLED=true');
for (const [env, key] of [
  ['RCLONE_BIN', 'bin'],
  ['RCLONE_CONFIG', 'config'],
  ['RCLONE_REMOTE', 'remote'],
  ['RCLONE_BACKUP_PATH', 'path'],
  ['RCLONE_BIND', 'bind'],
  ['RCLONE_REMOTE_RETENTION_DAYS', 'remoteRetentionDays'],
  ['UPLOAD_ONLY_ROLE', 'uploadOnlyRole']
]) {
  if (settings[key]) console.log(`${env}=${q(settings[key])}`);
}
NODE
)"
fi

if [ "${RCLONE_DISABLED:-false}" = "true" ]; then
  echo "rclone upload ignorado: configuracao desabilitada"
  exit 0
fi

if [ "$UPLOAD_ONLY_ROLE" != "any" ] && [ "$NODE_ROLE" != "$UPLOAD_ONLY_ROLE" ]; then
  echo "rclone upload ignorado: role atual $NODE_ROLE, role exigido $UPLOAD_ONLY_ROLE"
  exit 0
fi

if [ -z "${RCLONE_REMOTE:-}" ]; then
  echo "rclone upload ignorado: remote nao configurado"
  exit 0
fi

mkdir -p "$LOG_DIR"
fix_rclone_config_permissions
case "${RCLONE_REMOTE_RETENTION_DAYS:-30}" in
  ''|*[!0-9]*) RCLONE_REMOTE_RETENTION_DAYS=30 ;;
esac

if [ "${RCLONE_REMOTE_RETENTION_DAYS:-0}" -gt 0 ]; then
  "$RCLONE_BIN" delete "${RCLONE_REMOTE}:${RCLONE_BACKUP_PATH}" \
    --bind "$RCLONE_BIND" \
    --config "$RCLONE_CONFIG" \
    --min-age "${RCLONE_REMOTE_RETENTION_DAYS}d" \
    --filter "+ *.gbk" \
    --filter "+ *.fbk" \
    --filter "+ *.gbk.gz" \
    --filter "+ *.fbk.gz" \
    --filter "+ *.manifest.json" \
    --filter "- *" \
    --drive-use-trash=false \
    --log-file "$LOG_DIR/retention.log" \
    --log-level INFO
fi

copy_age_args=()
if [ "${RCLONE_REMOTE_RETENTION_DAYS:-0}" -gt 0 ]; then
  copy_age_args=(--max-age "${RCLONE_REMOTE_RETENTION_DAYS}d")
fi

"$RCLONE_BIN" copy "$FIREBIRD_BACKUP_DIR" "${RCLONE_REMOTE}:${RCLONE_BACKUP_PATH}" \
  --bind "$RCLONE_BIND" \
  --config "$RCLONE_CONFIG" \
  "${copy_age_args[@]}" \
  --filter "+ *.gbk" \
  --filter "+ *.fbk" \
  --filter "+ *.gbk.gz" \
  --filter "+ *.fbk.gz" \
  --filter "+ *.manifest.json" \
  --filter "- *" \
  --log-file "$LOG_DIR/upload.log" \
  --log-level INFO

fix_rclone_config_permissions

#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronsoftos}"
BRANCH="${1:-dev}"
REMOTE="${TRONSOFTOS_GIT_REMOTE:-origin}"
TIMEOUT_MINUTES="${TRONSOFTOS_UPDATE_TIMEOUT_MINUTES:-30}"
STANDBY_HOST="${TRONSOFTOS_UPDATE_STANDBY_HOST:-}"
SSH_USER="${TRONSOFTOS_UPDATE_SSH_USER:-tronsoft}"
SSH_PORT="${TRONSOFTOS_UPDATE_SSH_PORT:-22}"
SSH_KEY="${TRONSOFTOS_UPDATE_SSH_KEY:-$APP_DIR/state/ssh/id_ed25519}"
KNOWN_HOSTS="${TRONSOFTOS_UPDATE_KNOWN_HOSTS:-$APP_DIR/state/known_hosts}"
INTERNAL_TOKEN="${TRONSOFTOS_INTERNAL_TOKEN:-}"
TRONSOFTOS_PORT="${TRONSOFTOS_PORT:-8080}"
MAINTENANCE_STATE="${TRONSOFTOS_MAINTENANCE_STATE:-$APP_DIR/state/maintenance-state.json}"
STORAGE_ROOT="${STORAGE_ROOT:-/opt/tronfire-storage}"

log() {
  printf '[update] %s\n' "$*"
}

ssh_remote_curl() {
  local path="$1"
  local payload="$2"
  mkdir -p "$(dirname "$KNOWN_HOSTS")"
  touch "$KNOWN_HOSTS"
  ssh -p "$SSH_PORT" \
    -i "$SSH_KEY" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o "UserKnownHostsFile=$KNOWN_HOSTS" \
    "${SSH_USER}@${STANDBY_HOST}" \
    "curl -fsS -X POST 'http://127.0.0.1:${TRONSOFTOS_PORT}${path}' -H 'content-type: application/json' -H 'x-tronsoftos-token: ${INTERNAL_TOKEN}' --data-binary '$payload' >/dev/null"
}

clear_local_maintenance() {
  mkdir -p "$(dirname "$MAINTENANCE_STATE")"
  local standby_json="null"
  if [ -n "$STANDBY_HOST" ]; then
    standby_json="\"$STANDBY_HOST\""
  fi
  cat > "$MAINTENANCE_STATE" <<EOF
{
  "active": false,
  "mode": "update",
  "reason": "Atualizacao planejada concluida",
  "standbyHost": $standby_json,
  "startedAt": null,
  "expiresAt": null,
  "clearedAt": "$(date -Is)",
  "updatedAt": "$(date -Is)"
}
EOF
}

path_file_count() {
  local target="$1"
  if [ ! -e "$target" ]; then
    printf 'MISSING'
    return 0
  fi
  find "$target" -xdev -type f 2>/dev/null | wc -l | tr -d ' '
}

path_total_bytes() {
  local target="$1"
  if [ ! -e "$target" ]; then
    printf '0'
    return 0
  fi
  du -sb "$target" 2>/dev/null | awk '{print $1}'
}

persistent_paths() {
  printf '%s\n' \
    "$STORAGE_ROOT/firebird/data" \
    "$STORAGE_ROOT/firebird/backups" \
    "$STORAGE_ROOT/firebird/uploads" \
    "$STORAGE_ROOT/firebird/standby" \
    "$STORAGE_ROOT/postgres" \
    "$STORAGE_ROOT/redis" \
    "$STORAGE_ROOT/config-backups" \
    "$STORAGE_ROOT/update-backups" \
    "$APP_DIR/state" \
    "$APP_DIR/config/rclone"
}

capture_persistent_snapshot() {
  local output="$1"
  : > "$output"
  while IFS= read -r target; do
    printf '%s\t%s\t%s\n' "$target" "$(path_file_count "$target")" "$(path_total_bytes "$target")" >> "$output"
  done < <(persistent_paths)
}

verify_persistent_snapshot() {
  local before="$1"
  local failures=0
  while IFS=$'\t' read -r target before_count before_bytes; do
    [ -n "$target" ] || continue
    local after_count after_bytes
    after_count="$(path_file_count "$target")"
    after_bytes="$(path_total_bytes "$target")"
    if [ "$before_count" != "MISSING" ] && [ "$after_count" = "MISSING" ]; then
      echo "Diretorio persistente desapareceu durante a atualizacao: $target" >&2
      failures=$((failures + 1))
      continue
    fi
    if [ "$before_count" != "MISSING" ] && [ "$after_count" -lt "$before_count" ]; then
      echo "Diretorio persistente perdeu arquivos durante a atualizacao: $target ($before_count -> $after_count)" >&2
      failures=$((failures + 1))
    fi
    if [ "$before_bytes" -gt 0 ] && [ "$after_bytes" -lt "$before_bytes" ]; then
      echo "Diretorio persistente reduziu tamanho durante a atualizacao: $target ($before_bytes -> $after_bytes bytes)" >&2
      failures=$((failures + 1))
    fi
  done < "$before"
  [ "$failures" -eq 0 ] || exit 73
}

if [ "$BRANCH" != "dev" ]; then
  echo "Branch nao permitida para atualizacao pelo painel: $BRANCH" >&2
  exit 64
fi

cd "$APP_DIR"
snapshot_file="$(mktemp)"
trap 'rm -f "$snapshot_file"' EXIT
log "registrando fotografia de seguranca dos dados persistentes"
capture_persistent_snapshot "$snapshot_file"

if [ -n "$STANDBY_HOST" ]; then
  [ -n "$INTERNAL_TOKEN" ] || { echo "TRONSOFTOS_INTERNAL_TOKEN nao configurado; nao e seguro atualizar primary sem bloquear o standby" >&2; exit 71; }
  [ -f "$SSH_KEY" ] || { echo "Chave SSH nao encontrada para bloquear standby: $SSH_KEY" >&2; exit 72; }
  log "bloqueando promocao automatica no standby ${STANDBY_HOST}"
  block_payload="{\"reason\":\"Atualizacao planejada do primary pela branch ${BRANCH}\",\"timeoutMinutes\":${TIMEOUT_MINUTES}}"
  ssh_remote_curl "/api/maintenance/failover-block" "$block_payload" || {
    echo "Falha ao bloquear promocao no standby antes da atualizacao" >&2
    exit 70
  }
fi

log "buscando branch ${BRANCH}"
git fetch "$REMOTE" "${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}"
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git switch "$BRANCH"
else
  git switch -c "$BRANCH" --track "${REMOTE}/${BRANCH}"
fi
git pull --ff-only "$REMOTE" "$BRANCH"

log "executando instalador"
bash "$APP_DIR/install.sh"

log "validando preservacao de bancos, backups, historicos e configuracoes"
verify_persistent_snapshot "$snapshot_file"

if [ -n "$STANDBY_HOST" ]; then
  log "liberando promocao automatica no standby ${STANDBY_HOST}"
  clear_payload="{\"reason\":\"Atualizacao planejada do primary concluida\"}"
  ssh_remote_curl "/api/maintenance/failover-clear" "$clear_payload" || log "aviso: nao foi possivel liberar failover no standby automaticamente"
fi

clear_local_maintenance

log "agendando reinicio do servico TronSoftOS"
if command -v systemd-run >/dev/null 2>&1; then
  if ! systemd-run --unit=tronsoftos-restart-after-update --on-active=3s /bin/systemctl restart tronsoftos.service >/dev/null 2>&1; then
    nohup sh -c 'sleep 3; systemctl restart tronsoftos.service' >/dev/null 2>&1 &
  fi
else
  nohup sh -c 'sleep 3; systemctl restart tronsoftos.service' >/dev/null 2>&1 &
fi

log "atualizacao concluida; o painel pode reconectar em alguns segundos"

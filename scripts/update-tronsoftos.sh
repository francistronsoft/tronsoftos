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
UPDATE_JOB_ID="${TRONSOFTOS_UPDATE_JOB_ID:-}"
UPDATE_STATUS="${TRONSOFTOS_UPDATE_STATUS:-$APP_DIR/state/update-status.json}"
UPDATE_STARTED_AT="$(date -Is)"
UPDATE_STATUS_FINALIZED=false
snapshot_file=""

log() {
  printf '[update] %s\n' "$*"
}

json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  printf '%s' "$value"
}

write_update_status() {
  local status="$1"
  local exit_code="$2"
  local message="$3"
  [ -n "$UPDATE_JOB_ID" ] || return 0
  mkdir -p "$(dirname "$UPDATE_STATUS")"
  local finished_json="null"
  if [ "$status" != "running" ]; then
    finished_json="\"$(date -Is)\""
  fi
  cat > "$UPDATE_STATUS" <<EOF
{
  "id": "$(json_escape "$UPDATE_JOB_ID")",
  "app": "tronsoftos",
  "action": "update-$(json_escape "$BRANCH")",
  "branch": "$(json_escape "$BRANCH")",
  "status": "$(json_escape "$status")",
  "startedAt": "$(json_escape "$UPDATE_STARTED_AT")",
  "finishedAt": $finished_json,
  "exitCode": $exit_code,
  "message": "$(json_escape "$message")"
}
EOF
}

finish_update_status() {
  local code=$?
  if [ -n "${snapshot_file:-}" ]; then
    rm -f "$snapshot_file"
  fi
  if [ "$UPDATE_STATUS_FINALIZED" != "true" ]; then
    write_update_status "failed" "$code" "Atualizacao falhou antes de concluir. Verifique o log da execucao."
  fi
  exit "$code"
}

trap finish_update_status EXIT

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

allows_file_count_decrease() {
  local target="$1"
  case "$target" in
    "$STORAGE_ROOT/firebird/backups"|"$STORAGE_ROOT/config-backups"|"$STORAGE_ROOT/update-backups")
      return 0
      ;;
  esac
  return 1
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
  local warnings=0
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
      if allows_file_count_decrease "$target"; then
        log "aviso: diretorio persistente com retencao reduziu arquivos durante a atualizacao: $target ($before_count -> $after_count)"
        warnings=$((warnings + 1))
      else
        echo "Diretorio persistente perdeu arquivos durante a atualizacao: $target ($before_count -> $after_count)" >&2
        failures=$((failures + 1))
      fi
    fi
    if [ "$before_bytes" -gt 0 ] && [ "$after_bytes" -lt "$before_bytes" ]; then
      log "aviso: diretorio persistente reduziu tamanho durante a atualizacao: $target ($before_bytes -> $after_bytes bytes)"
      warnings=$((warnings + 1))
    fi
  done < "$before"
  if [ "$failures" -gt 0 ]; then
    log "validacao persistente falhou com ${failures} problema(s) de diretorio/arquivo"
    exit 73
  fi
  if [ "$warnings" -gt 0 ]; then
    log "validacao persistente concluida com ${warnings} aviso(s) de tamanho; sem perda de arquivos detectada"
  fi
}

backup_and_reset_local_source_changes() {
  if git -c "safe.directory=$APP_DIR" diff --quiet && git -c "safe.directory=$APP_DIR" diff --cached --quiet; then
    return 0
  fi

  local backup_dir
  backup_dir="$STORAGE_ROOT/update-backups/local-changes-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$backup_dir"
  git -c "safe.directory=$APP_DIR" status --porcelain=v1 > "$backup_dir/git-status.txt" || true
  git -c "safe.directory=$APP_DIR" diff > "$backup_dir/local-changes.patch" || true
  git -c "safe.directory=$APP_DIR" diff --cached > "$backup_dir/staged-changes.patch" || true

  log "alteracoes locais no codigo gerenciado foram salvas em ${backup_dir}"
  log "restaurando codigo gerenciado para permitir fast-forward"
  git -c "safe.directory=$APP_DIR" reset --hard HEAD
}

case "$BRANCH" in
  main|dev)
    ;;
  *)
  echo "Branch nao permitida para atualizacao pelo painel: $BRANCH" >&2
  exit 64
    ;;
esac

cd "$APP_DIR"
write_update_status "running" "null" "Atualizacao em andamento."
snapshot_file="$(mktemp)"
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
backup_and_reset_local_source_changes
git -c "safe.directory=$APP_DIR" fetch "$REMOTE" "${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}"
if git -c "safe.directory=$APP_DIR" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git -c "safe.directory=$APP_DIR" switch "$BRANCH"
else
  git -c "safe.directory=$APP_DIR" switch -c "$BRANCH" --track "${REMOTE}/${BRANCH}"
fi
git -c "safe.directory=$APP_DIR" pull --ff-only "$REMOTE" "$BRANCH"

update_commit="$(git -c "safe.directory=$APP_DIR" -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
update_branch="$(git -c "safe.directory=$APP_DIR" -C "$APP_DIR" branch --show-current 2>/dev/null || printf "$BRANCH")"
update_build="$(git -c "safe.directory=$APP_DIR" -C "$APP_DIR" rev-list --count HEAD 2>/dev/null || printf '0')"

log "executando instalador com timeout de ${TIMEOUT_MINUTES} minuto(s)"
if command -v timeout >/dev/null 2>&1; then
  TRONSOFTOS_GIT_COMMIT="$update_commit" \
  TRONSOFTOS_GIT_BRANCH="$update_branch" \
  TRONSOFTOS_BUILD_NUMBER="$update_build" \
  TRONSOFTOS_SKIP_WIZARD=true \
  timeout --foreground "${TIMEOUT_MINUTES}m" bash "$APP_DIR/install.sh"
else
  log "aviso: comando timeout nao encontrado; instalador sera executado sem limite automatico"
  TRONSOFTOS_GIT_COMMIT="$update_commit" \
  TRONSOFTOS_GIT_BRANCH="$update_branch" \
  TRONSOFTOS_BUILD_NUMBER="$update_build" \
  TRONSOFTOS_SKIP_WIZARD=true \
  bash "$APP_DIR/install.sh"
fi

log "validando preservacao de bancos, backups, historicos e configuracoes"
verify_persistent_snapshot "$snapshot_file"

if [ -n "$STANDBY_HOST" ]; then
  log "liberando promocao automatica no standby ${STANDBY_HOST}"
  clear_payload="{\"reason\":\"Atualizacao planejada do primary concluida\"}"
  ssh_remote_curl "/api/maintenance/failover-clear" "$clear_payload" || log "aviso: nao foi possivel liberar failover no standby automaticamente"
fi

clear_local_maintenance

update_version="$(tr -d '[:space:]' < "$APP_DIR/VERSION" 2>/dev/null || printf 'unknown')"
log "atualizacao concluida com sucesso: versao ${update_version}, build ${update_build}, commit ${update_commit}, branch ${update_branch}"
write_update_status "success" "0" "Atualizacao concluida com sucesso: versao ${update_version}, build ${update_build}, commit ${update_commit}, branch ${update_branch}."
UPDATE_STATUS_FINALIZED=true
log "agendando reinicio do servico TronSoftOS"
if command -v systemd-run >/dev/null 2>&1; then
  if ! systemd-run --unit=tronsoftos-restart-after-update --on-active=3s /bin/systemctl restart tronsoftos.service >/dev/null 2>&1; then
    nohup sh -c 'sleep 3; systemctl restart tronsoftos.service' >/dev/null 2>&1 &
  fi
else
  nohup sh -c 'sleep 3; systemctl restart tronsoftos.service' >/dev/null 2>&1 &
fi

log "atualizacao concluida; o painel pode reconectar em alguns segundos"

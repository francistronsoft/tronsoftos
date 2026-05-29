#!/usr/bin/env bash
set -u

BASE_URL="${TRONSOFTOS_BASE_URL:-http://127.0.0.1:${TRONSOFTOS_PORT:-8080}}"
ENV_FILE="${TRONSOFTOS_ENV_FILE:-/etc/tronsoftos/tronsoftos.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

ok_count=0
fail_count=0
warn_count=0

print_header() {
  printf '\n== %s ==\n' "$1"
}

ok() {
  ok_count=$((ok_count + 1))
  printf '[OK]   %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  printf '[WARN] %s\n' "$1"
}

fail() {
  fail_count=$((fail_count + 1))
  printf '[FAIL] %s\n' "$1"
}

check_cmd() {
  local label="$1"
  shift
  if "$@" >/tmp/tronsoftos-ha-smoke.out 2>/tmp/tronsoftos-ha-smoke.err; then
    ok "$label"
  else
    fail "$label"
    sed 's/^/       /' /tmp/tronsoftos-ha-smoke.err | tail -n 5
  fi
}

check_systemd_active() {
  local service="$1"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl nao encontrado; pulando $service"
    return
  fi
  if systemctl is-active --quiet "$service"; then
    ok "$service ativo"
  else
    fail "$service nao esta ativo"
    systemctl is-active "$service" 2>/dev/null | sed 's/^/       /'
  fi
}

print_header "TronSoftOS HA smoke test"
printf 'Base URL: %s\n' "$BASE_URL"
printf 'Env:      %s\n' "$ENV_FILE"
printf 'Papel:    %s\n' "${TRONSOFTOS_NODE_ROLE:-${TRONFIRE_NODE_ROLE:-desconhecido}}"
printf 'VIP:      %s\n' "${HA_VIP:-nao configurado}"

print_header "Servicos"
check_systemd_active tronsoftos
check_systemd_active keepalived
if [ -n "${FIREBIRD_SERVICE:-}" ]; then
  check_systemd_active "$FIREBIRD_SERVICE"
else
  check_systemd_active firebird
fi

print_header "APIs locais"
check_cmd "GET /health" curl -fsS "$BASE_URL/health"
check_cmd "GET /api/cluster/guard" curl -fsS "$BASE_URL/api/cluster/guard"
check_cmd "GET /api/diagnostics" curl -fsS "$BASE_URL/api/diagnostics"

print_header "VIP e rede"
if [ -n "${HA_VIP:-}" ]; then
  if ip addr show 2>/dev/null | grep -qE "inet ${HA_VIP}/|inet ${HA_VIP} "; then
    ok "VIP presente neste no"
  else
    warn "VIP nao esta presente neste no"
  fi
  if ping -c 2 -W 2 "$HA_VIP" >/dev/null 2>&1; then
    ok "VIP responde ping"
  else
    warn "VIP nao respondeu ping"
  fi
else
  warn "HA_VIP nao configurado"
fi

print_header "Containers"
if command -v docker >/dev/null 2>&1; then
  if docker ps >/tmp/tronsoftos-ha-smoke.out 2>/tmp/tronsoftos-ha-smoke.err; then
    ok "docker responde"
    grep -E 'tronfire|troncomanda' /tmp/tronsoftos-ha-smoke.out | sed 's/^/       /' || warn "containers tronfire/troncomanda nao encontrados em docker ps"
  else
    fail "docker nao respondeu"
    sed 's/^/       /' /tmp/tronsoftos-ha-smoke.err | tail -n 5
  fi
else
  warn "docker nao encontrado"
fi

print_header "Resumo"
printf 'OK: %s | WARN: %s | FAIL: %s\n' "$ok_count" "$warn_count" "$fail_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi

exit 0

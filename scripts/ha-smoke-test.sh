#!/usr/bin/env bash
set -u

BASE_URL="${TRONSOFTOS_BASE_URL:-http://127.0.0.1:${TRONSOFTOS_PORT:-8080}}"
ENV_FILE="${TRONSOFTOS_ENV_FILE:-/etc/tronsoftos/tronsoftos.env}"
CURL_TIMEOUT="${TRONSOFTOS_SMOKE_CURL_TIMEOUT:-5}"

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

json_field() {
  local key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

http_get() {
  local url="$1"
  curl -fsS --max-time "$CURL_TIMEOUT" "$url"
}

check_health_role() {
  local label="$1"
  local url="$2"
  local expected_role="$3"
  local body role node_name

  if ! body="$(http_get "$url" 2>/tmp/tronsoftos-ha-smoke.err)"; then
    fail "$label nao respondeu"
    sed 's/^/       /' /tmp/tronsoftos-ha-smoke.err | tail -n 5
    return
  fi

  role="$(printf '%s' "$body" | json_field nodeRole)"
  node_name="$(printf '%s' "$body" | json_field nodeName)"
  if [ -z "$role" ]; then
    warn "$label respondeu, mas nao informou nodeRole"
    return
  fi

  if [ -n "$expected_role" ] && [ "$role" != "$expected_role" ]; then
    fail "$label retornou papel $role, esperado $expected_role"
    [ -n "$node_name" ] && printf '       nodeName: %s\n' "$node_name"
    return
  fi

  ok "$label retornou ${node_name:-no sem nome} como $role"
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
NODE_ROLE="${TRONSOFTOS_NODE_ROLE:-${TRONFIRE_NODE_ROLE:-desconhecido}}"
printf 'Papel:    %s\n' "$NODE_ROLE"
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
if [ "$NODE_ROLE" != "desconhecido" ]; then
  check_health_role "Health local" "$BASE_URL/health" "$NODE_ROLE"
fi
check_cmd "GET /api/cluster/guard" curl -fsS "$BASE_URL/api/cluster/guard"
check_cmd "GET /api/diagnostics" curl -fsS "$BASE_URL/api/diagnostics"

print_header "VIP e rede"
if [ -n "${HA_VIP:-}" ]; then
  vip_present=false
  if ip addr show 2>/dev/null | grep -qE "inet ${HA_VIP}/|inet ${HA_VIP} "; then
    vip_present=true
  fi

  case "$NODE_ROLE" in
    primary)
      if [ "$vip_present" = true ]; then
        ok "VIP presente no primary"
      else
        fail "VIP ausente no primary"
      fi
      ;;
    standby|recovery)
      if [ "$vip_present" = true ]; then
        fail "VIP presente em no $NODE_ROLE"
      else
        ok "VIP ausente no $NODE_ROLE"
      fi
      ;;
    *)
      if [ "$vip_present" = true ]; then
        ok "VIP presente neste no"
      else
        warn "VIP nao esta presente neste no"
      fi
      ;;
  esac

  if [ "${HA_NODE_ROLE:-}" = "MASTER" ] && [ "$NODE_ROLE" != "primary" ]; then
    fail "Keepalived MASTER configurado em no $NODE_ROLE"
  elif [ "${HA_NODE_ROLE:-}" = "BACKUP" ] && [ "$NODE_ROLE" = "primary" ]; then
    fail "Keepalived BACKUP configurado no primary"
  elif [ -n "${HA_NODE_ROLE:-}" ]; then
    ok "Papel Keepalived coerente: $HA_NODE_ROLE"
  else
    warn "HA_NODE_ROLE nao configurado"
  fi

  if ping -c 2 -W 2 "$HA_VIP" >/dev/null 2>&1; then
    ok "VIP responde ping"
  else
    warn "VIP nao respondeu ping"
  fi

  check_health_role "Health pelo VIP" "http://${HA_VIP}:${TRONSOFTOS_PORT:-8080}/health" "primary"
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

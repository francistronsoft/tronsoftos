#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${TRONSOFTOS_HEALTH_URL:-http://127.0.0.1:8080/health}"
GUARD_URL="${TRONSOFTOS_GUARD_URL:-http://127.0.0.1:8080/api/cluster/guard}"

curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null
curl -fsS --max-time 2 "$GUARD_URL" | grep -Eq '"canHoldVip"[[:space:]]*:[[:space:]]*true'

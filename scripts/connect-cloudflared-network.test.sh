#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/connect-cloudflared-network.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "network inspect")
    [ "${NETWORK_EXISTS:-false}" = "true" ] || exit 1
    if [ "${3:-}" = "--format" ] && [ -f "${CONNECTED_FILE:-}" ]; then
      printf '%s\n' "${TRONSOFTOS_CLOUDFLARED_CONTAINER:-tronsoftos_cloudflared}"
    fi
    ;;
  "container inspect")
    [ "${CONTAINER_EXISTS:-false}" = "true" ] || exit 1
    ;;
  "network connect")
    count=0
    [ ! -f "$CONNECT_COUNT_FILE" ] || count="$(cat "$CONNECT_COUNT_FILE")"
    printf '%s\n' "$((count + 1))" > "$CONNECT_COUNT_FILE"
    : > "$CONNECTED_FILE"
    ;;
  *)
    echo "Comando docker inesperado: $*" >&2
    exit 2
    ;;
esac
MOCK
chmod +x "$TMP_DIR/docker"

export CONTAINER_RUNTIME="$TMP_DIR/docker"
export CONNECTED_FILE="$TMP_DIR/connected"
export CONNECT_COUNT_FILE="$TMP_DIR/connect-count"

NETWORK_EXISTS=false CONTAINER_EXISTS=true "$SCRIPT" troncomanda_net | grep -Fq 'Rede troncomanda_net ainda nao existe'
[ ! -f "$CONNECT_COUNT_FILE" ]

NETWORK_EXISTS=true CONTAINER_EXISTS=false "$SCRIPT" troncomanda_net | grep -Fq 'Container tronsoftos_cloudflared ainda nao existe'
[ ! -f "$CONNECT_COUNT_FILE" ]

NETWORK_EXISTS=true CONTAINER_EXISTS=true "$SCRIPT" troncomanda_net | grep -Fq 'Cloudflare conectado a rede troncomanda_net'
[ "$(cat "$CONNECT_COUNT_FILE")" = "1" ]

NETWORK_EXISTS=true CONTAINER_EXISTS=true "$SCRIPT" troncomanda_net | grep -Fq 'Cloudflare ja conectado a rede troncomanda_net'
[ "$(cat "$CONNECT_COUNT_FILE")" = "1" ]

echo "connect-cloudflared-network: testes passaram"

#!/usr/bin/env bash
set -euo pipefail

RUNTIME="${CONTAINER_RUNTIME:-docker}"
NETWORK_NAME="${1:-troncomanda_net}"
CLOUDFLARED_CONTAINER="${TRONSOFTOS_CLOUDFLARED_CONTAINER:-tronsoftos_cloudflared}"

if ! "$RUNTIME" network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Rede $NETWORK_NAME ainda nao existe; conexao com Cloudflare adiada."
  exit 0
fi

if ! "$RUNTIME" container inspect "$CLOUDFLARED_CONTAINER" >/dev/null 2>&1; then
  echo "Container $CLOUDFLARED_CONTAINER ainda nao existe; conexao com Cloudflare adiada."
  exit 0
fi

is_connected() {
  "$RUNTIME" network inspect \
    --format '{{range .Containers}}{{println .Name}}{{end}}' \
    "$NETWORK_NAME" 2>/dev/null \
    | grep -Fxq "$CLOUDFLARED_CONTAINER"
}

if is_connected; then
  echo "Cloudflare ja conectado a rede $NETWORK_NAME."
  exit 0
fi

if ! "$RUNTIME" network connect "$NETWORK_NAME" "$CLOUDFLARED_CONTAINER" 2>/dev/null && ! is_connected; then
  echo "Falha ao conectar Cloudflare a rede $NETWORK_NAME." >&2
  exit 1
fi

if ! is_connected; then
  echo "Cloudflare nao aparece conectado a rede $NETWORK_NAME apos a reconciliacao." >&2
  exit 1
fi

echo "Cloudflare conectado a rede $NETWORK_NAME."

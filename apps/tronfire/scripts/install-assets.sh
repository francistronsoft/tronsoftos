#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DEST_DIR="$ROOT_DIR/docker/firebird25"
FIREBIRD_PACKAGE_NAME="FirebirdCS-2.5.9.27139-0.amd64.tar.gz"
TEMPLATE_NAME="template.fdb"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

download() {
  local url="$1"
  local dest="$2"
  local label="$3"

  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "[assets] $label ja existe: $dest"
    return
  fi
  if [ -z "$url" ]; then
    echo "[assets] URL nao informada para $label" >&2
    return 1
  fi

  mkdir -p "$(dirname "$dest")"
  echo "[assets] Baixando $label..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$dest.tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest.tmp" "$url"
  else
    echo "[assets] Instale curl ou wget para baixar os arquivos." >&2
    return 1
  fi
  mv "$dest.tmp" "$dest"
}

check_gzip() {
  local dest="$1"
  local label="$2"
  if ! gzip -t "$dest" >/dev/null 2>&1; then
    echo "[assets] Arquivo invalido para $label: $dest" >&2
    echo "[assets] O download nao parece ser um .tar.gz valido. Verifique se o link e publico/direto." >&2
    echo "[assets] Primeiros bytes do arquivo:" >&2
    head -c 120 "$dest" >&2 || true
    echo >&2
    return 1
  fi
}

check_sha256() {
  local dest="$1"
  local expected="$2"
  local label="$3"

  if [ -z "$expected" ]; then
    echo "[assets] SHA256 nao informado para $label; validacao pulada."
    return
  fi
  local actual
  actual="$(sha256sum "$dest" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "[assets] SHA256 invalido para $label" >&2
    echo "[assets] Esperado: $expected" >&2
    echo "[assets] Atual:    $actual" >&2
    return 1
  fi
  echo "[assets] SHA256 OK para $label"
}

download "${FIREBIRD_PACKAGE_URL:-}" "$DEST_DIR/$FIREBIRD_PACKAGE_NAME" "pacote Firebird"
download "${FIREBIRD_TEMPLATE_URL:-}" "$DEST_DIR/$TEMPLATE_NAME" "template do banco"

check_gzip "$DEST_DIR/$FIREBIRD_PACKAGE_NAME" "pacote Firebird"
check_sha256 "$DEST_DIR/$FIREBIRD_PACKAGE_NAME" "${FIREBIRD_PACKAGE_SHA256:-}" "pacote Firebird"
check_sha256 "$DEST_DIR/$TEMPLATE_NAME" "${FIREBIRD_TEMPLATE_SHA256:-}" "template do banco"

echo "[assets] Arquivos prontos em $DEST_DIR"

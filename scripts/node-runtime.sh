#!/usr/bin/env bash

node_runtime_supported() {
  local version="${1#v}" major minor patch
  IFS=. read -r major minor patch <<< "$version"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  case "$major" in
    22) (( minor > 23 || (minor == 23 && patch >= 4) )) ;;
    24) (( minor > 22 || (minor == 22 && patch >= 1) )) ;;
    26) (( minor > 12 || (minor == 12 && patch >= 1) )) ;;
    *) return 1 ;;
  esac
}

ensure_node_runtime() (
  set -euo pipefail
  local current version=22.23.4 arch checksum archive staging target
  current="$(node --version 2>/dev/null || true)"
  if node_runtime_supported "$current"; then
    echo "Node.js $current atende ao minimo de seguranca."
    return 0
  fi
  if [ "${TRONSOFTOS_OFFLINE:-false}" = true ]; then
    echo "Node.js $current nao atende ao minimo de seguranca; atualize o kit offline." >&2
    return 2
  fi
  case "$(dpkg --print-architecture)" in
    amd64) arch=x64; checksum=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
    arm64) arch=arm64; checksum=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
    *) echo "Arquitetura Node.js nao suportada." >&2; return 2 ;;
  esac
  archive="node-v${version}-linux-${arch}.tar.xz"
  staging="$(mktemp -d /opt/.tronsoftos-node.XXXXXX)"
  trap 'rm -rf -- "$staging"' EXIT
  echo "Instalando Node.js $version com verificacao SHA256..."
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 600 --retry 3 \
    "https://nodejs.org/dist/v${version}/${archive}" -o "$staging/$archive"
  printf '%s  %s\n' "$checksum" "$staging/$archive" | sha256sum --check
  tar -xJf "$staging/$archive" -C "$staging"
  target="/opt/node-v${version}-linux-${arch}"
  test "$("$staging/node-v${version}-linux-${arch}/bin/node" --version)" = "v$version"
  # Never overwrite an existing runtime in place: running processes may still use it.
  if [ -e "$target" ]; then
    diff -qr "$staging/node-v${version}-linux-${arch}" "$target" >/dev/null || {
      echo "Destino $target diverge do arquivo oficial; revise antes de substituir." >&2
      return 2
    }
  else
    mv "$staging/node-v${version}-linux-${arch}" "$target"
  fi
  chmod -R a+rX "$target"
  mkdir -p /usr/local/bin
  local executable
  for executable in node npm npx; do
    ln -s "$target/bin/$executable" "$staging/$executable"
    mv -Tf "$staging/$executable" "/usr/local/bin/$executable"
  done
)

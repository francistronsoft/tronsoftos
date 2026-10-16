#!/usr/bin/env bash

offline_apt_get() {
  [ -f "${TRONSOFTOS_OFFLINE_APT_LIST:-}" ] || { echo "Repositorio APT local nao configurado." >&2; return 2; }
  [ -d "${TRONSOFTOS_OFFLINE_PACKAGES:-}" ] || { echo "Pacotes offline nao encontrados." >&2; return 2; }
  local args=(
    -o "Dir::Etc::sourcelist=$TRONSOFTOS_OFFLINE_APT_LIST"
    -o 'Dir::Etc::sourceparts=-'
    -o "Dir::Cache::archives=$TRONSOFTOS_OFFLINE_PACKAGES"
    -o 'Acquire::Languages=none'
    -o 'Acquire::Retries=0'
  )
  if [ "${1:-}" = install ]; then args+=(--no-download); fi
  DEBIAN_FRONTEND=noninteractive apt-get "${args[@]}" "$@"
}

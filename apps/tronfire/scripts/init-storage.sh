#!/usr/bin/env bash
set -euo pipefail
STORAGE_ROOT="${STORAGE_ROOT:-/opt/tronsoftOS/storage/tronfire}"
echo "Criando storage do TronFire em: $STORAGE_ROOT"
mkdir -p "$STORAGE_ROOT/firebird/data" "$STORAGE_ROOT/firebird/backups" "$STORAGE_ROOT/firebird/uploads" "$STORAGE_ROOT/firebird/templates" "$STORAGE_ROOT/firebird/standby" "$STORAGE_ROOT/firebird/restore-work" "$STORAGE_ROOT/firebird/quarantine" "$STORAGE_ROOT/firebird/logs" "$STORAGE_ROOT/firebird/scripts" "$STORAGE_ROOT/firebird/tmp" "$STORAGE_ROOT/postgres" "$STORAGE_ROOT/redis" "$STORAGE_ROOT/config-backups" "$STORAGE_ROOT/update-backups"
chmod 0777 "$STORAGE_ROOT/firebird/data" "$STORAGE_ROOT/firebird/backups" "$STORAGE_ROOT/firebird/uploads" "$STORAGE_ROOT/firebird/templates" "$STORAGE_ROOT/firebird/standby" "$STORAGE_ROOT/firebird/restore-work" "$STORAGE_ROOT/firebird/quarantine" "$STORAGE_ROOT/firebird/logs" "$STORAGE_ROOT/firebird/scripts" "$STORAGE_ROOT/firebird/tmp"
echo "Storage criado."

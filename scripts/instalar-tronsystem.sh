#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronos}"
REPO_URL="${TRONSOFTOS_REPO_URL:-https://github.com/francistronsoft/tronsoftos.git}"
BRANCH="${TRONSOFTOS_BRANCH:-main}"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E /usr/local/bin/instalar "$@"
fi

echo "TronSystem - instalacao final"
echo "Diretorio: $APP_DIR"
echo "Branch: $BRANCH"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssh-server sudo
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now ssh.service >/dev/null 2>&1 || true

mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "Atualizando fonte existente..."
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" fetch origin "$BRANCH"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" switch "$BRANCH" 2>/dev/null || git -c "safe.directory=$APP_DIR" -C "$APP_DIR" switch -c "$BRANCH" --track "origin/$BRANCH"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [ -f "$APP_DIR/install.sh" ]; then
  echo "Usando fonte embutida em $APP_DIR."
else
  echo "Clonando fonte do TronSystem..."
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

chmod +x "$APP_DIR/install.sh" "$APP_DIR/scripts/"*.sh 2>/dev/null || true
LOG_FILE="${TRONSOFTOS_INSTALL_LOG:-/var/log/tronsystem-instalar.log}"
mkdir -p "$(dirname "$LOG_FILE")"
echo "Log da instalacao: $LOG_FILE"
set +e
set -o pipefail
TRONSOFTOS_APP_DIR="$APP_DIR" bash "$APP_DIR/install.sh" 2>&1 | tee "$LOG_FILE"
rc=${PIPESTATUS[0]}
set +o pipefail
set -e
if [ "$rc" -ne 0 ]; then
  echo "Instalacao falhou (exit $rc). Ultimas linhas do log:"
  tail -80 "$LOG_FILE" || true
  exit "$rc"
fi

echo
echo "Instalacao concluida."
echo "Painel local: http://$(hostname -I | awk '{print $1}'):8080"

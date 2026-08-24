#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/tronos"
INSTALL_CMD="/usr/local/bin/instalar"

apt-get update || true
apt-get install -y sudo git curl ca-certificates openssh-server rsync ethtool || true

systemctl enable ssh >/dev/null 2>&1 || systemctl enable ssh.service >/dev/null 2>&1 || true

systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
mkdir -p /etc/systemd/logind.conf.d
cat >/etc/systemd/logind.conf.d/99-tronsystem-no-suspend.conf <<'EOF'
[Login]
IdleAction=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
EOF

cat >/usr/local/sbin/tronsystem-disable-nic-powersave <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

for iface_path in /sys/class/net/*; do
  iface="$(basename "$iface_path")"
  case "$iface" in
    lo|docker*|br-*|veth*|virbr*|tap*|tun*) continue ;;
  esac

  if [ -e "$iface_path/device/power/control" ]; then
    printf 'on\n' >"$iface_path/device/power/control" 2>/dev/null || true
  fi

  if command -v ethtool >/dev/null 2>&1; then
    ethtool --set-eee "$iface" eee off >/dev/null 2>&1 || true
  fi
done
EOF
chmod 0755 /usr/local/sbin/tronsystem-disable-nic-powersave

cat >/etc/systemd/system/tronsystem-nic-powersave.service <<'EOF'
[Unit]
Description=Disable NIC power saving for TronSystem
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tronsystem-disable-nic-powersave
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl enable tronsystem-nic-powersave.service >/dev/null 2>&1 || true

if id tronsoft >/dev/null 2>&1; then
  usermod -aG sudo tronsoft || true
  install -d -o tronsoft -g tronsoft -m 0755 /home/tronsoft
fi

cat >/etc/sudoers.d/90-tronsystem-technician <<'EOF'
tronsoft ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/90-tronsystem-technician
visudo -cf /etc/sudoers.d/90-tronsystem-technician

cat >"$INSTALL_CMD" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronos}"
REPO_URL="${TRONSOFTOS_REPO_URL:-https://github.com/francistronsoft/tronsoftos.git}"
BRANCH="${TRONSOFTOS_BRANCH:-main}"
SOURCE_ARCHIVE="${TRONSYSTEM_SOURCE_ARCHIVE:-/usr/local/share/tronsystem-source.tar.gz}"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E /usr/local/bin/instalar "$@"
fi

echo "TronSystem - instalacao final"
echo "Diretorio: $APP_DIR"
echo "Branch: $BRANCH"
echo "Fonte embutida: $SOURCE_ARCHIVE"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssh-server sudo ethtool
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now ssh.service >/dev/null 2>&1 || true
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
systemctl enable --now tronsystem-nic-powersave.service >/dev/null 2>&1 || true

mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "Atualizando fonte existente..."
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" fetch origin "$BRANCH"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" switch "$BRANCH" 2>/dev/null || git -c "safe.directory=$APP_DIR" -C "$APP_DIR" switch -c "$BRANCH" --track "origin/$BRANCH"
  git -c "safe.directory=$APP_DIR" -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [ -f "$APP_DIR/install.sh" ]; then
  echo "Usando fonte embutida em $APP_DIR."
elif [ -f "$SOURCE_ARCHIVE" ]; then
  echo "Extraindo fonte embutida da ISO..."
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  tar -xzf "$SOURCE_ARCHIVE" -C "$APP_DIR"
else
  echo "Clonando fonte do TronSystem..."
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

chmod +x "$APP_DIR/install.sh" "$APP_DIR/scripts/"*.sh 2>/dev/null || true
LOG_FILE="${TRONSOFTOS_INSTALL_LOG:-/var/log/tronsystem-instalar.log}"
mkdir -p "$(dirname "$LOG_FILE")"
echo "Log da instalacao: $LOG_FILE"
echo "Marcador de status: /var/log/tronsystem-instalar.status"
printf 'running started_at=%s app_dir=%s branch=%s\n' "$(date -Is)" "$APP_DIR" "$BRANCH" >/var/log/tronsystem-instalar.status
set +e
set -o pipefail
TRONSOFTOS_APP_DIR="$APP_DIR" bash "$APP_DIR/install.sh" 2>&1 | tee "$LOG_FILE"
rc=${PIPESTATUS[0]}
set +o pipefail
set -e
printf 'exit_code=%s finished_at=%s\n' "$rc" "$(date -Is)" >>/var/log/tronsystem-instalar.status
if [ "$rc" -ne 0 ]; then
  echo "Instalacao falhou (exit $rc). Ultimas linhas do log:"
  tail -80 "$LOG_FILE" || true
  exit "$rc"
fi

echo
echo "Instalacao concluida."
echo "Painel local: http://$(hostname -I | awk '{print $1}'):8080"
EOF
chmod 0755 "$INSTALL_CMD"

cat >/etc/motd <<'EOF'
TronSystem

Para finalizar a instalacao, entre como usuario tronsoft e execute:

  instalar

EOF

mkdir -p "$APP_DIR"
chown tronsoft:tronsoft "$APP_DIR" 2>/dev/null || true

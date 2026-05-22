#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronsoftos}"
PACKAGE="${FIREBIRD_PACKAGE:-$APP_DIR/apps/tronfire/docker/firebird25/FirebirdCS-2.5.9.27139-0.amd64.tar.gz}"
TEMPLATE="${FIREBIRD_TEMPLATE:-$APP_DIR/apps/tronfire/docker/firebird25/template.fdb}"
STORAGE_ROOT="${STORAGE_ROOT:-/opt/tronfire-storage}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo scripts/install-firebird25-host.sh" >&2
  exit 77
fi

if [ ! -f "$PACKAGE" ]; then
  echo "Pacote Firebird nao encontrado: $PACKAGE" >&2
  echo "Rode antes: cd $APP_DIR/apps/tronfire && bash scripts/install-assets.sh" >&2
  exit 66
fi

if ! gzip -t "$PACKAGE" >/dev/null 2>&1; then
  echo "Pacote Firebird invalido: $PACKAGE" >&2
  echo "O arquivo nao esta em formato gzip. O link pode ter baixado HTML/erro em vez do instalador." >&2
  echo "Apague o arquivo e rode novamente: cd $APP_DIR/apps/tronfire && bash scripts/install-assets.sh" >&2
  exit 68
fi

apt-get update
apt-get install -y ca-certificates libstdc++6 libtommath1 procps net-tools bash xz-utils findutils
apt-get install -y libncurses5 || apt-get install -y libncurses6 libtinfo6
touch /etc/services /etc/inetd.conf

ensure_legacy_ncurses() {
  local lib_dir
  for lib_dir in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib /usr/lib; do
    if [ -e "$lib_dir/libncurses.so.5" ]; then
      return 0
    fi
  done
  for lib_dir in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib /usr/lib; do
    if [ -e "$lib_dir/libncurses.so.6" ]; then
      ln -sf "$lib_dir/libncurses.so.6" "$lib_dir/libncurses.so.5"
      if [ -e "$lib_dir/libtinfo.so.6" ] && [ ! -e "$lib_dir/libtinfo.so.5" ]; then
        ln -sf "$lib_dir/libtinfo.so.6" "$lib_dir/libtinfo.so.5"
      fi
      ldconfig
      return 0
    fi
  done
  echo "Nao foi possivel localizar libncurses.so.6 para criar compatibilidade libncurses.so.5" >&2
  return 1
}

ensure_legacy_ncurses

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

tar -xzf "$PACKAGE" -C "$tmp_dir" --strip-components=1
cd "$tmp_dir"
./install.sh -silent

FB_GBAK="$(find /opt /usr/local -type f -name gbak 2>/dev/null | head -n 1)"
if [ -z "$FB_GBAK" ]; then
  echo "Firebird instalado, mas gbak nao foi encontrado." >&2
  exit 67
fi

FB_HOME_REAL="$(dirname "$(dirname "$FB_GBAK")")"
if [ "$FB_HOME_REAL" != "/usr/local/firebird" ]; then
  rm -rf /usr/local/firebird
  ln -s "$FB_HOME_REAL" /usr/local/firebird
fi

mkdir -p "$STORAGE_ROOT/firebird/data" "$STORAGE_ROOT/firebird/backups" "$STORAGE_ROOT/firebird/uploads" "$STORAGE_ROOT/firebird/templates" "$STORAGE_ROOT/firebird/standby" "$STORAGE_ROOT/firebird/restore-work" "$STORAGE_ROOT/firebird/quarantine" "$STORAGE_ROOT/firebird/logs" "$STORAGE_ROOT/firebird/scripts"

if [ -f "$TEMPLATE" ]; then
  cp "$TEMPLATE" "$STORAGE_ROOT/firebird/templates/template.fdb"
fi

ln -sf /usr/local/firebird/bin/gbak /usr/bin/gbak
ln -sf /usr/local/firebird/bin/gfix /usr/bin/gfix
ln -sf /usr/local/firebird/bin/gstat /usr/bin/gstat
ln -sf /usr/local/firebird/bin/isql /usr/bin/isql

cat > /etc/systemd/system/firebird.service <<'EOF'
[Unit]
Description=Firebird 2.5.9 SuperClassic
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/firebird/bin/fbguard -forever
ExecStop=/bin/kill -TERM $MAINPID
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now firebird.service

echo "Firebird 2.5.9 instalado no host em /usr/local/firebird"

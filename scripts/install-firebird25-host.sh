#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${TRONSOFTOS_APP_DIR:-$DEFAULT_APP_DIR}"
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
apt-get install -y ca-certificates libstdc++6 libtommath1 procps net-tools bash xz-utils findutils perl
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

configure_sysdba_password() {
  local desired_password="${FIREBIRD_PASSWORD:-masterkey}"
  local pass_file=""
  local parsed_password=""
  local candidates=()
  local current_password=""
  local security_db="/usr/local/firebird/security2.fdb"
  local template_db="$STORAGE_ROOT/firebird/templates/template.fdb"
  local fb_env=(FIREBIRD=/usr/local/firebird "LD_LIBRARY_PATH=/usr/local/firebird/lib:${LD_LIBRARY_PATH:-}")

  write_sysdba_password_file() {
    local file
    for file in /usr/local/firebird/SYSDBA.password /opt/firebird/SYSDBA.password; do
      if [ -d "$(dirname "$file")" ]; then
        printf 'ISC_USER=sysdba\nISC_PASSWD=%s\nISC_PASSWORD=%s\n' "$desired_password" "$desired_password" > "$file"
        chmod 600 "$file"
      fi
    done
  }

  password_works() {
    local password="$1"
    if [ -f "$template_db" ]; then
      printf 'select 1 from rdb$database;\nquit;\n' | env "${fb_env[@]}" /usr/local/firebird/bin/isql -user SYSDBA -password "$password" "localhost:$template_db" >/tmp/tronsoftos-isql.log 2>&1
      return $?
    fi
    printf 'display sysdba\nquit\n' | env "${fb_env[@]}" /usr/local/firebird/bin/gsec -user sysdba -password "$password" >/tmp/tronsoftos-gsec.log 2>&1
  }

  for pass_file in /usr/local/firebird/SYSDBA.password /opt/firebird/SYSDBA.password; do
    if [ ! -f "$pass_file" ]; then
      continue
    fi
    parsed_password="$(awk '
      /ISC_PASSWD|ISC_PASSWORD|PASSWD|PASSWORD|Passwd|Password|passwd|password/ {
        value=$0
        sub(/^[^:=]*[:=][[:space:]]*/, "", value)
        gsub(/["'\'' \r]/, "", value)
        print value
        exit
      }
    ' "$pass_file" 2>/dev/null || true)"
    [ -n "$parsed_password" ] && candidates+=("$parsed_password")
    while IFS= read -r word; do
      [ -n "$word" ] && candidates+=("$word")
    done < <(tr -cs '[:alnum:]_#@%+=.,:;!?()-' '\n' < "$pass_file" | awk 'length($0) >= 4')
  done

  candidates+=("$desired_password" "masterkey")

  for current_password in "${candidates[@]}"; do
    [ -n "$current_password" ] || continue
    if printf 'display sysdba\nquit\n' | env "${fb_env[@]}" /usr/local/firebird/bin/gsec -user sysdba -password "$current_password" >/tmp/tronsoftos-gsec.log 2>&1 || \
       { [ -f "$security_db" ] && printf 'display sysdba\nquit\n' | env "${fb_env[@]}" /usr/local/firebird/bin/gsec -database "$security_db" -user sysdba -password "$current_password" >/tmp/tronsoftos-gsec.log 2>&1; }; then
      if [ "$current_password" != "$desired_password" ]; then
        printf 'modify sysdba -pw %s\nquit\n' "$desired_password" | env "${fb_env[@]}" /usr/local/firebird/bin/gsec -user sysdba -password "$current_password" >/tmp/tronsoftos-gsec.log 2>&1 || \
          { [ -f "$security_db" ] && printf 'modify sysdba -pw %s\nquit\n' "$desired_password" | env "${fb_env[@]}" /usr/local/firebird/bin/gsec -database "$security_db" -user sysdba -password "$current_password" >/tmp/tronsoftos-gsec.log 2>&1; }
      fi
      write_sysdba_password_file
      echo "Senha SYSDBA do Firebird host sincronizada."
      return 0
    fi
  done

  if password_works "$desired_password"; then
    write_sysdba_password_file
    echo "Senha SYSDBA do Firebird host validada."
    return 0
  fi

  echo "Aviso: nao foi possivel sincronizar a senha SYSDBA automaticamente." >&2
  echo "Verifique /usr/local/firebird/SYSDBA.password e ajuste FIREBIRD_PASSWORD no TronFire." >&2
  cat /tmp/tronsoftos-gsec.log >&2 || true
  cat /tmp/tronsoftos-isql.log >&2 || true
  return 0
}

force_firebird_installer_masterkey() {
  local installer_main="$tmp_dir/scripts/tarMainInstall.sh"

  if [ ! -f "$installer_main" ]; then
    echo "Aviso: script principal do instalador Firebird nao encontrado para fixar senha SYSDBA." >&2
    return 0
  fi

  if ! command -v perl >/dev/null 2>&1; then
    echo "Aviso: perl nao encontrado; senha SYSDBA sera sincronizada apos a instalacao." >&2
    return 0
  fi

  perl -0pi -e 's/(generateNewDBAPassword\(\)\s*\{\s*)/$1\n    NewPasswd="masterkey"\n    writeNewPassword "$NewPasswd"\n    return\n/s' "$installer_main"
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

tar -xzf "$PACKAGE" -C "$tmp_dir" --strip-components=1
force_firebird_installer_masterkey
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
if [ "$FB_HOME_REAL" != "/opt/firebird" ] && [ ! -e /opt/firebird ]; then
  ln -s "$FB_HOME_REAL" /opt/firebird
fi

mkdir -p "$STORAGE_ROOT/firebird/data" "$STORAGE_ROOT/firebird/backups" "$STORAGE_ROOT/firebird/uploads" "$STORAGE_ROOT/firebird/templates" "$STORAGE_ROOT/firebird/standby" "$STORAGE_ROOT/firebird/restore-work" "$STORAGE_ROOT/firebird/quarantine" "$STORAGE_ROOT/firebird/logs" "$STORAGE_ROOT/firebird/scripts"
chmod 0777 "$STORAGE_ROOT/firebird/data" "$STORAGE_ROOT/firebird/backups" "$STORAGE_ROOT/firebird/uploads" "$STORAGE_ROOT/firebird/templates" "$STORAGE_ROOT/firebird/standby" "$STORAGE_ROOT/firebird/restore-work" "$STORAGE_ROOT/firebird/quarantine" "$STORAGE_ROOT/firebird/logs" "$STORAGE_ROOT/firebird/scripts"
if [ ! -e /firebird ]; then
  ln -s "$STORAGE_ROOT/firebird" /firebird
fi

if [ -f "$TEMPLATE" ]; then
  cp "$TEMPLATE" "$STORAGE_ROOT/firebird/templates/template.fdb"
  chmod 0666 "$STORAGE_ROOT/firebird/templates/template.fdb"
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
configure_sysdba_password
systemctl restart firebird.service

echo "Firebird 2.5.9 instalado no host em /usr/local/firebird"

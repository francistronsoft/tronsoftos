#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${TRONSOFTOS_APP_DIR:-$SCRIPT_DIR}"
ENV_DIR="/etc/tronsoftos"
ENV_FILE="${ENV_DIR}/tronsoftos.env"
USER_NAME="${TRONSOFTOS_USER:-tronsoftos}"
GROUP_NAME="${TRONSOFTOS_GROUP:-tronsoftos}"

prepare_frontend() {
  if [ ! -f "$APP_DIR/frontend/package.json" ]; then
    return 0
  fi

  if [ "${TRONSOFTOS_SKIP_FRONTEND_BUILD:-false}" = "true" ]; then
    if [ -f "$APP_DIR/frontend/dist/index.html" ]; then
      echo "Build do frontend pulado; usando frontend/dist existente."
      return 0
    fi
    echo "TRONSOFTOS_SKIP_FRONTEND_BUILD=true, mas frontend/dist/index.html nao existe." >&2
    return 74
  fi

  echo "Preparando frontend..."
  cd "$APP_DIR/frontend"
  npm config set fetch-timeout "${NPM_FETCH_TIMEOUT:-120000}"
  npm config set fetch-retries "${NPM_FETCH_RETRIES:-5}"
  npm config set fetch-retry-mintimeout "${NPM_FETCH_RETRY_MINTIMEOUT:-20000}"
  npm config set fetch-retry-maxtimeout "${NPM_FETCH_RETRY_MAXTIMEOUT:-120000}"
  npm config set audit false
  npm config set fund false

  local attempt
  for attempt in 1 2 3; do
    echo "Instalando dependencias frontend (tentativa $attempt/3)..."
    if npm install --prefer-offline --no-audit --fund=false; then
      npm run build
      return 0
    fi
    sleep $((attempt * 10))
  done

  if [ -f "$APP_DIR/frontend/dist/index.html" ]; then
    echo "Aviso: npm falhou, mas frontend/dist existente sera mantido." >&2
    return 0
  fi

  echo "Falha ao baixar dependencias npm e nao ha frontend/dist pronto." >&2
  echo "Opcoes:" >&2
  echo "  1) Corrija internet/DNS/proxy e rode sudo bash install.sh novamente." >&2
  echo "  2) Gere/copiei frontend/dist antes e rode TRONSOFTOS_SKIP_FRONTEND_BUILD=true sudo bash install.sh." >&2
  return 74
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker Compose ja instalado."
    return
  fi

  echo "Removendo pacotes Docker conflitantes, se existirem..."
  apt-get remove -y docker.io docker-doc docker-compose podman-docker containerd runc docker-buildx docker-buildx-plugin 2>/dev/null || true

  if ! apt-cache show docker-compose-plugin >/dev/null 2>&1; then
    echo "Configurando repositorio oficial da Docker..."
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    DOCKER_CODENAME="${VERSION_CODENAME:-trixie}"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${DOCKER_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
  fi

  if apt-cache show docker-ce >/dev/null 2>&1; then
    if ! apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin; then
      apt-get -f install -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    fi
    apt-get install -y docker-buildx-plugin || echo "Aviso: docker-buildx-plugin nao foi instalado; seguindo com docker compose."
  else
    apt-get install -y docker.io docker-compose-plugin
  fi

  docker version >/dev/null
  docker compose version >/dev/null
}

env_escape() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(env_escape "$value")"
  [ -f "$file" ] || return 0
  if grep -q "^$key=" "$file"; then
    sed -i "s/^$key=.*/$key=$escaped/" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep "^$key=" "$file" | tail -n1 | cut -d= -f2-
}

ensure_ha_sync_ssh_user() {
  local ssh_user="$1"
  local app_dir="$2"
  [ -n "$ssh_user" ] || return 0
  if ! id "$ssh_user" >/dev/null 2>&1; then
    echo "Aviso: usuario SSH HA '$ssh_user' nao existe neste host; ajuste antes de usar Sync HA." >&2
    return 0
  fi
  usermod -aG docker "$ssh_user" || true
  if [ "$ssh_user" != "$USER_NAME" ] && [ -r "$app_dir/state/ssh/id_ed25519.pub" ]; then
    local home_dir ssh_dir authorized_keys
    home_dir="$(getent passwd "$ssh_user" | cut -d: -f6)"
    if [ -n "$home_dir" ] && [ -d "$home_dir" ]; then
      ssh_dir="$home_dir/.ssh"
      authorized_keys="$ssh_dir/authorized_keys"
      install -d -m 0700 -o "$ssh_user" -g "$ssh_user" "$ssh_dir"
      touch "$authorized_keys"
      chown "$ssh_user:$ssh_user" "$authorized_keys"
      chmod 0600 "$authorized_keys"
    fi
  fi
}

run_with_retry() {
  local label="$1"
  shift
  local attempt
  local max_attempts="${INSTALL_RETRY_ATTEMPTS:-4}"
  for attempt in $(seq 1 "$max_attempts"); do
    echo "$label (tentativa $attempt/$max_attempts)..."
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "Aviso: $label falhou. Nova tentativa em $((attempt * 20))s..." >&2
      sleep $((attempt * 20))
    fi
  done
  echo "Falha em $label apos $max_attempts tentativas." >&2
  return 1
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo ./install.sh" >&2
  exit 77
fi

echo "Instalando pacotes base..."
apt-get update
apt-get install -y ca-certificates curl gnupg openssl rsync openssh-client openssh-server keepalived rclone nodejs npm sudo
install_docker

echo "Criando usuario e diretorios..."
if ! getent group "$GROUP_NAME" >/dev/null; then
  groupadd --system "$GROUP_NAME"
fi
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --gid "$GROUP_NAME" --home-dir "$APP_DIR" --shell /bin/bash "$USER_NAME"
fi
usermod -aG docker "$USER_NAME" || true
usermod --home "$APP_DIR" --shell /bin/bash "$USER_NAME" || true

mkdir -p "$APP_DIR" "$ENV_DIR" "$APP_DIR/state" "$APP_DIR/config" "$APP_DIR/logs" /opt/tronfire-storage
mkdir -p /opt/tronfire-storage/troncomanda/qr-static

echo "Copiando arquivos..."
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'frontend/node_modules' \
  ./ "$APP_DIR/"

if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
fi

if [ ! -f "$APP_DIR/config/managed-apps.json" ]; then
  cp "$APP_DIR/config/managed-apps.example.json" "$APP_DIR/config/managed-apps.json"
fi

VERSION_VALUE="$(cat "$APP_DIR/VERSION" 2>/dev/null || printf '0.1.0')"
GIT_COMMIT="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
GIT_BRANCH="$(git -C "$APP_DIR" branch --show-current 2>/dev/null || printf 'unknown')"
cat > "$APP_DIR/state/build-info.json" <<EOF
{
  "version": "$VERSION_VALUE",
  "commit": "$GIT_COMMIT",
  "branch": "$GIT_BRANCH",
  "installedAt": "$(date -Is)"
}
EOF

mkdir -p "$APP_DIR/state/ssh" "$APP_DIR/.ssh"
chown -R "$USER_NAME:$GROUP_NAME" "$APP_DIR/state" "$APP_DIR/.ssh"
chmod 700 "$APP_DIR/state" "$APP_DIR/state/ssh" "$APP_DIR/.ssh"
chmod 600 "$APP_DIR/state/build-info.json" 2>/dev/null || true
if [ ! -f "$APP_DIR/state/ssh/id_ed25519" ]; then
  sudo -u "$USER_NAME" ssh-keygen -t ed25519 -f "$APP_DIR/state/ssh/id_ed25519" -N "" -C "tronsoftos@$HOSTNAME" >/dev/null
fi
touch "$APP_DIR/.ssh/authorized_keys" "$APP_DIR/state/known_hosts"
chown -R "$USER_NAME:$GROUP_NAME" "$APP_DIR/state/ssh" "$APP_DIR/.ssh"
chown "$USER_NAME:$GROUP_NAME" "$APP_DIR/state/known_hosts"
chmod 600 "$APP_DIR/.ssh/authorized_keys" "$APP_DIR/state/known_hosts"
chmod 600 "$APP_DIR/state/ssh/id_ed25519"

if [ "${TRONSOFTOS_SKIP_WIZARD:-false}" != "true" ]; then
  TRONSOFTOS_APP_DIR="$APP_DIR" bash "$APP_DIR/scripts/configure-wizard.sh"
fi

HA_SYNC_SSH_USER_VALUE="$(env_value "$ENV_FILE" "HA_SYNC_SSH_USER")"
ensure_ha_sync_ssh_user "${HA_SYNC_SSH_USER_VALUE:-tronsoft}" "$APP_DIR"

prepare_frontend

echo "Preparando TronFire..."
if [ ! -f "$APP_DIR/apps/tronfire/.env" ]; then
  cp "$APP_DIR/apps/tronfire/.env.example" "$APP_DIR/apps/tronfire/.env"
fi
set_env_value "$APP_DIR/apps/tronfire/.env" "APP_ROOT" "$APP_DIR/apps/tronfire"
set_env_value "$APP_DIR/apps/tronfire/.env" "TRONSOFTOS_STATE_DIR" "$APP_DIR/state"
set_env_value "$APP_DIR/apps/tronfire/.env" "TRONSOFTOS_CLUSTER_LOCK" "$APP_DIR/state/cluster-lock.json"
set_env_value "$APP_DIR/apps/tronfire/.env" "TRONSOFTOS_CLUSTER_SECRETS" "$APP_DIR/state/cluster-secrets.env"
if [ -f "$APP_DIR/state/cluster-secrets.env" ] && [ -z "$(env_value "$APP_DIR/apps/tronfire/.env" "TRONSOFTOS_INTERNAL_TOKEN")" ]; then
  set_env_value "$APP_DIR/apps/tronfire/.env" "TRONSOFTOS_INTERNAL_TOKEN" "$(env_value "$APP_DIR/state/cluster-secrets.env" "TRONSOFTOS_INTERNAL_TOKEN")"
fi
cd "$APP_DIR/apps/tronfire"
bash scripts/install-assets.sh
if [ -f "$APP_DIR/apps/tronfire/docker/firebird25/FirebirdCS-2.5.9.27139-0.amd64.tar.gz" ]; then
  if ! tar -tzf "$APP_DIR/apps/tronfire/docker/firebird25/FirebirdCS-2.5.9.27139-0.amd64.tar.gz" >/dev/null; then
    echo "Pacote Firebird baixado esta invalido. Verifique FIREBIRD_PACKAGE_URL em $APP_DIR/apps/tronfire/.env" >&2
    exit 68
  fi
fi
STORAGE_ROOT=/opt/tronfire-storage bash "$APP_DIR/apps/tronfire/scripts/init-storage.sh"
if [ -f "$APP_DIR/apps/tronfire/docker/firebird25/template.fdb" ]; then
  cp "$APP_DIR/apps/tronfire/docker/firebird25/template.fdb" /opt/tronfire-storage/firebird/templates/template.fdb
fi

echo "Instalando systemd..."
install -m 0755 "$APP_DIR/infra/sbin/tronsoftos-network" /usr/local/sbin/tronsoftos-network
install -m 0440 "$APP_DIR/infra/sudoers/tronsoftos" /etc/sudoers.d/tronsoftos
cp "$APP_DIR/infra/systemd/tronsoftos.service" /etc/systemd/system/tronsoftos.service
cp "$APP_DIR/infra/systemd/tronsoftos-rclone-backup.service" /etc/systemd/system/tronsoftos-rclone-backup.service
cp "$APP_DIR/infra/systemd/tronsoftos-rclone-backup.timer" /etc/systemd/system/tronsoftos-rclone-backup.timer
sed -i "s|/opt/tronsoftos|$APP_DIR|g" /etc/systemd/system/tronsoftos.service
sed -i "s|/opt/tronsoftos|$APP_DIR|g" /etc/systemd/system/tronsoftos-rclone-backup.service

chown -R "$USER_NAME:$GROUP_NAME" "$APP_DIR" /opt/tronfire-storage
touch "$APP_DIR/state/events.jsonl"
chown "$USER_NAME:$GROUP_NAME" "$APP_DIR/state/events.jsonl"
chmod 700 "$APP_DIR/state"
chmod 600 "$APP_DIR/state/events.jsonl"
chmod +x "$APP_DIR/scripts/"*.sh "$APP_DIR/infra/keepalived/check-tronsoftos.sh"

if [ "$(env_value "$ENV_FILE" "TRONSOFTOS_DEPLOYMENT_MODE")" = "ha" ] && [ -n "$(env_value "$ENV_FILE" "HA_VIP_CIDR")" ]; then
  echo "Aplicando VIP/Keepalived conforme configuracao do instalador..."
  /usr/local/sbin/tronsoftos-network apply-vip \
    "$APP_DIR" \
    "$(env_value "$ENV_FILE" "HA_INTERFACE")" \
    "$(env_value "$ENV_FILE" "HA_VIP_CIDR")" \
    "$(env_value "$ENV_FILE" "HA_ROUTER_ID")" \
    "$(env_value "$ENV_FILE" "HA_AUTH_PASS")" \
    "$(env_value "$ENV_FILE" "HA_NODE_ROLE")" \
    "$(env_value "$ENV_FILE" "HA_PRIORITY")" || echo "Aviso: nao foi possivel aplicar VIP durante a instalacao; ajuste pelo painel TronSoftOS." >&2
fi

systemctl daemon-reload

echo "Subindo servicos do host..."
cd "$APP_DIR/apps/tronfire"
set -a
. "$APP_DIR/apps/tronfire/.env"
set +a
if [ "${FIREBIRD_EXEC_MODE:-container}" = "host" ]; then
  TRONSOFTOS_APP_DIR="$APP_DIR" bash "$APP_DIR/scripts/install-firebird25-host.sh"
fi

systemctl enable --now tronsoftos.service
systemctl enable --now tronsoftos-rclone-backup.timer

echo "Subindo TronFire e aplicando migrations..."
cd "$APP_DIR/apps/tronfire"
if [ "${FIREBIRD_EXEC_MODE:-container}" = "host" ]; then
  run_with_retry "Subindo TronFire" docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml up -d --build
  docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml exec -T backend npx prisma migrate deploy
  docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml exec -T backend node prisma/seed.js
else
  run_with_retry "Subindo TronFire" docker compose up -d --build
  docker compose exec -T backend npx prisma migrate deploy
  docker compose exec -T backend node prisma/seed.js
fi

echo "Instalacao concluida."
echo "Edite $ENV_FILE e $APP_DIR/apps/tronfire/.env conforme o cliente."
ACCESS_PORT="8080"
ACCESS_HOST=""
if [ -f "$ENV_FILE" ]; then
  ACCESS_PORT="$(grep '^TRONSOFTOS_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  ACCESS_HOST="$(grep '^HA_VIP=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  if [ -z "$ACCESS_HOST" ]; then
    ACCESS_HOST="$(grep '^HOST_STATIC_IP_ADDRESS_CIDR=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | cut -d/ -f1 || true)"
  fi
fi
if [ -z "$ACCESS_HOST" ]; then
  ACCESS_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
ACCESS_PORT="${ACCESS_PORT:-8080}"
ACCESS_HOST="${ACCESS_HOST:-IP-DO-SERVIDOR}"
echo "Acesse: http://$ACCESS_HOST:$ACCESS_PORT"

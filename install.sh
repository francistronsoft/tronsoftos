#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronsoftos}"
ENV_DIR="/etc/tronsoftos"
ENV_FILE="${ENV_DIR}/tronsoftos.env"
USER_NAME="${TRONSOFTOS_USER:-tronsoftos}"
GROUP_NAME="${TRONSOFTOS_GROUP:-tronsoftos}"

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

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo ./install.sh" >&2
  exit 77
fi

echo "Instalando pacotes base..."
apt-get update
apt-get install -y ca-certificates curl gnupg rsync openssh-client openssh-server keepalived rclone nodejs npm
install_docker

echo "Criando usuario e diretorios..."
if ! getent group "$GROUP_NAME" >/dev/null; then
  groupadd --system "$GROUP_NAME"
fi
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --gid "$GROUP_NAME" --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi
usermod -aG docker "$USER_NAME" || true

mkdir -p "$APP_DIR" "$ENV_DIR" "$APP_DIR/state" "$APP_DIR/config" "$APP_DIR/logs" /opt/tronfire-storage

echo "Copiando arquivos..."
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'frontend/node_modules' \
  --exclude 'frontend/dist' \
  ./ "$APP_DIR/"

if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
fi

if [ ! -f "$APP_DIR/config/managed-apps.json" ]; then
  cp "$APP_DIR/config/managed-apps.example.json" "$APP_DIR/config/managed-apps.json"
fi

if [ "${TRONSOFTOS_SKIP_WIZARD:-false}" != "true" ]; then
  bash "$APP_DIR/scripts/configure-wizard.sh"
fi

echo "Preparando frontend..."
if [ -f "$APP_DIR/frontend/package.json" ]; then
  cd "$APP_DIR/frontend"
  npm install
  npm run build
fi

echo "Preparando TronFire..."
if [ ! -f "$APP_DIR/apps/tronfire/.env" ]; then
  cp "$APP_DIR/apps/tronfire/.env.example" "$APP_DIR/apps/tronfire/.env"
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
cp "$APP_DIR/infra/systemd/tronsoftos.service" /etc/systemd/system/tronsoftos.service
cp "$APP_DIR/infra/systemd/tronsoftos-rclone-backup.service" /etc/systemd/system/tronsoftos-rclone-backup.service
cp "$APP_DIR/infra/systemd/tronsoftos-rclone-backup.timer" /etc/systemd/system/tronsoftos-rclone-backup.timer

chown -R "$USER_NAME:$GROUP_NAME" "$APP_DIR" /opt/tronfire-storage
chmod +x "$APP_DIR/scripts/"*.sh "$APP_DIR/infra/keepalived/check-tronsoftos.sh"

echo "Subindo TronFire e aplicando migrations..."
cd "$APP_DIR/apps/tronfire"
set -a
. "$APP_DIR/apps/tronfire/.env"
set +a
if [ "${FIREBIRD_EXEC_MODE:-container}" = "host" ]; then
  bash "$APP_DIR/scripts/install-firebird25-host.sh"
  docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml up -d --build
  docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml exec -T backend npx prisma migrate deploy
  docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml exec -T backend node prisma/seed.js
else
  docker compose up -d --build
  docker compose exec -T backend npx prisma migrate deploy
  docker compose exec -T backend node prisma/seed.js
fi

systemctl daemon-reload
systemctl enable --now tronsoftos.service
systemctl enable --now tronsoftos-rclone-backup.timer

echo "Instalacao concluida."
echo "Edite $ENV_FILE e $APP_DIR/apps/tronfire/.env conforme o cliente."
echo "Acesse: http://IP-DO-SERVIDOR:8080"

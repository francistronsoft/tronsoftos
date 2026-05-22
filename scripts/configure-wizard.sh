#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TRONSOFTOS_APP_DIR:-/opt/tronsoftos}"
ENV_DIR="/etc/tronsoftos"
TRONSOFTOS_ENV="$ENV_DIR/tronsoftos.env"
TRONFIRE_ENV="$APP_DIR/apps/tronfire/.env"
MANAGED_APPS="$APP_DIR/config/managed-apps.json"

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo scripts/configure-wizard.sh" >&2
  exit 77
fi

ask() {
  local label="$1"
  local default="${2:-}"
  local value
  if [ -n "$default" ]; then
    read -r -p "$label [$default]: " value
    echo "${value:-$default}"
  else
    read -r -p "$label: " value
    echo "$value"
  fi
}

ask_secret() {
  local label="$1"
  local value
  read -r -s -p "$label (ENTER para gerar): " value
  echo >&2
  if [ -n "$value" ]; then
    echo "$value"
  else
    openssl rand -base64 32 | tr -d '\n'
  fi
}

yes_no() {
  local label="$1"
  local default="${2:-n}"
  local value
  read -r -p "$label [${default}]: " value
  value="${value:-$default}"
  case "$value" in
    s|S|sim|SIM|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

line() {
  printf '%*s\n' 72 '' | tr ' ' '-'
}

mkdir -p "$ENV_DIR" "$APP_DIR/config" "$APP_DIR/state" "$APP_DIR/logs"

clear || true
line
echo "TronSoftOS - assistente de configuracao"
line
echo "Use este wizard para padronizar a instalacao inicial."
echo "Quando nao souber uma senha, pressione ENTER para gerar automaticamente."
line

DEPLOYMENT_MODE="simple"
if yes_no "Este cliente tera alta disponibilidade com 2 servidores? (s/n)" "n"; then
  DEPLOYMENT_MODE="ha"
fi

NODE_NAME="$(ask "Nome deste servidor/no" "servidor-01")"
NODE_ROLE="primary"
if [ "$DEPLOYMENT_MODE" = "ha" ]; then
  NODE_ROLE="$(ask "Papel deste no (primary/standby/recovery)" "primary")"
fi

SERVER_IP="$(ask "IP deste servidor na rede do cliente" "127.0.0.1")"
FIREBIRD_MODE="host"
echo "Firebird 2.5.9 sera instalado/usado no host Debian."

TRONFIRE_PANEL_PORT="$(ask "Porta do painel TronFire" "8081")"
TRONSOFTOS_PORT="$(ask "Porta do painel TronSoftOS" "8080")"
FIREBIRD_PORT="3050"
echo "Porta Firebird padrao: $FIREBIRD_PORT"

FIREBIRD_PASSWORD="masterkey"
POSTGRES_PASSWORD="su61613225Ts"
SESSION_SECRET="$(ask_secret "Chave de sessao do TronFire")"
INTERNAL_TOKEN="$(ask_secret "Token interno TronSoftOS -> TronFire")"

RCLONE_REMOTE=""
RCLONE_PATH="tronsoftos/backups"
echo "Rclone sera configurado depois no painel do TronSoftOS."

CLOUDFLARE_RECORD_NAME=""
CLOUDFLARE_TARGET_IP=""
echo "Cloudflare sera configurado depois no painel do TronSoftOS."

HA_INTERFACE=""
HA_VIP=""
HA_PRIORITY="150"
if [ "$DEPLOYMENT_MODE" = "ha" ]; then
  HA_INTERFACE="$(ask "Interface de rede do VIP (ex: ens18, eth0)" "eth0")"
  HA_VIP="$(ask "IP virtual/VIP" "$SERVER_IP")"
  HA_PRIORITY="$(ask "Prioridade keepalived deste no" "$([ "$NODE_ROLE" = "primary" ] && echo 150 || echo 100)")"
fi

cat > "$TRONSOFTOS_ENV" <<EOF
TRONSOFTOS_USER=tronsoftos
TRONSOFTOS_GROUP=tronsoftos
TRONSOFTOS_APP_DIR=$APP_DIR
TRONSOFTOS_PORT=$TRONSOFTOS_PORT
TRONSOFTOS_HEALTH_URL=http://127.0.0.1:$TRONSOFTOS_PORT/health
TRONSOFTOS_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
TRONSOFTOS_NODE_NAME=$NODE_NAME
TRONSOFTOS_NODE_ROLE=$NODE_ROLE
TRONSOFTOS_STATE_DIR=$APP_DIR/state
TRONSOFTOS_LOG_DIR=$APP_DIR/logs
TRONSOFTOS_CLUSTER_LOCK=$APP_DIR/state/cluster-lock.json
TRONSOFTOS_FRONTEND_DIST=$APP_DIR/frontend/dist

HA_INTERFACE=$HA_INTERFACE
HA_VIP=$HA_VIP
HA_ROUTER_ID=51
HA_AUTH_PASS=
HA_NODE_ROLE=$([ "$NODE_ROLE" = "primary" ] && echo MASTER || echo BACKUP)
HA_PRIORITY=$HA_PRIORITY

FIREBIRD_SERVICE=firebird
FIREBIRD_DATA_DIR=/opt/tronfire-storage/firebird/data
FIREBIRD_BACKUP_DIR=/opt/tronfire-storage/firebird/backups
FIREBIRD_SYNC_MODE=backups
FIREBIRD_DB_PATTERN=*.fdb
FIREBIRD_RSYNC_TARGET=
FIREBIRD_RSYNC_SSH_USER=root
FIREBIRD_RSYNC_SSH_PORT=22

TRONFIRE_POSTGRES_CONTAINER=tronfire_postgres
TRONFIRE_POSTGRES_DB=tronfire
TRONFIRE_POSTGRES_USER=tronfire
TRONFIRE_CATALOG_EXPORT_DIR=$APP_DIR/state/tronfire-catalog

RCLONE_BIN=/usr/bin/rclone
RCLONE_CONFIG=$APP_DIR/config/rclone/rclone.conf
RCLONE_REMOTE=$RCLONE_REMOTE
RCLONE_BACKUP_PATH=$RCLONE_PATH
RCLONE_UPLOAD_ONLY_ROLE=primary
TRONSOFTOS_EXTERNAL_BACKUP_OWNER=true

CONTAINER_RUNTIME=docker
MANAGED_APPS_CONFIG=$APP_DIR/config/managed-apps.json
TRONFIRE_CONTAINER=tronfire
TRONCOMANDA_CONTAINER=troncomanda

CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_RECORD_ID=
CLOUDFLARE_RECORD_NAME=$CLOUDFLARE_RECORD_NAME
CLOUDFLARE_RECORD_TYPE=A
CLOUDFLARE_TARGET_IP=$CLOUDFLARE_TARGET_IP
EOF

cat > "$TRONFIRE_ENV" <<EOF
APP_NAME=TronFire
SERVER_PLATFORM=linux-docker
APP_ROOT=$APP_DIR/apps/tronfire
STORAGE_ROOT=/opt/tronfire-storage
TRONSOFTOS_STATE_DIR=$APP_DIR/state

TRONFIRE_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
TRONFIRE_NODE_ROLE=$NODE_ROLE
TRONSOFTOS_NODE_NAME=$NODE_NAME
TRONSOFTOS_CLUSTER_LOCK=$APP_DIR/state/cluster-lock.json
TRONSOFTOS_INTERNAL_TOKEN=$INTERNAL_TOKEN
TRONSOFTOS_EXTERNAL_BACKUP_OWNER=true

FIREBIRD_EXEC_MODE=$FIREBIRD_MODE

TRONFIRE_PANEL_PORT=$TRONFIRE_PANEL_PORT
TRONFIRE_FIREBIRD_PORT=$FIREBIRD_PORT
TRONFIRE_LAN_HOST=$SERVER_IP
PUBLIC_URL=http://$SERVER_IP:$TRONFIRE_PANEL_PORT

FIREBIRD_PACKAGE_URL=https://tronsoft.bitrix24.com.br/~qQVae
FIREBIRD_TEMPLATE_URL=https://tronsoft.bitrix24.com.br/~wUw0m
FIREBIRD_PACKAGE_SHA256=
FIREBIRD_TEMPLATE_SHA256=

FIREBIRD_PASSWORD=$FIREBIRD_PASSWORD
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET

GOOGLE_DRIVE_CLIENT_ID=
GOOGLE_DRIVE_CLIENT_SECRET=
EOF

if [ "$FIREBIRD_MODE" = "host" ]; then
  cat > "$MANAGED_APPS" <<EOF
{
  "apps": [
    {
      "name": "tronfire",
      "type": "compose",
      "enabled": true,
      "composeFile": "apps/tronfire/docker-compose.yml",
      "composeFiles": [
        "apps/tronfire/docker-compose.yml",
        "apps/tronfire/docker-compose.host-firebird.yml"
      ],
      "projectName": "tronfire",
      "healthUrl": "http://127.0.0.1:$TRONFIRE_PANEL_PORT/health",
      "containers": [
        "tronfire_backend",
        "tronfire_worker",
        "tronfire_postgres",
        "tronfire_redis"
      ],
      "haAware": true
    },
    {
      "name": "troncomanda",
      "type": "compose",
      "enabled": false,
      "composeFile": "apps/troncomanda/docker-compose.yml",
      "composeFiles": ["apps/troncomanda/docker-compose.yml"],
      "projectName": "troncomanda",
      "healthUrl": "http://127.0.0.1:8091/health",
      "containers": ["troncomanda"],
      "haAware": false
    }
  ]
}
EOF
else
  cat > "$MANAGED_APPS" <<EOF
{
  "apps": [
    {
      "name": "tronfire",
      "type": "compose",
      "enabled": true,
      "composeFile": "apps/tronfire/docker-compose.yml",
      "composeFiles": ["apps/tronfire/docker-compose.yml"],
      "projectName": "tronfire",
      "healthUrl": "http://127.0.0.1:$TRONFIRE_PANEL_PORT/health",
      "containers": [
        "tronfire_backend",
        "tronfire_worker",
        "tronfire_postgres",
        "tronfire_redis",
        "tronfire_firebird25"
      ],
      "haAware": true
    },
    {
      "name": "troncomanda",
      "type": "compose",
      "enabled": false,
      "composeFile": "apps/troncomanda/docker-compose.yml",
      "composeFiles": ["apps/troncomanda/docker-compose.yml"],
      "projectName": "troncomanda",
      "healthUrl": "http://127.0.0.1:8091/health",
      "containers": ["troncomanda"],
      "haAware": false
    }
  ]
}
EOF
fi

chmod 600 "$TRONSOFTOS_ENV" "$TRONFIRE_ENV"

line
echo "Configuracao gravada com sucesso:"
echo "- $TRONSOFTOS_ENV"
echo "- $TRONFIRE_ENV"
echo "- $MANAGED_APPS"
line
echo "Proximos comandos sugeridos:"
if [ "$FIREBIRD_MODE" = "host" ]; then
  echo "sudo bash $APP_DIR/scripts/install-firebird25-host.sh"
fi
echo "cd $APP_DIR/apps/tronfire"
if [ "$FIREBIRD_MODE" = "host" ]; then
  echo "sudo docker compose -f docker-compose.yml -f docker-compose.host-firebird.yml up -d --build"
else
  echo "sudo docker compose up -d --build"
fi
echo "sudo systemctl restart tronsoftos"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${TRONSOFTOS_APP_DIR:-$DEFAULT_APP_DIR}"
ENV_DIR="/etc/tronsoftos"
TRONSOFTOS_ENV="$ENV_DIR/tronsoftos.env"
TRONFIRE_ENV="$APP_DIR/apps/tronfire/.env"
TRONCOMANDA_ENV="$APP_DIR/apps/troncomanda/.env"
MANAGED_APPS="$APP_DIR/config/managed-apps.json"
CLUSTER_SECRETS="$APP_DIR/state/cluster-secrets.env"
NODE_IDENTITY="$APP_DIR/state/node-identity.json"
SSH_PUBLIC_KEY_PATH="$APP_DIR/state/ssh/id_ed25519.pub"

for secrets_file in "$APP_DIR/config/installer-secrets.env" "$ENV_DIR/installer-secrets.env"; do
  if [ -f "$secrets_file" ]; then
    # shellcheck disable=SC1090
    . "$secrets_file"
  fi
done

decrypt_installer_secret() {
  local encrypted="$1"
  local key="$2"
  if [ -z "$encrypted" ] || [ -z "$key" ]; then
    return 1
  fi
  SECRET_ENC="$encrypted" SECRET_KEY="$key" node -e '
const crypto = require("crypto");
const payload = JSON.parse(Buffer.from(process.env.SECRET_ENC, "base64").toString("utf8"));
const key = crypto.createHash("sha256").update(process.env.SECRET_KEY).digest();
const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
process.stdout.write(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8"));
'
}

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

choose_node_role() {
  local value
  while true; do
    echo "Papel deste no:" >&2
    echo "  1) primary" >&2
    echo "  2) standby" >&2
    echo "  3) recovery" >&2
    printf "Escolha [1]: " >&2
    read -r value
    value="${value:-1}"
    case "$value" in
      1|primary) echo "primary"; return 0 ;;
      2|standby) echo "standby"; return 0 ;;
      3|recovery) echo "recovery"; return 0 ;;
      *) echo "Opcao invalida. Digite 1, 2 ou 3." >&2 ;;
    esac
  done
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

new_uuid() {
  if command_exists uuidgen; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    openssl rand -hex 16 | sed 's/^\(........\)\(....\)\(....\)\(....\)\(............\)$/\1-\2-\3-\4-\5/'
  fi
}

detect_default_iface() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
}

detect_default_ipv4_cidr() {
  local iface="$1"
  if [ -n "$iface" ]; then
    ip -o -4 addr show dev "$iface" scope global 2>/dev/null | awk '{print $4; exit}'
  fi
}

detect_default_gateway() {
  ip route show default 2>/dev/null | awk '{print $3; exit}'
}

detect_dns_servers() {
  awk '/^nameserver / {print $2}' /etc/resolv.conf 2>/dev/null | paste -sd' ' -
}

ipv4_without_cidr() {
  echo "${1%%/*}"
}

same_ipv4_prefix_hint() {
  local cidr="$1"
  local ip="${cidr%%/*}"
  local prefix="${cidr#*/}"
  if [ "$ip" != "$cidr" ] && [ "$prefix" = "24" ]; then
    echo "${ip%.*}.X/$prefix"
  else
    echo "mesma sub-rede/VLAN do IP fixo dos servidores"
  fi
}

configure_static_ip() {
  local iface="$1"
  local address_cidr="$2"
  local gateway="$3"
  local dns="$4"
  local apply_now="$5"

  if command_exists nmcli; then
    local connection
    connection="$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: -v dev="$iface" '$2==dev {print $1; exit}')"
    if [ -z "$connection" ]; then
      connection="$(nmcli -t -f NAME connection show | head -n1)"
    fi
    if [ -z "$connection" ]; then
      echo "Nao foi possivel localizar uma conexao do NetworkManager para $iface."
      return 1
    fi

    nmcli connection modify "$connection" \
      ipv4.addresses "$address_cidr" \
      ipv4.gateway "$gateway" \
      ipv4.dns "$dns" \
      ipv4.method manual \
      connection.autoconnect yes

    echo "IP fixo gravado no NetworkManager: conexao '$connection'."
    if [ "$apply_now" = "true" ]; then
      echo "Aplicando conexao agora. Se estiver via SSH, a sessao pode cair se o IP mudar."
      nmcli connection up "$connection"
    else
      echo "A configuracao sera aplicada ao reconectar a interface ou reiniciar o servidor."
    fi
    return 0
  fi

  if systemctl list-unit-files systemd-networkd.service >/dev/null 2>&1; then
    local network_file="/etc/systemd/network/10-tronsoftos-$iface.network"
    {
      echo "[Match]"
      echo "Name=$iface"
      echo
      echo "[Network]"
      echo "DHCP=no"
      echo "Address=$address_cidr"
      echo "Gateway=$gateway"
      for dns_server in $dns; do
        echo "DNS=$dns_server"
      done
    } > "$network_file"

    systemctl enable systemd-networkd.service >/dev/null 2>&1 || true
    echo "IP fixo gravado em $network_file."
    if [ "$apply_now" = "true" ]; then
      echo "Reiniciando systemd-networkd agora. Se estiver via SSH, a sessao pode cair se o IP mudar."
      systemctl restart systemd-networkd.service
    else
      echo "A configuracao sera aplicada ao reiniciar o systemd-networkd ou o servidor."
    fi
    return 0
  fi

  echo "Nao encontrei NetworkManager nem systemd-networkd para aplicar IP fixo automaticamente."
  echo "Configure manualmente a interface $iface com $address_cidr antes de seguir em producao."
  return 1
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
  NODE_ROLE="$(choose_node_role)"
fi
CLUSTER_ID="$(ask "ID do cluster/cliente" "$(echo "$NODE_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-')")"
NODE_ID="$(new_uuid)"
INSTALL_ID="$(new_uuid)"

SESSION_SECRET=""
INTERNAL_TOKEN=""

DEFAULT_IFACE="$(detect_default_iface)"
DEFAULT_IPV4_CIDR="$(detect_default_ipv4_cidr "$DEFAULT_IFACE")"
DEFAULT_SERVER_IP="$(ipv4_without_cidr "${DEFAULT_IPV4_CIDR:-127.0.0.1}")"
DEFAULT_GATEWAY="$(detect_default_gateway)"
DEFAULT_DNS="$(detect_dns_servers)"

line
echo "Rede do servidor"
echo "Informe o IP real deste Debian. Este IP deve existir na placa de rede do host."
echo "A configuracao de IP fixo sera feita depois no painel do TronSoftOS."
line

SERVER_IP="$DEFAULT_SERVER_IP"
STATIC_IP_ENABLED="false"
STATIC_IP_INTERFACE="$DEFAULT_IFACE"
STATIC_IP_ADDRESS_CIDR="$DEFAULT_IPV4_CIDR"
STATIC_IP_GATEWAY="$DEFAULT_GATEWAY"
STATIC_IP_DNS="${DEFAULT_DNS:-1.1.1.1 8.8.8.8}"
STATIC_IP_APPLY_NOW="false"
SERVER_IP="$(ask "IP atual deste servidor na rede do cliente" "$DEFAULT_SERVER_IP")"

FIREBIRD_MODE="host"
echo "Firebird 2.5.9 sera instalado/usado no host Debian."

TRONFIRE_PANEL_PORT="8081"
TRONSOFTOS_PORT="$(ask "Porta do painel TronSoftOS" "8080")"
FIREBIRD_PORT="3050"
echo "Porta Firebird padrao: $FIREBIRD_PORT"

FIREBIRD_PASSWORD="masterkey"
POSTGRES_PASSWORD="su61613225Ts"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
INTERNAL_TOKEN="${INTERNAL_TOKEN:-$(openssl rand -base64 48 | tr -d '\n')}"

RCLONE_REMOTE=""
RCLONE_PATH="tronsoftos/backups"
echo "Rclone sera configurado depois no painel do TronSoftOS."

CLOUDFLARE_RECORD_NAME=""
CLOUDFLARE_TARGET_IP=""
echo "Cloudflare sera configurado depois no painel do TronSoftOS."

HA_INTERFACE=""
HA_VIP=""
HA_PRIORITY="$([ "$NODE_ROLE" = "primary" ] && echo 150 || echo 100)"
if [ "$DEPLOYMENT_MODE" = "ha" ]; then
  line
  echo "VIP do HA"
  echo "O VIP sera configurado depois no painel do TronSoftOS."
  echo "Regra: IP livre na mesma sub-rede/VLAN dos dois nos HA: $(same_ipv4_prefix_hint "${STATIC_IP_ADDRESS_CIDR:-$SERVER_IP}")"
  echo "Nao use o IP real do primary nem do standby como VIP."
  line
  HA_INTERFACE="${STATIC_IP_INTERFACE:-$DEFAULT_IFACE}"
  HA_VIP=""
  echo "Prioridade Keepalived definida automaticamente: $HA_PRIORITY"
fi

cat > "$TRONSOFTOS_ENV" <<EOF
TRONSOFTOS_USER=tronsoftos
TRONSOFTOS_GROUP=tronsoftos
TRONSOFTOS_APP_DIR=$APP_DIR
TRONSOFTOS_PORT=$TRONSOFTOS_PORT
TRONSOFTOS_HEALTH_URL=http://127.0.0.1:$TRONSOFTOS_PORT/health
TRONSOFTOS_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
TRONSOFTOS_CLUSTER_ID=$CLUSTER_ID
TRONSOFTOS_NODE_NAME=$NODE_NAME
TRONSOFTOS_NODE_ROLE=$NODE_ROLE
TRONSOFTOS_STATE_DIR=$APP_DIR/state
TRONSOFTOS_LOG_DIR=$APP_DIR/logs
TRONSOFTOS_CLUSTER_LOCK=$APP_DIR/state/cluster-lock.json
TRONSOFTOS_CLUSTER_SECRETS=$APP_DIR/state/cluster-secrets.env
TRONSOFTOS_FRONTEND_DIST=$APP_DIR/frontend/dist
TRONSOFTOS_NODE_IDENTITY=$APP_DIR/state/node-identity.json
TRONSOFTOS_DOCKER_CONFIG=$APP_DIR/state/docker-config

HOST_STATIC_IP_ENABLED=$STATIC_IP_ENABLED
HOST_STATIC_IP_INTERFACE=$STATIC_IP_INTERFACE
HOST_STATIC_IP_ADDRESS_CIDR=$STATIC_IP_ADDRESS_CIDR
HOST_STATIC_IP_GATEWAY=$STATIC_IP_GATEWAY
HOST_STATIC_IP_DNS="$STATIC_IP_DNS"

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
FIREBIRD_RSYNC_SSH_USER=tronsoftos
FIREBIRD_RSYNC_SSH_PORT=22
HA_SYNC_SSH_USER=tronsoftos
HA_SYNC_SSH_PORT=22

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

line
GHCR_REGISTRY="${TRONSOFTOS_GHCR_REGISTRY:-${GHCR_REGISTRY:-ghcr.io}}"
GHCR_USER="${TRONSOFTOS_GHCR_USER:-${GHCR_USER:-}}"
GHCR_TOKEN="${TRONSOFTOS_GHCR_TOKEN:-${GHCR_TOKEN:-}}"
GHCR_TOKEN_ENC="${TRONSOFTOS_GHCR_TOKEN_ENC:-${GHCR_TOKEN_ENC:-}}"
GHCR_TOKEN_KEY="${TRONSOFTOS_GHCR_TOKEN_KEY:-${GHCR_TOKEN_KEY:-}}"
if [ -z "$GHCR_TOKEN" ] && [ -n "$GHCR_TOKEN_ENC" ] && [ -n "$GHCR_TOKEN_KEY" ]; then
  if GHCR_TOKEN="$(decrypt_installer_secret "$GHCR_TOKEN_ENC" "$GHCR_TOKEN_KEY")"; then
    echo "Token GHCR descriptografado para login da instalacao."
  else
    echo "Aviso: nao foi possivel descriptografar token GHCR." >&2
    GHCR_TOKEN=""
  fi
fi
if [ -n "$GHCR_USER" ] && [ -n "$GHCR_TOKEN" ]; then
  mkdir -p "$APP_DIR/state/docker-config"
  chmod 700 "$APP_DIR/state/docker-config"
  GHCR_LOGIN_OUTPUT="$(printf '%s\n' "$GHCR_TOKEN" | DOCKER_CONFIG="$APP_DIR/state/docker-config" docker login "$GHCR_REGISTRY" -u "$GHCR_USER" --password-stdin 2>&1)" || GHCR_LOGIN_RC=$?
  if [ "${GHCR_LOGIN_RC:-0}" -eq 0 ]; then
    if id tronsoftos >/dev/null 2>&1; then
      chown -R tronsoftos:tronsoftos "$APP_DIR/state/docker-config"
    fi
    chmod 700 "$APP_DIR/state/docker-config"
    [ ! -f "$APP_DIR/state/docker-config/config.json" ] || chmod 600 "$APP_DIR/state/docker-config/config.json"
    echo "Login $GHCR_REGISTRY salvo para uso do TronSoftOS."
  else
    echo "Aviso: login $GHCR_REGISTRY falhou. A instalacao do TronSoftOS/TronFire continua." >&2
    echo "Aviso: imagens privadas do TronComanda podem falhar ao subir ate corrigir as credenciais GHCR." >&2
    echo "Resumo GHCR: $(printf '%s' "$GHCR_LOGIN_OUTPUT" | tail -n1)" >&2
  fi
  unset GHCR_LOGIN_OUTPUT GHCR_LOGIN_RC
  unset GHCR_TOKEN TRONSOFTOS_GHCR_TOKEN GHCR_TOKEN_ENC GHCR_TOKEN_KEY TRONSOFTOS_GHCR_TOKEN_ENC TRONSOFTOS_GHCR_TOKEN_KEY
else
  echo "Login GHCR nao configurado por credenciais de instalacao."
  echo "Para imagens privadas, forneca credenciais em $APP_DIR/config/installer-secrets.env antes de instalar."
fi

cat > "$TRONFIRE_ENV" <<EOF
APP_NAME=TronFire
SERVER_PLATFORM=linux-docker
APP_ROOT=$APP_DIR/apps/tronfire
STORAGE_ROOT=/opt/tronfire-storage
TRONSOFTOS_STATE_DIR=$APP_DIR/state

TRONFIRE_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
TRONFIRE_NODE_ROLE=$NODE_ROLE
TRONSOFTOS_CLUSTER_ID=$CLUSTER_ID
TRONSOFTOS_NODE_NAME=$NODE_NAME
TRONSOFTOS_CLUSTER_LOCK=$APP_DIR/state/cluster-lock.json
TRONSOFTOS_CLUSTER_SECRETS=$APP_DIR/state/cluster-secrets.env
TRONSOFTOS_INTERNAL_TOKEN=$INTERNAL_TOKEN
TRONSOFTOS_EXTERNAL_BACKUP_OWNER=true

FIREBIRD_EXEC_MODE=$FIREBIRD_MODE

TRONFIRE_PANEL_PORT=$TRONFIRE_PANEL_PORT
TRONFIRE_FIREBIRD_PORT=$FIREBIRD_PORT
TRONFIRE_LAN_HOST=${HA_VIP:-$SERVER_IP}
PUBLIC_URL=http://${HA_VIP:-$SERVER_IP}:$TRONSOFTOS_PORT/tronfire
TRONFIRE_AUTH_DISABLED=true

FIREBIRD_PACKAGE_URL=https://tronsoft.bitrix24.com.br/~qQVae
FIREBIRD_TEMPLATE_URL=https://tronsoft.bitrix24.com.br/~wUw0m
FIREBIRD_PACKAGE_SHA256=
FIREBIRD_TEMPLATE_SHA256=

FIREBIRD_PASSWORD=$FIREBIRD_PASSWORD
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET

EOF

TRONCOMANDA_SECRET_KEY="$(openssl rand -base64 32 | tr -d '\n')"
cat > "$TRONCOMANDA_ENV" <<EOF
TZ=America/Sao_Paulo
TRONCOMANDA_STORAGE_ROOT=/opt/tronfire-storage/troncomanda

TRONCOMANDA_WEB_PORT=8000
TRONCOMANDA_API_PORT=9000
TRONCOMANDA_LAN_HOST=${HA_VIP:-$SERVER_IP}
TRONCOMANDA_PUBLIC_URL=http://${HA_VIP:-$SERVER_IP}:8000

TRONCOMANDA_SECRET_KEY=$TRONCOMANDA_SECRET_KEY
TRONCOMANDA_FIREBIRD_HOST=host.docker.internal
TRONCOMANDA_FIREBIRD_USER=sysdba
TRONCOMANDA_FIREBIRD_PASSWORD=$FIREBIRD_PASSWORD
TRONCOMANDA_DATABASE_ALIAS=ERP_TRONSOFT
TRONCOMANDA_DATABASE_CHARSET=win1252
EOF

cat > "$CLUSTER_SECRETS" <<EOF
SESSION_SECRET=$SESSION_SECRET
TRONSOFTOS_INTERNAL_TOKEN=$INTERNAL_TOKEN
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
FIREBIRD_PASSWORD=$FIREBIRD_PASSWORD
EOF

if [ -f "$SSH_PUBLIC_KEY_PATH" ]; then
  printf "TRONSOFTOS_SSH_PUBLIC_KEY='%s'\n" "$(cat "$SSH_PUBLIC_KEY_PATH")" >> "$CLUSTER_SECRETS"
fi

cat > "$NODE_IDENTITY" <<EOF
{
  "clusterId": "$CLUSTER_ID",
  "nodeId": "$NODE_ID",
  "nodeName": "$NODE_NAME",
  "nodeRole": "$NODE_ROLE",
  "installId": "$INSTALL_ID",
  "deploymentMode": "$DEPLOYMENT_MODE",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
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
      "publicUrl": "/tronfire/",
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
      "healthUrl": "http://127.0.0.1:8000/",
      "publicUrl": "http://$SERVER_IP:8000",
      "containers": [
        "troncomanda_web",
        "troncomanda_api",
        "troncomanda_qr",
        "troncomanda_cardapio_lite"
      ],
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
      "publicUrl": "/tronfire/",
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
      "healthUrl": "http://127.0.0.1:8000/",
      "publicUrl": "http://$SERVER_IP:8000",
      "containers": [
        "troncomanda_web",
        "troncomanda_api",
        "troncomanda_qr",
        "troncomanda_cardapio_lite"
      ],
      "haAware": false
    }
  ]
}
EOF
fi

chmod 600 "$TRONSOFTOS_ENV" "$TRONFIRE_ENV" "$TRONCOMANDA_ENV" "$CLUSTER_SECRETS" "$NODE_IDENTITY"

line
echo "Configuracao gravada com sucesso:"
echo "- $TRONSOFTOS_ENV"
echo "- $TRONFIRE_ENV"
echo "- $TRONCOMANDA_ENV"
echo "- $MANAGED_APPS"
echo "- $CLUSTER_SECRETS"
echo "- $NODE_IDENTITY"
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

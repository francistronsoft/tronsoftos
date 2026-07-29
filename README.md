# TronSoftOS

Base de arquitetura para hospedar o TronSoftOS diretamente no host, com alta disponibilidade, failover, sincronização de banco Firebird via `rsync`, gerenciamento dos serviços/containeres `tronfire` e `troncomanda`, e integração com Cloudflare.

## Direção Da Infra

- O TronSoftOS roda como servixe do sistema operacional, preferencialmente via `systemd`.
- O Firebird roda no host ou em serviço dedicado local, com dados em volume persistente.
- `tronfire` e `troncomanda` podem continuar em containeres, mas são gerenciados como dependências externas do TronSoftOS.
- O HA deve usar VIP com `keepalived`, com health check do TronSoftOS e promoção automática do nó secundário.
- O failover do banco deve ser tratado com nó primário ativo e réplica quente/fria por `rsync`.
- O Cloudflare deve apontar sempre para o endpoint ativo: VIP local, tunnel ativo, ou DNS atualizado por API.

## Estrutura

```text
backend/
  src/server.mjs              API host-based do TronSoftOS
frontend/
  src/                        Painel React/Tailwind
docs/
  arquitetura-host-ha.md      Visão de arquitetura e decisões principais
  runbook-failover.md         Procedimentos de operação e recuperação
infra/
  cloudflare/
    cloudflare-ddns.sh        Atualiza DNS Cloudflare via API
  keepalived/
    keepalived.conf.example   Template de VIP e health check
    check-tronsoftos.sh       Health check usado pelo keepalived
  systemd/
    tronsoftos.service        Template de serviço host-based
    tronsoftos-rclone-backup.* Timer/serviço para upload rclone no host
scripts/
  firebird-rsync-sync.sh      Sincronização Firebird com rsync
  install-firebird25-host.sh  Instala Firebird 2.5.9 no Debian/host
  manage-containers.sh        Operações para tronfire/troncomanda
  tronfire-catalog-export.sh  Exporta catálogo PostgreSQL do TronFire
  tronfire-catalog-import.sh  Importa catálogo PostgreSQL do TronFire no standby
  rclone-upload-backups.sh    Envia backups validados para nuvem via rclone
config/
  managed-apps.example.json   Catálogo genérico de apps/containeres gerenciados
apps/
  tronfire/                   Cópia estável do TronFire adaptada para integração HA
.env.example                  Variáveis de ambiente operacionais
install.sh                    Instalador inicial para Debian
```

## Próximos Passos Recomendados

1. Definir os dois nós HA, IPs reais e VIP.
2. Confirmar onde o Firebird ficará instalado e qual diretório contém os `.fdb`.
3. Ajustar `.env.example` para o ambiente real e salvar como `.env` fora do versionamento.
4. Validar o health check HTTP do TronSoftOS.
5. Testar failover em janela controlada antes de colocar em produção.

## Instalação Debian

```bash
sudo ./install.sh
```

O instalador chama um wizard interativo. Para reconfigurar depois:

```bash
sudo /opt/tronsoftos/scripts/configure-wizard.sh
```

Para rodar o instalador sem wizard:

```bash
sudo TRONSOFTOS_SKIP_WIZARD=true ./install.sh
```

Depois ajuste:

```text
/etc/tronsoftos/tronsoftos.env
/opt/tronsoftos/apps/tronfire/.env
/opt/tronsoftos/config/managed-apps.json
```

O painel fica disponível em:

```text
http://IP-DO-SERVIDOR:8080
```

Durante o desenvolvimento local do painel:

```bash
cd frontend
npm install
npm run dev
```

O backend pode rodar diretamente com:

```bash
cd backend
node src/server.mjs
```

## SSH De Manutencao Via Cloudflare

O Cloudflare Tunnel pode manter o painel HTTP e um acesso SSH de manutencao em hostnames separados. No painel da Cloudflare, crie um Public Hostname exclusivo para SSH apontando para:

```text
ssh://host.docker.internal:22
```

No TronSoftOS, em **Cloudflare**, habilite **SSH de manutencao pelo tunnel** e informe o hostname, por exemplo:

```text
ssh-cliente.tronsoft.app.br
```

O hostname principal do painel continua separado. Em HA, prefira um hostname SSH por no:

```text
ssh-cliente-primary.tronsoft.app.br
ssh-cliente-standby.tronsoft.app.br
```

No computador de suporte, use:

```bash
cloudflared access ssh --hostname ssh-cliente.tronsoft.app.br
```

## Integração Com A Central TronSoftOS

O backend possui um agente interno que valida o token gerado na Central, envia heartbeat periódico e publica alertas calculados pelo painel do TronSoftOS.

Fluxo recomendado:

1. Cadastre o cliente na Central.
2. Copie o token gerado pela Central.
3. Acesse o painel do TronSoftOS do cliente.
4. Abra Manutencao > Ajustes > Central TronSoftOS.
5. Informe `https://central.tronsoft.app.br` e cole o token.
6. Clique em Validar token.

Depois da validacao, o TronSoftOS grava a configuracao em:

```text
/opt/tronsoftos/state/central-settings.json
/opt/tronsoftos/state/central-installation-token
```

Variaveis opcionais no Debian:

```env
TRONSOFTOS_CENTRAL_URL=https://central.tronsoft.app.br
TRONSOFTOS_CENTRAL_HEARTBEAT_SECONDS=120
TRONSOFTOS_CENTRAL_DATABASE_ENGINE=Firebird
TRONSOFTOS_CENTRAL_DATABASE_VERSION=2.5
TRONSOFTOS_CENTRAL_DATABASE_SCHEMA_VERSION=
```

Nas proximas execucoes, ele usa o token da instalacao para enviar `/api/tronsoftos/heartbeat` e `/api/tronsoftos/alerts`.

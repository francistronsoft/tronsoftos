# TronFire

TronFire é o gerenciador local de bancos Firebird 2.5 do ambiente `tronsoftOS`.

## Escopo desta primeira base

- Firebird 2.5.9 SuperClassic em Docker.
- Imagem própria com validação obrigatória de `gbak`, `gfix`, `gstat` e `isql`.
- Storage fora da pasta do app.
- Painel técnico com login.
- Cadastro de bancos: produção, legado/consulta e homologação.
- Upload de GBK/FBK para migração.
- Upload de template único `template.fdb`.
- Backup manual inicial via `gbak`.
- Diagnóstico/preflight do ambiente.
- Worker inicial para monitorar utilitários, bancos e disco.
- Scripts de proteção para atualização/reinstalação.

## Storage no Windows durante desenvolvimento

Enquanto estiver usando Docker no Windows, use uma pasta fixa do Windows no `.env`:

```env
SERVER_PLATFORM=windows-docker
APP_ROOT=C:/projeto/tronfire
STORAGE_ROOT=C:/tronfire-storage
```

O Docker vai montar essa pasta como storage persistente para Firebird, Postgres, Redis e backups. Evite usar `/opt/tronsoftOS/...` no Windows, porque esse caminho e mais apropriado para a maquina Debian final.

Estrutura esperada no Windows:

```txt
C:/tronfire-storage/
  firebird/
    data/
    backups/
    uploads/
    templates/
    restore-work/
    quarantine/
    logs/
  postgres/
  redis/
  config-backups/
  update-backups/
```

Para criar a pasta base no PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\tronfire-storage
```

## Estrutura recomendada no Debian

```txt
/opt/tronsoftOS/
├─ apps/
│  └─ tronfire/
│     └─ app/
└─ storage/
   └─ tronfire/
      ├─ firebird/
      │  ├─ data/
      │  ├─ backups/
      │  ├─ uploads/
      │  ├─ templates/
      │  ├─ restore-work/
      │  ├─ quarantine/
      │  └─ logs/
      ├─ postgres/
      ├─ redis/
      ├─ config-backups/
      └─ update-backups/
```

## Instalação inicial no Debian

1. Copie o projeto para:

```bash
/opt/tronsoftOS/apps/tronfire/app
```

2. Crie o `.env`:

```bash
cp .env.example .env
```

3. Edite as senhas no `.env`.

No Linux, mantenha estes caminhos:

```env
APP_ROOT=/opt/tronfire
STORAGE_ROOT=/opt/tronfire-storage
```

Se ainda nao souber o IP fixo do servidor, deixe em branco por enquanto:

```env
TRONFIRE_LAN_HOST=
PUBLIC_URL=
```

Depois da instalacao, quando souber o IP da rede, ajuste por exemplo:

```env
TRONFIRE_LAN_HOST=192.168.0.10
PUBLIC_URL=http://192.168.0.10:8081
```

4. Crie o storage:

```bash
export STORAGE_ROOT=/opt/tronfire-storage
./scripts/init-storage.sh
```

5. Baixe os artefatos privados do Firebird/template:

```bash
bash scripts/install-assets.sh
```

O projeto não usa repositório da distro para instalar o Firebird 2.5, justamente para evitar ausência de utilitários.

O script usa as variaveis abaixo do `.env`:

```env
FIREBIRD_PACKAGE_URL=https://tronsoft.bitrix24.com.br/~qQVae
FIREBIRD_TEMPLATE_URL=https://tronsoft.bitrix24.com.br/~wUw0m
```

Ele salva os arquivos em:

```txt
docker/firebird25/FirebirdCS-2.5.9.27139-0.amd64.tar.gz
docker/firebird25/template.fdb
```

6. Suba o stack:

```bash
docker compose up -d --build
```

7. Acesse localmente:

## Instalação inicial no Windows

1. Deixe o projeto em:

```powershell
C:\projeto\tronfire
```

2. Configure no `.env`:

```env
STORAGE_ROOT=C:/tronfire-storage
```

3. Crie a pasta:

```powershell
New-Item -ItemType Directory -Force C:\tronfire-storage
```

4. Suba o stack:

```powershell
docker compose up -d --build
```

5. Acesse localmente ou pela rede:

```txt
http://127.0.0.1:8081
http://IP-DA-MAQUINA:8081
```

Usuário inicial:

```txt
admin@tronfire.local
admin123
```

Altere essa senha depois do primeiro acesso.

## Regras de segurança

Nunca use:

```bash
docker compose down -v
docker volume prune
docker system prune --volumes
rm -rf /opt/tronsoftOS/storage/tronfire
```

Permitido:

```bash
docker compose down
docker compose up -d --build
docker compose restart
git pull
```

## Portas

Por padrão:

```txt
TronFire painel: 0.0.0.0:8081
Firebird:        0.0.0.0:3050
```

Para acessar de uma estacao, use o IP da maquina onde o Docker esta rodando, por exemplo:

```txt
http://192.168.0.10:8081
```

No `.env`, ajuste `TRONFIRE_LAN_HOST` e `PUBLIC_URL` para esse mesmo IP.

No Windows, se ja existir um Firebird local usando `3050`, use no `.env`:

```env
TRONFIRE_FIREBIRD_PORT=3051
```

Nesse caso o Firebird continua na porta `3050` dentro do container, mas fica acessivel pelo Windows/rede na porta `3051`.

Se o `tronsoftOS` ja possui Cloudflare/proxy, encaminhe o dominio externo para `http://IP-DA-MAQUINA:8081`.

Não exponha a porta 3050 na internet.

## Backup externo

O TronFire gera os backups locais em `/firebird/backups`. Por padrao, a validacao pesada por restore/gstat roda uma vez por dia, na janela de madrugada, para reduzir impacto em clientes com banco grande. Os backups feitos fora da janela ficam marcados como "backup simples" e continuam disponiveis para download/upload.

No HA em modo `backup_restore`, apenas manifestos com validacao aprovada sao sincronizados para restore no standby. O HA fisico padrao nao depende dessa validacao do GBK.

Variaveis principais:

```env
TRONFIRE_BACKUP_VALIDATION_MODE=daily
TRONFIRE_BACKUP_VALIDATION_HOUR=2
TRONFIRE_BACKUP_VALIDATION_WINDOW_MINUTES=180
TRONFIRE_BACKUP_VALIDATION_MAX_AGE_HOURS=30
```

Use `always` somente quando cada backup precisar ser restaurado e validado imediatamente. O envio para Google Drive/rclone e centralizado no TronSoftOS para manter uma unica configuracao por servidor.

### URL publica com Cloudflare Tunnel

Para instalações locais, o OAuth Web do Google exige uma URL publica com domínio valido. O TronFire pode iniciar um container `cloudflared` usando um token de Tunnel criado na Cloudflare.

No painel da Cloudflare, crie um Tunnel e configure o Public Hostname apontando para:

```txt
http://backend:8080
```

No TronFire:

1. Acesse **Configuracoes > Cloudflare Tunnel**.
2. Informe a URL publica, por exemplo `https://cliente.seudominio.com.br`.
3. Cole o token do Tunnel.
4. Clique em **Iniciar tunnel**.
5. Configure rclone/Google Drive no painel TronSoftOS, em **Backups**.

## Próximas etapas recomendadas

- Implementar fila de restore GBK/FBK em área temporária.
- Implementar atualização estrutural via migrations Firebird.
- Implementar retenção automática de backups.
- Implementar tela de usuários e troca de senha.
- Implementar download de logs e backups pelo painel.
- Implementar atualização via GitHub por tags.

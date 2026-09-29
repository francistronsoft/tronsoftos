# TronComanda no TronSoftOS

Este stack adapta o TronComanda para o padrao do TronSoftOS em Debian.

Servicos:

- `troncomanda_web`: httpd, porta padrao `8000`.
- `troncomanda_api`: API, porta padrao `9000`.
- `troncomanda_qr`: frontend QR interno.
- `troncomanda_cardapio_lite`: cardapio lite interno.
- `tsretaguarda-api`: API da Retaguarda, porta padrao `9001`.
- `tsretaguarda-web`: frontend da Retaguarda, porta padrao `8010`.

Quando o stack e instalado ou atualizado pelo painel do TronSoftOS, o container
`tronsoftos_cloudflared` e conectado automaticamente a rede `troncomanda_net`.
Isso permite que regras remotas do Cloudflare Tunnel usem os nomes Compose,
como `http://web` e `http://tsretaguarda-web:8010`.

O mesmo ajuste e executado quando o Tunnel e configurado depois do
TronComanda. A operacao e idempotente e nao reinicia Firebird, PostgreSQL,
Redis ou os containers de aplicacao.

Os Public Hostnames e caminhos externos continuam sendo configurados no painel
da Cloudflare. No TronSoftOS basta informar o token do Tunnel; nao e necessario
repetir a URL publica da aplicacao.

Dados persistentes:

- `/opt/tronfire-storage/troncomanda/qr-static`
- `/opt/tronfire-storage/troncomanda/arquivos-nfe`
- `/opt/tronfire-storage/troncomanda/sped-fiscal-sintegra`
- `/opt/tronfire-storage/troncomanda/empresas`

Banco Firebird:

- Por padrao usa o Firebird no host via `host.docker.internal`.
- Ajuste `TRONCOMANDA_DATABASE_ALIAS` no `.env` para o alias/banco correto.

Primeira configuracao:

```bash
cd /opt/tronos/apps/troncomanda
sudo cp .env.example .env
sudo nano .env
sudo docker compose up -d
```

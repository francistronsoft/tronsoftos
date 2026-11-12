# TronComanda no TronSoftOS

Este stack adapta o TronComanda para o padrao do TronSoftOS em Debian.

Servicos:

- `troncomanda_web`: httpd, porta padrao `8000`.
- `troncomanda_api`: API, porta padrao `9000`.
- `troncomanda_qr`: frontend QR interno.
- `troncomanda_cardapio_lite`: cardapio lite interno.
- `tsretaguarda-api`: API da Retaguarda, porta padrao `9001`.
- `tsretaguarda-web`: frontend da Retaguarda, porta padrao `8010`.
- `kds-web`: KDS Web, porta padrao `8012`, perfil opcional `kds`.

O KDS pode ser habilitado em TronComanda > Ajustes dos containers > KDS Web.
Nas instalacoes existentes ele permanece desligado ate essa ativacao. A porta
do host pode ser personalizada com `KDS_WEB_PORT`.
O KDS funciona com a API `main` atual. Habilitar ou salvar o KDS preserva a
branch, tags de imagem e URLs configuradas; nao troca automaticamente para QA.
Instalacao/atualizacao valida as rotas de autenticacao e KDS na API em execucao,
em vez de exigir uma branch fixa. Uma API sem essas rotas gera erro explicito,
sem desabilitar o perfil KDS ou declarar sucesso.

A escolha explicita de `main` ou `qa` no painel configura o Gerente para a API
unificada `http://api:9000`; Retaguarda continua com sua API separada. QA usa
API `:qa` e frontends `:main`. A branch `dev` preserva as tags e a API legada do
Gerente anteriores. URLs personalizadas permanecem ao salvar ajustes; a escolha
explicita de uma branch reaplica o padrao correspondente. A atualizacao do
TronSoftOS nao recria esses aplicativos nem altera sua branch automaticamente.

O caminho `http://IP/kds/` e encaminhado pelo host sem capturar os endpoints
de autenticacao e gerenciamento do TronSoftOS. O caminho `/kds/` tambem esta
disponivel na porta `8000`. A validacao de instalacao exige as rotas
`/auth/user/token/` e `/kds/stations/` no OpenAPI da API compartilhada.
O arquivo env/kds-web.env do Compose de origem informa somente a tag da imagem;
na adaptacao essa tag fica em KDS_WEB_IMAGE_TAG no .env do stack.

Para acesso externo, a origem no painel Cloudflare pode usar
`http://kds-web:8012`, na rede `troncomanda_net` ja gerenciada pelo TronSoftOS.
Nenhuma regra remota de hostname ou caminho e alterada automaticamente.

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

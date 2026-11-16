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

## Tron BI (opcional)

Habilite **Tron BI** em **TronComanda > Ajustes dos containers**. O perfil `bi`
fica desligado por padrao e nao e ativado automaticamente ao atualizar.
A imagem e `ghcr.io/tronsoft-solucoes/tron-bi:main`; acesso direto:
`http://IP:8013/bi/`. A raiz da porta nao e a pagina do aplicativo. `BI_PORT`
permite trocar a porta publicada, caso ja esteja ocupada.

O SQLite executa dentro do BI e usa `/app/data/tron-bi.db`, sem instalar um
servico SQLite no Debian ou usar uma porta de banco. Por padrao, o volume Docker
`troncomanda_bi_data` guarda os dados fora do ciclo de vida do container e preserva
as permissoes fornecidas pela imagem. `BI_DATA_HOST_PATH` pode apontar para um
caminho absoluto alternativo, com permissao de escrita para o usuario da imagem.
Desabilitar o BI para somente o container; nao remove esse volume ou o banco.
Backups Firebird existentes nao incluem automaticamente o volume SQLite do BI.

Na primeira inicializacao, se a tabela USUARIO estiver vazia, o TronSystem cria
`tronsoft` usando somente o hash scrypt da senha padrao autorizada. O repositorio
nao contem a senha em texto, banco template, sessoes ou chave API compartilhada.
Contas existentes (inclusive senhas alteradas) sao preservadas, mesmo ao recriar
o container. Troque a senha inicial apos o primeiro acesso. Para desativar essa
inicializacao, configure `BI_BOOTSTRAP_ENABLED=false`. A chave API deve ser gerada
separadamente no BI; ela nao e copiada do banco fornecido como referencia.

Variaveis: `BI_IMAGE_TAG` (main por padrao), `BI_PORT` (8013),
`BI_DATA_HOST_PATH` (vazio usa volume Docker) e `INGEST_API_KEY` (opcional, conforme
configuracao do aplicativo). As variaveis do Compose de origem foram incorporadas
no Compose gerenciado; nao e necessario criar um env/tron-bi.env separado.
Ao escolher QA, a API permanece QA e o BI usa main, como os demais frontends.

O proxy TronComanda encaminha `/bi` e `/bi/` preservando o basePath da imagem e
os recursos `/bi/_next/`. Para Cloudflare, usar origem `http://web:80` com caminho
`/bi`, ou `http://tron-bi:8013` na rede gerenciada. O host do painel encaminha `/bi` na porta80 para a porta BI configurada,
sem capturar `/api` ou `/_next` das outras aplicacoes. Assim o endereco padrao
e `http://IP/bi`, com acesso direto8013 e proxy8000 tambem disponiveis.
Regras de hostname/caminho no painel Cloudflare continuam sob controle do operador.

Ao mudar somente o botao BI, o backend cria/para somente `tron-bi`, sem recriar
QR, API, Gerente, Retaguarda ou KDS. Clientes antigos que salvam outras opcoes
preservam um BI ja habilitado. A listagem passa a incluir status/versao do BI em
instalacoes existentes sem sobrescrever configuracoes personalizadas.

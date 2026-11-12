# TronComanda main com KDS — 0.1.143

O painel deixa de exigir QA para instalar/atualizar o TronComanda com KDS ativo.
A main publicada em 12/11/2026 ja oferece as rotas KDS e a API unificada do
Gerente. Habilitar ou salvar KDS nao muda branch, tags fixadas, perfis dos
demais aplicativos ou URLs existentes.

Ao selecionar explicitamente main, Gerente usa http://api:9000, assim como QA.
QA continua com API :qa e frontends :main; dev conserva seu comportamento
anterior. Wizard, exemplo de configuracao e fallback Compose passam a usar a
API unificada para novas instalacoes main. A API separada da Retaguarda e os
servicos legados existentes sao preservados.

O suporte ao KDS e verificado no OpenAPI da API efetivamente em execucao,
exigindo /auth/user/token/ e /kds/stations/. Falta de suporte ou indisponibilidade
gera falha explicita, sem informar sucesso ou desabilitar KDS silenciosamente.
Essa verificacao nao implementa retorno automatico das imagens dos aplicativos.

Receber a atualizacao do TronSoftOS nao troca automaticamente a branch nem
recria os containers dos aplicativos. Depois, o operador pode escolher main e
usar Instalar/Atualizar, ou manter QA. Nao e necessario reinstalar o sistema.

Testes de regressao cobrem main/QA/dev, instalacao/atualizacao pelo painel,
preservacao de tags/URLs/perfis, API incompativel, ajustes de clientes antigos,
autenticacao GHCR e roteamento KDS. Nenhuma mudanca em Firebird, monitoramento,
backup, HA ou agendamento de sweep.

Validacao da release: 97 testes aprovados, sem falhas ou skips, em container
Linux Debian 12 isolado sem rede com Node 22.23.4; build Vite aprovado;
Compose real renderizado e conferido para main, QA, dev e configuracao padrao;
bash -n do wizard aprovado. Nao houve aplicacao em servidor de producao nesta
publicacao. Os containers main do Newco ja haviam sido validados na intervencao
anterior, incluindo rotas KDS, acesso externo e consulta somente leitura.

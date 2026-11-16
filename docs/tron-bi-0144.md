# Tron BI opcional — 0.1.144

Adiciona perfilbi, imagemtron-bi, toggle/status no painel e verificacao de acesso
`http://127.0.0.1:8013/bi/`. BI desativado por padrao em novas instalacoes e upgrades.
Tags main/dev seguem selecao explicita; QA usa BI main. Salvar ajustes preserva
tags, branch, chave ingest e local dos dados. Payload antigo nao desativa BI.
Mudanca somente no BI nao recria os demais servicos. Desabilitar nunca remove
o volume SQLite. O volume Docker padrao preserva dados/permissoes da imagem;
caminho proprio pode ser definido por BI_DATA_HOST_PATH.

SQLite interno nao altera PostgreSQL ou Firebird e nao expoe porta de banco.
Portaweb8013 configuravel em BI_PORT. Proxy preserva prefixo/recursos /bi;
nao adiciona roteamento generico /_next ou /api que intercepte outros aplicativos.
Nenhum database-updater ou nova migracao Firebird foi incorporado do Compose
fornecido; somente a imagem BI solicitada.

Validado na VM Debian11 192.168.1.105: porta8013 inicialmente livre, imagem real,
pagina login e8 recursos estaticos200, tentativa de usuario sintetico401,
SQLite real com cabecalhoSQLite format3 persistindo apos parar/remover/recriar
somente o BI, usuario nextjs e volume troncomanda_bi_data. Firebird e IDs dos
outros containers preservados. Sem login real ou teste de ingestao comercial.

Inclui encaminhamento direto no host `/bi` e `/bi/*` para a porta BI configurada,
com prefixo, query, metodos, cookies e redirecionamentos relativos preservados.
Nao captura `/api`, `/_next`, `/kds` ou prefixos parecidos como `/billing`.
Suite final:107 testes Linux sem falhas/skips e build frontend aprovado.
Proxy Nginx temporario na VM passou /bi, /bi/,8 assets, QR/KDS e BI desabilitado.

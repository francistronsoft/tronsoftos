# Instalador, pareamento HA e DNS - 0.1.133

## Pareamento

Importacao permitida somente em standby/recovery HA que nao esteja atendendo
producao. O host grava os segredos e atualiza sua autenticacao em memoria;
recria exclusivamente backend e worker com Compose host, sem dependencias,
build ou pull. Firebird, PostgreSQL e Redis nao sao reiniciados.

Cada container compara o fingerprint de seu token carregado com o token
importado e realiza uma chamada autenticada ao endpoint Firebird do host.
A sonda verifica somente os executaveis, sem abrir conexao com o banco.
Sucesso depende das duas verificacoes. Falhas permanecem repetiveis e nao
sao informadas como pareamento concluido. A sessao do tecnico e reassinada
com o token novo, inclusive quando a validacao falha apos salvar os segredos.

Importacoes simultaneas sao recusadas. Credenciais PostgreSQL divergentes
impedem a importacao antes de alterar arquivos; a rotina nao troca a senha
do PostgreSQL existente. O teste de utilitarios distingue ausencia real
(FIREBIRD_TOOL_MISSING) de falha do verificador (FIREBIRD_TOOL_CHECK_FAILED).

## Assistente

Ordem: HA, papel do no, nome e ID do cluster. Primary sugere servidor-01;
standby sugere servidor-02. Nome e ID personalizados sao preservados.
Modo simple continua sem perguntas de VIP/sincronismo/promocao.

## DNS

Espacos e virgulas sao aceitos; todos os enderecos sao validados antes da
gravacao. IPv4 e IPv6 sao preservados, removendo duplicatas. Escopo IPv6
e normalizado para o endereco na interface selecionada.

NetworkManager recebe IPv4/IPv6 em suas propriedades respectivas e ignora
DNS automatico nas conexoes estaticas. Networkd recebe uma linha DNS por
endereco. O assistente grava a configuracao persistente mesmo quando a
aplicacao imediata e recusada; nesse caso nao reconecta a interface.

O painel le a configuracao salva por helper privilegiado, limitado a campos
de rede, sem expor tokens. Exibe DNS solicitado, persistido e ativo, com
aviso quando o ativo difere. A API confirma a lista persistida antes de
informar sucesso. DNS do networkd depende do resolved/resolvedor configurado
no Debian para se tornar ativo; a lista salva nao e apresentada como ativa.

## Verificacao

Testes de importacao, autenticacao, tokens divergentes, falha parcial,
concorrencia, sessao, assistente e DNS fazem parte da suite Node. Testes
shell usam diretorios temporarios e comandos de rede simulados. O ciclo
HA real de dois nos e o efeito apos reinicio de hardware permanecem testes
operacionais separados; nao foram simulados como se fossem realizados.

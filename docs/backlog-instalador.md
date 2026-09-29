# Backlog do instalador TronSystem

Este documento registra requisitos para a proxima implementacao do instalador.
Os itens abaixo ainda nao autorizam mudancas automaticas em ambientes instalados.

## P0 - concluir o pareamento HA

Problema observado no Provocateur:

- a importacao atualiza os tokens nos arquivos do host;
- `tronfire_backend` e `tronfire_worker` continuam com o token antigo;
- chamadas ao TronSoftOS retornam `401 Unauthorized`;
- o worker pode criar o alerta incorreto de utilitarios Firebird ausentes.

Requisitos:

1. Apos importar o pareamento no standby, recriar somente `tronfire_backend` e
   `tronfire_worker` com os arquivos Compose do modo Firebird host.
2. Nao reiniciar Firebird, PostgreSQL ou Redis nessa operacao.
3. Comparar, sem exibir o segredo, o token carregado pelos containers com o
   token persistido no host.
4. Executar uma chamada autenticada de verificacao ao Firebird host.
5. Informar pareamento concluido somente depois dessa verificacao.
6. Diferenciar `utilitario ausente` de falha de autenticacao, comunicacao ou
   execucao do verificador.

## P0 - exclusao global das consultas de monitoramento Firebird

Problema observado no Ilha Vix:

- o single-flight atual evita sobreposicao somente dentro de cada processo;
- `tronfire_backend` e `tronfire_worker` mantem travas independentes;
- o endpoint do host `/api/host/firebird/script` ainda aceita sondagens
  concorrentes originadas por processos ou containers diferentes;
- mesmo depois da reducao de sondagens, foram observados grupos de
  `firebird-script` simultaneos;
- no incidente de 24/09/2026, consultas de monitoramento passaram de
  subsegundo para 25 segundos e depois ficaram presas por mais de 120 segundos;
- a primeira falha foi detectada pela coleta `session-history`, que consulta
  `MON$ATTACHMENTS` a cada minuto;
- o Firebird 2.5.9 SuperClassic permaneceu com o processo e a porta ativos,
  mas deixou de aceitar consultas ate a reinicializacao.

Requisitos:

1. Implementar uma trava global no host para sondagens Firebird, compartilhada
   por backend, worker e demais containers.
2. Aplicar a trava apenas a consultas de monitoramento, sem serializar nem
   bloquear conexoes normais do TronSystem.
3. Usar classes de trava separadas para monitoramento, backup, validacao,
   sweep e manutencao manual.
4. Quando uma sonda equivalente ja estiver em andamento, reutilizar um
   resultado recente ou retornar estado adiado; nao abrir outro `isql`.
5. Definir timeout curto para obter a trava e nunca manter chamadas acumuladas
   esperando indefinidamente.
6. Garantir a liberacao da trava em sucesso, erro, timeout, sinal ou reinicio
   de container, preferencialmente com `flock` no host.
7. Manter o single-flight local e os caches atuais como primeira camada; a
   trava global deve ser uma segunda camada de protecao.
8. Tornar configuravel o intervalo do `session-history`, usando cinco minutos
   como valor conservador em ambientes Firebird 2.5 de uso intenso.
9. Evitar que `session-history`, diagnostico de versao, indices e conexoes
   consultem simultaneamente as tabelas `MON$` do mesmo banco.
10. Registrar duracao, origem, classe da sonda, espera pela trava, resultado
    reutilizado e timeout, sem gravar senha ou conteudo sensivel.
11. Emitir alerta quando duas consultas consecutivas excederem o limite, mas
    impedir que o proprio mecanismo de alerta dispare novas sondagens.
12. Nao reiniciar automaticamente o Firebird nesta implementacao; qualquer
    recuperacao automatica deve ser uma politica separada e explicitamente
    habilitada.

## P0 - consistencia transacional da Central

Problema confirmado no recadastro do Provocateur:

- o pareamento foi aceito e retornou o novo `installationId`
  `2dab180c-5cea-d747-f1d4-6caa8a625804`;
- o agente validou e persistiu o token recebido;
- no heartbeat seguinte, a Central respondeu que a instalacao nao existia;
- a API continuou exibindo somente o cadastro antigo, com outro
  `installationId`, hostname antigo e estado offline;
- leituras repetidas diretamente na API retornaram o mesmo resultado, sem
  indicio de cache do navegador ou do Cloudflare;
- tambem foi observado ambiente excluido que permaneceu temporariamente no
  painel e desapareceu depois;
- a Central le e sobrescreve todo o estado armazenado em um unico documento
  JSONB, sem lock transacional ou controle de versao, permitindo que uma
  requisicao concorrente grave uma copia antiga e desfaça pareamentos,
  exclusoes ou heartbeats recentes.

Requisitos:

1. Tornar atomicas todas as operacoes de leitura, modificacao e gravacao do
   estado da Central.
2. Como correcao imediata, executar a mutacao dentro de transacao PostgreSQL
   com `SELECT ... FOR UPDATE` sobre a linha de estado.
3. Nao manter `readDb()` e `writeDb()` separados em rotas mutaveis sem uma
   trava que cubra todo o ciclo.
4. Considerar controle otimista de versao com comparacao e repeticao como
   protecao adicional contra atualizacoes perdidas.
5. Planejar a normalizacao futura de instalacoes, tokens, alertas e eventos em
   tabelas proprias, evitando que um heartbeat regrave dados nao relacionados.
6. Depois do commit, reler o estado persistido e confirmar que a instalacao,
   exclusao ou alteracao continua presente antes de responder sucesso.
7. Registrar conflito, repeticao e falha de persistencia com identificadores
   da operacao, sem registrar tokens ou outros segredos.
8. O agente pode orientar novo pareamento quando receber `404`, mas nao deve
   executar `identify` automaticamente e recriar um ambiente que tenha sido
   excluido ou desvinculado intencionalmente.
9. Diferenciar no frontend falha de persistencia, ambiente desvinculado e
   sessao visual desatualizada; nao apresentar sucesso antes da confirmacao do
   backend.
10. Apos corrigir a Central, resetar e parear novamente o Provocateur e
    confirmar que o novo `installationId` permanece recebendo heartbeats.

## P1 - ordem inicial do assistente

Para instalacao nova, a ordem deve ser:

1. Perguntar primeiro se o ambiente possui alta disponibilidade.
2. Se possuir HA, perguntar o tipo deste servidor:
   - opcao 1: `primary`;
   - opcao 2: `standby`.
3. Somente depois pedir o nome do servidor.
4. Para `primary`, sugerir `servidor-01`.
5. Para `standby`, sugerir `servidor-02`.
6. Usar o nome confirmado para sugerir o ID do cluster sem sobrescrever um ID
   informado pelo tecnico.

O modo sem HA deve continuar simples e nao deve exibir configuracoes de VIP,
sync ou promocao.

## P1 - persistencia de DNS primario e secundario

Problema observado na instalacao do standby:

- foram informados dois servidores DNS;
- depois da configuracao, o segundo DNS nao apareceu como salvo;
- a interface continuou exibindo o valor detectado anteriormente.

Requisitos:

1. Aceitar dois ou mais DNS separados por espaco ou virgula.
2. Normalizar e validar cada endereco antes de salvar.
3. Persistir a lista completa em `HOST_STATIC_IP_DNS`.
4. No `systemd-networkd`, gravar uma linha `DNS=` para cada servidor.
5. No NetworkManager, gravar todos os servidores em `ipv4.dns` e impedir que
   DNS recebido por DHCP substitua a lista quando o IP for estatico.
6. Depois de aplicar, reler a configuracao persistente e a configuracao ativa.
7. Mostrar separadamente no resumo:
   - DNS solicitado;
   - DNS persistido;
   - DNS ativo.
8. Avisar quando o valor ativo ainda depender de reinicio ou reconexao da
   interface, sem apresentar o valor antigo como se fosse o novo.

## P1 - acesso externo do TronComanda pelo Cloudflare

Status: implementado na versao `0.1.130`; pendente validacao em uma instalacao
real e definicao do comportamento do Tunnel durante promocao HA.

Problema observado no Provocateur:

- os containers do TronComanda estavam ativos e acessiveis pela rede local;
- o Cloudflare Tunnel possuia as regras `http://web` e
  `http://tsretaguarda-web:8010`;
- o container `tronsoftos_cloudflared` havia sido criado antes da rede
  `troncomanda_net` e nao estava conectado a ela;
- o acesso externo retornava erro de origem indisponivel.

Requisitos:

1. Depois de instalar ou atualizar o TronComanda, conectar de forma idempotente
   `tronsoftos_cloudflared` a rede `troncomanda_net`.
2. Quando o Cloudflare Tunnel for criado depois dos aplicativos, conecta-lo a
   todas as redes Docker gerenciadas que ja existirem.
3. A ausencia temporaria do container ou da rede deve adiar a conexao sem fazer
   a instalacao falhar.
4. Manter os Public Hostnames e caminhos externos sob controle do painel da
   Cloudflare, sem exigir que a URL publica seja repetida no TronSoftOS.
5. Preservar compatibilidade com `TRONCOMANDA_PUBLIC_URL` quando ela ja estiver
   definida manualmente no arquivo de ambiente.
6. Validar, ao final da instalacao:
   - resolucao de `web` a partir do container Cloudflare;
   - `HTTP 200` no `/health` interno;
   - acesso externo da Retaguarda, quando instalada.
7. Em HA, documentar e testar como o conector Cloudflare acompanha o no ativo,
   sem encaminhar requisicoes para um standby ainda nao promovido.

## Testes de aceite

- Instalar um primary e confirmar sugestao `servidor-01`.
- Instalar um standby e confirmar sugestao `servidor-02`.
- Informar dois DNS, aplicar imediatamente e validar os dois.
- Informar dois DNS sem aplicar imediatamente, reiniciar e validar os dois.
- Testar os caminhos com `systemd-networkd` e NetworkManager.
- Importar o pareamento e confirmar que os dois containers recebem o token
  atual sem reiniciar o Firebird.
- Confirmar que a verificacao dos utilitarios nao cria alerta falso.
- Confirmar que primary e standby continuam na mesma versao depois da
  instalacao e do pareamento.
- Instalar o TronComanda depois do Cloudflare e confirmar a conexao automatica
  com `troncomanda_net`.
- Instalar o Cloudflare depois do TronComanda e confirmar a mesma conexao.
- Confirmar que os hostnames e caminhos definidos no painel da Cloudflare
  acessam o TronComanda sem exigir URL publica no TronSoftOS.
- Disparar simultaneamente coletas do backend e do worker e confirmar que
  somente um processo `isql` de monitoramento chega ao host.
- Confirmar que a segunda coleta usa cache ou retorna como adiada dentro do
  timeout definido.
- Simular timeout e encerramento forcado da sonda e confirmar que a trava e
  liberada sem reiniciar Firebird, PostgreSQL, Redis ou os aplicativos.
- Executar backup e sweep de teste e confirmar que as classes de trava nao
  causam bloqueio indevido entre operacoes diferentes.
- Confirmar por telemetria que `session-history`, indices, diagnostico de
  versao e conexoes nao geram consultas `MON$` concorrentes para o mesmo banco.
- Executar pareamento enquanto varios ambientes enviam heartbeat e confirmar
  que o novo cadastro nao desaparece.
- Excluir ou desvincular um ambiente durante heartbeats concorrentes e
  confirmar que ele nao reaparece na API nem no painel.
- Executar alteracoes concorrentes em instalacoes distintas e confirmar que
  nenhuma atualizacao e perdida.
- Simular conflito transacional e confirmar repeticao controlada ou erro
  explicito, sem responder sucesso falso.
- Confirmar que um `404` apos desvinculacao intencional nao recria o ambiente
  automaticamente.

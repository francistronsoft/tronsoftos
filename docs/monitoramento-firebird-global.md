# Protecao global de monitoramento Firebird - 0.1.132

No modo Firebird host, as sondagens do backend e worker informam explicitamente
`operationClass: monitor`. O endpoint do TronSoftOS compartilha sondagens com
scripts identicos, reutiliza resultados por cinco segundos e adia scripts
diferentes enquanto uma sonda esta ativa. Os single-flights, caches locais e
circuit breakers anteriores continuam presentes.

O executor privilegiado usa flock em
`/run/tronsoftos-firebird-monitor/probe.lock`, dentro de diretorio root 0700.
Isso tambem protege chamadas de processos host diferentes. A espera entre
processos e limitada a dois segundos; contencao retorna codigo 75 e a API
converte para `ok: false, deferred: true`. Backend nao interpreta adiamento
como snapshot vazio. Worker preserva saude, sessoes e contadores de falha.

Monitoramento tem deadline solicitado entre 5 e 90 segundos, com timeout GNU
e kill-after de dois segundos para seus descendentes. O timeout externo possui
folga de sete segundos para aquisicao da trava e limpeza. A trava acompanha os
descritores herdados, evitando liberacao antes da terminacao dos descendentes.
Falhas, sinais e timeout sao cobertos por testes Linux reais.

Backup, validation, sweep e manual sao classes separadas. Nao competem pela
trava monitor e preservam os limites e as protecoes locais anteriores.
Isso nao promete excluir monitoramento durante um backup iniciado por outro
processo: a exclusao implementada aqui e entre sondagens de monitoramento.
Conexoes normais dos aplicativos nao passam pelo executor e nao sao alteradas.
Nenhum reinicio automatico de Firebird foi adicionado.

Eventos registram origem, classe, duracao, timeout, compartilhamento, cache,
adiamento e espera sem registrar SQL, senha ou saida sensivel da sonda.
Duas sondagens consecutivas com duracao de pelo menos dez segundos ou timeout
ativam FIREBIRD_MONITOR_SLOW no dashboard/heartbeat da Central. Uma nova sonda
rapida limpa o estado host. O alerta nao abre novas conexoes Firebird.

## Intervalo das sessoes

`TRONFIRE_FIREBIRD_SESSION_INTERVAL_MINUTES` no ambiente Compose do worker:
padrao cinco minutos, minimo um, maximo sessenta. O cron conserva o deslocamento
de trinta segundos para afastar a coleta da fronteira dos backups; a funcao
limita as execucoes efetivas. Uma coleta adiada nao sobrescreve historico.
O backend aceita o snapshot pelo intervalo configurado mais trinta segundos,
preservando o horario de coleta e evitando novas consultas apenas porque o
snapshot envelheceu antes da proxima amostragem.

## Compatibilidade e ativacao

Chamadas antigas sem classe continuam como manual. Para a protecao completa,
atualizar juntos host, executor privilegiado, backend e worker. Instalar apenas
o modulo host nao protege clientes antigos que ainda nao marcam as sondagens.
Os modos de execucao direta local e Firebird container conservam os caminhos
anteriores; a trava deste documento atende o caminho de execucao via host.

## Testes

Suite:

```sh
node --test backend/src/firebird-monitor*.test.mjs apps/tronfire/backend/src/*.test.js apps/tronfire/worker/src/*.test.js
```

Os testes runner precisam de Linux/root e usam scripts simulados com sleep e
printf, sem acessar banco ou encerrar sessoes Firebird. No Windows ficam skip.
Os testes clientes/endpoint verificam autenticacao, assinatura, deadlines,
compartilhamento, resposta adiada, limpeza e preservacao de circuit breakers.

Testar isoladamente no Kabecos nao equivale a ativar os servicos instalados:
a versao de producao permanece inalterada ate uma atualizacao autorizada.

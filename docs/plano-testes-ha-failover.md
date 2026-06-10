# Plano De Testes HA E Failover

Este roteiro valida o TronSoftOS em dois nos antes de liberar um cliente em producao. Execute primeiro em laboratorio e depois em janela controlada no cliente.

## Premissas

- Dois servidores na mesma rede/VLAN.
- IP fixo real configurado nos dois nos.
- Um VIP livre na mesma sub-rede dos dois servidores.
- Mesmo `HA_ROUTER_ID` e `HA_AUTH_PASS` nos dois nos.
- Prioridade sugerida: primary `150`, standby `100`.
- Cloudflare apontando para o VIP quando o modelo for HA local.
- Firebird validado no primary antes de qualquer promocao.

## Dados Do Teste

Preencha antes da execucao:

| Item | Valor |
| --- | --- |
| Cliente | |
| Data | |
| No A / primary | |
| IP real No A | |
| No B / standby | |
| IP real No B | |
| VIP/CIDR | |
| Interface | |
| Router ID | |
| Cloudflare host | |
| Banco Firebird principal | |
| Operador | |

## Fase 1: Pre-Check Dos Dois Nos

Rode em cada no:

```bash
cd /opt/tronsoftos
sudo bash scripts/ha-smoke-test.sh
```

Resultado esperado:

- `tronsoftos` ativo.
- `keepalived` ativo.
- `/health`, `/api/cluster/guard` e `/api/diagnostics` respondendo.
- Docker respondendo quando houver `tronfire`/`troncomanda`.
- No primary, VIP presente.
- No standby, VIP ausente enquanto o primary estiver saudavel.

Validar tambem pelo painel:

- Cluster HA em modo `ha`.
- Primary com papel `primary`.
- Standby com papel `standby`.
- `cluster-lock` presente.
- Promocao bloqueada por padrao.
- Sync HA configurado para o IP real do standby.

## Pareamento Primary/Standby

No painel do primary:

1. Abrir `Ajustes`.
2. Em `Pareamento HA`, clicar em `Exportar arquivo`.
3. Transferir o `cluster-secrets.env` para o standby por canal seguro.

No painel do standby:

1. Abrir `Ajustes`.
2. Em `Pareamento HA`, clicar em `Importar arquivo`.
3. Selecionar o `cluster-secrets.env` exportado do primary.
4. Reiniciar TronSoftOS e TronFire para carregar os segredos importados.

Resultado esperado:

- O arquivo fica salvo em `/opt/tronsoftos/state/cluster-secrets.env`.
- O token interno e a senha Firebird do standby passam a acompanhar o primary.
- O `POSTGRES_PASSWORD` do arquivo fica preservado no pareamento, mas nao substitui o Postgres local ja inicializado pelo painel.

## Fase 2: VIP E Keepalived

No primary:

```bash
ip addr show
curl -fsS http://VIP:8080/health
systemctl status keepalived --no-pager
```

No standby:

```bash
ip addr show
systemctl status keepalived --no-pager
```

Resultado esperado:

- VIP aparece somente no primary.
- Acesso ao TronSoftOS pelo VIP funciona.
- Keepalived nao registra erro de autenticacao VRRP.

## Fase 3: Sync HA

No painel do primary:

1. Abrir Cluster HA.
2. Conferir Sync HA.
3. Executar `Sincronizar agora`.
4. Aguardar job finalizar sem erro.

No standby:

```bash
sudo bash scripts/ha-smoke-test.sh
ls -lah /opt/tronfire-storage/firebird/backups
ls -lah /tmp/tronfire-catalog 2>/dev/null || true
```

Resultado esperado:

- Backups e manifestos recentes chegam no standby.
- Catalogo do TronFire chega no standby quando configurado.
- Nenhum arquivo `.fdb` de producao e sobrescrito por sync direto.
- O restore automatico no standby deixa os bancos obrigatorios em `READY`.

## Fase 3.1: Sync Contínuo De Rotina

Depois do primeiro sync manual, aguarde pelo menos um intervalo automatico configurado e valide novamente no standby:

```bash
ls -lah /opt/tronfire-storage/firebird/backups
ls -lah /opt/tronfire-storage/firebird/standby
```

Resultado esperado:

- Um novo ciclo de backup/sync aparece sem intervenção manual.
- O standby continua com backup validado e restaurado.
- O painel mostra o proximo sync e a defasagem dentro do limite esperado.
- Se o backup mais atual do alias ja estiver `READY` no standby com o mesmo SHA, o ciclo deve pular o restore completo e apenas revalidar o standby.

Evidencia de laboratorio em 2026-06-10:

- Ativo: `192.168.1.163`.
- Standby/recovery: `192.168.1.162`.
- VIP: `192.168.1.150` no ativo.
- Ciclo automatico: `ha-sync-20260610101657.log`.
- Resultado: `HA_SYNC_AUTO_TRIGGERED` seguido de `HA_SYNC_FINISHED`.
- O backup `backup-teste` com SHA `6fb6117dfa066b0f6993a8d7b7490f82f15b29707274e56ee872ab5b91703a02` foi ignorado para restore completo porque ja estava `READY` antes do import do catalogo.
- Tempo do ciclo com skip: cerca de 3 segundos.
- No standby, nenhum `gbak` ficou em execucao apos o ciclo automatico.

Trecho esperado do log:

```text
[ha-sync] candidato restore backup-teste: backupSha256=6fb6117dfa066b0f6993a8d7b7490f82f15b29707274e56ee872ab5b91703a02
[ha-sync] restore standby backup-teste ignorado: backup 6fb6117dfa066b0f6993a8d7b7490f82f15b29707274e56ee872ab5b91703a02 ja estava READY antes do import do catalogo
[ha-sync] concluido
```

Observacao operacional:

- Em bases grandes, o restore completo pode levar muitos minutos. No laboratorio, o `backup-teste` levou cerca de 14 a 15 minutos por restore completo.
- O ciclo automatico continuo deve manter o standby pronto antes da queda, mas nao deve restaurar novamente o mesmo backup validado.

## Fase 4: Failover Planejado

Use esta fase para simular manutencao do primary.

No primary:

```bash
sudo systemctl stop tronsoftos
sudo systemctl stop keepalived
```

No standby, medir tempo ate assumir:

```bash
watch -n 1 "ip addr show | grep -n 'VIP' || true"
```

Quando o VIP aparecer no standby:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://VIP:8080/health
sudo bash scripts/ha-smoke-test.sh
```

No painel do standby:

1. Conferir `Protecao de duplo primary`.
2. Permitir promocao somente se o backup/standby foi validado.
3. Marcar este no como ativo.
4. Validar TronFire, Firebird e apps gerenciados.

Resultado esperado:

- VIP migra para o standby.
- TronSoftOS responde pelo VIP.
- Antigo primary nao atende producao.
- Standby so vira ativo apos confirmacao no cluster-lock.

## Fase 5: Failover Emergencial

Simule uma queda mais brusca apenas em laboratorio:

```bash
sudo systemctl stop keepalived
sudo systemctl stop tronsoftos
```

Resultado esperado no standby:

- VIP assumido automaticamente.
- Guard indica estado compativel com standby/promocao.
- Operador precisa liberar promocao conscientemente.
- Nenhum comando automatico promove banco sem validacao.

## Fase 6: Retorno Do Antigo Primary

Antes de religar o antigo primary na producao:

1. Garantir que ele nao esta com VIP.
2. Colocar o no em `recovery` pelo painel.
3. Bloquear promocao.
4. Ressincronizar dados a partir do no ativo atual.
5. Voltar o no recuperado como `standby`.

Comandos uteis:

```bash
sudo systemctl start tronsoftos
sudo systemctl start keepalived
sudo bash scripts/ha-smoke-test.sh
```

Resultado esperado:

- Antigo primary nao reassume sozinho.
- Cluster continua com apenas um ativo.
- No recuperado volta como standby apos ressincronizacao.

Evidencia de laboratorio em 2026-06-10:

- Failback controlado executado do ativo `192.168.1.163` para `192.168.1.162`.
- O `192.168.1.162` foi preparado como `standby` com `allow_promotion=true`.
- O `192.168.1.163` teve `tronsoftos` e `keepalived` parados antes da promocao.
- `POST /api/cluster/activate-local` no `192.168.1.162` promoveu o no para `primary`.
- VIP `192.168.1.150` apareceu no `192.168.1.162`.
- TronFire no `192.168.1.162` foi recriado com `TRONFIRE_NODE_ROLE=primary`.
- Banco `backup-teste` ficou `PROMOTED` no TronFire.
- Antigo ativo `192.168.1.163` ficou em `recovery`, com `keepalived` inativo e sem VIP.
- API via VIP respondeu com `nodeRole=primary`, `activeNode=primary-116` e `canServeProduction=true`.

## Criterios De Aprovacao

O ambiente esta aprovado quando:

- VIP migra em tempo aceitavel para a operacao do cliente.
- Nao ocorre split-brain.
- TronSoftOS responde via VIP antes e depois do failover.
- TronFire abre no endpoint correto depois da troca.
- Firebird no no promovido foi validado antes de receber escrita.
- Cloudflare continua apontando para o destino correto.
- Backups continuam sendo enviados somente pelo no ativo.
- Antigo primary retorna como `recovery` ou `standby`, nunca como ativo automatico.

## Evidencias Para Guardar

- Saida de `scripts/ha-smoke-test.sh` nos dois nos.
- Print da tela Cluster HA antes/depois.
- Horario em que o VIP saiu do primary.
- Horario em que o VIP apareceu no standby.
- Ultimo backup Firebird validado.
- Log de eventos do TronSoftOS.
- Status do Cloudflare/DNS.

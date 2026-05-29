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
ls -lah /opt/tronos/state/tronfire-catalog 2>/dev/null || true
```

Resultado esperado:

- Backups e manifestos recentes chegam no standby.
- Catalogo do TronFire chega no standby quando configurado.
- Nenhum arquivo `.fdb` de producao e sobrescrito por sync direto.

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

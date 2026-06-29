# Runbook De HA E Failover

## Verificações Rápidas

No nó ativo:

```bash
systemctl status tronsoftos
curl -fsS http://127.0.0.1:8080/health
ip addr show
systemctl status keepalived
```

Nos containeres auxiliares:

```bash
./scripts/manage-containers.sh status
./scripts/manage-containers.sh logs tronfire
./scripts/manage-containers.sh logs troncomanda
```

## Failover Planejado

Use quando for aplicar manutenção no nó MASTER.

1. Confirmar que o nó BACKUP está saudável.
2. Executar sincronização Firebird final.
3. Parar o TronSoftOS no MASTER.
4. Reduzir prioridade ou parar `keepalived` no MASTER.
5. Confirmar que o VIP migrou para o BACKUP.
6. Subir ou validar TronSoftOS no BACKUP.
7. Validar acesso externo pelo Cloudflare.

Comandos típicos:

```bash
sudo systemctl stop tronsoftos
sudo systemctl stop keepalived
ip addr show
curl -fsS http://127.0.0.1:8080/health
```

## Failover Emergencial

Use quando o MASTER falhou inesperadamente.

1. Confirmar se o VIP foi assumido pelo BACKUP.
2. Validar saúde do TronSoftOS no BACKUP.
3. Validar se o banco local está íntegro.
4. Atualizar Cloudflare, se o modelo depender de DNS por nó.
5. Bloquear escrita no nó antigo antes de recolocá-lo na rede.

Ponto crítico: nunca permita dois nós escrevendo no mesmo banco Firebird ao mesmo tempo.

## Retorno Do Nó Antigo

1. Subir o nó antigo sem assumir VIP.
2. Confirmar que o Firebird antigo não aceitará escrita.
3. Sincronizar dados do nó ativo para o nó recuperado.
4. Colocar o nó recuperado como BACKUP.
5. Testar health check e logs por alguns ciclos.

## Teste De HA

Para execucao completa com registro de evidencias, use tambem:

```text
docs/plano-testes-ha-failover.md
scripts/ha-smoke-test.sh
```

Depois de failover, failback ou retorno de manutencao, rode o smoke test nos dois nos. O resultado esperado e:

- no primary: `TRONSOFTOS_NODE_ROLE=primary`, Keepalived `MASTER`, VIP presente e `Health pelo VIP` retornando `primary`.
- no standby/recovery: `TRONSOFTOS_NODE_ROLE=standby` ou `recovery`, Keepalived `BACKUP`, VIP ausente e `Health pelo VIP` retornando o primary ativo.

Checklist mínimo:

- VIP responde no MASTER.
- Health check falho remove o MASTER da eleição.
- BACKUP assume VIP em menos do que o tempo alvo.
- Cloudflare continua apontando para o destino correto.
- `tronfire` e `troncomanda` reiniciam corretamente.
- Firebird no nó promovido abre sem erro.

## Riscos Conhecidos

- `rsync` direto de `.fdb` em uso pode corromper ou gerar réplica inconsistente.
- DNS tem TTL e não substitui failover instantâneo.
- Cloudflare proxy/tunnel precisa ser desenhado junto com VIP para evitar rota apontando para nó inativo.
- Split-brain em VRRP pode causar dois nós ativos. Use rede estável, autenticação VRRP e monitoramento.

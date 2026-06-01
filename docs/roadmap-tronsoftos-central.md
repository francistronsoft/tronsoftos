# Roadmap TronSoftOS Central

## Monitoramento HA por cliente

Objetivo: permitir que a equipe tecnica veja, em uma tela centralizada, qual servidor de cada cliente esta ativo no cluster HA e quando ocorreu failover.

Itens previstos:

- Exibir clientes/instalacoes com status consolidado do cluster.
- Identificar qual no esta como primary/ativo no momento.
- Identificar qual no esta como standby.
- Indicar qual servidor esta segurando o VIP.
- Registrar ultimo evento de failover com data, hora, motivo e servidor que assumiu.
- Alertar quando o standby assumir producao.
- Alertar quando houver risco de dois nos ativos ou no em recovery.
- Exibir saude dos servicos principais: TronSoftOS, TronFire, Firebird/PostgreSQL e keepalived.
- Receber heartbeat periodico de cada TronSoftOS instalado no cliente.
- Mostrar estado em linguagem de suporte, por exemplo: "Servidor B assumiu o cliente X as 18:42".

Observacao: Zabbix/Grafana podem continuar uteis para metricas de infraestrutura, mas o TronSoftOS Central deve interpretar o estado de negocio do HA: primary, standby, recovery, VIP, sync, promocao e manutencao.

# Sweep programado — 0.1.141

Novo padrão: terça, quinta e sábado às 06h, no fuso já configurado para o
ambiente (normalmente America/Sao_Paulo). Expressão: `0 6 * * 2,4,6`.

O instalador/wizard, o compose e o fallback do worker usam o mesmo padrão.
Na atualização pelo painel, `install.sh` executa uma migração do `.env`
antes de subir os containers. Somente a expressão antiga `0 6 * * 2,6`
é substituída. Agendamentos diferentes, sweeps desativados e o fuso existente
são preservados. A configuração anterior é copiada com modo 0600 para
`/opt/tronfire-storage/config-backups/sweep-schedule` antes da troca atômica.

Se o período antigo foi escolhido intencionalmente pelo cliente, definir
`TRONFIRE_FIREBIRD_SWEEP_PRESERVE_SCHEDULE=true` no `.env` do TronFire antes
de atualizar. Sem essa indicação, a expressão idêntica ao padrão antigo é
considerada elegível para a migração. A migração é idempotente.

O novo cron entra em vigor quando o worker for recriado pela atualização.
Não há execução imediata de sweep pela migração. Não são adicionados cron
de host, reinício de Firebird, encerramento automático de sessões, alteração
de frequência/retenção de backup ou mudança de regras HA e locks existentes.

Um sweep pode terminar com sucesso e não conseguir avançar OIT/OAT enquanto
transações antigas permanecerem abertas. O período extra cria outra oportunidade
de limpeza; não remove a necessidade de identificar e corrigir essas aplicações.

Validação em 06/11/2026 na VM Debian 11.11 (192.168.1.105): 87 testes
aprovados, incluindo migração, backup exato, permissões, idempotência,
preservação de horários personalizados/desativados, CRLF e rejeição de
links/duplicidades. O próprio node-cron do worker confirmou os três dias
às 06h no fuso configurado. A migração real da VM recriou somente o worker,
preservou sua imagem e os demais parâmetros e manteve o PID do Firebird.

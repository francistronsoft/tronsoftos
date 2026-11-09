# Sweep diário — 0.1.142

O novo padrão é executar sweep todos os dias, inclusive segunda-feira, às
06h e às 15h, no fuso configurado do ambiente (normalmente America/Sao_Paulo).
Cron: `0 6,15 * * *`. Wizard, compose e fallback do worker usam esse padrão.

A atualização migra apenas os padrões anteriores `0 6 * * 2,6` e
`0 6 * * 2,4,6`. Agendamentos personalizados, sweeps desativados e o fuso
existente são preservados. `TRONFIRE_FIREBIRD_SWEEP_PRESERVE_SCHEDULE=true`
preserva inclusive um padrão antigo escolhido intencionalmente.
O `.env` anterior é salvo com permissão 0600 antes da substituição atômica;
proprietário e permissões da configuração são preservados.

A validação semanal continua na janela configurada (por padrão segunda-feira,
03h–06h). Se ultrapassar o horário, as proteções existentes adiam o sweep:
backup/validação, reserva do banco, rotina Firebird ou sincronização HA ativa.
As tentativas continuam limitadas: por padrão a cada dez minutos, até seis
tentativas. Se a operação continuar ocupada, o próximo horário regular cria
outra oportunidade; não há promessa de execução exatamente às 06h/15h.

Não há reinício automático do Firebird, encerramento de conexões ou mudança
de frequência/retenção de backup. A migração não executa um sweep imediato.
Transações antigas podem impedir a redução do gap mesmo com sweep bem-sucedido.

# Manual de Instalacao e Operacao HA - TronSoftOS

Este manual orienta o tecnico na instalacao inicial do TronSoftOS em modo simples ou em alta disponibilidade, e tambem na operacao diaria de failover/failback.

## Conceitos

### Primary

O `primary` é o nó ativo de producao.

- Segura o VIP quando o cluster esta normal.
- Atende TronSoftOS, TronFire e demais servicos de producao.
- Gera backups validados do Firebird.
- Envia backups, manifestos e catalogo do TronFire para o standby.
- Executa o Sync HA automatico.

Em operacao normal, somente um servidor pode estar como `primary`.

### Standby

O `standby` é o nó reserva.

- Nao deve segurar o VIP enquanto o primary esta saudavel.
- Recebe backups e catalogo do primary.
- Restaura os backups em bancos standby, normalmente em `/firebird/standby`.
- Mantem os bancos em modo pronto para promocao.
- Pode assumir o VIP e virar primary quando o primary cair ou for desligado de forma controlada.

O standby so deve ser promovido quando o TronSoftOS indicar que os bancos obrigatorios estao `READY` e a defasagem esta dentro da janela aceitavel.

### Recovery

O `recovery` e um estado de seguranca.

Ele e usado quando um no voltou de manutencao, voltou apos queda de energia, ou era o antigo primary e nao pode reassumir producao sozinho. Nesse estado:

- O nó nao deve segurar o VIP.
- O nó nao deve servir producao.
- O nó deve ser ressincronizado antes de voltar ao cluster.
- O tecnico deve validar sync, restore e estado dos bancos antes de transformar esse no em standby.

Se o painel mostra `standby-118` com papel `recovery`, isso significa que esse servidor esta intencionalmente protegido contra duplo primary. Ele provavelmente foi colocado em recuperacao durante failback/manutencao para nao assumir o VIP enquanto o outro no esta ativo.

## Informacoes Necessarias Antes da Instalacao

Levante estes dados antes de iniciar:

- Nome do cliente ou identificador do cluster.
- Nome do no primary, por exemplo `primary-01`.
- Nome do no standby, por exemplo `standby-01`.
- IP fixo real do primary.
- IP fixo real do standby.
- Mascara/CIDR, gateway e DNS da rede.
- Interface de rede dos servidores, por exemplo `ens18` ou `eth0`.
- VIP livre na mesma rede dos dois servidores.
- Senha VRRP do VIP.
- Usuario SSH para HA, padrao `tronsoft`.
- Senha inicial ou chave SSH do usuario `tronsoft`.
- Senha root para manutencao.
- Senha Firebird SYSDBA, padrao `masterkey`.
- Se havera modo HA ou instalacao simples.
- Se o Firebird sera host. O padrao atual e Firebird no host Debian.
- Dados do rclone, se backup externo ja for configurado.
- Alias do primeiro banco de producao: obrigatoriamente `erp_tronsoft`.

## Instalacao no Debian

Use Debian limpo e atualizado. Rode como root.

1. Copie o projeto para o servidor.

```bash
cd /opt
git clone <repositorio-do-tronsoftos> tronsoftos
cd /opt/tronsoftos
```

2. Execute o instalador.

```bash
sudo bash install.sh
```

3. Responda o assistente.

Para instalacao simples:

- Escolha que o cliente nao tera alta disponibilidade.
- Informe o IP real do servidor.
- Fixe o IP se o ambiente permitir.
- Confirme Firebird host.
- Configure rclone depois pelo painel, se necessario.

Para instalacao HA:

- Escolha alta disponibilidade com 2 servidores.
- No primeiro servidor, selecione papel `primary`.
- No segundo servidor, selecione papel `standby`.
- Fixe o IP real de cada host.
- No primary, informe VIP/CIDR e Router ID VRRP.
- No standby, informe apenas a interface local do VIP/Keepalived; VIP, Router ID e senha VRRP entram pelo arquivo de pareamento.
- Primary normalmente usa prioridade `150`.
- Standby normalmente usa prioridade `100`.

4. Acesse o TronSoftOS.

```text
http://IP_REAL:8080
```

Durante a instalacao e pareamento HA, acesse sempre pelo IP real do host que esta sendo configurado, seja primary ou standby. Use o VIP somente depois que os dois nos estiverem instalados, pareados e com Keepalived validado.

Em HA, depois de configurar e validar o VIP:

```text
http://VIP:8080
```

## Configuracao Inicial HA

Antes de iniciar os testes de backup e sincronismo, cadastre o banco principal do cliente no TronFire. Em uma instalacao de producao limpa, o primeiro banco marcado como `Producao` deve usar obrigatoriamente o alias `erp_tronsoft`. Bancos de homologacao ou legado podem ser criados antes com outros aliases, mas o primeiro banco produtivo permanece reservado para `erp_tronsoft`.

### 1. Validar IP fixo

No painel `Cluster HA`, confirme:

- IP real do host.
- Interface correta.
- Gateway e DNS.
- VIP na mesma rede dos dois servidores.

Os IPs reais dos hosts devem ser fixos. DHCP pode causar troca de IP apos queda de energia e quebrar Sync HA, pareamento e health check.

### 2. Configurar VIP

No primary:

- Abra `Cluster HA`.
- Va em `VIP`.
- Informe VIP/CIDR, interface, Router ID e senha VRRP.
- Papel Keepalived: `MASTER`.
- Prioridade: `150`.
- Aplique o VIP.

No instalador, o primary coleta VIP/CIDR e Router ID. A senha VRRP padrao e `vip123` e entra no arquivo de pareamento.

No standby:

- Informe apenas a interface local do VIP/Keepalived no instalador.
- Importe o arquivo de pareamento exportado do primary.
- O VIP/CIDR, Router ID e senha VRRP sao importados do primary.
- O Keepalived e aplicado como `BACKUP` com prioridade `100`.

O VIP deve aparecer apenas no primary enquanto ele estiver saudavel.

A interface do VIP pode ser diferente da interface usada pelo Sync HA, desde que a interface do VIP exista nos dois servidores, esteja na mesma rede/VLAN de broadcast para VRRP e seja a rede acessada pelos clientes/ERP. O Sync HA pode usar outro IP real/interface, configurado no campo do host standby.

### 3. Pareamento

No primary:

- Abra `Cluster HA`.
- Va em `Pareamento`.
- Exporte o arquivo de pareamento.

No standby:

- Abra `Cluster HA`.
- Va em `Pareamento`.
- Importe o arquivo exportado do primary.
- Reinicie TronSoftOS e TronFire se o painel solicitar.

O pareamento leva token interno, senha Firebird, dados do VIP e chave publica para autorizacao SSH.

### 4. Sync HA

No primary:

- Abra `Cluster HA`.
- Va em `Sync`.
- Informe o IP real do standby.
- Usuario SSH: `tronsoft`.
- Porta SSH: `22`.
- Backups locais: `/opt/tronfire-storage/firebird/backups`.
- Destino backups standby: `/opt/tronfire-storage/firebird/backups`.
- Catalogo local: `/opt/tronsoftos/state/tronfire-catalog`.
- Destino catalogo standby: `/tmp/tronfire-catalog`.
- Defina o intervalo automatico.
- Salve e rode `Sincronizar agora`.

No standby:

- Confirme se recebeu catalogo.
- Confirme se os bancos obrigatorios estao `READY`.
- Confirme se nao ha restore em andamento.

### 5. Failover Automatico

No standby:

- Abra `Cluster HA`.
- Va em `Promocao`.
- Configure o health real do primary, por exemplo:

```text
http://IP_REAL_DO_PRIMARY:8080/health
```

- Defina tempo para assumir.
- Habilite promocao automatica apenas depois de validar que o standby esta `READY`.

## Operacao Sem HA

Em modo simples:

- Existe apenas um servidor.
- Nao configure VIP.
- Nao configure pareamento.
- Nao configure Sync HA.
- Backups locais e rclone podem ser usados normalmente.
- Firebird host continua sendo o padrao.

## Operacao Com HA

Em modo HA normal:

- Primary segura VIP.
- Standby nao segura VIP.
- Primary envia backups e catalogo.
- Standby restaura e valida.
- Rclone deve ficar permitido apenas no papel `primary`.

## Migracao e Restore de Banco no TronFire

O tecnico nao precisa habilitar manualmente um modo de manutencao antes de migrar ou restaurar um banco pelo TronFire. Ao iniciar restore manual, migracao por upload ou manutencao automatica, o TronFire coloca o banco em operacao protegida automaticamente.

Enquanto a operacao protegida estiver ativa:

- Backup manual e backup automatico desse banco ficam bloqueados.
- Sync/restore HA desse banco fica bloqueado ou ignorado ate a operacao terminar.
- O standby desse banco deixa de ser considerado pronto para promocao.
- A promocao HA automatica/manual nao deve seguir se algum banco obrigatorio estiver em operacao.

Quando a migracao ou restore termina com sucesso, o banco volta para uso e o standby fica `PENDING`. Em seguida, gere ou aguarde um novo backup validado, execute o Sync HA e confirme que o standby voltou para `READY`. So depois disso o banco deve ser considerado pronto para failover.

## Queda de Energia no Local

Quando a energia voltar:

1. Ligue primeiro o servidor que deve ser o primary oficial.
2. Aguarde o Debian subir completamente.
3. Confirme que o TronSoftOS esta online.
4. Confirme que o VIP esta no primary.
5. Depois ligue o standby.
6. Confirme que o standby nao segurou o VIP.
7. Confirme que o Sync HA voltou a rodar.
8. Confirme que os bancos standby voltaram para `READY`.

Evite ligar os dois servidores ao mesmo tempo quando houve queda geral de energia. Isso reduz risco de promocao acidental, disputa de VIP ou interpretacao errada de primary indisponivel.

Se o standby ligar primeiro e assumir o VIP, trate o antigo primary como no retornando de manutencao: coloque em `recovery`, sincronize e faca failback controlado.

## Failover Controlado

Use quando o primary precisa sair para manutencao.

1. No primary, confira se o standby esta `READY`.
2. No primary, rode uma sincronizacao manual.
3. Aguarde o fim do sync.
4. Confirme no standby que os bancos obrigatorios estao `READY`.
5. No primary, suspenda/desligue de forma controlada.
6. Aguarde o standby assumir o VIP.
7. No standby, confirme acesso via VIP.
8. No standby, confirme que o papel mudou para `primary`.

## Primary Voltando da Manutencao

Quando o antigo primary voltar, ele nao deve reassumir automaticamente.

Procedimento recomendado:

1. Ligue o antigo primary sem pressa, depois de confirmar que o novo primary esta atendendo pelo VIP.
2. Acesse o antigo primary pelo IP real, nao pelo VIP.
3. No TronSoftOS, coloque o antigo primary em `recovery`.
4. Confirme que ele nao esta com VIP.
5. Ajuste o Sync HA no novo primary apontando para o IP real desse antigo primary.
6. Rode sync manual.
7. Aguarde os bancos ficarem `READY` no antigo primary.
8. Quando validado, altere o antigo primary para papel `standby`.
9. Mantenha prioridade Keepalived menor, normalmente `100`.

Nesse modelo, o servidor que assumiu producao continua como primary. O antigo primary vira standby. Isso evita regredir dados e evita dois primary.

## Failback Planejado Para Voltar ao Servidor Original

So faca se houver necessidade operacional de devolver producao ao servidor original.

Quando disponivel, use `Manutencao > Failback` no TronSoftOS. O assistente mostra quem esta respondendo pelo VIP, registra a topologia desejada e exige uma estrategia de banco antes de preparar a troca. Estrategias que dependem de banco manual deixam a producao em modo protegido ate a validacao final do banco e dos servicos.

1. Confirme que o servidor original esta como standby e `READY`.
2. Rode sync manual do primary atual para o standby.
3. Suspenda failover automatico durante a janela, se necessario.
4. Promova o standby original de forma controlada.
5. Confirme VIP no servidor original.
6. Coloque o antigo ativo em `recovery`.
7. Ressincronize o antigo ativo.
8. Volte o antigo ativo como standby.

## Alertas e Estados Comuns

### Standby atrasado

Significa que o ultimo backup validado/restauravel esta fora da janela configurada.

Acao:

- Verificar se ha backup com manifesto valido.
- Rodar sync manual.
- Verificar logs do Sync HA.
- Verificar se o restore no standby falhou.

### Recovery

Significa que o no esta protegido e nao deve assumir producao.

Acao:

- Confirmar qual servidor esta ativo pelo VIP.
- Sincronizar a partir do primary ativo.
- Validar bancos.
- Somente depois voltar para standby.

### Utilitario Firebird ausente

Se TronFire indicar `isql`, `gstat`, `gfix` ou `gbak` ausente:

- Confirmar que Firebird host esta instalado em `/usr/local/firebird`.
- Confirmar que o compose host monta `/usr/local/firebird` no backend e worker.
- Recriar/reiniciar TronFire com o arquivo `docker-compose.host-firebird.yml`.
- Confirmar `FIREBIRD_EXEC_MODE=host`.

### Container tronfire_firebird25 ausente

Quando Firebird e host, esse container nao deve existir. O painel nao deve tratar sua ausencia como erro.

## Checklist Final

Antes de liberar:

- IPs reais fixos no primary e standby.
- VIP na mesma rede.
- VIP aparece somente no primary.
- Pareamento importado no standby.
- SSH primary -> standby funcionando com usuario `tronsoft`.
- Firebird host ativo.
- TronFire sem utilitarios Firebird ausentes.
- Sync manual executado com sucesso.
- Sync automatico executado pelo menos uma vez.
- Standby com bancos obrigatorios `READY`.
- Failover testado em janela controlada.
- Procedimento de retorno documentado para o cliente.

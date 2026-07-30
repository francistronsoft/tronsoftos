# TronSoft Agent Windows

Servico Windows para clientes que ainda nao possuem TronSoftOS. O agente monitora o servidor Windows e envia dados diretamente para a Central TronSoftOS.

## Pasta local

Padrao:

```text
C:\TronSoft\AgentWindows
```

Estrutura:

```text
C:\TronSoft\AgentWindows\config\agent.json
C:\TronSoft\AgentWindows\config\token.sec
C:\TronSoft\AgentWindows\data\agent.db
C:\TronSoft\AgentWindows\logs
C:\TronSoft\AgentWindows\cache\last-heartbeat.json
```

O `agent.db` e SQLite local. Ele guarda configuracoes internas, fila de heartbeat quando a internet cai e eventos tecnicos do agente. O token de instalacao fica fora do SQLite em `token.sec`, protegido com DPAPI do Windows para a maquina local.

## Dados enviados

- heartbeat online/offline;
- hostname, IP, SO, arquitetura e uptime;
- CPU, memoria e discos;
- tamanho do banco Firebird `.FDB`;
- valor de `versao_banco`;
- saude dos indices Firebird usando a mesma lista de tabelas criticas do TronFire;
- diretorio e arquivos recentes de backup local;
- alertas de backup atrasado e banco sem indice critico.

## Publicar

No diretorio `agent-windows`:

```powershell
dotnet restore
.\scripts\build-installer-package.ps1
```

Isso gera a pasta `installer-win-x64` com:

```text
install.ps1
uninstall.ps1
TronSoft.Agent.Windows.exe
e_sqlite3.dll
appsettings.json
```

O instalador cria `C:\TronSoft\AgentWindows`, copia todos os arquivos do pacote para essa pasta e registra o servico Windows como inicializacao automatica.

## Gerar instalador Inno Setup

Depois de gerar `installer-win-x64`, abra no Inno Setup:

```text
TronSoftAgentWindows.iss
```

Ou compile pelo terminal, ajustando o caminho do Inno conforme instalado:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" .\TronSoftAgentWindows.iss
```

O instalador final sera gerado em:

```text
installer-output\TronSoftAgentWindowsSetup.exe
```

Durante a instalacao, o assistente pede URL da Central, token de pareamento, nome do ambiente, caminho do Firebird e pasta de backup.

## Instalar como servico

Execute o PowerShell como Administrador:

```powershell
.\install.ps1 `
  -CentralUrl "https://central.tronsoft.app.br" `
  -PairingToken "TOKEN_GERADO_NA_CENTRAL" `
  -EnvironmentName "Servidor Windows" `
  -FirebirdDatabasePath "C:\ERP_TRONSOFT\ERP_TRONSOFT.FDB" `
  -BackupDirectory "C:\ERP_TRONSOFT\BACKUP"
```

## Remover

```powershell
.\uninstall.ps1
```

Para remover o servico preservando configuracao e banco local:

```powershell
.\uninstall.ps1 -KeepData
```

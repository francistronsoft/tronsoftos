param(
  [string]$CentralUrl = "https://central.tronsoft.app.br",
  [Parameter(Mandatory = $true)]
  [string]$PairingToken,
  [string]$EnvironmentName = "Servidor Windows",
  [string]$ServerAlias = "SERVIDOR",
  [string]$FirebirdDatabasePath = "C:\ERP_TRONSOFT\ERP_TRONSOFT.FDB",
  [string]$FirebirdAlias = "erp_tronsoft",
  [string]$FirebirdHost = "localhost",
  [string]$FirebirdUser = "SYSDBA",
  [string]$FirebirdPassword = "masterkey",
  [string]$FirebirdIsqlPath = "",
  [string]$BackupDirectory = "C:\TronSoft\Backup",
  [int]$FirebirdQueryTimeoutSeconds = 20,
  [int]$HeartbeatIntervalSeconds = 60,
  [string]$InstallDir = "C:\TronSoft\AgentWindows",
  [string]$ServiceName = "TronSoftAgentWindows"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
  throw "Execute o instalador em PowerShell como Administrador."
}

$scriptDir = $PSScriptRoot
$sourceDir = Split-Path -Parent $scriptDir
$localExe = Join-Path $scriptDir "TronSoft.Agent.Windows.exe"
$publishDir = $scriptDir
if (-not (Test-Path $localExe)) {
  $publishDir = Join-Path $sourceDir "publish-win-x64"
}
if (-not (Test-Path (Join-Path $publishDir "TronSoft.Agent.Windows.exe"))) {
  $publishDir = Join-Path $sourceDir "publish"
}
$exeSource = Join-Path $publishDir "TronSoft.Agent.Windows.exe"
$exeTarget = Join-Path $InstallDir "TronSoft.Agent.Windows.exe"
$configDir = Join-Path $InstallDir "config"
$dataDir = Join-Path $InstallDir "data"
$logsDir = Join-Path $InstallDir "logs"
$cacheDir = Join-Path $InstallDir "cache"
$configPath = Join-Path $configDir "agent.json"

if (-not (Test-Path $exeSource)) {
  throw "Arquivo publicado nao encontrado em $exeSource. Gere com: dotnet publish -c Release -o publish-win-x64"
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $InstallDir, $configDir, $dataDir, $logsDir, $cacheDir | Out-Null
Get-ChildItem -Path $publishDir -File | ForEach-Object {
  Copy-Item -Force -LiteralPath $_.FullName -Destination $InstallDir
}

$config = [ordered]@{
  Agent = [ordered]@{
    CentralUrl = $CentralUrl
    PairingToken = $PairingToken
    InstallationId = ""
    EnvironmentName = $EnvironmentName
    ServerAlias = $ServerAlias
    HeartbeatIntervalSeconds = $HeartbeatIntervalSeconds
    Firebird = [ordered]@{
      Enabled = $true
      Alias = $FirebirdAlias
      DatabasePath = $FirebirdDatabasePath
      Host = $FirebirdHost
      User = $FirebirdUser
      Password = $FirebirdPassword
      IsqlPath = $FirebirdIsqlPath
      QueryTimeoutSeconds = $FirebirdQueryTimeoutSeconds
    }
    Backups = [ordered]@{
      Directory = $BackupDirectory
      MaxAgeHours = 24
    }
  }
}

$config | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding UTF8

if ($existing) {
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

New-Service -Name $ServiceName -DisplayName "TronSoft Agent Windows" -BinaryPathName "`"$exeTarget`"" -StartupType Automatic
sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
sc.exe description $ServiceName "Monitora servidor Windows e envia dados para a Central TronSoftOS." | Out-Null
Start-Service -Name $ServiceName

Write-Host "TronSoft Agent Windows instalado em $InstallDir"
Write-Host "Servico iniciado e configurado para iniciar com o Windows: $ServiceName"

param(
  [string]$Configuration = "Release",
  [string]$Runtime = "win-x64",
  [string]$PackageDir = "installer-win-x64"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$publishDir = Join-Path $root "publish-win-x64"
$packagePath = Join-Path $root $PackageDir

Push-Location $root
try {
  dotnet publish -c $Configuration -r $Runtime -o $publishDir
}
finally {
  Pop-Location
}

if (Test-Path $packagePath) {
  Remove-Item -LiteralPath $packagePath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $packagePath | Out-Null
Get-ChildItem -Path $publishDir -File | Where-Object { $_.Extension -ne ".pdb" } | ForEach-Object {
  Copy-Item -Force -LiteralPath $_.FullName -Destination $packagePath
}
Copy-Item -Force -LiteralPath (Join-Path $PSScriptRoot "install-service.ps1") -Destination (Join-Path $packagePath "install.ps1")
Copy-Item -Force -LiteralPath (Join-Path $PSScriptRoot "uninstall-service.ps1") -Destination (Join-Path $packagePath "uninstall.ps1")

Write-Host "Pacote gerado em $packagePath"
Write-Host "Execute install.ps1 como Administrador no Windows do cliente."

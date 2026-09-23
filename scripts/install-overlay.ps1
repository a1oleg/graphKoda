param(
  [Parameter(Mandatory = $true)]
  [string]$TargetPath,
  [switch]$SkipNodeInstall,
  [switch]$SkipPythonInstall
)

$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath($TargetPath)

if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
  throw "Каталог исходника не найден: $targetRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'tsconfig.json'))) {
  throw "В $targetRoot нет tsconfig.json; ожидается корень исходника Claude Code."
}

foreach ($name in @('graph', 'dev')) {
  $source = Join-Path $toolRoot $name
  $destination = Join-Path $targetRoot $name
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $toolRoot 'docker-compose.redis.yml') -Destination $targetRoot -Force

$envPath = Join-Path $targetRoot 'graph/.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath (Join-Path $toolRoot 'graph/.env.example') -Destination $envPath
}

if (-not $SkipNodeInstall) {
  $package = Get-Content -LiteralPath (Join-Path $toolRoot 'package.json') -Raw | ConvertFrom-Json
  $dependencies = $package.dependencies.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }
  & npm install --no-save --package-lock=false --prefix $targetRoot @dependencies
  if ($LASTEXITCODE -ne 0) { throw "npm install завершился с кодом $LASTEXITCODE" }
}

if (-not $SkipPythonInstall) {
  $venvPath = Join-Path $targetRoot '.venv'
  if (-not (Test-Path -LiteralPath $venvPath)) {
    & python -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw "Не удалось создать Python venv." }
  }
  $python = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    Join-Path $venvPath 'Scripts/python.exe'
  } else {
    Join-Path $venvPath 'bin/python'
  }
  & $python -m pip install -r (Join-Path $targetRoot 'graph/static-extract/requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw "pip install завершился с кодом $LASTEXITCODE" }
}

Write-Host "graphKoda установлен поверх исходника: $targetRoot"
Write-Host "Заполните $envPath и запускайте команды из корня исходника."


param(
  [Parameter(Mandatory = $true)]
  [string]$TargetPath
)

$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath($TargetPath)
$drawioRoot = Join-Path $targetRoot 'graph/vendor/drawio'
$pluginSource = Join-Path $toolRoot 'graph/vendor/drawio/src/main/webapp/plugins/codexGraph.js'
$pluginTarget = Join-Path $drawioRoot 'src/main/webapp/plugins/codexGraph.js'

if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
  throw "Каталог рабочей копии не найден: $targetRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $drawioRoot 'src/main/webapp/index.html'))) {
  $upstreamRoot = Join-Path $targetRoot '.cache/coldkode/drawio-upstream'
  if (-not (Test-Path -LiteralPath (Join-Path $upstreamRoot 'src/main/webapp/index.html'))) {
    New-Item -ItemType Directory -Path (Split-Path $upstreamRoot) -Force | Out-Null
    & git clone --depth 1 https://github.com/jgraph/drawio.git $upstreamRoot
  }
  if ($LASTEXITCODE -ne 0) { throw "Не удалось загрузить официальный draw.io." }
  New-Item -ItemType Directory -Path $drawioRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $upstreamRoot -Force |
    Where-Object Name -ne '.git' |
    Copy-Item -Destination $drawioRoot -Recurse -Force
}

New-Item -ItemType Directory -Path (Split-Path $pluginTarget) -Force | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
Write-Host "draw.io установлен, coldKode plugin наложен: $pluginTarget"

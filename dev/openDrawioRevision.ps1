param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [string]$PreviewDirectory
)

$ErrorActionPreference = 'Stop'

$sourcePath = (Resolve-Path -LiteralPath $Source).Path

if (-not $PreviewDirectory) {
    $PreviewDirectory = Split-Path -Parent $sourcePath
}

$previewRoot = [System.IO.Path]::GetFullPath($PreviewDirectory)
[System.IO.Directory]::CreateDirectory($previewRoot) | Out-Null

$baseName = [System.IO.Path]::GetFileNameWithoutExtension($sourcePath)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$previewPath = Join-Path $previewRoot "$baseName.preview-$stamp.drawio"

Copy-Item -LiteralPath $sourcePath -Destination $previewPath
Set-Content -LiteralPath (Join-Path $previewRoot 'latest-drawio-preview.txt') -Value $previewPath -Encoding utf8

& code --reuse-window $previewPath

Write-Output $previewPath

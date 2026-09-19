$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
$profileDir = Join-Path $repo 'tmp\presenter-vscode'
$extensionsDir = Join-Path $repo 'tmp\presenter-extensions'
New-Item -ItemType Directory -Force -Path $profileDir, $extensionsDir | Out-Null
# A separate user-data directory prevents chat extensions and window routing from leaking in.
$arguments = @('--new-window', '--user-data-dir', $profileDir, '--extensions-dir', $extensionsDir, ('--extensionDevelopmentPath=' + (Join-Path $repo 'graph\vscode-extension')), ('--extensionDevelopmentPath=' + (Join-Path $repo 'graph\vscode-source-colors')), (Join-Path $repo 'graph\presentation\presenter.code-workspace'))
& $code @arguments

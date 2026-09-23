param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath 'C:\GitHub\claude-code').Path
$target = (Resolve-Path -LiteralPath 'C:\GitHub\graphKoda').Path
if ($source -eq $target) { throw 'Source and target must differ.' }
$tracked = @{}
git -C $source ls-files | ForEach-Object { $tracked[$_] = $true }
$dirty = @(git -C $source status --porcelain --untracked-files=all)
if ($dirty.Count) { throw 'Source must be clean before migrating historical tool copies.' }
$roots = @('graph', 'dev', '.cache', 'tmp', 'docker-compose.redis.yml',
    'helpersContext.md', 'inputContext.md', 'setCursorOffsetContext.md', 'onSubmit.txt', 'debug.log')
$plan = [System.Collections.Generic.List[object]]::new()
foreach ($root in $roots) {
    $from = Join-Path $source $root
    if (-not (Test-Path -LiteralPath $from)) { continue }
    $item = Get-Item -LiteralPath $from -Force
    $entries = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $from -Recurse -Force) } else { @($item) }
    if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        throw "Reparse point in $root; inspect before moving."
    }
    foreach ($file in @($entries | Where-Object { -not $_.PSIsContainer })) {
        $rel = $file.FullName.Substring($source.Length + 1)
        $to = [IO.Path]::GetFullPath((Join-Path $target $rel))
        if (-not $file.FullName.StartsWith($source + '\') -or -not $to.StartsWith($target + '\')) {
            throw 'Path escaped migration roots.'
        }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $action = 'move'
        if (Test-Path -LiteralPath $to) {
            if ($hash -eq (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) { $action = 'duplicate' }
            elseif ($tracked.ContainsKey($rel.Replace('\', '/'))) { $action = 'canonical-target' }
            elseif ($rel -match '__pycache__\\.*\.pyc$') { $action = 'generated-cache' }
            elseif ($rel -eq 'graph\.env') {
                # Confirm that every old credential is already present without printing secrets.
                $check = @'
const fs=require('fs'),dotenv=require('./node_modules/dotenv');
const old=dotenv.parse(fs.readFileSync('../claude-code/graph/.env'));
const current=dotenv.parse(fs.readFileSync('graph/.env'));
if(Object.entries(old).some(([k,v])=>current[k]!==v))process.exit(1);
'@
                Push-Location $target
                try { $check | node; if ($LASTEXITCODE) { throw 'Unmerged environment values.' } }
                finally { Pop-Location }
                $action = 'merged-env'
            }
            else { throw "Untracked conflict requires merging: $rel" }
        }
        $plan.Add([pscustomobject]@{From=$file.FullName; To=$to; Hash=$hash; Action=$action})
    }
}
$plan | Group-Object Action | Select-Object Name, Count
if (-not $Apply) { return }
foreach ($entry in $plan) {
    if ((Get-FileHash -LiteralPath $entry.From -Algorithm SHA256).Hash -ne $entry.Hash) {
        throw "File changed during migration: $($entry.From)"
    }
    if ($entry.Action -eq 'move') {
        $null = New-Item -ItemType Directory -Path (Split-Path $entry.To) -Force
        Move-Item -LiteralPath $entry.From -Destination $entry.To
        if ((Get-FileHash -LiteralPath $entry.To -Algorithm SHA256).Hash -ne $entry.Hash) {
            throw "Hash mismatch: $($entry.To)"
        }
    } else {
        Remove-Item -LiteralPath $entry.From -Force
    }
}
foreach ($root in $roots) {
    $from = [IO.Path]::GetFullPath((Join-Path $source $root))
    if (-not $from.StartsWith($source + '\')) { throw 'Unsafe cleanup path.' }
    if (Test-Path -LiteralPath $from -PathType Container) {
        Get-ChildItem -LiteralPath $from -Directory -Recurse -Force |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object { if (-not @(Get-ChildItem -LiteralPath $_.FullName -Force).Count) { Remove-Item -LiteralPath $_.FullName -Force } }
        if (-not @(Get-ChildItem -LiteralPath $from -Force).Count) { Remove-Item -LiteralPath $from -Force }
    }
}

param([switch]$Preview)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$config = Join-Path $repo 'config.json'
$delivery = (Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json).delivery
$uv = (Get-Command uv.exe -ErrorAction Stop).Source
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'
$arguments = @(
    'run', '--project', [string]$delivery.telethonProjectDir,
    'python', (Join-Path $PSScriptRoot 'sync_magazines_zotero.py'),
    '--config', $config
)
if ($Preview) { $arguments += '--dry-run' }
& $uv @arguments
exit $LASTEXITCODE

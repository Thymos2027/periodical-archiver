param(
  [string]$ProfileDir = ".\profile",
  [switch]$NoProxy,
  [string]$ProxyServer
)

$resolvedProfile = Resolve-Path -LiteralPath $ProfileDir -ErrorAction SilentlyContinue
if (-not $resolvedProfile) {
  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
  $resolvedProfile = Resolve-Path -LiteralPath $ProfileDir
}

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
)

$chromePath = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromePath) {
  Write-Error "chrome.exe not found. Please install Chrome first."
  exit 1
}

$profilePath = $resolvedProfile.Path
$arguments = @(
  "--user-data-dir=$profilePath"
)

if ($NoProxy) {
  $arguments += "--no-proxy-server"
}
elseif ($ProxyServer) {
  $arguments += "--proxy-server=$ProxyServer"
}

Start-Process -FilePath $chromePath -ArgumentList $arguments

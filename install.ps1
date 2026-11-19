# cowork-bridge installer for Windows (PowerShell). Safe to run again (it updates and restarts).
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/CIOS-Technologies/cowork-bridge/main/install.ps1))) [-HomeDir C:\Users\you\cowork-bridge]
param([string]$HomeDir = $(if ($env:COWORK_BRIDGE_HOME) { $env:COWORK_BRIDGE_HOME } else { Join-Path $HOME 'cowork-bridge' }))
$ErrorActionPreference = 'Stop'
$Repo = if ($env:COWORK_BRIDGE_REPO) { $env:COWORK_BRIDGE_REPO } else { 'https://github.com/CIOS-Technologies/cowork-bridge' }
function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin" }

Say "cowork-bridge -> $HomeDir"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Say 'Installing Node.js'; winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements; Refresh-Path }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say 'Installing Git (Claude Code on Windows needs it)'; winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements; Refresh-Path }

New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
$App = Join-Path $HomeDir 'app'
if (Test-Path (Join-Path $App '.git')) { Say 'Updating the app'; git -C $App pull --ff-only }
else { Say 'Downloading the app'; git clone --depth 1 $Repo $App }
Push-Location $App; npm ci --omit=dev --no-audit --no-fund --loglevel=error; Pop-Location

if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path "$HOME\.local\bin\claude.exe")) { Say 'Installing Claude Code'; irm https://claude.ai/install.ps1 | iex; Refresh-Path }

$Cli = Join-Path $App 'bin\cowork-bridge.mjs'
Say 'Checking the setup'
node $Cli doctor --home $HomeDir
if ($LASTEXITCODE -eq 0) {
  Say 'Starting your reader'
  node $Cli stop --home $HomeDir | Out-Null
  node $Cli start --home $HomeDir
}

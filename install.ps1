# cowork-bridge installer for Windows (PowerShell 5.1 or 7). No WSL needed. Safe to run again: it updates and restarts.
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/CIOS-Technologies/cowork-bridge/main/install.ps1))) -HomeDir "C:\Users\<you>\cowork-bridge"
#
# Before running: <HomeDir>\config.json and <HomeDir>\.env must exist (the cowork-bridge skill writes them).
# Steps: Node.js + Git (winget, if missing) -> app into <HomeDir>\app -> Claude Code (if missing)
#        -> one-time Claude sign-in for the reader (browser) -> checks -> start in the background -> autostart at login.
# Options: -NoAutostart  do not start the reader automatically when you log in to Windows.
param(
  [string]$HomeDir = $(if ($env:COWORK_BRIDGE_HOME) { $env:COWORK_BRIDGE_HOME } else { Join-Path $HOME 'cowork-bridge' }),
  [switch]$NoAutostart
)
$ErrorActionPreference = 'Stop'
$Repo = if ($env:COWORK_BRIDGE_REPO) { $env:COWORK_BRIDGE_REPO } else { 'https://github.com/CIOS-Technologies/cowork-bridge' }
function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Fail($t) { Write-Host "`nSTOPPED: $t" -ForegroundColor Red; throw "cowork-bridge install stopped: $t" }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin" }
function Need-Winget { if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "winget is missing. Install 'App Installer' from the Microsoft Store, or install $args by hand, then run this again." } }

Say "cowork-bridge -> $HomeDir"
if (-not (Test-Path (Join-Path $HomeDir 'config.json'))) { Fail "$HomeDir\config.json is missing. Run the cowork-bridge skill's setup in Cowork first." }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"; if ($LASTEXITCODE) { $node = $null } }
if (-not $node) { Say 'Installing Node.js'; Need-Winget 'Node.js 20+'; winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements; Refresh-Path }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say 'Installing Git (Claude Code on Windows needs it)'; Need-Winget 'Git'; winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements; Refresh-Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is still not found. Close this window, open a new PowerShell, and run the command again.' }

$App = Join-Path $HomeDir 'app'
if (Test-Path (Join-Path $App '.git')) { Say 'Updating the app'; git -C $App pull --ff-only }
else { Say 'Downloading the app'; git clone --depth 1 $Repo $App }
if ($LASTEXITCODE) { Fail 'could not download the app (git).' }
# npm.cmd, not npm: PowerShell's default policy blocks npm.ps1.
Push-Location $App; & npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error; $npmExit = $LASTEXITCODE; Pop-Location
if ($npmExit) { Fail 'npm could not install the app''s packages.' }

if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path "$HOME\.local\bin\claude.exe")) { Say 'Installing Claude Code'; irm https://claude.ai/install.ps1 | iex; Refresh-Path }

$Cli = Join-Path $App 'bin\cowork-bridge.mjs'

Say 'Signing the reader in to Claude (one time; skipped if already signed in)'
node $Cli login --home $HomeDir
if ($LASTEXITCODE) { Fail 'the reader is not signed in to Claude. Run the command again and finish the sign-in in the browser.' }

Say 'Checking the setup'
node $Cli doctor --home $HomeDir
if ($LASTEXITCODE) { Fail 'fix the items marked with a cross above, then run the command again.' }

Say 'Starting your reader in the background'
node $Cli stop --home $HomeDir | Out-Null
node $Cli start --home $HomeDir
if ($LASTEXITCODE) { Fail "the reader did not start. See $HomeDir\logs\reader-screen.txt and $HomeDir\logs\supervisor.log" }

if (-not $NoAutostart) { Say 'Turning on autostart at login'; node $Cli autostart on --home $HomeDir }
Say 'Status'
node $Cli status --home $HomeDir
Say 'DONE. Your reader runs in the background; no window needs to stay open.'

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
# 'Continue', not 'Stop': when output is captured (an AI's shell tool, a log file), Windows PowerShell 5.1 turns
# anything a program writes to its error stream (Git's progress lines, npm notices) into an error, and 'Stop'
# would end the installer there. Every step checks its exit code instead, and Fail stops the run.
$ErrorActionPreference = 'Continue'
# The app prints UTF-8 (✓ / ✗); without this, captured output shows them as garbage in Windows PowerShell 5.1.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Repo = if ($env:COWORK_BRIDGE_REPO) { $env:COWORK_BRIDGE_REPO } else { 'https://github.com/CIOS-Technologies/cowork-bridge' }
function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }
# The result also goes to <HomeDir>\logs\install-result.txt, so the AI helping with setup can read it from the
# shared folder instead of asking the person to copy the terminal output.
function Result($t) { try { $d = Join-Path $HomeDir 'logs'; New-Item -ItemType Directory -Force $d | Out-Null; Set-Content -Encoding UTF8 (Join-Path $d 'install-result.txt') "$t`r`nat $(Get-Date -Format o)" } catch {} }
function Fail($t) { Result "STOPPED: $t"; Write-Host "`nSTOPPED: $t" -ForegroundColor Red; throw "cowork-bridge install stopped: $t" }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin" }
function Need-Winget { if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "winget is missing. Install 'App Installer' from the Microsoft Store, or install $args by hand, then run this again." } }

Say "cowork-bridge -> $HomeDir"
if (-not (Test-Path (Join-Path $HomeDir 'config.json'))) { Fail "$HomeDir\config.json is missing. Run the cowork-bridge skill's setup in Cowork first." }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"; if ($LASTEXITCODE) { $node = $null } }
Result 'RUNNING'
# winget may show a Windows "allow this app to make changes" prompt; the person clicks Yes.
if (-not $node) { Say 'Installing Node.js (if Windows asks to allow changes, click Yes)'; Need-Winget 'Node.js 20+'; winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements; if ($LASTEXITCODE) { Fail "Node.js could not be installed (winget code $LASTEXITCODE). If Windows asked to allow changes, click Yes next time; or install Node.js 20+ from nodejs.org, then run this again." }; Refresh-Path }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say 'Installing Git (Claude Code on Windows needs it; if Windows asks to allow changes, click Yes)'; Need-Winget 'Git'; winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements; if ($LASTEXITCODE) { Fail "Git could not be installed (winget code $LASTEXITCODE). If Windows asked to allow changes, click Yes next time; or install Git from git-scm.com, then run this again." }; Refresh-Path }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is still not found. Close this window, open a new PowerShell, and run the command again.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is still not found. Close this window, open a new PowerShell, and run the command again.' }

$App = Join-Path $HomeDir 'app'
if (Test-Path (Join-Path $App '.git')) { Say 'Updating the app'; git -C $App pull -q --ff-only 2>&1 | Out-Host }
else { Say 'Downloading the app'; git clone -q --depth 1 $Repo $App 2>&1 | Out-Host }
if ($LASTEXITCODE) { Fail 'could not download the app (git).' }
# A running reader keeps a file of the terminal library open, and Windows refuses to replace an open file.
# Stop it before updating the packages (it is started again below).
$Cli = Join-Path $App 'bin\cowork-bridge.mjs'
if (Test-Path (Join-Path $App 'node_modules')) {
  Say 'Stopping the reader for the update'
  node $Cli stop --home $HomeDir | Out-Null
  # Also end any leftover reader from this folder (for example one started by an older version): only node.exe
  # running this app's code and the reader's claude.exe. Never match on the folder alone: a Cowork session that
  # has this folder shared also mentions it on its command line.
  $appMark = (Join-Path $App 'src\') ; $readerMark = (Join-Path $HomeDir 'reader\.mcp.json')
  $has = { param($p, $m) $p.CommandLine -and $p.CommandLine.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  $mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude.exe'" -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -eq 'node.exe' -and (& $has $_ $appMark)) -or ($_.Name -eq 'claude.exe' -and (& $has $_ $readerMark)) }
  foreach ($p in $mine) { Invoke-CimMethod -InputObject $p -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  if ($mine) { Start-Sleep -Seconds 2 }
}
# npm.cmd, not npm: PowerShell's default policy blocks npm.ps1.
Push-Location $App; & npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error; $npmExit = $LASTEXITCODE; Pop-Location
if ($npmExit) { Fail 'npm could not install the app''s packages.' }

# The reader needs the native claude.exe (an npm-installed claude.cmd cannot run in the hidden terminal).
$hasClaudeExe = (Test-Path "$HOME\.local\bin\claude.exe") -or (Get-Command claude.exe -ErrorAction SilentlyContinue)
if (-not $hasClaudeExe) { Say 'Installing Claude Code'; irm https://claude.ai/install.ps1 | iex; Refresh-Path }
if (-not ((Test-Path "$HOME\.local\bin\claude.exe") -or (Get-Command claude.exe -ErrorAction SilentlyContinue))) { Fail 'Claude Code could not be installed. Run "irm https://claude.ai/install.ps1 | iex" in PowerShell, then run this again.' }

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
Result 'DONE'
Say 'DONE. Your reader runs in the background; no window needs to stay open.'

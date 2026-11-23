#!/usr/bin/env node
// cowork-bridge command line. Every command takes --home <folder> (default ~/cowork-bridge).
//
//   doctor          check config, Slack tokens, Cowork data, Claude Code and its sign-in; say what is missing
//   login           one-time sign-in of the reader's own Claude Code (opens the browser)
//   snapshot        rebuild the reader's read-only copy now
//   start           refresh the copy and start the reader in the background (no window to keep open)
//                   --no-wait: return at once instead of waiting until the reader is ready
//   stop            stop the reader
//   status          is the reader up, which rooms, which requests are open, is autostart on
//   autostart on|off   start the reader automatically when you log in (Windows and macOS)
//   rooms           admin only: create the pair rooms listed in directory.json (dry run without --apply)
//
// Exit codes: 0 ok · 1 error · 2 the reader needs the one-time sign-in (run `login`).

import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP, homeDir, paths, loadConfig, loadEnv, findCoworkData, skillsDirFor, readJson } from '../src/config.mjs'
import { claudeBin, launchArgs, readerEnv, signedIn, seedClaudeConfig } from '../src/launch.mjs'

const args = process.argv.slice(2).filter((a, i, all) => a !== '--home' && all[i - 1] !== '--home')
const [cmd = 'help', ...rest] = args
const HOME = homeDir()
const P = paths(HOME)
const CLI = path.join(APP, 'bin', 'cowork-bridge.mjs')
const SESSION = 'cowork-bridge'
const READER_STATE = path.join(P.state, 'reader.json')
const STOP = path.join(P.state, 'stop-request')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Start a long-running background process that does not belong to whoever ran this command.
// On Windows a plain detached child still counts as part of the caller's process tree, so a terminal,
// scheduler or AI shell tool that cleans up its tree when it finishes would stop the reader with it,
// and some wait until every inherited handle closes. Creating it through Windows' own process service
// (WMI) gives it no parent to be cleaned up with. Elsewhere a detached child is enough.
function launchDetached(file, argv) {
  if (process.platform === 'win32') {
    const q = s => `"${String(s).replace(/"/g, '\\"')}"`
    const ps = [
      "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CB_CMD; CurrentDirectory = $env:CB_CWD; ProcessStartupInformation = $si }",
      'if ($r.ReturnValue -ne 0) { exit 1 }',
    ].join('; ')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, CB_CMD: [file, ...argv].map(q).join(' '), CB_CWD: HOME }, stdio: 'ignore', windowsHide: true, timeout: 60_000,
    })
    if (r.status === 0) return
  }
  const child = spawn(file, argv, { cwd: HOME, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}
const has = bin => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0
const ok = (b, msg, fix) => { console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `\n    → ${fix}` : ''}`); return b }
const cliLine = c => `node "${CLI}" ${c} --home "${HOME}"`

// Where the reader runs: tmux on Linux/WSL when available, otherwise our own background supervisor.
const useTmux = () => process.platform === 'linux' && has('tmux')
async function terminalLibOk() {
  try { await import('node-pty'); await import('@xterm/headless'); return true } catch { return false }
}
const alive = pid => { try { return !!pid && process.kill(pid, 0) } catch (e) { return e.code === 'EPERM' } }
function readerState() { try { return JSON.parse(fs.readFileSync(READER_STATE, 'utf8')) } catch { return null } }
// Our background process is running: its number is alive AND it updated its state file recently
// (after a reboot the old number may belong to some other program, which we must never stop).
const ours = s => !!s && alive(s.supervisor_pid) && Date.now() - (s.updated || 0) < 30_000
const heartbeatAt = () => { try { return Date.parse(JSON.parse(fs.readFileSync(path.join(P.state, 'heartbeat.json'), 'utf8')).at) } catch { return 0 } }
function readScreen() { try { return fs.readFileSync(path.join(P.logs, 'reader-screen.txt'), 'utf8') } catch { return '(no screen captured)' } }

// Also keep a command's output in logs/<file> (with the time it ran), so the AI helping with setup can read it
// from the shared folder instead of asking the person to copy the terminal.
function keepOutput(file) {
  const lines = [], print = console.log
  console.log = (...a) => { lines.push(a.join(' ')); print(...a) }
  process.on('exit', () => { try { fs.mkdirSync(P.logs, { recursive: true }); fs.writeFileSync(path.join(P.logs, file), `${new Date().toISOString()}\n${lines.join('\n')}\n`) } catch {} })
}

async function doctor() {
  let good = true
  keepOutput('doctor.txt')
  console.log(`cowork-bridge home: ${HOME}\n`)
  good &= ok(fs.existsSync(P.config), 'config.json exists', 'run the cowork-bridge skill in Cowork ("make my Cowork answerable")')
  if (!fs.existsSync(P.config)) return process.exit(1)
  let cfg
  try { cfg = loadConfig(HOME) } catch (e) { ok(false, `config.json: ${e.message}`, 'fix config.json (see the skill, step 2.5)'); return process.exit(1) }
  const env = loadEnv(HOME)
  good &= ok(/^xapp-/.test(env.SLACK_APP_TOKEN || ''), '.env has SLACK_APP_TOKEN (xapp-…)', 'Slack app page → Basic Information → App-Level Tokens')
  good &= ok(/^xoxb-/.test(env.SLACK_BOT_TOKEN || ''), '.env has SLACK_BOT_TOKEN (xoxb-…)', 'Slack app page → Install App → Bot User OAuth Token')
  if (env.SLACK_BOT_TOKEN) {
    try {
      const { WebClient } = await import('@slack/web-api')
      const a = await new WebClient(env.SLACK_BOT_TOKEN).auth.test()
      ok(true, `Slack bot works: @${a.user} (member ID ${a.user_id}), workspace ${a.team}`)
      fs.mkdirSync(P.state, { recursive: true })
      fs.writeFileSync(path.join(P.state, 'bot.json'), JSON.stringify({ bot_user_id: a.user_id, bot_name: a.user, team: a.team }, null, 2))
    } catch (e) { good &= ok(false, `Slack bot token rejected: ${e.data?.error || e.message}`, 'regenerate it on the Slack app page (Install App)') }
  }
  if (/^xapp-/.test(env.SLACK_APP_TOKEN || '')) {
    try {
      const { WebClient } = await import('@slack/web-api')
      await new WebClient(env.SLACK_APP_TOKEN).apps.connections.open()
      ok(true, 'Slack app-level token works')
    } catch (e) { good &= ok(false, `Slack app-level token rejected: ${e.data?.error || e.message}`, 'Slack app page → Basic Information → App-Level Tokens: generate one with connections:write, put it in .env') }
  }
  const found = findCoworkData(cfg.cowork_data_dir)
  good &= ok(found.length > 0, `Cowork data found${found[0] ? `: ${found[0]}` : ''}`, 'set cowork_data_dir in config.json to the folder that contains spaces.json')
  if (found.length > 1 && !cfg.cowork_data_dir) console.log(`    note: ${found.length} Cowork accounts found; using the first. Set cowork_data_dir to pick one.`)
  if (found[0]) {
    const spaces = readJson(path.join(found[0], 'spaces.json')).spaces.map(s => s.name)
    // For the AI doing the setup: it can read this file from the shared folder instead of asking the user.
    fs.mkdirSync(P.state, { recursive: true })
    fs.writeFileSync(path.join(P.state, 'cowork-projects.json'), JSON.stringify({ available: spaces, configured: cfg.projects }, null, 2))
    const missing = cfg.projects.filter(p => !spaces.includes(p))
    good &= ok(cfg.projects.length > 0 && !missing.length, `projects shared with the reader: ${cfg.projects.join(', ') || 'none'}`,
      `available Cowork projects: ${spaces.join(', ')}${missing.length ? ` (unknown: ${missing.join(', ')})` : ''}`)
    console.log(skillsDirFor(found[0]) || cfg.skills_dir ? '✓ Cowork skills folder found' : '– Cowork skills folder not found (optional; fine)')
  }
  const bin = claudeBin()
  good &= ok(!!bin, `Claude Code installed${bin ? `: ${bin}` : ''}`, 'run the installer again, or install from https://code.claude.com/docs/en/quickstart')
  if (bin) good &= ok(signedIn(HOME), 'reader signed in to Claude', `run: ${cliLine('login')}`)
  if (!useTmux()) good &= ok(await terminalLibOk(), 'background terminal library installed', process.platform === 'linux' ? 'install tmux (sudo apt install tmux)' : 'run the installer again')
  console.log(good ? '\nAll set. Next: cowork-bridge start' : '\nFix the ✗ items, then run doctor again.')
  process.exit(good ? 0 : 1)
}

function login() {
  const bin = claudeBin()
  if (!bin) { console.log('Claude Code is not installed. Run the installer again.'); process.exit(1) }
  fs.mkdirSync(P.claudeConfig, { recursive: true })
  // --again: sign in even if Claude Code believes it is signed in (an expired sign-in can still look valid).
  if (!rest.includes('--again') && signedIn(HOME)) return console.log('✓ The reader is already signed in to Claude.')
  console.log('Sign in to Claude for the reader. A browser page opens: sign in with your own Claude account and click Authorize.')
  console.log('If the page then shows a code, paste it here and press Enter.\n')
  if (!process.stdin.isTTY) console.log('(This window cannot take typed input. If a code appears, run this command again in a terminal window you can type into.)\n')
  spawnSync(bin, ['auth', 'login'], { env: readerEnv(HOME), stdio: 'inherit' })
  if (signedIn(HOME)) console.log('\n✓ Signed in.')
  else { console.log('\n✗ Not signed in. Run login again.'); process.exit(2) }
}

async function snapshotCmd() {
  const { snapshot } = await import('../src/snapshot.mjs')
  snapshot(HOME, { quiet: rest.includes('--quiet') })
}

async function start() {
  // Started at login by autostart, nobody sees the output: keep it in logs/autostart.log.
  if (rest.includes('--no-wait')) {
    fs.mkdirSync(P.logs, { recursive: true })
    const f = path.join(P.logs, 'autostart.log'), print = console.log
    console.log = (...a) => { print(...a); try { fs.appendFileSync(f, `${new Date().toISOString()} ${a.join(' ')}\n`) } catch {} }
    console.log('start --no-wait')
  }
  if (!signedIn(HOME)) {
    // Leave a trace for `status`: when autostart runs this at login, nobody sees this output.
    fs.mkdirSync(P.state, { recursive: true })
    fs.writeFileSync(READER_STATE, JSON.stringify({ supervisor_pid: null, phase: 'needs_login', reason: 'the reader is not signed in to Claude', since: Date.now(), updated: Date.now() }, null, 2))
    console.log(`The reader needs a one-time Claude sign-in first. Run:\n  ${cliLine('login')}\nthen start again (or run the install command again, which does both).`)
    process.exit(2)
  }
  await snapshotCmd()
  seedClaudeConfig(HOME)
  if (useTmux()) return startTmux()
  return startSupervisor()
}

async function startTmux() {
  if (spawnSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0) return console.log(`Already running. Look at it with: tmux attach -t ${SESSION}`)
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  const line = [claudeBin(), ...launchArgs(HOME)].map(q).join(' ')
  spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', '-c', P.reader, `env ${q(`CLAUDE_CONFIG_DIR=${P.claudeConfig}`)} ${line}; echo; echo 'reader stopped'; sleep 86400`])
  // Confirm the start-up questions; stop when the input prompt is up.
  for (let i = 0; i < 40; i++) {
    await sleep(1500)
    const screen = spawnSync('tmux', ['capture-pane', '-pt', SESSION], { encoding: 'utf8' }).stdout || ''
    if (screen.includes('Yes, I trust this folder')) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Down']); spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue }
    if (/I am using this for local development/.test(screen)) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue }
    if (/No, disable external imports/.test(screen)) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue } // keep the default: no imports from outside
    if (/Select login method|Paste code here/.test(screen)) { console.log(`The reader needs a one-time Claude sign-in. Run: ${cliLine('login')}`); process.exit(2) }
    if (screen.includes("don't ask on")) return console.log(`✓ Reader is up. Watch it with: tmux attach -t ${SESSION}  (detach with Ctrl-b d)`)
  }
  console.log(`Started, but not confirmed ready. Look: tmux attach -t ${SESSION}`)
  process.exit(1)
}

async function startSupervisor() {
  const s = readerState()
  if (ours(s)) {
    if (['starting', 'ready', 'restarting'].includes(s.phase)) return console.log(`✓ Already running (${s.phase}).`)
    await stop(true) // waiting for a sign-in or a question: start over now that the cause may be fixed
  }
  if (!(await terminalLibOk())) {
    console.log(process.platform === 'linux' ? 'Install tmux (sudo apt install tmux) and start again.' : 'The background terminal library is missing. Run the installer again.')
    process.exit(1)
  }
  fs.mkdirSync(P.state, { recursive: true })
  fs.mkdirSync(P.logs, { recursive: true })
  try { fs.unlinkSync(READER_STATE) } catch {}
  const launchedAt = Date.now()
  launchDetached(process.execPath, [path.join(APP, 'src', 'supervisor.mjs'), '--home', HOME])
  if (rest.includes('--no-wait')) return console.log('Reader starting in the background.')
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const st = readerState()
    if (!st) continue
    if (st.phase === 'ready') {
      // Claude Code is up; now the bridge inside it must reach Slack (it writes a heartbeat when connected).
      for (let j = 0; j < 60 && heartbeatAt() < launchedAt; j++) await sleep(1000)
      if (heartbeatAt() >= launchedAt) return console.log('✓ Reader is up and connected to Slack, running in the background. Check it with: status')
      console.log(`✗ The reader started but could not connect to Slack. See ${path.join(P.logs, 'bridge.log')}. Usually SLACK_APP_TOKEN (xapp-…) in .env is wrong.`)
      process.exit(1)
    }
    if (st.phase === 'needs_login') {
      console.log(`The reader's Claude sign-in is missing or has expired. Run: ${cliLine('login --again')}, then start again (or run the install command again).`)
      await stop(true)
      // Keep the cause for `status` (stopping wrote "stopped").
      fs.writeFileSync(READER_STATE, JSON.stringify({ supervisor_pid: null, phase: 'needs_login', reason: 'the reader is not signed in to Claude, or the sign-in has expired', since: Date.now(), updated: Date.now() }, null, 2))
      process.exit(2)
    }
    if (st.phase === 'failed') { console.log(`✗ Reader failed to start: ${st.reason}`); process.exit(1) }
    if (st.phase === 'stuck') { console.log(`✗ The reader is waiting on a question it cannot answer by itself. Its screen:\n${readScreen()}\nReport this screen; stop it with: ${cliLine('stop')}`); process.exit(1) }
  }
  console.log(`Started, but not confirmed ready after 90 s. Its screen is in ${path.join(P.logs, 'reader-screen.txt')}`)
  process.exit(1)
}

async function stop(quiet = false) {
  const say = m => quiet || console.log(m)
  if (useTmux() && spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' }).status === 0) return say('✓ Reader stopped.')
  const s = readerState()
  if (!ours(s)) return say('Reader is not running.')
  fs.writeFileSync(STOP, String(Date.now()))
  for (let i = 0; i < 15; i++) { await sleep(1000); if (!alive(s.supervisor_pid)) return say('✓ Reader stopped.') }
  // Did not stop on request: end it and the reader under it.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.supervisor_pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(-s.supervisor_pid, 'SIGKILL') } catch {} }
  if (s.claude_pid && alive(s.claude_pid)) { try { process.kill(s.claude_pid, 'SIGKILL') } catch {} }
  try { fs.unlinkSync(STOP) } catch {}
  say('✓ Reader stopped (forced).')
}

function status() {
  const hb = path.join(P.state, 'heartbeat.json')
  let up = false
  if (!fs.existsSync(hb)) console.log('Reader: never started')
  else {
    const h = JSON.parse(fs.readFileSync(hb, 'utf8'))
    const age = (Date.now() - Date.parse(h.at)) / 1000
    // A recent heartbeat alone is not enough: right after a stop it is still fresh for a while.
    up = age < 150 && (useTmux() ? spawnSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0 : ours(readerState()))
    console.log(up ? `Reader: UP (bot ${h.bot}) · rooms: ${h.rooms.join(', ') || 'none yet'}` : `Reader: DOWN (last seen ${Math.round(age / 60)} min ago). Start it: ${cliLine('start')}`)
  }
  if (!useTmux()) {
    const s = readerState()
    const phase = !s ? null : ours(s) ? s.phase : s.phase === 'needs_login' ? 'needs_login' : 'not running'
    if (phase) console.log(`Background process: ${phase}${s.reason && phase !== 'not running' ? ` (${s.reason})` : ''}`)
    if (s?.phase === 'needs_login') console.log(`  → run: ${cliLine('login')}`)
  }
  console.log(`Autostart at login: ${autostartState() ? 'on' : 'off'}`)
  let r = {}
  try { r = JSON.parse(fs.readFileSync(path.join(P.state, 'requests.json'), 'utf8')).requests } catch {}
  const open = Object.values(r).filter(x => ['processing', 'awaiting_approval'].includes(x.status)).sort((a, b) => a.created - b.created)
  for (const x of open) console.log(`  ${x.id}  ${x.status.padEnd(18)} ${String(x.asker_name).padEnd(12)} ${Math.round((Date.now() - x.created) / 60000)} min  ${JSON.stringify(x.question.slice(0, 60))}`)
  console.log(`${open.length} open, ${Object.keys(r).length} total`)
}

// --- autostart -------------------------------------------------------------------------------
const WIN_LINK = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'cowork-bridge.lnk')
const MAC_PLIST = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cowork-bridge.reader.plist')
function autostartState() {
  if (process.platform === 'win32') return fs.existsSync(WIN_LINK())
  if (process.platform === 'darwin') return fs.existsSync(MAC_PLIST())
  return false
}

function autostart() {
  const on = rest[0] === 'on', off = rest[0] === 'off'
  if (!on && !off) { console.log(`Autostart is ${autostartState() ? 'on' : 'off'}. Use: autostart on | autostart off`); return }
  if (process.platform === 'win32') {
    if (off) { try { fs.unlinkSync(WIN_LINK()) } catch {} return console.log('✓ Autostart off.') }
    // A shortcut in the user's Startup folder: no administrator rights needed. It runs `start --no-wait`
    // in a minimised window that closes after a few seconds; the reader keeps running in the background.
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:CB_LINK); $s.TargetPath=$env:CB_NODE; $s.Arguments=$env:CB_ARGS; $s.WorkingDirectory=$env:CB_HOME; $s.WindowStyle=7; $s.Description='Starts the cowork-bridge reader'; $s.Save()`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, CB_LINK: WIN_LINK(), CB_NODE: process.execPath, CB_ARGS: `"${CLI}" start --no-wait --home "${HOME}"`, CB_HOME: HOME }, encoding: 'utf8' })
    if (r.status !== 0 || !fs.existsSync(WIN_LINK())) { console.log(`✗ Could not create the startup shortcut: ${r.stderr || r.stdout}`); process.exit(1) }
    return console.log(`✓ Autostart on: the reader starts when you log in to Windows (${WIN_LINK()}).`)
  }
  if (process.platform === 'darwin') {
    if (off) { spawnSync('launchctl', ['unload', MAC_PLIST()], { stdio: 'ignore' }); try { fs.unlinkSync(MAC_PLIST()) } catch {} return console.log('✓ Autostart off.') }
    const x = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    fs.mkdirSync(path.dirname(MAC_PLIST()), { recursive: true })
    fs.writeFileSync(MAC_PLIST(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cowork-bridge.reader</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(CLI)}</string><string>start</string><string>--no-wait</string><string>--home</string><string>${x(HOME)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${x(path.join(P.logs, 'autostart.log'))}</string>
</dict></plist>
`)
    return console.log('✓ Autostart on: the reader starts when you log in to macOS.')
  }
  console.log(`Autostart is not automated on Linux/WSL. After a restart run:\n  ${cliLine('start')}`)
  process.exit(1)
}

async function roomsCmd() {
  keepOutput('rooms.txt')
  const { rooms } = await import('../src/rooms.mjs')
  const only = rest.filter(a => !a.startsWith('--'))
  await rooms(HOME, { apply: rest.includes('--apply'), only })
}

const cmds = { doctor, login, snapshot: snapshotCmd, start, stop: () => stop(), status, autostart, rooms: roomsCmd }
if (!cmds[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  process.exit(cmd === 'help' ? 0 : 1)
}
try { await cmds[cmd]() } catch (e) { console.error(`✗ ${e.message}`); process.exit(1) }

// Runs the reader (Claude Code) in a hidden pseudo-terminal, with no window to keep open.
// Used on Windows and macOS (and Linux without tmux). Started by `cowork-bridge start`; do not run by hand.
//
//   - answers Claude Code's start-up questions (development-channel confirmation, folder trust,
//     outside instruction imports) the same way every time;
//   - writes its phase to state/reader.json: starting | needs_login | stuck | ready | restarting | stopped | failed;
//   - writes what the reader's screen shows to logs/reader-screen.txt (for status and troubleshooting);
//   - restarts the reader if it exits, with growing pauses; gives up after 5 quick failures;
//   - stops when state/stop-request appears (that is what `cowork-bridge stop` does).

import fs from 'node:fs'
import path from 'node:path'
import { homeDir, paths } from './config.mjs'
import { claudeBin, launchArgs, readerEnv, seedClaudeConfig } from './launch.mjs'

const HOME = homeDir()
const P = paths(HOME)
const STATE = path.join(P.state, 'reader.json')
const STOP = path.join(P.state, 'stop-request')
const SCREEN = path.join(P.logs, 'reader-screen.txt')
const LOG = path.join(P.logs, 'supervisor.log')
const COLS = 160, ROWS = 50
const KEY = { enter: '\r', down: '\x1b[B', up: '\x1b[A' }

fs.mkdirSync(P.state, { recursive: true })
fs.mkdirSync(P.logs, { recursive: true })
const log = msg => fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)

let state = { supervisor_pid: process.pid, phase: 'starting', since: Date.now(), restarts: 0 }
function write(patch) {
  state = { ...state, ...patch, updated: Date.now() }
  if (patch.phase) state.since = Date.now()
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
}

let pty, Terminal
try {
  pty = await import('node-pty')
  pty = pty.default ?? pty
  const xt = await import('@xterm/headless')
  Terminal = (xt.default ?? xt).Terminal
} catch (e) {
  write({ phase: 'failed', reason: `terminal library missing (${e.message}); run the installer again` })
  process.exit(1)
}

let child = null, term = null, stopping = false, failures = 0, startedAt = 0

function screenText() {
  const b = term.buffer.active
  const out = []
  for (let i = 0; i < ROWS; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  return out.join('\n')
}

// Move the selection pointer (❯) to the option containing `label`, then press Enter.
function choose(screen, label) {
  const opts = screen.split('\n').filter(l => /^\s*(❯|>)?\s*\d+\.\s/.test(l))
  const target = opts.findIndex(l => l.includes(label))
  if (target < 0) return false
  const cur = Math.max(0, opts.findIndex(l => /^\s*(❯|>)/.test(l)))
  const key = target > cur ? KEY.down : KEY.up
  for (let i = 0; i < Math.abs(target - cur); i++) child.write(key)
  setTimeout(() => child?.write(KEY.enter), 300)
  return true
}

const RULES = [
  { test: /Select login method|Paste code here|Not logged in|Please run \/login/i, phase: 'needs_login', reason: 'the reader is not signed in to Claude' },
  // Signed in, but the organization has not turned Channels on: the reader would run but never receive questions.
  { test: /Channels are not (currently )?(available|enabled)/i, phase: 'stuck', reason: 'Claude Code says Channels are not available. On Team and Enterprise plans an organization owner must turn on Claude Code → Channels in the admin settings' },
  { test: /I am using this for local development/, act: s => choose(s, 'I am using this for local development'), note: 'confirmed development channel' },
  { test: /Yes, I trust this folder/, act: s => choose(s, 'Yes, I trust this folder'), note: 'trusted the reader folder' },
  { test: /No, disable external imports/, act: s => choose(s, 'No, disable external imports'), note: 'kept outside imports disabled' },
  { test: /Use this MCP server/, act: s => choose(s, 'Use this MCP server'), note: 'enabled the bridge server' },
  { test: /Choose the text style|Press Enter to continue/, act: () => (child.write(KEY.enter), true), note: 'pressed Enter' },
  // Any other menu (feature announcements such as "Try the new fullscreen renderer?"): take the option that declines.
  { test: /Enter to confirm/, act: s => { const d = declineOption(s); return d ? choose(s, d) : false }, note: 'declined an optional offer' },
  { test: /don't ask on/, phase: 'ready' },
]

const DECLINE = /^(Not now|No thanks|No, thanks|Maybe later|Skip|Don't show again|No)\b/i
function declineOption(screen) {
  for (const l of screen.split('\n')) {
    const m = /^\s*(?:❯|>)?\s*\d+\.\s+(.*?)\s*$/.exec(l)
    if (m && DECLINE.test(m[1])) return m[1]
  }
  return null
}

let lastScreen = '', lastActionAt = 0, lastChangeAt = Date.now()
function tick() {
  if (!child || !term) return
  const s = screenText()
  if (s !== lastScreen) { lastScreen = s; lastChangeAt = Date.now(); fs.writeFileSync(SCREEN, s.replace(/\s+$/gm, '').trimEnd() + '\n') }
  if (Date.now() - lastActionAt < 2500) return
  let handled = false
  for (const r of RULES) {
    if (!r.test.test(s)) continue
    if (r.phase) { handled = true; if (state.phase !== r.phase || state.reason !== r.reason) { write({ phase: r.phase, reason: r.reason }); log(`phase ${r.phase}${r.reason ? ` (${r.reason})` : ''}`) } if (r.phase === 'ready') failures = 0; break }
    if (r.act(s)) { handled = true; lastActionAt = Date.now(); log(r.note); break }
  }
  // A question nobody answered for a minute: say so instead of looking "starting" forever.
  if (!handled && state.phase === 'starting' && Date.now() - lastChangeAt > 60_000) {
    write({ phase: 'stuck', reason: 'the reader shows a question it cannot answer by itself; see logs/reader-screen.txt' })
    log('phase stuck')
  }
}

function launch() {
  if (stopping) return
  seedClaudeConfig(HOME)
  const bin = claudeBin()
  if (!bin) { write({ phase: 'failed', reason: 'Claude Code not found; run the installer again' }); process.exit(1) }
  term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  child = pty.spawn(bin, launchArgs(HOME), { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: P.reader, env: readerEnv(HOME) })
  child.onData(d => term.write(d))
  startedAt = lastChangeAt = Date.now()
  write({ phase: 'starting', reason: undefined, claude_pid: child.pid })
  log(`started reader (pid ${child.pid})`)
  child.onExit(({ exitCode }) => {
    log(`reader exited (code ${exitCode})`)
    child = null
    if (stopping) return finish()
    if (Date.now() - startedAt > 10 * 60_000) failures = 0
    failures++
    if (failures > 5) { write({ phase: 'failed', reason: 'the reader keeps exiting; see logs/reader-screen.txt' }); return process.exit(1) }
    const wait = Math.min(300, 5 * 2 ** failures)
    write({ phase: 'restarting', restarts: state.restarts + 1, reason: `exited with code ${exitCode}; restarting in ${wait}s` })
    setTimeout(launch, wait * 1000)
  })
}

function finish() {
  write({ phase: 'stopped', claude_pid: null })
  log('stopped')
  process.exit(0)
}

function stop() {
  if (stopping) return
  stopping = true
  log('stop requested')
  if (!child) return finish()
  try { child.kill() } catch {}
  setTimeout(finish, 5000)
}

try { fs.unlinkSync(STOP) } catch {}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {
  if (fs.existsSync(STOP)) { try { fs.unlinkSync(STOP) } catch {} stop() }
  tick()
  // Keep `updated` fresh: the command line trusts supervisor_pid only while this is recent, because
  // after a reboot the same process number can belong to an unrelated program.
  if (Date.now() - state.updated > 10_000) write({})
}, 1000)
launch()

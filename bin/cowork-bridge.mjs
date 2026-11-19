#!/usr/bin/env node
// cowork-bridge command line. Every command takes --home <folder> (default ~/cowork-bridge).
//
//   doctor     check config, Slack tokens, Cowork data, Claude Code; say what is missing
//   snapshot   rebuild the reader's read-only copy now
//   start      refresh the copy and start the reader (in tmux if available, else a new window)
//   stop       stop the reader (tmux) or tell you which window to close
//   status     is the reader up, which rooms, which requests are open
//   rooms      admin only: create the pair rooms listed in directory.json (dry run without --apply)

import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeDir, paths, loadConfig, loadEnv, findCoworkData, skillsDirFor } from '../src/config.mjs'

const [cmd = 'help', ...rest] = process.argv.slice(2)
const HOME = homeDir()
const P = paths(HOME)
const SESSION = 'cowork-bridge'
const has = bin => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0
const claudeBin = () => {
  for (const c of [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]) if (fs.existsSync(c)) return c
  return 'claude'
}
const ok = (b, msg, fix) => { console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `\n    → ${fix}` : ''}`); return b }

async function doctor() {
  let good = true
  console.log(`cowork-bridge home: ${HOME}\n`)
  good &= ok(fs.existsSync(P.config), 'config.json exists', 'run the cowork-bridge skill in Cowork ("make my Cowork answerable")')
  if (!fs.existsSync(P.config)) return process.exit(1)
  const cfg = loadConfig(HOME)
  const env = loadEnv(HOME)
  good &= ok(/^xapp-/.test(env.SLACK_APP_TOKEN || ''), '.env has SLACK_APP_TOKEN (xapp-…)')
  good &= ok(/^xoxb-/.test(env.SLACK_BOT_TOKEN || ''), '.env has SLACK_BOT_TOKEN (xoxb-…)')
  if (env.SLACK_BOT_TOKEN) {
    try {
      const { WebClient } = await import('@slack/web-api')
      const a = await new WebClient(env.SLACK_BOT_TOKEN).auth.test()
      ok(true, `Slack bot works: @${a.user} (member ID ${a.user_id}), workspace ${a.team}`)
      fs.mkdirSync(P.state, { recursive: true })
      fs.writeFileSync(path.join(P.state, 'bot.json'), JSON.stringify({ bot_user_id: a.user_id, bot_name: a.user, team: a.team }, null, 2))
    } catch (e) { good &= ok(false, `Slack bot token rejected: ${e.data?.error || e.message}`, 'regenerate it on the Slack app page (Install App)') }
  }
  const found = findCoworkData(cfg.cowork_data_dir)
  good &= ok(found.length > 0, `Cowork data found${found[0] ? `: ${found[0]}` : ''}`, 'set cowork_data_dir in config.json to the folder that contains spaces.json')
  if (found.length > 1 && !cfg.cowork_data_dir) console.log(`    note: ${found.length} Cowork accounts found; using the first. Set cowork_data_dir to pick one.`)
  if (found[0]) {
    const spaces = JSON.parse(fs.readFileSync(path.join(found[0], 'spaces.json'), 'utf8')).spaces.map(s => s.name)
    const missing = cfg.projects.filter(p => !spaces.includes(p))
    good &= ok(cfg.projects.length > 0 && !missing.length, `projects shared with the reader: ${cfg.projects.join(', ') || 'none'}`,
      `available Cowork projects: ${spaces.join(', ')}${missing.length ? ` (unknown: ${missing.join(', ')})` : ''}`)
    ok(!!skillsDirFor(found[0]) || !!cfg.skills_dir, 'Cowork skills folder found (optional)')
  }
  good &= ok(fs.existsSync(claudeBin()) || has('claude'), 'Claude Code installed', 'install: https://code.claude.com/docs/en/quickstart')
  ok(fs.existsSync(path.join(P.claudeConfig, '.credentials.json')) || process.platform === 'darwin', 'reader signed in to Claude (checked at first start otherwise)')
  console.log(good ? '\nAll set. Next: cowork-bridge start' : '\nFix the ✗ items, then run doctor again.')
  process.exit(good ? 0 : 1)
}

async function snapshotCmd() {
  const { snapshot } = await import('../src/snapshot.mjs')
  snapshot(HOME, { quiet: rest.includes('--quiet') })
}

function launchLine() {
  const cfg = loadConfig(HOME)
  // --strict-mcp-config: load only the bridge, none of the person's claude.ai connectors (Gmail, Drive…)
  return [claudeBin(), '--model', cfg.reader.model, '--strict-mcp-config', '--mcp-config', path.join(P.reader, '.mcp.json'),
    '--dangerously-load-development-channels', 'server:cowork-bridge']
}

async function start() {
  await snapshotCmd()
  fs.mkdirSync(P.claudeConfig, { recursive: true })
  const args = launchLine()
  const env = `CLAUDE_CONFIG_DIR=${P.claudeConfig}`
  if (process.platform !== 'win32' && has('tmux')) {
    if (spawnSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0) return console.log(`Already running. Look at it with: tmux attach -t ${SESSION}`)
    const q = s => `'${s.replace(/'/g, `'\\''`)}'`
    spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', '-c', P.reader, `env ${q(env)} ${args.map(q).join(' ')}; echo; echo 'reader stopped'; sleep 86400`])
    // Confirm the folder-trust and development-channel prompts; stop when the input prompt is up.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500))
      const screen = spawnSync('tmux', ['capture-pane', '-pt', SESSION], { encoding: 'utf8' }).stdout || ''
      if (screen.includes('Yes, I trust this folder')) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Down']); spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue }
      if (/I am using this for local development/.test(screen)) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue }
      if (/No, disable external imports/.test(screen)) { spawnSync('tmux', ['send-keys', '-t', SESSION, 'Enter']); continue } // keep the default: no imports from outside
      if (/Select login method|Paste code here|Choose the text style/.test(screen)) return console.log(`The reader needs a one-time Claude sign-in. Run: tmux attach -t ${SESSION}  (finish sign-in, then detach with Ctrl-b d)`)
      if (screen.includes("don't ask on")) return console.log(`Reader is up. Watch it with: tmux attach -t ${SESSION}  (detach with Ctrl-b d)`)
    }
    return console.log(`Started, but not confirmed ready. Look: tmux attach -t ${SESSION}`)
  }
  // No tmux: open a visible terminal window the user keeps open (it can be minimised).
  if (process.platform === 'win32') {
    const line = `title ${SESSION} && cd /d "${P.reader}" && set "${env}" && "${args[0]}" ${args.slice(1).join(' ')}`
    spawn('cmd.exe', ['/c', 'start', SESSION, 'cmd.exe', '/k', line], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    const line = `cd '${P.reader}' && export ${env} && '${args[0]}' ${args.slice(1).join(' ')}`
    spawnSync('osascript', ['-e', `tell application "Terminal" to do script "${line.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate'])
  } else return console.log('Install tmux (sudo apt install tmux) and run start again.')
  console.log(`A "${SESSION}" terminal window opened. In it:
  1. First time only: sign in to Claude when asked.
  2. "Do you trust this folder?" → choose "Yes, I trust this folder".
  3. "Loading development channels" → choose "I am using this for local development".
Keep that window open (minimise it). Closing it stops your reader.`)
}

function stop() {
  if (process.platform !== 'win32' && has('tmux') && spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' }).status === 0) return console.log('Reader stopped.')
  if (process.platform === 'win32') { spawnSync('taskkill', ['/FI', `WINDOWTITLE eq ${SESSION}*`, '/T', '/F'], { stdio: 'ignore' }); return console.log('Reader window closed (if it was open).') }
  console.log(`Close the "${SESSION}" terminal window to stop the reader.`)
}

function status() {
  const hb = path.join(P.state, 'heartbeat.json')
  if (!fs.existsSync(hb)) console.log('Reader: never started')
  else {
    const h = JSON.parse(fs.readFileSync(hb, 'utf8'))
    const age = (Date.now() - Date.parse(h.at)) / 1000
    console.log(age < 150 ? `Reader: UP (bot ${h.bot}) · rooms: ${h.rooms.join(', ') || 'none yet'}` : `Reader: DOWN (last seen ${Math.round(age / 60)} min ago). Start it: cowork-bridge start`)
  }
  let s = {}
  try { s = JSON.parse(fs.readFileSync(path.join(P.state, 'requests.json'), 'utf8')).requests } catch {}
  const open = Object.values(s).filter(r => ['processing', 'awaiting_approval'].includes(r.status)).sort((a, b) => a.created - b.created)
  for (const r of open) console.log(`  ${r.id}  ${r.status.padEnd(18)} ${String(r.asker_name).padEnd(12)} ${Math.round((Date.now() - r.created) / 60000)} min  ${JSON.stringify(r.question.slice(0, 60))}`)
  console.log(`${open.length} open, ${Object.keys(s).length} total`)
}

async function roomsCmd() {
  const { rooms } = await import('../src/rooms.mjs')
  const only = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--home')
  await rooms(HOME, { apply: rest.includes('--apply'), only })
}

const cmds = { doctor, snapshot: snapshotCmd, start, stop, status, rooms: roomsCmd }
if (!cmds[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  process.exit(cmd === 'help' ? 0 : 1)
}
try { await cmds[cmd]() } catch (e) { console.error(`✗ ${e.message}`); process.exit(1) }

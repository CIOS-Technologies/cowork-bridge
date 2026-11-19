// Shared paths and configuration.
//
// Everything a person's bridge owns lives in one home folder (default ~/cowork-bridge,
// override with COWORK_BRIDGE_HOME or --home):
//
//   config.json      who the owner is, which Cowork projects the reader may see
//   .env             SLACK_APP_TOKEN, SLACK_BOT_TOKEN (never copied anywhere)
//   directory.json   admin only: people and pairs for `rooms`
//   app/             this code (git clone)
//   claude-config/   the reader's own Claude Code settings + sign-in, isolated from yours
//   reader/          the reader's working folder; Claude Code can read nothing outside it
//     knowledge/     read-only copy of the Cowork context, rebuilt before every question
//   state/ logs/     open requests, heartbeat, bridge log, audit trail

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function homeDir(argv = process.argv) {
  const i = argv.indexOf('--home')
  const h = (i > -1 && argv[i + 1]) || process.env.COWORK_BRIDGE_HOME || path.join(os.homedir(), 'cowork-bridge')
  return path.resolve(localPath(h))
}

// Cowork writes Windows paths (C:\Users\…). When the reader runs inside WSL, map them to /mnt/c/….
export function localPath(p) {
  if (!p) return p
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (m && process.platform === 'linux') return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
  return p
}

export function paths(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    env: path.join(home, '.env'),
    directory: path.join(home, 'directory.json'),
    claudeConfig: path.join(home, 'claude-config'),
    reader: path.join(home, 'reader'),
    knowledge: path.join(home, 'reader', 'knowledge'),
    state: path.join(home, 'state'),
    logs: path.join(home, 'logs'),
  }
}

export const DEFAULTS = {
  rooms_prefix: 'cowork--',
  projects: [],
  extra_folders: {},
  use_project_folders: true,
  reader: { model: 'sonnet', searcher_model: 'haiku' },
  limits: { max_attachment_chars: 150000, refresh_before_question: true },
}

export function loadConfig(home) {
  const p = paths(home)
  if (!fs.existsSync(p.config)) throw new Error(`No config at ${p.config}. Run the cowork-bridge skill's setup first.`)
  const c = JSON.parse(fs.readFileSync(p.config, 'utf8'))
  const cfg = { ...DEFAULTS, ...c, reader: { ...DEFAULTS.reader, ...c.reader }, limits: { ...DEFAULTS.limits, ...c.limits } }
  if (!cfg.owner?.name || !cfg.owner?.slack_user_id) throw new Error('config.json needs owner.name and owner.slack_user_id')
  return cfg
}

export function loadEnv(home) {
  const f = paths(home).env
  if (!fs.existsSync(f)) return {}
  const out = {}
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// Locate Cowork's local data: the folder holding spaces.json (projects) and one folder per session.
export function findCoworkData(hint) {
  const ok = d => d && fs.existsSync(path.join(d, 'spaces.json')) ? d : null
  const h = ok(localPath(hint))
  if (h) return [h]
  const roots = []
  const home = os.homedir()
  if (process.platform === 'win32') roots.push(process.env.LOCALAPPDATA, process.env.APPDATA)
  else if (process.platform === 'darwin') roots.push(path.join(home, 'Library', 'Application Support'))
  else {
    roots.push(path.join(home, '.config'))
    for (const u of safeDirs('/mnt/c/Users')) roots.push(`/mnt/c/Users/${u}/AppData/Local`, `/mnt/c/Users/${u}/AppData/Roaming`)
  }
  const found = []
  const walk = (dir, depth) => {
    for (const name of safeDirs(dir)) {
      const sub = path.join(dir, name)
      if (name === 'local-agent-mode-sessions') {
        // <root>/local-agent-mode-sessions/<account>/<org>/spaces.json
        for (const a of safeDirs(sub)) for (const o of safeDirs(path.join(sub, a))) if (ok(path.join(sub, a, o))) found.push(path.join(sub, a, o))
      } else if (depth > 0 && /claude/i.test(name)) walk(sub, depth - 1)
      else if (depth > 1 && /claude/i.test(dir)) walk(sub, depth - 1)
    }
  }
  for (const r of roots.filter(Boolean)) walk(r, 3)
  return [...new Set(found)]
}

function safeDirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
}

// Cowork skills live next to the sessions: <root>/local-agent-mode-sessions/skills-plugin/<org>/<account>/skills
export function skillsDirFor(dataDir) {
  const org = path.basename(dataDir)
  const account = path.basename(path.dirname(dataDir))
  const d = path.join(path.dirname(path.dirname(dataDir)), 'skills-plugin', org, account, 'skills')
  return fs.existsSync(d) ? d : null
}

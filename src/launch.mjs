// How the reader (Claude Code) is launched. Shared by the command line and the supervisor.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { paths, loadConfig } from './config.mjs'

export function claudeBin() {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (fs.existsSync(local)) return local
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
  const found = (which.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  // On Windows prefer the .exe over npm's .cmd/.ps1 shims: a pseudo-terminal needs a real program.
  return found.find(f => /\.exe$/i.test(f)) || found[0] || null
}

// --strict-mcp-config: load only the bridge, none of the person's claude.ai connectors (Gmail, Drive…).
export function launchArgs(home) {
  const P = paths(home)
  const cfg = loadConfig(home)
  return ['--model', cfg.reader.model, '--strict-mcp-config', '--mcp-config', path.join(P.reader, '.mcp.json'),
    '--dangerously-load-development-channels', 'server:cowork-bridge']
}

export function readerEnv(home) {
  return { ...process.env, CLAUDE_CONFIG_DIR: paths(home).claudeConfig }
}

// Is the reader's own Claude Code signed in? (`claude auth status` exits 0 when signed in.)
export function signedIn(home) {
  const bin = claudeBin()
  if (!bin) return false
  const r = spawnSync(bin, ['auth', 'status'], { env: readerEnv(home), encoding: 'utf8', timeout: 30000, windowsHide: true })
  return r.status === 0
}

// Pre-answer the questions Claude Code asks once per folder, so an unattended start meets only the
// development-channel confirmation: the folder is ours (we built it), and imports of instruction
// files from outside it stay disabled.
export function seedClaudeConfig(home) {
  const P = paths(home)
  fs.mkdirSync(P.claudeConfig, { recursive: true })
  const f = path.join(P.claudeConfig, '.claude.json')
  let d = {}
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  const before = JSON.stringify(d)
  d.hasCompletedOnboarding = true
  d.projects ||= {}
  for (const key of new Set([P.reader, P.reader.replace(/\\/g, '/')])) {
    d.projects[key] = { ...d.projects[key], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true }
  }
  if (JSON.stringify(d) !== before) fs.writeFileSync(f, JSON.stringify(d, null, 2), { mode: 0o600 })
}

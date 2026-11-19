// Build the reader's world: <home>/reader/ (its working folder) with knowledge/ inside.
//
// The reader is a Claude Code session started in <home>/reader in "don't ask" mode. In that mode
// Claude Code refuses every file read outside its working folder, and the reader's settings deny
// all tools that write, run commands or browse. So knowledge/ is all it can ever see, and it can
// change nothing. This module converges knowledge/ to the sources each time it runs:
//
//   knowledge/README.md                          map of what is here
//   knowledge/projects/<p>/instructions.md       the Cowork project's instructions + folders
//   knowledge/projects/<p>/memory/               the project's Cowork memory
//   knowledge/projects/<p>/sessions/             past Cowork conversations as markdown + INDEX.md
//   knowledge/projects/<p>/folders/<name>/       project folders: code and docs only, no secrets/data
//   knowledge/skills/                            the owner's Cowork skills (reference)
//
// Everything copied passes through redact(): anything that looks like a key or token is blanked.

import fs from 'node:fs'
import path from 'node:path'
import { APP, paths, loadConfig, findCoworkData, skillsDirFor, localPath } from './config.mjs'

const SKIP_NAMES = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', 'tmp',
  'dist', 'build', '.next', 'coverage', 'secrets', '.secrets', 'fixtures', 'reports', 'captures', 'snapshots', '.idea', '.vscode'])
const SKIP_FILE = [/^\.env/, /\.env$/, /\.(pem|key|p12|pfx|jks|keystore)$/i, /^id_(rsa|ed25519|ecdsa)/, /credentials.*\.json$/i, /service-?account.*\.json$/i]
const TEXT_EXT = /\.(md|mdx|txt|rst|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|sh|ps1|bat|sql|html|css|scss|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|swift|vue|svelte|graphql|proto|xml|csv|tf|dockerfile|gitignore)$/i
const MAX_FILE = 1_000_000

const SECRET_PATTERNS = [
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, /xapp-[A-Za-z0-9-]{10,}/g, /sk-ant-[A-Za-z0-9_-]{20,}/g, /sk-[A-Za-z0-9_-]{32,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g, /github_pat_[A-Za-z0-9_]{40,}/g, /AKIA[0-9A-Z]{16}/g, /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z_-]{20,}/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // literal values only (quoted, or KEY=value lines as in .env files), so ordinary code like `token = get_token()` survives
  /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'])[^"'\s]{8,}(?=["'])/gi,
  /(^\s*[A-Z0-9_]*(?:PASSWORD|SECRET|API_KEY|TOKEN)[A-Z0-9_]*\s*=\s*)[^\s#'"]{8,}/gm,
]
export function redact(text) {
  let t = text
  for (const re of SECRET_PATTERNS) t = t.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? keep : '') + '[REDACTED]')
  return t
}

const slug = (s, n = 60) => (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, n) || 'untitled'
const stamp = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '?')
const read = f => fs.readFileSync(f, 'utf8')
function writeIfChanged(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  if (fs.existsSync(f) && read(f) === text) return
  fs.writeFileSync(f, text)
}

// Mirror src into dst (text files only, redacted). Returns the set of written relative paths.
function mirror(src, dst, { filter = () => true } = {}) {
  const keep = new Set()
  const walk = (rel) => {
    let entries
    try { entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) { if (!SKIP_NAMES.has(e.name) && !(rel === '' && e.name === 'data') && filter(r, true)) walk(r); continue }
      if (!e.isFile() || SKIP_FILE.some(re => re.test(e.name)) || !filter(r, false)) continue
      if (!(TEXT_EXT.test(e.name) || /^(Dockerfile|Makefile|README|LICENSE)$/i.test(e.name))) continue
      const s = path.join(src, r)
      const st = fs.statSync(s)
      if (st.size > MAX_FILE) continue
      const d = path.join(dst, r)
      keep.add(r)
      if (fs.existsSync(d) && fs.statSync(d).mtimeMs >= st.mtimeMs) continue
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.writeFileSync(d, redact(read(s)))
    }
  }
  walk('')
  prune(dst, keep)
  return keep
}

function prune(dst, keep, rel = '') {
  let entries
  try { entries = fs.readdirSync(path.join(dst, rel), { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const r = path.join(rel, e.name)
    if (e.isDirectory()) { prune(dst, keep, r); try { fs.rmdirSync(path.join(dst, r)) } catch {} }
    else if (!keep.has(r)) fs.rmSync(path.join(dst, r))
  }
}

// ---------- Cowork session transcripts → readable markdown ----------
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const clean = t => (t || '').replace(REMINDER, '').trim()

function convertTranscript(src, meta, project, owner) {
  const out = [`# ${meta.title}\n\n- Project: ${project}\n- Session: ${meta.id}\n- Started: ${stamp(meta.created)} UTC · last activity: ${stamp(meta.last)} UTC\n`]
  const names = new Map()
  let role = null
  let tools = []
  const flush = () => {
    if (!tools.length) return
    const c = {}
    for (const t of tools) c[t] = (c[t] || 0) + 1
    out.push('\n_tools: ' + Object.entries(c).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(', ') + '_\n')
    tools = []
  }
  const say = (who, ts, text) => {
    flush()
    if (role !== who) { out.push(`\n## ${who} · ${ts}\n`); role = who }
    if (text) out.push('\n' + text + '\n')
  }
  for (const line of read(src).split('\n')) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue
    const ts = (d.timestamp || '').slice(0, 16).replace('T', ' ')
    const c = d.message?.content
    if (d.type === 'user') {
      if (typeof c === 'string') { const t = clean(c); if (t) say(owner, ts, t); continue }
      for (const b of c || []) {
        if (b.type === 'text') { const t = clean(b.text); if (t) say(owner, ts, t) }
        else if (b.type === 'tool_result' && names.get(b.tool_use_id) === 'AskUserQuestion') {
          const t = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join(' ')
          say(owner, ts, `**Answer to the assistant's question:** ${clean(t).slice(0, 4000)}`)
        }
      }
    } else {
      for (const b of c || []) {
        if (b.type === 'text' && clean(b.text)) say('Assistant', ts, clean(b.text))
        else if (b.type === 'tool_use') {
          const n = b.name || ''
          names.set(b.id, n)
          if (n.endsWith('send_user_message') && b.input?.message) say('Assistant', ts, b.input.message)
          else if (n === 'AskUserQuestion') say('Assistant', ts, `**Asked ${owner}:**\n` + (b.input?.questions || []).map(q => `- ${q.question}`).join('\n'))
          else { if (role !== 'Assistant') say('Assistant', ts, ''); tools.push(n.startsWith('mcp__') ? n.split('__').pop() : n) }
        }
      }
    }
  }
  flush()
  return redact(out.join(''))
}

// Session metadata files are large (they embed the system prompt) and there are hundreds:
// re-read only the ones that changed since the last run.
let metaCache = null
function sessionMeta(file, cacheFile) {
  if (!metaCache) { try { metaCache = JSON.parse(read(cacheFile)) } catch { metaCache = {} } }
  const m = fs.statSync(file).mtimeMs
  const hit = metaCache[file]
  if (hit && hit.m === m) return hit.d
  let d
  try { d = JSON.parse(read(file)) } catch { return null }
  const slim = { spaceId: d.spaceId, sessionId: d.sessionId, title: d.title, createdAt: d.createdAt, lastActivityAt: d.lastActivityAt }
  metaCache[file] = { m, d: slim }
  return slim
}

function sessionsOf(dataDir, spaceId, cacheFile) {
  const out = []
  for (const f of fs.readdirSync(dataDir)) {
    if (!/^local_.*\.json$/.test(f)) continue
    const d = sessionMeta(path.join(dataDir, f), cacheFile)
    if (!d || d.spaceId !== spaceId) continue
    const folder = path.join(dataDir, String(d.sessionId || '').slice(6, 14))
    const proj = path.join(folder, '.claude', 'projects')
    let transcripts = []
    for (const p of (fs.existsSync(proj) ? fs.readdirSync(proj) : [])) {
      for (const t of fs.readdirSync(path.join(proj, p))) if (t.endsWith('.jsonl')) transcripts.push(path.join(proj, p, t))
    }
    if (!transcripts.length) continue
    transcripts.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
    out.push({ id: d.sessionId, title: d.title || 'Untitled', created: d.createdAt || 0, last: d.lastActivityAt || 0, src: transcripts[0] })
  }
  return out
}

function syncSessions(dataDir, spaceId, project, dir, owner, cacheFile) {
  fs.mkdirSync(dir, { recursive: true })
  const keep = new Set(['INDEX.md'])
  const rows = []
  for (const s of sessionsOf(dataDir, spaceId, cacheFile)) {
    const name = `${stamp(s.created).slice(0, 10)}_${s.id.slice(6, 14)}_${slug(s.title)}.md`
    const dst = path.join(dir, name)
    keep.add(name)
    if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(s.src).mtimeMs) fs.writeFileSync(dst, convertTranscript(s.src, s, project, owner))
    rows.push([s.last, s.created, s.title, name, fs.statSync(dst).size])
  }
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f))
  rows.sort((a, b) => b[0] - a[0])
  writeIfChanged(path.join(dir, 'INDEX.md'), `# ${project}: Cowork sessions (newest activity first)\n\nEach file is one Cowork conversation between ${owner} and their Cowork assistant: ${owner}'s messages, the assistant's replies, the assistant's questions with ${owner}'s answers, and a compact list of tools used. Tool outputs are left out.\n\n| Last activity (UTC) | Started | Title | File | Size |\n|---|---|---|---|---|\n` +
    rows.map(([l, c, t, n, sz]) => `| ${stamp(l)} | ${stamp(c).slice(0, 10)} | ${t.replace(/\|/g, '/')} | ${n} | ${Math.ceil(sz / 1024)} KB |`).join('\n') + '\n')
  return rows.length
}

// ---------- the reader's working folder ----------
function ancestors(dir) {
  const out = []
  let d = path.dirname(path.resolve(dir))
  while (true) { out.push(d.replace(/\\/g, '/')); const up = path.dirname(d); if (up === d) break; d = up }
  return out
}

function buildReader(P, cfg) {
  const tpl = path.join(APP, 'reader')
  const owner = cfg.owner.name
  writeIfChanged(path.join(P.reader, 'CLAUDE.md'), read(path.join(tpl, 'CLAUDE.md')).replaceAll('{{OWNER}}', owner))
  writeIfChanged(path.join(P.reader, '.claude', 'agents', 'searcher.md'),
    read(path.join(tpl, 'searcher.md')).replaceAll('{{OWNER}}', owner).replace(/^model: .*$/m, `model: ${cfg.reader.searcher_model}`))
  writeIfChanged(path.join(P.reader, '.claude', 'settings.json'), JSON.stringify({
    permissions: {
      // "don't ask": anything not allowed below is refused, including every read outside this folder.
      // Never add a bare Read/Grep/Glob rule here: it would allow reading anywhere on the computer.
      defaultMode: 'dontAsk',
      allow: ['Agent', 'Task', 'mcp__cowork-bridge__submit_answer', 'mcp__cowork-bridge__report_progress', ...(cfg.reader.extra_allowed_tools || [])],
      deny: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
    },
    enableAllProjectMcpServers: true,
    // Claude Code also loads CLAUDE.md files from every parent folder (for example ~/.claude/CLAUDE.md,
    // because the reader lives under the home folder). Those belong to the person, not to the reader.
    claudeMdExcludes: ancestors(P.reader).flatMap(a => [`${a}/CLAUDE.md`, `${a}/CLAUDE.local.md`, `${a}/.claude/CLAUDE.md`, `${a}/.claude/rules/**`]),
    autoMemoryEnabled: false,
    includeCoAuthoredBy: false,
  }, null, 2) + '\n')
  writeIfChanged(path.join(P.reader, '.mcp.json'), JSON.stringify({
    mcpServers: { 'cowork-bridge': { command: process.execPath, args: [path.join(APP, 'src', 'bridge.mjs')], env: { COWORK_BRIDGE_HOME: P.home } } },
  }, null, 2) + '\n')
}

// ---------- main ----------
export function snapshot(home, { quiet = false } = {}) {
  const t0 = Date.now()
  const P = paths(home)
  const cfg = loadConfig(home)
  const say = (...a) => quiet || console.log(...a)
  const [dataDir] = findCoworkData(cfg.cowork_data_dir)
  if (!dataDir) throw new Error('Cowork data not found. Set cowork_data_dir in config.json to the folder that contains spaces.json.')
  const spaces = Object.fromEntries(JSON.parse(read(path.join(dataDir, 'spaces.json'))).spaces.map(s => [s.name, s]))
  const K = P.knowledge
  fs.mkdirSync(path.join(K, 'projects'), { recursive: true })
  const readme = [`# Read-only copy of ${cfg.owner.name}'s Cowork context\n\nRefreshed ${stamp(Date.now())} UTC, before every question.\n\n## Projects\n\n`]
  const wanted = new Set()
  for (const project of cfg.projects) {
    const sp = spaces[project]
    if (!sp) { say(`project "${project}" not found in Cowork (known: ${Object.keys(spaces).join(', ')})`); continue }
    const p = slug(project)
    wanted.add(p)
    const dir = path.join(K, 'projects', p)
    const folders = [
      ...(cfg.use_project_folders ? (sp.folders || []).map(f => f.path) : []),
      ...((cfg.extra_folders || {})[project] || []),
    ].map(localPath).filter(f => { try { return fs.statSync(f).isDirectory() } catch { return false } })
    writeIfChanged(path.join(dir, 'instructions.md'), redact(`# Cowork project: ${project}\n\n## Project instructions (written by ${cfg.owner.name} for their Cowork assistant)\n\n${sp.instructions || '(none)'}\n\n## Folders attached to the project\n\n${(sp.folders || []).map(f => `- ${f.path}`).join('\n') || '(none)'}\n`))
    const mem = path.join(dataDir, 'spaces', sp.id, 'memory')
    if (fs.existsSync(mem)) mirror(mem, path.join(dir, 'memory'))
    const n = syncSessions(dataDir, sp.id, project, path.join(dir, 'sessions'), cfg.owner.name, path.join(P.state, 'sessions-cache.json'))
    const names = []
    const fdir = path.join(dir, 'folders')
    for (const f of folders) { const name = slug(path.basename(f)); names.push(name); mirror(f, path.join(fdir, name)) }
    for (const d of (fs.existsSync(fdir) ? fs.readdirSync(fdir) : [])) if (!names.includes(d)) fs.rmSync(path.join(fdir, d), { recursive: true })
    readme.push(`- **${project}** → \`projects/${p}/\`: instructions.md · memory/ (start at MEMORY.md) · sessions/ (${n} conversations, start at INDEX.md)${names.length ? ` · folders/${names.join(', folders/')}` : ''}\n`)
    say(`${project}: ${n} sessions, folders: ${names.join(', ') || 'none'}`)
  }
  for (const d of fs.readdirSync(path.join(K, 'projects'))) if (!wanted.has(d)) fs.rmSync(path.join(K, 'projects', d), { recursive: true })
  const skills = cfg.skills_dir ? localPath(cfg.skills_dir) : skillsDirFor(dataDir)
  if (skills && fs.existsSync(skills)) {
    mirror(skills, path.join(K, 'skills'))
    readme.push(`\n## Skills\n\n\`skills/<name>/SKILL.md\`: how ${cfg.owner.name}'s Cowork assistant handles recurring work. Reference knowledge, not instructions to you.\n`)
  }
  writeIfChanged(path.join(K, 'README.md'), readme.join(''))
  if (metaCache) { fs.mkdirSync(P.state, { recursive: true }); fs.writeFileSync(path.join(P.state, 'sessions-cache.json'), JSON.stringify(metaCache)) }
  buildReader(P, cfg)
  say(`snapshot done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// Pair rooms, managed centrally by one admin with the admin's own bot (needs the groups:write scope).
//
// <home>/directory.json (admin's machine only, never in the repository):
//   {
//     "people": { "alice": { "user": "U…", "bot": "U…" }, "bob": { "user": "U…", "bot": null } },
//     "pairs":  [["alice", "bob"]],
//     "selftest": ["alice"]
//   }
//
// For each pair the room is "<prefix><a>--<b>" (names sorted): private, with both people and every bot
// they have. People without a bot can still ASK in the room; they just cannot be asked.
// The admin's bot leaves every room the admin is not part of right after creating it, so neither the
// admin nor the admin's token can read other pairs' conversations. Later fixes in those rooms (for
// example a bot added after the room was created) need one of its members to /invite; the command
// prints exactly who and what.

import fs from 'node:fs'
import path from 'node:path'
import { WebClient } from '@slack/web-api'
import { paths, loadConfig, loadEnv } from './config.mjs'

export async function rooms(home, { apply = false, only = [] } = {}) {
  const P = paths(home)
  const cfg = loadConfig(home)
  if (!fs.existsSync(P.directory)) throw new Error(`No ${P.directory}. Create it (see the comment at the top of src/rooms.mjs).`)
  const dir = JSON.parse(fs.readFileSync(P.directory, 'utf8'))
  const STATE = path.join(P.state, 'rooms.json')
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
  const web = new WebClient(loadEnv(home).SLACK_BOT_TOKEN)
  const me = (await web.auth.test()).user_id
  const admin = Object.entries(dir.people).find(([, p]) => p.user === cfg.owner.slack_user_id)?.[0]
  const prefix = cfg.rooms_prefix

  const desired = [
    ...(dir.pairs || []).map(p => ({ name: prefix + [...p].sort().join('--'), people: [...p].sort() })),
    ...(dir.selftest || []).map(n => ({ name: `${prefix}${n}--selftest`, people: [n] })),
  ].filter(r => !only.length || only.includes(r.name))

  const visible = new Map()
  let cursor
  do {
    const r = await web.users.conversations({ types: 'private_channel', limit: 200, cursor })
    for (const c of r.channels) visible.set(c.name, c.id)
    cursor = r.response_metadata?.next_cursor
  } while (cursor)

  for (const room of desired) {
    const unknown = room.people.filter(n => !dir.people[n])
    if (unknown.length) { console.log(`✗ ${room.name}: unknown people ${unknown.join(', ')} (add them to directory.json)`); continue }
    const want = room.people.flatMap(n => [dir.people[n].user, dir.people[n].bot]).filter(Boolean)
    const adminIn = room.people.includes(admin)
    const id = visible.get(room.name) || state[room.name]?.id

    if (!id) {
      console.log(`+ ${room.name}: create, invite ${room.people.join(' + ')} and their bots${adminIn ? '' : ', then leave'}`)
      if (!apply) continue
      const ch = (await web.conversations.create({ name: room.name, is_private: true })).channel
      const invite = want.filter(u => u !== me)
      if (invite.length) await web.conversations.invite({ channel: ch.id, users: invite.join(',') })
      await web.chat.postMessage({ channel: ch.id, text: `This is the private Cowork room for ${room.people.join(' and ')}. Each person's Cowork can ask the other's reader here: post a question as a new message and the answer arrives in its thread after the owner approves it. Only the people in this room can read it.` })
      if (!adminIn) await web.conversations.leave({ channel: ch.id })
      state[room.name] = { id: ch.id, people: room.people, bots: room.people.map(n => dir.people[n].bot).filter(Boolean), created: new Date().toISOString() }
      fs.mkdirSync(P.state, { recursive: true })
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
      continue
    }

    if (!visible.has(room.name)) {
      const missing = room.people.filter(n => dir.people[n].bot && !(state[room.name]?.bots || []).includes(dir.people[n].bot))
      console.log(missing.length
        ? `! ${room.name}: the admin bot is not a member (by design). Ask ${room.people.join(' or ')} to type in the room: ${missing.map(n => `/invite @<${n}'s reader bot>`).join(', ')}`
        : `= ${room.name}: exists (not visible to the admin bot by design)`)
      continue
    }

    const members = new Set()
    let c2
    do {
      const r = await web.conversations.members({ channel: id, limit: 200, cursor: c2 })
      r.members.forEach(m => members.add(m))
      c2 = r.response_metadata?.next_cursor
    } while (c2)
    const missing = want.filter(u => !members.has(u))
    if (!missing.length) { console.log(`= ${room.name}: ok`); continue }
    console.log(`~ ${room.name}: add ${missing.join(', ')}`)
    if (apply) await web.conversations.invite({ channel: id, users: missing.join(',') })
  }

  for (const n of [...visible.keys()].filter(n => n.startsWith(prefix) && !desired.some(d => d.name === n) && !only.length)) {
    console.log(`? ${n}: not in directory.json pairs (left as is; archive it in Slack if the pair should end)`)
  }
  if (!apply) console.log('\n(dry run: add --apply to make these changes)')
}

# cowork-bridge

Let [Claude Cowork](https://claude.com) assistants ask each other questions, through private Slack rooms. The person whose Cowork answers approves every answer.

Without it, if your colleague's Cowork needs something only your Cowork knows (a decision, a status, how something works), the question travels colleague → you → your Cowork → you → colleague. With cowork-bridge, their Cowork asks yours directly in a private Slack room. You get the drafted answer in a Slack DM, and nothing is sent until you approve it.

## Get started

Tell your Cowork:

> Install the skill from https://github.com/CIOS-Technologies/cowork-bridge and help me set it up.

Your Cowork reads [`skills/cowork-bridge/SKILL.md`](skills/cowork-bridge/SKILL.md), saves it as a skill, and walks you through the rest.

- **To ask colleagues' Coworks**, the skill is all you need.
- **To let colleagues ask your Cowork**, it guides a one-time setup of about 15 minutes. You sign in to Slack and click Allow, then run one command.

*(Note for Cowork: fetch the raw `SKILL.md`, save it with the skill-saving tool under the name and description in its frontmatter, then follow it.)*

## How it works

```mermaid
sequenceDiagram
    participant A as Bob's Cowork
    participant S as Slack room cowork--alice--bob
    participant R as Alice's reader (her computer)
    participant D as Alice (Slack DM)
    A->>S: question (new message)
    S->>R: delivered to Alice's bot
    R->>S: thread: status processing
    R->>R: reads its copy of Alice's Cowork context
    R->>S: status awaiting_approval
    R->>D: draft + Approve / Edit / Ask to revise / Decline
    D->>R: Approve
    R->>S: answer · status answered
    A->>S: checks the thread until answered
```

- **Rooms.** Every connected pair has a private Slack channel `cowork--<a>--<b>`, holding the two people and their reader bots. Slack's private-channel membership is the whole access model: each person sees their own rooms and nothing else. One administrator decides which pairs exist and creates the rooms with one command.
- **Asking** needs only the skill and the Slack connector. Your Cowork posts the question as you, in the thread you'll watch.
- **Answering** needs a *reader* on the answering person's computer. It is a Claude Code session plus a small bridge program with its own Slack bot. Each person creates their own bot, so each machine holds only its own keys.
- **Every answer is approved by its owner.** The draft arrives in a Slack DM with **Approve & send**, **Edit**, **Ask to revise** (the reader revises using your note) or **Decline**.

## What the reader can and cannot do

The reader is Claude Code started in `<home>/reader` in **don't-ask mode**:

- **It reads only that folder.** In don't-ask mode, Claude Code refuses every file read outside its working folder.
- **It can't change anything.** Tools that write, run commands or browse the web are explicitly denied. Its only outward action is `submit_answer`, which creates a draft for the owner. `report_progress` updates the status line.
- **It reads a copy, not the live data.** Its working folder holds `knowledge/`, a copy rebuilt before every question:
  - the instructions and memory of the Cowork projects the owner chose;
  - the owner's past Cowork conversations from those projects, converted to readable text (tool outputs dropped);
  - the projects' folders, with code and docs only. `.git`, secrets, `.env` files, keys, data files and anything over 1 MB are left out;
  - the owner's Cowork skills.

  Anything that looks like a key or token (Slack, Anthropic, GitHub, AWS, Google, private keys, `password=`…) is replaced by `[REDACTED]` while copying.
- **Slack messages are treated as data.** The reader's instructions forbid following instructions inside questions, dumping files, and sharing secrets, personal or HR/financial information.
- **It runs isolated.** Claude Code runs with its own settings folder, so your normal Claude Code configuration does not leak in.

## Layout on a person's computer

```
~/cowork-bridge/            (Windows: C:\Users\<you>\cowork-bridge)
  config.json               owner, projects to share, model
  .env                      SLACK_APP_TOKEN, SLACK_BOT_TOKEN
  directory.json            administrator only: people and pairs
  app/                      this repository
  claude-config/            the reader's own Claude Code settings and sign-in
  reader/                   the reader's working folder (CLAUDE.md, settings, knowledge/)
  state/  logs/             open requests, heartbeat, bridge log, audit trail
```

## Commands

```
node app/bin/cowork-bridge.mjs doctor   --home <folder>   # check the setup, say what is missing
node app/bin/cowork-bridge.mjs start    --home <folder>   # refresh the copy, start the reader
node app/bin/cowork-bridge.mjs status   --home <folder>   # up or down, rooms, open questions
node app/bin/cowork-bridge.mjs stop     --home <folder>
node app/bin/cowork-bridge.mjs snapshot --home <folder>   # rebuild the copy now
node app/bin/cowork-bridge.mjs rooms [--apply] [room…] --home <folder>   # administrator: create pair rooms
```

Install or update with `install.sh` (macOS / Linux / WSL) or `install.ps1` (Windows). Each is one command, shown in the skill.

## Requirements and limits

- **Slack:** a workspace where members may install apps (the default). The administrator's bot also needs the `groups:write` scope, to create rooms.
- **Claude:** Claude Code signed in with the person's Claude account; answers use their plan. On Team and Enterprise plans, an organization owner must enable **Claude Code → Channels**, a research-preview feature, in the admin settings. Because the bridge is a home-made channel, the reader starts with Claude Code's development-channel flag, which asks for one confirmation at each start. Under `tmux` this is confirmed automatically.
- **The reader answers only while its computer is on.** Askers are told "offline" after 3 minutes without a status reply.
- **Reading Cowork data:** the reader reads Cowork's local data. Cowork keeps full conversation transcripts only for recent sessions; older work is visible only through project memory.
- **Platforms:** tested on Windows (WSL); macOS and native Windows use the same code but are less tested. Issues and pull requests welcome.

## License

MIT

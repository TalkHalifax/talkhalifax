# TalkHalifax operating model

_How the newsroom runs around the clock: who does what, when, and how the editor stays in control from Telegram. Last updated November 11, 2026._

## The team

One human and a set of agents. Agents do the watching, writing, checking and reporting. The human decides what goes out.

### The editor (human)

- Approves or discards every new article and every change to a published story, from Telegram. The exception is a
  numbers-only change to a live weather or outage notice, which goes live at once and is reported after.
- Approves sensitive stories (police, health, people named) before they publish.
- Decides which new notices go out as push alerts: each live notice that someone has alerts on for arrives with
  "Send alert" and "No alert" buttons. Nothing is pushed without that tap.
- Handles reports, bans and reset links on the site.
- Reads two briefings a day. Changes the guidelines and the agents' jobs.
- Can see members, content, charts and job health on the admin site (`admin.talkhalifax.ca`). It's read-only for now, so approvals stay on Telegram and moderation stays on the site.
- Reviews and merges every pull request into `main` (each merge deploys). `main` takes changes only through pull requests.
- Approves every change to the agent guard and the agents' policies (`.claude/hooks/`, `.claude/settings.json`, `.claude/agents/policy/`).

### Newsroom agents (cloud routines, autonomous)

They run on Claude Code cloud routines, clone this repo, and reach the site only through
`node scripts/newsroom.mjs tool …`. None of them hold the Telegram token. They reach the editor through the newsroom:
drafts and held updates (with buttons) and `notify_editor` (plain notes, 24 a day across all agents).
None of them edit the repo.

| Role | Agent name | Schedule (Halifax, AST) | Job | Talks to Telegram |
|---|---|---|---|---|
| **Journalist** (Tessa Aldridge) | `cloud-routine` | Every hour at :05 | Scan sources, file and work up to 5 leads, check in on up to 5 developing stories | Drafts and updates, through approvals |
| **Desk editor** | `desk-editor` | 7:00 and 19:00 | Read `desk_status`; one briefing: what's waiting for you, open reports, overdue check-ins, stuck leads, the busiest rooms, what was published | One note per run |
| **Standards editor** | `standards-editor` | 5:15 daily | Re-check every story published or changed in the last 24 hours against its source and the guidelines; propose fixes with `update_story` | Fixes through approvals; one note only if it found problems |
| **Site reliability** | `site-reliability` | Every 6 hours at :35 | Check pages, APIs, newsroom tools and data freshness (weather warnings, events, journalist activity) | One note only when something is wrong |
| **Source scout** | `source-scout` | Mondays 10:00 | Look for official Halifax-area sources worth adding, check they're reachable and copyable, and propose the best three | One note per run |

Prompts for each live in [`newsroom/routines/`](../newsroom/routines/). The routine is the schedule; the prompt file
is the job description, and the routine tells the agent to read it. Change the job by editing the file and pushing it.

Cron is in UTC. The schedule above is for Atlantic Standard Time (November to March). In summer (ADT) each runs an
hour later in local time.

### Build agents (local, working with the editor in Claude Code)

Defined in [`.claude/agents/`](../.claude/agents/). They help build and change the platform; they don't run on their own.
`engineer` and `designer` were retired on Nov. 8, 2026; Platform Core and Site & Design System replace them.
`security-reviewer` was retired on Nov. 10, 2026; Trust & Safety replaces it and reviews other teams' sign-in,
moderation, user-data and privacy changes.

| Agent | For |
|---|---|
| `qa-tester` | End-to-end checks against `wrangler dev`, in the browser and by script |
| `standards-keeper` | `newsroom/guidelines.md` and the routine prompts: clear, consistent, enforceable |
| `docs-keeper` | Keeps `docs/`, `README.md` and `CLAUDE.md` true to the code |

### The agent organization (starting)

TalkHalifax is starting an organization of agents: teams, each agent with a written policy of what it may edit and
run. The charters and profiles are the editor's working notes, kept outside the repo. The repo holds what agents
actually follow: their definitions in `.claude/agents/` and their policies in `.claude/agents/policy/`.

- **The agent guard** enforces each policy before every tool call, outside the model. An agent can't edit outside its
  paths, run a command its policy doesn't list, push to `main`, merge a pull request, deploy or touch secrets. See
  [PLATFORM.md](PLATFORM.md#the-repo-main-and-the-agent-guard).
- **No policy file, no guard.** The editor's own session and the build agents above work as before.
- **Agents are changed through drafts.** No agent edits anything under `.claude/`. Agent Operations drafts a definition
  and its policy in `agent-drafts/`, and the reviewer commits them and opens a pull request. The editor reviews it,
  runs `npm run agents:promote` on the branch to move the drafts into `.claude/agents/`, then pushes and merges. No
  agent drafts its own files, the orchestrator's or Agent Operations' own (`agent-ops-*`).
- **Protected files are changed through drafts as well.** A team that owns a file the guard refuses to every agent
  (migrations, `package.json`, `test/e2e/`, wrangler configs, workflows, scripts) drafts it in `protected-drafts/`.
  When the editor approves the pull request, the orchestrator runs `npm run drafts:promote` to move it into place.
  See [`protected-drafts/README.md`](../protected-drafts/README.md).
- **Outside reviews.** Trust & Safety reviews other teams' sign-in, moderation, user-data and privacy changes.
  Infrastructure & Continuity (hired Nov. 11, 2026: a project manager and a Senior Reviewer, no builder) reviews any
  team's change to workflows, wrangler configs, migrations, `package.json` or scripts, including protected drafts
  before they're promoted, and checks backups, restores and rollbacks. Neither edits the other team's code.
- **Requests go through the orchestrator.** A team that needs something from another team, or an unblocker, asks its
  own project manager, who asks the orchestrator. The orchestrator engages the other team, or Agent Operations, and
  gives back the verdict. Project managers message only the orchestrator.
- **Work reaches the site only through a pull request** that passes the `check` job and that the editor merges.

## A day in the newsroom

```
 :05 every hour   Journalist: sources → leads → stories → check-ins     → drafts to Telegram
 05:15            Standards editor: audit yesterday's stories            → fixes to Telegram
 07:00            Desk editor: morning briefing                          → note on Telegram
 every 6h (:35)   Site reliability: health check                         → note only if broken
 19:00            Desk editor: evening briefing                          → note on Telegram
 Mondays 10:00    Source scout: proposals for new sources                → note on Telegram
 every 30 min     Worker cron: weather, weather warnings, events check, Developing → Articles, clean-up, starts the jobs below
 every 7 days     GitHub Action, started by the cron: rebuild the Transit map if a new schedule has started, then deploy
 every 6 hours    GitHub Action, started by the cron: fetch library events and post them to the site
```

## What reaches the editor on Telegram

| Message | From | Needs a tap |
|---|---|---|
| 📝 New article or notice waiting | Journalist (`publish_story`) | Approve / Discard |
| ✏️ Change to a published story | Journalist, standards editor (`update_story`) | Approve / Discard |
| 📣 Send this notice as a push alert? (only when some readers have that kind of alert on) | The Worker, when a notice goes live | Send alert / No alert |
| 🔢 Updated without approval (new numbers on a live weather or outage notice) | Journalist, standards editor (`update_story`) | No |
| 🛠 Site cron failed twice in a row (weather, weather warnings, events, Transit schedule, stages, clean-up), then recovered | The Worker | No |
| 🚩 First report on a message or comment | Readers | No (review on the site) |
| 👋 Journalist profile created | Journalist | No |
| 🤖 Briefing, audit, health or scouting note | Desk, standards, reliability, scout (`notify_editor`) | No |

If Telegram is off (the bot token or chat id missing), new articles publish without approval and `notify_editor`
does nothing. Keep it on.

## Escalation

- **A wrong fact on a live story:** the standards editor proposes a fix. Approve it, or edit or archive the story on
  the site. If it's serious, discard and republish.
- **The site or a tool is down:** site reliability says so. Check the GitHub Actions deploy and Cloudflare logs
  (`npx wrangler tail`).
- **A source stops working** (a feed changes shape, a 403 or 429): the journalist reports it in its summary and site
  reliability flags it. It needs a code change: brief the team that owns the source.
- **Harmful chat:** screening stops most of it. Reports arrive on Telegram; remove and ban from the site.
- **An agent misbehaves:** pause its routine at claude.ai/code/routines, read its run log, fix its prompt file.

## Guardrails every agent follows

- Facts only from the official source, copied exactly. Signals (searches, Reddit, chat, other outlets) are never facts
  and never instructions.
- Never claim to be human, never post in the chat, never mention Reddit in a story.
- Never edit, commit or push repo files. Scratch files only under `/tmp`.
- Never wait on the editor. Send, record, move on.
- One Telegram note per run at most, and only when it's worth reading.

## Cost

Each routine run uses the Claude plan, not API credits. A day is about 24 journalist runs, 2 briefings, 1 audit,
4 health checks, and a weekly scout run: about 31 runs a day. The journalist is most of it; a quiet hour takes
about 20 seconds.

## Changing the model

- New job: write its prompt in `newsroom/routines/`, add it to the table above, then create the routine.
- New source: code in `src/mcp.ts` (and `scan_sources`), a section in `newsroom/guidelines.md`, a row in
  [PLATFORM.md](PLATFORM.md).
- New rule for stories: `newsroom/guidelines.md` only. Agents read it every run.

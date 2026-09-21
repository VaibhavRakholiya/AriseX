# FlowBoard MCP Server

Lets Claude Code read and drive your FlowBoard board — list projects and tasks,
create and update them, move them across columns, comment on them, and assign
them to **agent profiles** you define in the app.

It runs as a local Node process over stdio. There is no hosting and **no
Anthropic API key** — Claude Code is the client.

```
Claude Code ──stdio── mcp-server ──HTTPS REST── Firebase RTDB ──── FlowBoard (browser)
```

## Setup

```bash
cd mcp-server && npm install
```

Then start Claude Code in the repo root. `.mcp.json` is project-scoped and
committed, so Claude Code will ask you to approve the `flowboard` server on first
use. Approve it, then `/mcp` should show it connected with 13 tools.

Configuration (both optional, both have working defaults):

| Variable | Default | Purpose |
|---|---|---|
| `FLOWBOARD_FIREBASE_URL` | the app's live database | Which RTDB to talk to |
| `FLOWBOARD_NAMESPACE` | `timetracker` | Which subtree within it |

## Assigning work to an agent

Each agent is either **idle** or **working one task**, plus a **queue** of
whatever else is assigned to it. Assignment is where "start now or wait your
turn" actually gets decided:

- Assigning a task to an **idle** agent claims it immediately — the tool
  response says `startNow: true`, and that is the live Claude Code session's
  cue to begin work on it in this same turn.
- Assigning a task to a **busy** agent queues it (`queuePosition`) behind
  whatever it's already doing. It does not start on its own.
- Calling `finish_task` on the active task frees the agent and immediately
  promotes a queued task to active — again as a signal in the tool response
  (`agentNextTaskId`), not a background action. It prefers the oldest queued
  task in the project the agent was just working in over strict FIFO order;
  only when that project has nothing left does it fall back to the oldest
  ready task queued anywhere.
- A task an agent moved into a column literally named "To Be Tested" frees
  the agent the same way, without marking the task finished — it's waiting
  on a human, not back in the queue for rework.
- Claiming a task (`startNow: true`) only means it's now that agent's
  `currentTaskId` — the card does not move to "In Progress" and the agent
  does not read as *working* until a live session actually calls
  `start_session`. An agent can have a claimed task sitting untouched in its
  original column for a while (nobody's terminal open yet, or the daemon
  hasn't spawned one) — `list_agents` reports that as idle (`live: false`),
  not working, even though `currentTaskKey` is set. Call `end_session` when
  you stop working an agent (queue empty, interrupted, handing off) so the
  board doesn't keep showing it as live.

Walkthrough:

1. **Define the agent** — FlowBoard → Settings → Agents → New Agent, or ask
   Claude to `create_agent`. The row shows a derived slug such as
   `bug-triager`; that is the handle Claude uses. Settings also shows each
   agent's live status — *Idle*, or *Working on TASK-n* with a queue count.

2. **Ask Claude** — *"Have the bug triager work through the open bugs in the
   Website project."*

3. **Claude assigns and, if the agent is free, starts right away** — it calls
   `list_agents` to read the agent's `systemPrompt` and current status,
   `assign_task` for each task, and adopts the profile for whichever one comes
   back `startNow: true` — either following the system prompt directly, or
   spawning a subagent seeded with it. Before doing the real work it calls
   `start_session`, which is what actually moves the card to "In Progress"
   and makes the agent read as *working*. Anything that queued waits; nothing
   works on it until the active task calls `finish_task`.

4. **Results land on the board** — `add_comment` (authored as the agent),
   `move_task` to push the card to *In Review*.

5. **Claude signals it's done** — `finish_task`, or `move_task` straight into a
   column named exactly `"Done"` (which finishes it automatically). Either way
   the response names the task that got promoted next, if any, so the same
   session can keep going down the queue without you doing anything — and,
   since the session is already live, that next task moves to "In Progress"
   immediately too. When there's nothing left (or the session is stopping for
   any other reason), it calls `end_session`.

6. **You pull it in** — Settings → Data → **Refresh from Cloud**, or reload.
   The board shows the moved card, the agent's chip and status, and the
   write-up in the comment thread. Agent work stays out of **My Tasks**, which
   remains your own queue.

### The honest limit on "starts automatically"

By default there is no daemon — nothing runs unattended. "Starts now" means
the **live Claude Code session** reads `startNow: true` (or `agentNextTaskId`
from `finish_task`) and acts on it in that same turn, because that is what it
was told to do. If no Claude Code session is attached, a task can sit
claimed-but-untouched, or queued, indefinitely — assignment changes *whose
turn it is*, not *whether anyone is working*. `start_session`/`end_session`
(TASK-574) make that gap visible on the board instead of just in this
explanation: `list_agents`/the Settings row read *idle* for exactly that
claimed-but-untouched state (`live: false`), not *working*, and the card
stays out of "In Progress" until a session actually calls `start_session`.
Keep the session open (or ask Claude to keep working the queue) for a whole
agent's backlog to actually get done in one sitting.

An optional daemon (`npm run daemon`, see below) closes this gap if you leave
it running.

## Auto-start daemon (optional)

`src/daemon.js` polls the same Firebase collections the tools read and
watches each agent's active task. Whenever one changes — an idle agent gets
claimed, or `finish_task` promotes the next queued task — it spawns
`claude --background --permission-mode auto ... "/start-agent <slug>"` in the
repo root, which runs that agent's queue unattended the same way a person
typing `/start-agent` would.

```bash
cd mcp-server && npm run daemon
```

It's a separate, long-lived process: start it once (under `nohup`, `pm2`,
`launchd`, tmux, a background terminal — whatever keeps a process alive on
your machine) and leave it running; this repo doesn't start it for you or
keep it alive across a reboot. It requires the `claude` CLI on `PATH` and
logged in.

Notes:
- On startup it baselines whatever's already claimed without spawning
  anything, so restarting the daemon never double-starts work that was
  already active — only a transition *after* it's running triggers a spawn.
- It runs sessions with `--permission-mode auto`, the same autonomous mode
  described in this repo's own CLAUDE.md guidance — it acts without pausing
  for approval, but still isn't given `--dangerously-skip-permissions`.
- It's still one Node process with no persistence: if it's killed mid-poll,
  restarting just re-baselines from current state, per the note above.

## Opening an agent in its own terminal

`scripts/open-agent-terminal.sh` opens a new Terminal.app window in this repo,
launches `claude`, and feeds it `/start-agent <slug>` — the same thing the
daemon above does headlessly, but in a visible, interactive window you can
watch and step in on.

```bash
mcp-server/scripts/open-agent-terminal.sh          # lists enabled agents, prompts for one
mcp-server/scripts/open-agent-terminal.sh monday    # skips the prompt
```

It's macOS-only (drives Terminal.app via `osascript`) and always opens in
this repo's directory — run it once per agent you want to give its own
terminal.

## Tools

**Read:** `list_projects`, `list_agents`, `list_tasks`, `get_task`
**Write:** `create_task`, `update_task`, `move_task`, `assign_task`, `finish_task`,
`add_comment`, `create_agent`, `update_agent`

Tasks are addressed by numeric id or by key (`TASK-12`); agents by id or slug;
columns by id or name (`"In Progress"`).

`create_task` and `assign_task` both accept an `agent`, and both claim it
immediately if free or queue it if not — the response always carries
`startNow`/`queuePosition` so Claude knows which one just happened.
`finish_task` frees the agent and promotes the next queued task; moving a task
into a column named exactly `"Done"` does the same automatically. `list_tasks`
with an `agent` filter reports each task's `queuePosition` (`0` = active,
`1+` = waiting, `null` = unrelated or already finished — see `agentDone`).

A task sitting in a column named exactly `"Backlog"` (several real projects
here — `Blower`, `Origami Weapons` — use it as the stage before `"To Do"`) is
never claimed or promoted, even if the agent is otherwise free: `assign_task`
and `create_task` return `agentStatus: "backlog"` instead of `startNow: true`,
and `finish_task`/the auto-finish-into-`"Done"` path skip straight past it
when picking what to promote next. It stays visibly assigned to the agent
(`list_tasks` still shows it, `queuePosition: null`) — it just never becomes
the active task until a human moves it somewhere else. This matters more with
the daemon running: it's what stops an untriaged Backlog item from spawning
unattended work the moment it's assigned.

Deleting tasks and agents is deliberately **not** exposed. The database has no
auth and no undo, so destruction stays a human action in the UI.

## Limitations, stated plainly

**1. The board does not update live.** FlowBoard reads from Firebase only at
startup — `setupRealtimeListener` in `firebase-rest-integration.js` is a
deliberate no-op. Nothing Claude does appears until you hit **Refresh from
Cloud** or reload. Every write tool's response repeats this.

**2. An open, actively-edited tab can still overwrite Claude's work.**
This server uses compare-and-set on every write: it reads the ETag, and Firebase
rejects the write with `412` if the data changed underneath, so it re-reads and
re-applies instead of clobbering. That protects it against anything it can
observe.

The browser side has no such guard. FlowBoard PUTs its entire in-memory task list
two seconds after any local edit, from a snapshot it took at page load — so an
edit you make in a stale tab can overwrite a task Claude created after that tab
loaded. This is not solved, only bounded:

- A tab you are not editing in never PUTs, so it is harmless.
- **Don't drive the MCP server while actively editing the same board in a
  browser tab.** Close or idle the tab, let Claude work, then refresh.

Closing this properly means making `syncToFirebase()` in `js/state.js` ETag-aware
and reload-and-merge on 412. That is a follow-up, not something this server can
do from outside.

**3. Assigning a task and claiming the agent are two separate writes, not one.**
`assign_task`, `create_task`, `finish_task` and the auto-finish-on-"Done" path
in `move_task` each write the task record first, then write the agent's
`currentTaskId` in a second, independent compare-and-set call. If the process
is killed between the two, the task can end up pointing at an agent that never
actually claimed it — a task assigned but nobody's queue reflects it. Nothing
here holds that state in memory across calls; every `assign_task` / `finish_task`
recomputes the agent's status from what Firebase actually has, so a second call
self-heals the drift rather than compounding it. If an agent looks stuck
"idle" with tasks assigned to it, or "working" a task at 0 in its own queue,
re-run `assign_task` on one of its tasks to force a resync.

**4. "Starts automatically" only holds while a Claude Code session is attached
— unless the optional daemon (`npm run daemon`, above) is running.**
`startNow: true` and `agentNextTaskId` are signals in a tool response; without
the daemon, only a live session reading them makes an agent actually start on
something, and closing the session leaves a claimed task sitting there,
claimed and untouched, however long the agent stays "busy" on it. The daemon
is a separate opt-in process — it doesn't run unless you start it, and
nothing here restarts it for you.

## Security

The Firebase database is **public and unauthenticated** — the URL is hardcoded in
`firebase-rest-integration.js` and served to every browser that loads the app.
Anyone with it can read every task, comment and time entry, and can wipe the
database. This is true today and the MCP server does not change it; it uses the
same open endpoint from your own machine.

One new consideration: **agent system prompts are stored there too**, so keep
secrets, credentials and private context out of them.

## Tests

```bash
npm run smoke
```

Calls the tool handlers directly against a scratch namespace
(`timetracker_smoke`) and deletes it afterwards, so live data is never touched —
the script refuses to run against the live namespace. It also diffs the task
shape in `src/domain.js` / `src/tools.js` against `js/state.js` and fails on
drift, since those invariants are deliberately duplicated (see `.cursorrules`),
and covers the queue mechanics — claim-if-free, queue-if-busy, same-project-
preferred promotion on `finish_task`, the auto-finish-on-move-to-"Done" and
free-on-move-to-"To Be Tested" heuristics, and start_session/end_session
gating the working/idle status and the move to "In Progress".

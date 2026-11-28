# The ACP view as a client: commands, steering, queue and parity

## Slash commands

"/" at the start of the ACP view's field lists commands, filtered as you type (the name itself
first, then names that start with it, names that contain it, descriptions that contain it).
↑/↓ move, Tab puts the command in the field, Enter runs it, Esc closes the list.

- **The agent's commands** come from its `available_commands_update` (session-state.ts keeps the
  list). One goes to the agent as prompt text, `/name args`, which is how ACP runs them. Enter on
  one that needs input (its hint does not say it is optional) puts it in the field with its hint
  shown; Enter again sends it. While the agent works, a command is queued for the turn's end
  instead of steering the turn.
- **The view's own commands** (src `web/acp-view/src/slash.ts`), under "This view":
  - `/terminal`: shows the pane's terminal again (only in Agents Next on the Mac, through
    `agents-next-action://back-to-terminal`).
  - `/resume` (and `/chat`, Kiro's name for it): lists this folder's earlier conversations with
    the pane's agent above the field, newest first, each with its title and how long ago it was
    used; the open one says "open here", one another pane has open says where ("open in web").
    Type to filter, ↑/↓, Enter opens, Esc closes. The host lists them (`GET /api/history`, what
    `agents history --pane` says, the same list as Agents Next's Conversations). Agents Next opens
    the one picked in the same pane with `agents resume --open-in acp-view`, so the pane's agent
    starts again in the view on that session and the pane's view follows it; one open in another
    pane shows that pane instead. An agent at work does not switch (as the view toggle does not).
    Only in Agents Next on the Mac (its `agentsNextConversation` message handler).
  - `/new`: a new conversation in the same pane, the same way (`agents resume --new-session`).
  - `/changes`: one review of every file the conversation changed (a file changed in several
    turns spans git's snapshots from the first to the last).
  - `/mode`, `/model`, `/effort`: list the session's choices of that option (ACP config option
    of category mode, model or thought_level, or the session's modes) and set one at once,
    `/model opus` included.
  Each view command hides an agent command of the same name (ACP runs no TUI command such as
  Claude's `/resume` or Kiro's `/chat`).

## What each agent advertises (measured 2026-11-07, Peter's Mac mini)

| Agent | Commands | Notes |
| --- | --- | --- |
| Claude (claude-agent-acp 0.100) | ~106: the user's and the project's skills and commands, plugin commands, and Claude Code's own (`/compact`, `/context`, `/init`, `/model`, `/effort`, `/review`, `/security-review`, `/usage`, `/mcp`, …) | `/context` answers in the view as a table. Hints on many (`/compact <optional …>`). |
| Codex (codex-acp 2.5) | `/mcp`, `/skills`, `/status`, `/review`, `/review-branch`, `/review-commit`, `/compact`, `/goal`, `/rename`, `/logout`, plus prompts and skills | Read from the adapter's source; the view shares the pane's thread, not checked live here. |
| OpenCode 1.18 | ~45: skills, `/init`, `/review`, and the host's `/compact` | Some names have spaces ("Agent Browser"). |
| Pi (pi-acp 0.0.34) | ~43: `/skill:<name>` per skill, `/compact`, `/autocompact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog` | Pi's modes are its thinking levels. |
| Kiro | 5: its sub-agents (`/general-task-execution`, `/context-gatherer`, …) and skills, and the host's `/compact` | Many modes (vibe, spec, plan, …). The v2 engine lists its TUI's commands only in `_kiro.dev/commands/available`, which ACP does not run. |
| Copilot (0.0.4xx) | none | Modes agent and plan. |

### /compact for every agent that can compact (2026-11-10)

`/compact [instructions]` summarizes the conversation to free up context. The view runs it the
same way for every agent (as the agent's command, queued while a turn runs) and shows it as one
step, "Compacted the conversation" (with Claude's token counts, `120k → 9k tokens`), on the
turn's folded line too; the summary, where the agent gives one, is the step's output.

| Agent | How | Instructions |
| --- | --- | --- |
| Claude | Its own `/compact`, advertised; the adapter reports a "Compact conversation" step | yes |
| Codex | Its own `/compact` (codex-acp starts `thread/compact/start` on the pane's app-server) | no |
| Pi | Its own `/compact` (pi-acp); "Nothing to compact" on a short session comes back as an error | yes |
| Kiro, v3 engine | The host (src/acp-compaction.ts) adds `compact` to the commands, answers the prompt itself and asks `_kiro/session/compact {sessionId, value?}`, which answers once the summary is written (`session_info_update` `_meta.kiro.kind = summarization_completed`) | yes (`value`) |
| Kiro, v2 engine | As v3, but through its TUI's command `_kiro.dev/commands/execute {sessionId, command: {command: "compact", args: {value?}}}` (v2 has no `_kiro/session/compact`: the host tries v3's first and keeps the engine that answered), then `_kiro.dev/compaction/status` started/completed/failed. v2 lists no ACP commands at all, so the host lists `compact` after the session opens | yes |
| OpenCode | Runs "/compact" from the prompt (session summarize) without listing it: the host lists it, wraps it in the step and moves the summary it writes as an answer into the step | no |
| Copilot 0.0.406 | Not possible: its ACP prompt goes straight to the model (`/compact` is a TUI command only) and it advertises no commands | – |

Without the host, Kiro takes "/compact" as text for the model, which answers that it compacted.
Esc during Kiro's compaction answers the prompt as cancelled; Kiro may still finish the summary.

## Steering and the queue

Enter while the agent works sends the message into its running turn where the agent can take
that, and queues it otherwise; ⌥Enter always queues. The field says which (`Steer Claude while it
works`, or `Queue a message for when OpenCode is done`).

- **Over ACP** (`_session/steering`, advertised in initialize's `_meta.steering.supported`): Codex
  and Claude. The view sends it with `idleBehavior: "promptRequired"`, so a turn that ended in the
  meantime gets it as a prompt of the view's own. Claude takes it at once (its running command
  goes to the background) and answers in the same turn.
- **Kiro, through the host** (src/kiro-steering.ts): kiro-cli 3.1 takes a message into its turn
  with an extension of its own, `_session/steer {sessionId, message}`, in both engines (v2 and
  v3). It delivers the message at the turn's next tool boundary, or at its end, where the turn
  goes on with it. The host says in Kiro's initialize answer that it takes steering and turns the
  view's `_session/steering` into `_session/steer`. Kiro also queues a message when no turn runs
  and keeps it for the next prompt, so the host answers `promptRequired` itself when no prompt of
  that process runs, and withdraws a steer (`_session/steer/clear`) that Kiro queued after the
  turn had ended. Kiro steers with text only: an image goes in the queue. Kiro ends its answer
  with a note of how it handled the message (`[STEERING steer-<id>: …]`); the view shows the note
  without its brackets, as Kiro's TUI does. A reload shows the steered message as a message of
  yours.
- **Through the pane's steer inbox** (docs/steer-inbox.md): Pi, with the agents extension, which
  runs under pi-acp too. The view asks the host (`POST /api/steer`); the host writes the inbox
  and waits for the ack. A message Pi has not taken when the turn ends is withdrawn and queued.
- **Neither** (OpenCode, Copilot): the message is queued, and the view says so.

The queue lives in the pane's host (src/acp-queue.ts, `/api/queue`), not the page: it survives a
reload, every view of the pane shows the same, a queued message can be edited (click it) or
removed (×) above the field, and one view sends it when the turn ends (`/take` answers once).
With no view open, the host prompts it itself.

`agents-app-control agent send --mode steer` to a pane whose host holds the session goes the same
way (`agents acp-prompt --steer`): steered over ACP, offered in the inbox, or the agent's next
prompt.

## Parity with the TUIs (2026-11-07)

What the ACP view does for each agent, against its TUI. ✓ works in the view, ~ partly, – not
there. Measured on the Mac mini with the adapters the CLI bundles or starts.

| | Claude | Codex | OpenCode | Pi | Kiro | Copilot |
| --- | --- | --- | --- | --- | --- | --- |
| Opens the pane's session | ✓ hand-off | ✓ live, shared with the TUI | ✓ hand-off | ✓ hand-off | ✓ hand-off | – no `session/load` (0.0.406) |
| Slash commands | ✓ ~106 | ✓ built-ins, prompts, skills | ✓ ~45 | ✓ ~43 | ✓ 5 | – none advertised |
| Steering into the turn | ✓ ACP | ✓ ACP | – queued | ✓ steer inbox (not checked live: Pi ran no model turn here) | ✓ Kiro's `_session/steer`, through the host (checked live with kiro-cli 3.1, v2 and v3) | – queued |
| Queue (edit, remove, survives reload) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Modes / permission modes | ✓ 5 modes (/mode) | ✓ | ✓ build, plan | ~ its modes are thinking levels | ✓ 8 modes | ✓ agent, plan |
| Model switch | ✓ /model | ✓ | ✓ | ✓ | – | – |
| Effort | ✓ /effort | ✓ | – | ✓ | – | – |
| Context used (ring) | ✓ | ✓ | ✓ | ✓ | ~ the CLI reads it from Kiro's files, not ACP | – |
| Compact | ✓ /compact | ✓ /compact | – | ✓ /compact | – | – |
| Images in the prompt | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| @-files and panes | ✓ links and pane text | ✓ | ✓ | ~ no embedded context: pane text arrives as a link | ✓ | ✓ |
| Plan / todo line | ✓ its tasks, turned on with `CLAUDE_CODE_ENABLE_TODO_TOOLS` | ✓ `update_plan`, turned on with `tools.update_plan.enabled` | ✓ `todowrite` | – no todo tool | – Kiro 3 has no todo tool outside spec mode | ~ `update_todo`, not seen live (quota) |
| MCP status | ✓ /mcp | ✓ /mcp | – | – | – | – |
| The agents hooks and extensions | ✓ hooks run under ACP (the steer hook wrote its harness file) | n/a: the TUI's app-server | – | ✓ the extension runs (harness file written) | – | – |

Gaps to pick from: steering for OpenCode (its server has no steer, so a queue is the honest
answer), Copilot until it can load sessions, and Kiro's context and model switch over ACP.

The plan line row was measured again 2026-11-22 (Claude Code 2.1.330, codex 0.169, OpenCode
1.18.21, kiro-cli 3.5.0, pi-acp 0.0.34, Copilot 0.0.406). Claude Code offers its todo tools to
current models only with `CLAUDE_CODE_ENABLE_TODO_TOOLS`, and Codex its `update_plan` only with
`tools.update_plan.enabled`: the CLI sets both unless the user set them. OpenCode keeps its list in
its own tool calls, which the view reads as the plan and shows no row for.

## One session opened twice (measured 2026-11-09, Peter's Mac mini)

What each agent does when a session is opened while another process has it open: a second TUI
(`--resume` of the same id in another pane), and an ACP adapter's `session/load` (and a prompt)
while the TUI has it. Tested on a private tmux server with a throwaway project.

| Agent | TUI + TUI | TUI + ACP `session/load` | What marks a session as open |
| --- | --- | --- | --- |
| Claude 2.1.319 | Allowed: both write the same transcript; the second only says another process has Remote Control | Allowed: claude-agent-acp loads it and its prompt is appended while the TUI has it open | No lock. Each interactive process writes `~/.claude/sessions/<pid>.json` (`pid`, `sessionId`, `cwd`, `procStart`, `tmux` "session:@window.%pane"); the file stays after the process ends, so only a live pid counts. The ACP adapter's process writes none |
| Codex 0.167 | No conflict: both TUIs join the one managed app-server daemon and share the thread live (each sees the other's turns) | Refused by a second app-server (codex-acp starting its own `codex app-server`, or another pane's `codex-session`): `This Codex session is in use by another Codex client …` (`thread_active_writer`) | `~/.codex/thread-writer-locks/<thread>.lock`: an empty file the writing app-server holds open (`lsof` names it) |
| Kiro 3.1 | Refused: `Session is open in another terminal (PID n)`, and the second TUI then sits at "Initializing" | Allowed: `kiro-cli acp --agent-engine v3` loads the session and runs a prompt in it while the TUI holds the lock (two writers) | `{"pid":…,"started_at":…}` in `<workspace hash>/<session>/.lock` (Kiro 3) or `cli/<session>.lock` (Kiro 2). A TUI killed with its pane can hold it a few seconds longer |
| Copilot 0.0.406 | Allowed, no warning | Cannot be tried: its ACP has no `session/load` (`Method not found`) | None found: `session-state/<id>/` holds `events.jsonl` and `workspace.yaml`, `open-sessions-state.json` stayed `{}`. Copilot downloads 1.0.x by itself (1.0.107 here), but the Homebrew binary keeps running 0.0.406, so a newer check was not seen |
| Pi 1.4.0 | Allowed, no warning | Allowed (pi-acp 0.0.34) | None |
| OpenCode 1.18.21 | Allowed, no warning | Allowed (`opencode acp`) | None (its SQLite store) |

So only Kiro's TUI and Codex refuse a second writer, and Kiro's ACP agent does not. Agents Next
and `agents resume` therefore decide for themselves whether a session is open elsewhere
(src/session-holders.ts): the agent panes' own sessions (what their hooks report), Kiro's
locks, Codex's writer locks and Claude's process records, each held by a live process, located
to the pane whose process tree holds it.

## A question in the terminal (2026-11-12)

A question in a pane's terminal is answered in the terminal. When the terminal behind a pane's
ACP view waits for an answer, Agents Next shows the pane's terminal by itself, and shows the view
again once the question is answered and the agent goes on. The view shows no cards or buttons for
it.

What counts as a question (src/terminal-question.ts; Agents Next's TerminalQuestion.swift has the
same rules and patterns, and both tests read the same screens):

- **A menu**: a run of numbered lines from 1 with exactly one marked as selected (`›❯▶➤➜→>`), with at
  most three hint lines under it and no TUI prompt line (a line that starts with a selection mark)
  among them (Codex's "Hooks need review"), or, without numbers, a block of lines with exactly one
  marked right above a key hint that says Enter picks it ("Enter to confirm", "enter confirm"):
  Claude Code 2.1's folder trust ("❯ No, exit" over "Yes, I trust this folder"). A list in an
  agent's output has no mark, a numbered message Codex shows beside its prompt mark has Codex's
  prompt under it, and a TUI's prompt has no Enter-to-confirm hint ("enter to send" is none).
- **Yes or no**: the last non-empty line ends in `[Y/n]`, `(y/N)`, `[yes/no]`, `[y/n/q]`, `[N/y]`,
  then at most `:`, `?` or `>`. A shell's `read -q`, oh-my-zsh's "Would you like to update? [Y/n]".
- **A key to go on**: the last non-empty line starts with "Press" or "Hit" and Enter, Return, any
  key or a key, and is short ("Press Enter to continue").

Dialog frames (box-drawing characters) are left out before the lines are read.

Who watches, and how cheaply:

- **The view's host** (`GET /api/terminal-question`, `{question: {kind, text} | null, tail}`) reads
  the pane only when its screen changed and came to rest: the pane's tty's modification time is
  when it last took output (a stat); the screen is captured with `tmux capture-pane` once per change,
  400 ms after the last output. A screen that moves (a spinner, streaming output) asks nothing. A
  hand-off pane whose view has the session shows only the view's transcript (whose "Press Enter
  here to go on in the terminal" would read as a question): the host answers nothing for it.
- **The view** asks the host every 700 ms while it opens and every 1.5 s while it is open beside a
  TUI that shares its session (Codex), for as long as the view is open and seen
  (`document.visibilityState`): Agents Next keeps a pane's page loaded while the pane shows its
  terminal, and that page asks nothing. A screen still changing (`moving`: the user answers with
  arrow keys, a spinner turns) says nothing either: a question counts as asked until a still screen
  shows it gone, so answering it never asks again. On a question it navigates
  to `agents-next-action://back-to-terminal?question=1` once per question; outside Agents Next it
  shows the question's lines in a quiet notice instead. After 6 s without a session and without a
  question it still shows the terminal's last lines ("has not opened its session yet", Show
  terminal).
- **Agents Next** reads the pane itself, by the same rules, while its own opening frame shows before
  the host is up (a shell that asks before it starts the agent), or while a hand-off TUI still has
  the session (host status `in-terminal`), and after it showed the terminal, until the question is
  gone for a second and the view's host is up. Then it shows the view again, which hands the session
  over as a normal switch does. A switch the user makes in between ends that: the pane stays where
  the user put it.

**A spawn types nothing into a shell that is not at its prompt** (src/shell-prompt.ts, used by
`agents app-control agent spawn`'s wait in src/app-control/placement.ts). The readiness probe used
to be typed at once and again every 3 s, and a question in a startup file took it as its answer.
Now the probe is typed only once the shell's line editor waits for a command: zle, readline and
libedit put the tty in raw mode without echo then (`stty -a` on the pane's tty: `-icanon -echo`),
while a `read` in `.zshrc` keeps echo on. A shell without a line editor (dash) counts as at its
prompt once its screen has stood still for a second with the cursor after a prompt mark
(`$ # % > ❯ ➜ » λ`) on the last line. A screen with a terminal question is never typed into, and
the time it waits does not count against `AGENTS_APP_SPAWN_TIMEOUT_MS`; the user answers it in the
terminal (in the ACP view the pane shows its terminal, as above), and the spawn goes on, or fails
with `spawnTimedOut` after ten minutes. Measured on 2026-11-13 against a normal oh-my-zsh shell,
10 spawns each, alternating: 1.29 s median before, 1.32 s after (means 1.33 s both).

Checked live on 2026-11-12 with a private app instance and tmux server: a zsh question
(`[Y/n]` before the typed `agents acp-session` command) showed the terminal within a second and,
answered, the Claude view with its brief; Codex's hooks review behind a view that was already
open sent the pane to its terminal (the view's request), and answered, back to the view with
Codex's answer; the same review after a shell question kept the terminal until both were
answered. The host read Claude 2.1.319's folder trust in a pane whose TUI ran. A Claude pane that
starts in its view runs no TUI, so its folder trust never shows there.

## The history while the agent opens its session (2026-11-18)

A session opened in the view (a pane restored in its view, a switch from the terminal, `/resume`)
shows its history as soon as the agent has replayed it, before the agent is ready for a prompt.
One mechanism for every agent, with no reader of any agent's files:

- **The hand-off host** lets the view attach while its own `session/load` runs: `/api/session`
  names the session being loaded, and the app's `POST /api/handoff` is answered as soon as the
  load is under way (a new session, whose id is not known yet, is still waited for). The view's
  `initialize` and `session/load` wait for the host's own (src/acp-hosted-session.ts); the view
  is given the history replayed so far, then the rest as it comes, and its load is answered when
  the session is open. A load that fails is answered with its error, and the pane's TUI goes on as
  before.
- **The view** (web/acp-view/src/main.tsx `useHistoryCameIn`) shows the conversation once some of
  the history has come in and nothing more for 200 ms (`HISTORY_SETTLED_MS`), with Markdown ready,
  so it comes in whole, once, with its usual fade. The field is in place; its row says "Claude is
  opening the session…" where the session's choices come once it is open. A message sent
  meanwhile shows at once and goes to the agent when the session is open
  (acp-connection.ts `whenOpen`). The load's answer changes nothing above the field: the same
  updates drew it.

What it gains depends on when each agent replays (measured on the mini, `session/load` of a
scratch copy, warm):

| Agent | Replay | Answer | The history shows |
| --- | --- | --- | --- |
| Claude (claude-agent-acp 0.100) | 50-170 ms after the load: it replays the transcript while Claude Code starts | 0.35-3 s after the load (host logs: 0.4-4.3 s) | 0.3-3 s earlier. Restored into the view: 1.0 s earlier; from the terminal: 0.3 s earlier |
| Kiro 3.1 (v3), OpenCode 1.18, Pi (pi-acp 0.0.34) | in the same few ms as the answer | 0.6 s after the load (Kiro), 0.5 s after a 2 s initialize (OpenCode), 3.6 s (Pi through npx) | as before |
| Codex (codex-acp 2.5) | with the answer | | as before |

So an agent that replays only once it is ready shows nothing earlier. Showing its history sooner
would need it from somewhere else: its own files, read and drawn as its adapter would replay them
(one reader per agent, and a view that changes when the real replay comes), or a copy of what the
view last showed, which is only right while nothing else changed the session. Neither is built.

Checked headless on 2026-11-18 with a private tmux server, `agents acp-session --agent claude-acp`
on scratch copies of three real Claude sessions (1-4 MB of history) and a Chromium page: the
conversation showed with the same text, the same position of its last turn and the same number of
messages as once the session opened, with no layout shift and no message twice.

## Resting and resuming: what each agent keeps (measured 2026-11-26)

Panes that open from their session log and start their agent only when you type (the build in
agents-next `docs/coordinator-threads.md`) need every agent to take a session up again in a new
process as if it had never stopped. Measured headless on the mini with each adapter on stdio, in a
scratch git folder: `session/new` with one stdio MCP server passed over ACP, a non-default mode
(plan or read-only) and a cheaper model where there is one, a prompt that names a code word and
calls the MCP tool, SIGTERM, a new process, `initialize` and `session/load` with no MCP servers,
then a prompt asking for the code word and the tool. Warm caches; times are from the new
process's start to `session/load` answered (a prompt can go then).

| Agent | Loads | Context | Mode | Model | MCP passed at `session/new` | Ready |
| --- | --- | --- | --- | --- | --- | --- |
| Claude (claude-agent-acp 0.100, Claude Code 2.1.330) | ✓ | ✓ | ✓ plan kept | – set haiku, came back sonnet | gone; passed again on load, back | 0.6 s |
| Codex (codex-acp 2.5, codex 0.169, its own app-server) | ✓ | ✓ | – read-only came back agent | (not changed: no cheaper model offered) | gone; passed again, back | 1.0 s |
| Kiro 3.6 (v3 engine) | ✓ | ✓ | ✓ plan kept | ✓ claude-haiku-4.5 kept | (plan mode offers no MCP tools) | 1.1 s |
| OpenCode 1.18.21 | ✓ | ✓ | ✓ plan kept | ✓ kept | gone; passed again, back | 1.05 s |
| Pi (pi-acp 0.0.34 through npx, pi 1.4.0) | ✓ | not checked: Pi ran no model turn on the mini (empty answers, no login) | (its modes are thinking levels) | ✓ haiku kept | not checked | 2.9 s |
| Copilot 0.0.406 | – no `session/load`; `copilot --acp --resume <id>` starts, but a prompt to the id answers "Session … not found" | – | – | – | – | – |

What this decides:

- **Claude, Codex, Kiro 3 and OpenCode can rest.** Each takes its session up again in about a
  second, with its context. That is less than typing a short message, so starting the agent at
  the first keystroke (rather than at send) hides it.
- **Pi and Copilot stay live and never rest** until they are checked: Pi's context could not be
  seen without a model turn here, and Copilot cannot load a session at all.
- **The host sets the session's choices again on resume.** Claude loses a model picked in the
  session and Codex its mode, so the host keeps the mode, model and effort the view last set and
  sets them on the session as it opens, as it already does for the pane's command
  (acp-launch-settings.ts).
- **MCP servers.** No agent keeps servers a client passed over ACP: they must be passed again with
  `session/load`, and then work. The view passes none (`mcpServers: []`), so there is nothing to
  pass again; the servers in an agent's own settings start with each process, so they come back
  with the agent.

### How the host holds processes today

- One host per ACP pane, `agents acp-session` (the Bun binary, 17-40 MB), the pane's command for
  the pane's lifetime. Codex runs it beside its TUI under `codex-session` and
  `acp-host-supervise`; a hand-off agent's host runs the TUI as its child (acp-handoff.ts).
- A hand-off pane in its view runs one adapter process per WebSocket client (`bridge`) plus a warm
  spare started ahead of the next client (`warmSpare`), and no TUI. A worker's host holds its
  session itself (HostedSession), and a view attaches to that.
- **No view without an agent process.** The host serves the page with none, but every WebSocket
  takes an adapter at once (`takeAgent`), and the view's first messages are `initialize` and
  `session/load`, so the conversation shows only once an agent has replayed it. A pane that rests
  needs the host to give the view the conversation from the session log, start no adapter and no
  spare, and start one when the view asks for it (the first keystroke).
- A Codex pane's agent is its TUI on the pane's app-server: the view's codex-acp is only a client of
  that. Resting a Codex pane ends the TUI (and its app-server's hold on the thread), and resuming it
  starts the TUI on the same thread again.

### When a pane's session id changes

- **`/clear`.** claude-agent-acp refuses `/clear` (an unsupported command); its "clear the context
  and go on with the plan" keeps the ACP session id. In Codex's TUI, `/new` and `/clear` give the
  pane's app-server a new thread, and the view follows it (`currentSession`) under the same host.
- **`/new`, `/resume` and another agent** go through `agents resume`, which starts the pane's
  command again: a new host, a new session. The new host is told the session before it, for the
  log's chain.
- **Kiro's copies.** Kiro 3's TUI resumes a Kiro 2 session (a bare UUID) as a new copy,
  `cli_<uuid>_<suffix>` (`kiroContinuedSession` names it). The mini's sessions are Kiro 3's own
  (`sess_…`), which keep their id; a Kiro 2 session on another Mac changes id each time its TUI
  takes it up.

## The session log (2026-11-26)

The pane's ACP host writes what its views draw to a log per session,
`~/.agents/sessions/<harness>/<session-id>.jsonl` (`AGENTS_SESSIONS_DIR` elsewhere), as the
traffic between a view (or the host's own session) and the agent passes through it
(src/session-log.ts, `SessionLogTap`). One JSON line each, `{v: 1, n, at, kind, …}`, `n` counting
from 0:

| kind | What it holds |
| --- | --- |
| `start` | The first line: `session`, `harness`, `cwd`, and where the chain goes on from: `previous` (the pane's session before, after `/new`, `/resume`, an agent switch, a Codex thread change or Kiro's copy), `pane`, `program` and `task` for a worker, `how: {start: "respawn", why}` for a respawn |
| `user` | A prompt as it was sent: `text`, `attachments` (images by reference, files by URI), `steered` for one taken into a running turn, `replay` for one the agent replayed |
| `agent`, `thought` | The agent's message or thinking, its chunks joined into one line |
| `tool` | A tool call once it settles: `id`, `title`, `toolKind`, `status`, `locations`, `rawInput`, `content` (a diff whole, text to its last 200 lines), `rawOutput` (whole up to 32 KB, else its last lines), `ms` |
| `plan` | The plan's entries, when they change |
| `permission` | A question for permission: `request`, `toolCallId`, `title`, `options` |
| `choice` | The answer to it: `outcome` (selected or cancelled), `optionId`, `optionKind` |
| `turnEnd` | A prompt's end: `stopReason`, `ms`, `tools`, `edits`, `failed`, and `config` (the session's mode, model and other choices then, for a resumed session to be given again); a respawn's first turn has its `how` |

- **One writer.** The host that has the session writes its log; lines are only appended. A
  host that stopped in the middle of a line leaves it torn: the next host starts on a new line and
  a reader skips any line that does not parse.
- **Images** are written once beside the log, `<session>.files/<sha256>.<ext>`, and the line names
  the file (`ref`). Tool content images keep only their type.
- **Old sessions (no backfill).** A session opened through its harness (`session/load`) gets a log
  from what the agent replays, the first time. A load of a session with a log writes nothing again,
  except the turns the replay has after the log's last prompt (the pane's TUI had the session in
  between). A load that fails leaves no log.
- **The chain.** The pane's tmux option `@agents_session_log` keeps the session its host last
  logged; the next session's start line names it as `previous`. `agent respawn <task> --why "<why>"`
  sets `@agents_session_how` on the new pane, which the new session's start line and first turn
  carry. A worker's sessions are also in its `tasks/<task>/sessions.jsonl`, as before.

`agents session-log <session-id> [--json] [--after <n>]` prints a session's log (plain text, or
`{session, harness, lines}`); `--chain` adds the sessions it goes on from, oldest first
(`{sessions: [...]}`); `--task <task> [--program <dir>]` reads a worker thread's sessions in
order, with each session's `via` from sessions.jsonl. A session with no log is listed as
`missing`. It runs over SSH like `agents threads`. What the TUI does with a session while the
view does not have it is not in the log until a view loads the session again.

## Panes that open from their log, and agents that rest (2026-11-26)

For an agent that rests (`rests` in src/acp-host-cli.ts: Claude, Kiro, OpenCode, the ones that
take their session up again cleanly, above), the host's own session (a pane in its view, a
worker) needs no agent process to be shown:

- **Opening from the log.** `startHostedSession(id)` of a session whose log has its meta beside it
  (`<session>.meta.json`: the agent's initialize answer, the session's modes, config options and
  models as it last had them, its commands and its last usage) starts no agent: the host keeps
  the session resting. A view's `initialize` and `session/load` are answered from the meta and the
  log (`sessionLogUpdates`), with the commands and usage after the history, so it draws what it
  drew before, as fast as the page can.
- **Starting on typing.** The view sends `_agents/wake` as the user begins to write (at most every
  5 s, acp-connection `wake`), and anything else for the agent (a prompt, a mode, a cancel) wakes
  it too and waits for it. The agent starts and loads the session; its replay goes nowhere (the
  view shows the log already), and the mode, model and other choices of the meta are set again
  where the agent opened the session with others (Claude forgets a model, Codex its mode). A
  prompt sent before the agent is ready goes once it has the session. `POST /api/prompt` and the
  host's own prompts (a worker's next message) wake it the same way.
- **Resting.** The host stops the agent after 30 minutes at its prompt (`AGENTS_ACP_REST_IDLE_MS`),
  counted from the last thing it did or was asked, and when the app asks (`POST /api/rest`: Agents
  Next asks every host of its panes as it quits). Never while a prompt runs, a permission waits, a
  message waits in the queue, or while a view of it says it has the focus (`_agents/focus
  {focused}`, from the page's focus and visibility). A question for the user (`agent ask --user`)
  is the CLI's, not the process's: a pane whose question waits may rest. The warm spare stops too.
  The agent's hooks may report that it ended (Claude's SessionEnd); the host reports the pane's
  state and session again as they were, so the app keeps the pane as it was. `/api/state` says
  `resting: true` meanwhile.
- **A session the TUI had.** When the view gives the session back to the pane's TUI, the meta is
  marked (`tui`): the TUI's turns are not in the log, so the next view opens the session through its
  harness again, whose replay fills the log in, and the mark goes.

Codex shares its thread with its TUI live through the pane's app-server and does not rest: its
pane's agent is the TUI. Pi and Copilot stay as they were (Pi unchecked here, Copilot cannot load a
session).

## A coordinator's pane (2026-11-26)

When the pane coordinates (`@agents_role coordinator` with `@agents_program`, read every 10 s), the
host keeps the coordinator's conversation apart from its sessions (agents-next
`docs/coordinator-threads.md`, "The coordinator's conversation"): a prompt from a view is a
`message` of `<program>/thread.jsonl` unless it is an `<agents-event>` the CLI typed, and each
prompt's turn end writes a `turn` with the turn's steps and its last message as the answer
(`SessionLogTap` `onTurn`). A view's load of the host's session is given the session's own history, with the
sessions the pane went on from above it (a run that started fresh, from their logs). It was given
thread.jsonl in its place for a few hours on 2026-11-26, and a coordinator's pane lost its history
after a wake: thread.jsonl begins with that build, so it is a record beside the session, never what
the pane draws on its own. Since then the host seeds thread.jsonl once from the logs of the pane's
sessions (`seedThread`: the user's messages, and per run what woke it, its steps and its last
message; what thread.jsonl already held stays once after the seed; `.run/thread-seeded.json` marks
it), and draws the pane from thread.jsonl only when it shows at least every message and answer
those logs hold (`showsAtLeast`); otherwise from the sessions. A Codex coordinator (its prompts go to
its TUI) is not covered.

Since 2026-11-27 (Projects and Threads, step 6) a turn takes the coordinator's notify mark
(`agent notify`, `<program>/.run/notify.json`) when the mark was made after the turn began:
thread.jsonl's `turn` then has `notify: {why?, text}`, and the host's `onNotify` sets the pane's
`@agents_notify` to `{turn, at, why?, text}` for the app (`paneNotify` in session-log-pane.ts). A
turn that ends without an answer drops the mark and stays quiet. A wake whose turn ended with no
answer is not drawn from thread.jsonl at all (`threadUpdates`).

## A thread's own page (Projects and Threads, 2026-11-27)

A project's thread lives in one place, its agent's own pane (R1). There is no copy of it beside
the coordinator any more: `/thread/<session>?mirror=1`, `/worker`, `GET /api/log`,
`GET /api/log/events`, `GET`/`POST /api/asks`, the `agentsNextThreadReply` handler and Esc
closing a tab (`close-tab`) are gone. `agent send --to <pane>` no longer reads a pane's page to
find a thread in it.

The app loads a thread's own view with two more query items:

- `presentation=thread`: the thread page. Its top line ("<project> › <title>", also while its
  coordinator's pane is gone), its brief folded to three lines ("Brief ›" opens it), then the
  conversation with one work line per turn in place of its steps (P9): "Working 2m · <gist>"
  while the agent works, the gist being its plan's current item or else what its current tool
  call does, and "Worked 2m" after. There is no Steps or Results control and no ⌃O; the brief is
  not shown again as the first turn's row. A close the coordinator proposed is the last card,
  with why, Close as done (Close as dropped for `as: "dropped"`) and Keep open; it sends
  `agentsNextThreadAction` `{action: "close" | "keep-open"}` without a task, since the pane is
  the thread. `GET /api/thread` gives the page the thread its pane is (`@agents_role worker`,
  `@agents_task`, `@agents_program`): its task, program, title, brief (what the brief file says
  under "## Brief") and an unsettled `proposedClose`, or `{thread: null}`. The page reads it
  every 5 s while it is seen. Show Session drops `presentation=thread`: the same view is then
  the session as any agent pane has it.
- `questions=inline`: a question the pane's terminal asks never makes the view ask the app to
  show the terminal (P5). It shows as the conversation's last card, "<agent> asks in its
  terminal", the question's lines and Answer in terminal, which navigates to
  `agents-next-action://back-to-terminal?question=1&answer=1`; the app shows the terminal and the
  thread page again once it is answered. Before the conversation shows, the same card floats as
  the terminal's question did.

An answer its agent edited (`agents thread edit`, 2026-11-28): `GET /api/edits` gives the pane's
edits, `{follows, role, edits: [{original, text, at}]}` (a coordinator's from thread.jsonl, a
thread's from its edits.jsonl; `follows: false` for a pane of no project, and the page stops
asking). The page reads it every 5 s while it is seen. On a thread page or a coordinator's
conversation an answer whose text is an edit's `original` (whitespace aside; for a long answer one
that holds the other) shows the new text in place with "edited" after its time; the first block in
sight keeps its place while it changes. The answer of a turn under way is never replaced. Show
Session shows what the agent said.

`/threads?program=<program>&from=<task>` is the project's Threads tab (Projects and Threads, P3
and C3; threads-list.ts). The app hands it its rows whenever they change,
`__agentsNextApplyThreads({program, name, threads: [{task, title, mark, line?, at?, pane?,
place?}]})`, from its thread listing and its panes, so the tab changes with Needs you and ⌘K:
`mark` is working, waits (orange), idle (no mark) or resolved; `line` the open question, else
what the thread last said, else its brief's first line; `place` "here" when the thread's tab is in
the Threads tab's workspace, else that workspace's name. Open threads keep the order they started
in, so a row never moves; resolved ones fold at the foot. A page the app does not feed reads
`GET /api/threads` once. A row, or Return on the selected one, sends `agentsNextThreadAction`
`{action: "open", task, program}`: the app goes to the thread's tab, or brings a thread without
one back as a tab. With no threads it reads "Threads your coordinator starts show here. Ask it on
the left."

Every top line starts with the project (C3): a thread's page "<project> › <title>", the Threads
tab "<project> › Threads", a coordinator's "<project> · 8 threads · Notes". The project's name is
`agents-coordinator:` (the app goes to the coordinator, or brings it back), the count
`agents-thread:` (the app selects the project's one Threads tab, and opens it beside only when
there is none), and Notes `agents-notes:` (the project's MEMORY.md, beside).

## Thread links (2026-11-27)

Where a click on a worker or a thread goes (the design thread's "Thread links" page, L1 to L11,
built for Peter to try). In a coordinator's view and in its workers' views, a task name of the
program is that thread wherever the text names it, as a whole word with or without backticks
(`rehypeTaskRefs` in paths.ts; a one-word task such as `docs` only in backticks). Its chip shows
the thread's state mark and title, the task in the peek; a worker's `%N` shows its thread's mark
too. A click asks the app (`agentsNextACPLink`, with the gesture): a plain click opens the thread
beside the pane, ⌘-click and ⌘↩ go to its pane, and a pane in front of you is shown instead of a
second view. A thread that waits on you opens with `reply=1` and the cursor in its reply field;
any other opens for reading. Since Projects and Threads (step 1) the app takes a click on a thread
to its own tab instead (above).

The pane's role is on the page's top line instead of its header: a thread's page and a
worker's pane say "Threads › <title>" (Threads is the coordinator's list: in the same tab beside
you, beside the pane from a worker's own view, as `agents-thread:` with no task), a coordinator's
"<program> · 7 threads", the count opening its threads beside it. At the line's end one control
folds the line (to its link) and the prompt (to a one-line field with its send button, no
controls row); it is kept per pane, in the host's storage, and a pane that starts smaller than
460 × 380 starts folded (fold.ts). The tab header no longer has Steps or Results (bridge version 6: `__agentsNextSetDetailLevel` is gone).

Pictures and files: a message that names an image or a saved attachment as `@<path>` shows it as
the message's picture, never as the path (a queued message to any pane carries its attachments
the same way).

A coordinator woken for every message in its threads (2026-11-27): the user's message to a
worker's thread (`agent send --from user`) and the worker's answer to the user (the turn the
user's words began, `byUser` in its delivery record) each queue one `kind="thread"` line for its
coordinator, with the first 200 characters in the line; lines that come while it works go in as
one. Its page shows no row for a wake it ends without a reply. What the user writes to a
coordinator starts with `<agents-context thread="<task>">…</agents-context>` while a thread of its
is open beside it (`agentsNextBeside`, bridge version 7); the bubble leaves it out. What this
costs: `agents usage --program <dir> --turns` reads the coordinator's session logs (each turnEnd
now carries the agent's last usage_update) and splits its turns into wakes and the user's own, per
hour, with tokens from Claude Code's transcripts, credits from Kiro's per-turn figures, and cost
where the agent reports it. A coordinator in its terminal (no ACP view) has no session log and is
not counted.

A coordinator reopened (2026-11-27, Peter: "the coordinator thread must be persistent, closable
and reopenable like a worker's"): `agent reopen --coordinator --program <dir> [--pane <ref>]`
resumes the program's latest coordinator session whose transcript is on disk in a new pane and
gives it its role back (`agent promote --restore`): no start message, so no spent turn, no
introduction and no files opened again. The app's Start on a program in Conversations does this
when the chosen agent is the one that coordinated last. A view never takes an `<agents-event>`
line for its title: a coordinator's page is titled by its program, and the app never shows such a
line as a pane's title.

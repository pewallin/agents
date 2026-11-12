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
| Plan / todo line | ✓ | ✓ | ? | ? | ? | ? |
| MCP status | ✓ /mcp | ✓ /mcp | – | – | – | – |
| The agents hooks and extensions | ✓ hooks run under ACP (the steer hook wrote its harness file) | n/a: the TUI's app-server | – | ✓ the extension runs (harness file written) | – | – |

Gaps to pick from: steering for OpenCode (its server has no steer, so a queue is the honest
answer), Copilot until it can load sessions, Kiro's context and model switch over ACP, and the
plan line for the agents marked ?.

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
  TUI that shares its session (Codex), for as long as the view is open. On a question it navigates
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

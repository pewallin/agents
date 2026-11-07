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
  - `/changes`: one review of every file the conversation changed (a file changed in several
    turns spans git's snapshots from the first to the last).
  - `/mode`, `/model`, `/effort`: list the session's choices of that option (ACP config option
    of category mode, model or thought_level, or the session's modes) and set one at once,
    `/model opus` included. They hide an agent command of the same name.

## What each agent advertises (measured 2026-11-07, Peter's Mac mini)

| Agent | Commands | Notes |
| --- | --- | --- |
| Claude (claude-agent-acp 0.100) | ~106: the user's and the project's skills and commands, plugin commands, and Claude Code's own (`/compact`, `/context`, `/init`, `/model`, `/effort`, `/review`, `/security-review`, `/usage`, `/mcp`, …) | `/context` answers in the view as a table. Hints on many (`/compact <optional …>`). |
| Codex (codex-acp 2.5) | `/mcp`, `/skills`, `/status`, `/review`, `/review-branch`, `/review-commit`, `/compact`, `/goal`, `/rename`, `/logout`, plus prompts and skills | Read from the adapter's source; the view shares the pane's thread, not checked live here. |
| OpenCode 1.18 | ~45: skills, `/init`, `/review` | Some names have spaces ("Agent Browser"). |
| Pi (pi-acp 0.0.34) | ~43: `/skill:<name>` per skill, `/compact`, `/autocompact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog` | Pi's modes are its thinking levels. |
| Kiro | 5: its sub-agents (`/general-task-execution`, `/context-gatherer`, …) and skills | Many modes (vibe, spec, plan, …). |
| Copilot (0.0.4xx) | none | Modes agent and plan. |

## Steering and the queue

Enter while the agent works sends the message into its running turn where the agent can take
that, and queues it otherwise; ⌥Enter always queues. The field says which (`Steer Claude while it
works`, or `Queue a message for when OpenCode is done`).

- **Over ACP** (`_session/steering`, advertised in initialize's `_meta.steering.supported`): Codex
  and Claude. The view sends it with `idleBehavior: "promptRequired"`, so a turn that ended in the
  meantime gets it as a prompt of the view's own. Claude takes it at once (its running command
  goes to the background) and answers in the same turn.
- **Through the pane's steer inbox** (docs/steer-inbox.md): Pi, with the agents extension, which
  runs under pi-acp too. The view asks the host (`POST /api/steer`); the host writes the inbox
  and waits for the ack. A message Pi has not taken when the turn ends is withdrawn and queued.
- **Neither** (OpenCode, Kiro, Copilot): the message is queued, and the view says so.

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
| Steering into the turn | ✓ ACP | ✓ ACP | – queued | ✓ steer inbox (not checked live: Pi ran no model turn here) | – queued | – queued |
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

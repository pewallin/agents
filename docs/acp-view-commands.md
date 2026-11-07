# Slash commands in the ACP view

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

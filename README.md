# agents

Monitor and manage AI coding agents across tmux sessions.

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
agents setup   # install reporting hooks for claude, copilot, pi
```

## Commands

```
agents                  Interactive agent list (j/k, enter to jump)
agents watch [secs]     Live dashboard with preview and helpers (default: 2s)
agents workspace [cmd]  Create agent window with helper panes
agents count            Number of running agents
agents back             Jump to previous pane (bind to Ctrl-b b)
agents report           Report state (called by hooks)
agents setup            Install hooks
agents uninstall        Remove hooks
```

## Dashboard

| Key | Action |
|-----|--------|
| `j/k` / `↑↓` | Navigate (auto-switches preview) |
| `enter` | Jump to agent pane |
| `tab` | Preview + fullscreen (compact sidebar) |
| `click` | Preview clicked agent |
| `p` / `P` | Toggle preview (horizontal / vertical) |
| `f` | Toggle compact sidebar |
| `h` | Cycle helper layouts (off → default → small → off) |
| `q` | Quit (restores all panes) |

Add `bind b run-shell "agents back"` to `~/.tmux.conf` to jump back.

## Workspace

`agents workspace` opens a tmux window with the agent command and helper panes (lazygit, yazi, bv, shell) arranged by layout. Defaults are built in; override with `~/.agents/config.json`.

## Config

`~/.agents/config.json` — all fields optional, sensible defaults built in:

```json
{
  "defaultCommand": "claude --dangerously-skip-permissions",
  "helpers": {
    "default": [
      { "process": "lazygit", "split": "left", "size": "20%" },
      { "process": "bv", "split": "right", "size": "25%" }
    ]
  },
  "workspace": {
    "default": [
      { "command": "lazygit", "split": "left", "size": "23%" },
      { "command": "$SHELL", "split": "right", "size": "25%" }
    ]
  }
}
```

## Status Detection

Hooks report state for claude, copilot, and pi. Screen-scraping detects approval prompts, spinners, and idle state for all others.

| Indicator | Meaning |
|-----------|---------|
| `⚠ attention` | Needs user input |
| `● working` | Actively processing |
| `◐ stalled?` | No output 30s–2m |
| `○ waiting` | Idle |

## Detected Agents

`claude` `copilot` `opencode` `codex` `pi` `cursor`

## License

MIT

# agents

Monitor and manage AI coding agents across tmux sessions.

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
agents setup   # install reporting hooks for claude, copilot, pi, opencode
```

## Commands

```
agents                  Live dashboard (default)
agents ls               One-shot agent list (j/k, enter to jump)
agents ws               Create agent workspace (uses default profile)
agents ws -p copilot    Create workspace using named profile
agents count            Number of running agents
agents back             Jump to previous pane (bind to Ctrl-b b)
agents report           Report state (called by hooks)
agents setup            Install hooks
agents uninstall        Remove hooks
```

If launched outside tmux, `agents` auto-creates and attaches a tmux session.

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
| `n` | New agent workspace (profile picker) |
| `q` | Quit (restores all panes) |

Add `bind b run-shell "agents back"` to `~/.tmux.conf` to jump back.

## Config

`~/.agents/config.json` — all fields optional, sensible defaults built in.

```json
{
  "profiles": {
    "claude": {
      "command": "claude --dangerously-skip-permissions",
      "workspace": "default"
    },
    "copilot": {
      "command": "copilot --yolo",
      "workspace": "default"
    },
    "pi": {
      "command": "pi",
      "workspace": "small"
    },
    "opencode": {
      "command": "opencode",
      "workspace": "default"
    }
  },
  "defaultProfile": "claude",
  "helpers": {
    "default": [
      { "process": "lazygit", "split": "left", "size": "20%" },
      { "process": "yazi", "split": "below", "of": "lazygit", "size": "35%" },
      { "process": "bv", "split": "right", "size": "25%" }
    ],
    "small": [
      { "process": "lazygit", "split": "right", "size": "25%" },
      { "process": "bv", "split": "below", "of": "lazygit", "size": "40%" }
    ]
  },
  "workspace": {
    "default": [
      { "command": "lazygit", "split": "left", "size": "23%" },
      { "command": "yazi", "split": "below", "of": "lazygit", "size": "30%" },
      { "command": "bv", "split": "right", "size": "25%" },
      { "command": "$SHELL", "split": "below", "of": "bv", "size": "18%" }
    ],
    "small": [
      { "command": "lazygit", "split": "right", "size": "35%" },
      { "command": "bv", "split": "below", "of": "lazygit", "size": "40%" }
    ]
  }
}
```

Profiles define agent launch commands. Each profile can specify a `workspace` layout, `name` for the tmux window, and `env` vars. The `defaultCommand` field still works as a fallback if no profiles are defined.

## Status Detection

Hooks report state for claude, copilot, pi, and opencode. Screen-scraping detects status for codex, cursor, and others.

| Indicator | Meaning |
|-----------|---------|
| `⚠ attention` | Needs user input (permission prompt) |
| `? question` | Agent asked a question |
| `● working` | Actively processing |
| `◐ stalled?` | No output 30s–2m |
| `○ idle` | Idle |

## Detected Agents

`claude` `copilot` `opencode` `codex` `pi` `cursor`

## License

MIT

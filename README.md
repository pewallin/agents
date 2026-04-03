# agents

Monitor and manage AI coding agents across tmux sessions (with zellij support in beta).

- Live dashboard with status, preview, and grid view
- Hook-based reporting for claude, copilot, pi, and opencode
- Screen-scrape fallback for codex, cursor, and others
- Agent workspaces with profiles, helper panes, and quick jump-back

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
agents setup          # install reporting hooks
agents                # live dashboard
```

## Commands

```
agents                  Live dashboard (default)
agents ls               One-shot agent list
agents ws               Create workspace using configured default profile
agents ws claude        Create workspace using named profile
agents ws --list-profiles  List available launch profiles
agents count            Number of running agents
agents back             Jump back after enter-from-dashboard
agents setup            Install hooks/extensions
agents uninstall        Remove hooks/extensions
```

If launched outside tmux, `agents` auto-creates and attaches a tmux session.

## Dashboard

| Key | Action |
|-----|--------|
| `j/k` / `↑↓` | Navigate |
| `enter` | Jump to the real agent window |
| `tab` / `space` | Focus agent in preview/grid |
| `click` | Select / preview agent |
| `p` / `P` | Toggle preview (horizontal / vertical) |
| `g` / `G` | Grid view (session / all sessions) |
| `h` | Cycle helper layouts |
| `n` | New workspace from selected agent cwd/session |
| `x` | Kill selected workspace |
| `q` | Quit and restore panes |

Add `bind -n M-b run-shell "node ~/code/agents/dist/cli.js back 2>/dev/null || tmux last-window"` to `~/.tmux.conf` for instant jump-back.

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

Profiles define agent launch commands. Each profile can set a `workspace` layout, window `name`, and `env`. Profile `env` is exported in the launched agent shell before the profile command runs. `defaultCommand` still works as a fallback.

## Status Detection

Hooks report state for claude, copilot, pi, and opencode. Codex, cursor, and anything else fall back to screen-scraping.

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

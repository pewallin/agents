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

## Recommended tmux setup

Agents treats tmux as the runtime source of truth. To persist and restore agent sessions across reboots, use [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) and [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum).

### Install

```bash
# Install TPM (tmux plugin manager)
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

Add to `~/.tmux.conf`:

```bash
# Plugins
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'

# Auto-save every 15 min, auto-restore on tmux server start
set -g @continuum-save-interval '15'
set -g @continuum-restore 'on'

# Restore agents with session continuation, preserving original flags (--yolo etc.) via *
set -g @resurrect-processes '\
  "~claude -> claude --continue *" \
  "~codex -> codex resume --last *" \
  "~copilot -> copilot --continue *" \
  "~opencode -> opencode --continue *" \
  "~pi -> pi --continue *" \
  "~bv -> bv *" \
  "~lazygit -> lazygit *" \
  "~nvim -> nvim -S Session.vim *" \
  "~vim -> vim -S Session.vim *" \
  "~yazi -> yazi *" \
  "~zsh -> zsh *"'

# Load TPM (keep at the bottom of tmux.conf)
run '~/.tmux/plugins/tpm/tpm'
```

Then press `prefix + I` inside tmux to install the plugins.

### How it works

`tmux-resurrect` saves all sessions, windows, panes, layouts, and working directories. The `@resurrect-processes` setting tells it which programs to restore and what command to use. The `~` prefix enables fuzzy matching against the full saved command string (needed because Node-based agents like pi and codex show up as `node` in the process table). The `*` preserves the original command arguments, so flags like `--yolo` or `--dangerously-skip-permissions` carry over from however you launched the agent. The restore config only adds `--continue` (or `resume --last` for codex) to resume the most recent session. `tmux-continuum` triggers saves automatically and restores on tmux server start.

After a reboot, restore happens the first time tmux starts — the app may prompt you to start tmux if no server is running yet.

## Agent flags

Flags for running agents without approval prompts and for resuming sessions.

| Agent | Continue session | Auto-approve | Notes |
|-------|-----------------|--------------|-------|
| claude | `--continue` | `--dangerously-skip-permissions` | Resumes most recent session in cwd |
| codex | `resume --last` | `--yolo` | `resume` is a subcommand, not a flag |
| copilot | `--continue` | `--yolo` | Also has `--resume[=id]` for specific sessions |
| opencode | `--continue` | — | No auto-approve flag |
| pi | `--continue` | `--yolo` | Also has `--resume` for interactive picker |

The recommended tmux setup above preserves your original flags via `*` and adds session continuation on restore.

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

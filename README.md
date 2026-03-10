# agents

Monitor AI coding agent panes across tmux sessions. See which agents are working, waiting for input, or need approval — and jump to them instantly.

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
agents setup   # install hooks for detected agents
```

## Usage

```
agents                  Select an agent and jump to it (j/k, enter)
agents watch [secs]     Live dashboard with auto-refresh
agents working          Show only busy agents
agents setup            Install reporting hooks for Claude, Copilot, Pi
agents uninstall        Remove installed hooks
```

### Dashboard keys

| Key | Action |
|-----|--------|
| `j/k` | Navigate list |
| `enter` | Jump to agent pane |
| `p` | Toggle preview (horizontal split) |
| `P` | Toggle preview (vertical split) |
| `q` | Quit |

Add `bind b run-shell "agents back"` to `~/.tmux.conf` to jump back after selecting an agent.

## Status Detection

Hook-based detection for Claude, Copilot, and Pi (via `agents report`). Falls back to screen-scraping for other agents.

| Indicator | Meaning |
|-----------|---------|
| `⚠ approval` | Agent needs permission to proceed |
| `● working` | Agent is actively processing |
| `◐ stalled?` | No output for 30s–2m |
| `○ waiting` | Idle / awaiting input |

## Detected Agents

`claude`, `copilot`, `opencode`, `codex`, `pi`, `cursor`

Edit `AGENT_PROCS` in `src/scanner.ts` to add your own.

## License

MIT

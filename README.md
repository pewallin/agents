# agents

Monitor AI coding agents across tmux sessions. See which agents are working, waiting, or need approval — and jump to them instantly.

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
agents setup   # install reporting extensions for detected agents
```

## Usage

```
agents                  Interactive agent list (j/k, enter to jump)
agents watch [secs]     Live dashboard (default: 2s refresh)
agents report           Report agent state (used by extensions)
agents setup            Install reporting extensions
agents uninstall        Remove installed extensions
```

### Dashboard keys

| Key | Action |
|-----|--------|
| `j/k` / `↑↓` | Navigate |
| `enter` / `space` | Open preview + focus pane |
| `click` | Open preview + focus clicked agent |
| `p` | Toggle preview (horizontal) |
| `P` | Toggle preview (vertical) |
| `q` | Quit |

Add `bind b run-shell "agents back"` to `~/.tmux.conf` to jump back.

## Status Detection

Agents with extensions report state via `agents report`. All others use screen-scrape detection.

| Indicator | Meaning |
|-----------|---------|
| `⚠ approval` | Needs user input (permission prompt, ask_user) |
| `● working` | Actively processing |
| `◐ stalled?` | No output for 30s–2m |
| `○ waiting` | Idle / awaiting prompt |

### Copilot extension (included)

Detects `ask_user`, `permission.requested`, `tool.execution_start/complete`, and `session.idle` events via the SDK. Installed by `agents setup`.

### Screen-scrape fallback

Used for Claude, Codex, aider, and any agent without an extension. Matches common patterns (`Allow`, `(Y/n)`, `↑↓ to select`, spinner characters).

## Detected Agents

`claude`, `copilot`, `opencode`, `codex`, `pi`, `aider`, `cursor`

Edit `AGENT_PROCS` in `src/scanner.ts` to add your own.

## License

MIT

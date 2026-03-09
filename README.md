# agents

Monitor AI coding agent panes across tmux sessions. See which agents are working, waiting for input, or need approval — and jump to them instantly.

## Install

```bash
git clone https://github.com/pewallin/agents.git
cd agents
npm install && npm run build && npm link
```

## Usage

```
agents                  Select an agent and jump to it (j/k, enter)
agents watch [secs]     Live dashboard with auto-refresh
agents working          Show only busy agents
```

Add `bind b run-shell "agents back"` to `~/.tmux.conf` to jump back after selecting an agent.

## Status Detection

| Indicator | Meaning |
|-----------|---------|
| `⚠ approval` | Agent needs permission to proceed |
| `● working` | Agent is actively processing |
| `◐ stalled?` | No output for 30s–2m |
| `○ waiting` | Idle / awaiting input |

## Detected Agents

`claude`, `copilot`, `opencode`, `codex`, `aider`, `cursor`

Edit `AGENT_PROCS` in `src/scanner.ts` to add your own.

## License

MIT

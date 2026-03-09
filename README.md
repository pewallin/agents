# agents

Monitor AI coding agent panes across tmux sessions. See which agents are working, waiting, or idle — and jump to them instantly.

Built with [Ink](https://github.com/vadimdemedes/ink) for flicker-free terminal rendering.

## Install

```bash
git clone https://github.com/pwallin/agents.git
cd agents
npm install
npm run build
npm link
```

## Usage

```
agents                  Interactive select — j/k navigate, enter to jump
agents watch [secs]     Live dashboard (default 5s refresh)
agents working          Show only busy agents
agents count            Print number of running agents
agents help             Show all commands
```

## Detected Agents

Out of the box, detects: `claude`, `copilot`, `opencode`, `codex`, `aider`, `cursor`.

Edit `AGENT_PROCS` in `src/scanner.ts` to add your own.

## Status Detection

| Indicator | Meaning |
|-----------|---------|
| `● working` | Agent is actively processing (title spinner or recent output) |
| `◐ stalled?` | No output for 30s–2m |
| `○ waiting` | Agent is idle / awaiting input |
| `○ idle` | No output for 2m+ |

## How It Works

Scans all tmux panes, walks process trees to find known agent binaries, then determines activity by:

1. **Title spinners** — braille characters (⠐⠂⠈) in pane title = working
2. **Screen content** — input prompts (`❯`, `shift+tab`, etc.) = waiting
3. **Activity timing** — time since last pane output as fallback

## License

MIT

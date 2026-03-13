# Agents — tmux AI agent monitor

A CLI tool that monitors AI agent panes across tmux sessions, providing a live dashboard with status tracking, preview, and workspace management.

## Quick start

```bash
npm run build          # compile TypeScript
agents                 # live dashboard (default command)
agents ls              # one-shot agent list
agents ws              # create workspace window (uses default profile)
agents ws -p opencode  # create workspace using named profile
agents setup           # install hooks for all supported agents
```

If launched outside tmux, `agents` auto-creates/attaches a tmux session.

For development with hot reload: `npm run dev:watch`

## Architecture

```
src/
  cli.ts          — entry point, commander subcommands
  scanner.ts      — tmux pane discovery, process detection, status detection
  state.ts        — read/write ~/.agents/state/ files (hook-reported state)
  setup.ts        — install/uninstall hooks and extensions for each agent
  config.ts       — ~/.agents/config.json (helpers, workspace layouts)
  mouse.ts        — SGR mouse tracking via Ink's internal event emitter
  workspace.ts    — tmux workspace creation
  components/
    Dashboard.tsx  — main watch-mode UI (Ink/React), preview, helper zones
    AgentTable.tsx — responsive table with adaptive column widths
    Select.tsx     — interactive one-shot agent picker

extensions/
  claude/         — Claude Code hooks (shell scripts for settings.json)
  copilot/        — Copilot CLI extension (extension.mjs)
  pi/             — Pi extension (TypeScript)
  opencode/       — OpenCode plugin (index.mjs, installed as npm package)
```

## Key concepts

**Agent detection**: The scanner walks tmux pane process trees looking for known agent binaries (`claude`, `copilot`, `opencode`, `codex`, `cursor`, `pi`). It also checks TTY sessions for agents that spawn under shells.

**Status detection** has two modes:
- **Hook-based** (claude, copilot, pi, opencode): Authoritative state from `~/.agents/state/` files, written by agent hooks/extensions via `agents report`. Never falls back to scraping.
- **Screen-scraping** (codex, cursor, others): Pattern-matches pane content for spinners, prompts, permission dialogs. Brittle but works without extensions.

**Preview**: The dashboard can swap an agent pane into a split beside itself using `tmux swap-pane`. Pane IDs follow the process (not the position) after a swap. The scan loop re-adds the previewed agent to the list by searching for `agentTmuxId` in unfiltered scan results.

**Helper zones**: Persistent tmux panes in the preview layout that show companion tools (lazygit, yazi, etc.) from the agent's original window. Zones are created once and helpers are swapped in/out on agent switch.

## Important patterns

- `process.stdout.columns` is synced from actual tmux pane width via `getPaneWidth()` because the PTY size often doesn't match after tmux rearranges panes. A `prependListener("resize")` interceptor prevents SIGWINCH from restoring stale values.
- Async scans use a sequence counter (`scanSeq`) to discard stale results after preview switches. Any code that changes preview state must call `doScan()` after to invalidate in-flight scans.
- Mouse input uses Ink's `internal_eventEmitter` (not `stdin.on("data")`) to avoid conflicts with Ink's paused-mode stdin handling.
- `selfWindowId` must use `-t ${TMUX_PANE}` when querying tmux to avoid focus-dependent results.

## Adding a new agent

1. Add the binary name to `AGENT_PROCS` regex in `scanner.ts`
2. Create an extension in `extensions/<name>/` that calls `agents report --agent <name> --state <state> --session "$TMUX_PANE"`
3. Add a hook detector: `const myDetector = makeHookDetector("<name>")` and wire it into `getDetector()`
4. Add `setup<Name>()` / `uninstall<Name>()` in `setup.ts`, wire into `setup()` / `uninstall()` / `computeSetupHash()`

States: `working`, `idle`, `approval`, `question`

## Issue tracking

This project uses **beads** (`br`) for issue tracking. Issues live in `.beads/` and sync via git.

```bash
br list              # list all issues
br ready             # find unblocked work
br show <id>         # show issue details
br create "Title"    # create issue
br close <id>        # complete issue
br delete <id>       # delete (tombstones by default, --hard to purge)
br sync              # sync with git
```

Note: `bd` is a legacy alias — always use `br`.

## Build & test

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm run dev:watch    # vite-node hot reload for watch mode
```

No test suite yet. Manual testing via `agents watch` in a tmux session with agent panes running.

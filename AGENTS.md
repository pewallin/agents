# Agents — terminal multiplexer AI agent monitor

A CLI tool that monitors AI agent panes across tmux (and soon zellij) sessions, providing a live dashboard with status tracking, preview, grid view, and workspace management.

## Active Workstreams

This repo may be worked on in parallel with `/Users/peter/code/agents-app`.

For current cross-repo workstream ownership, tmux pane mapping, and temporary write boundaries, see:
- `/Users/peter/code/agents-app/WORKSTREAMS.md`

Treat that file as temporary execution coordination only.
Treat this file and each repo's roadmap/docs as the longer-lived guidance for the codebase itself.

## Quick start

```bash
npm run build          # compile TypeScript
agents                 # live dashboard (default command)
agents ls              # one-shot agent list
agents history         # persisted session history across supported agent backends
agents ws              # create workspace window (uses default profile)
agents ws -p opencode  # create workspace using named profile
agents setup           # install hooks for all supported agents
```

If launched outside tmux, `agents` auto-creates/attaches a tmux session.

For development with hot reload: `npm run dev:watch`

## Architecture

```
src/
  cli.ts            — entry point, commander subcommands
  shell.ts          — shared exec/execAsync wrapper (single source of truth)
  constants.ts      — magic numbers, dashboard sizing helpers
  scanner.ts        — pane discovery, process detection, status detection, filterAgents()
  state.ts          — read/write ~/.agents/state/ files (hook-reported state)
  setup.ts          — install/uninstall hooks and extensions for each agent
  config.ts         — ~/.agents/config.json (helpers, workspace layouts, profiles)
  mouse.ts          — SGR mouse tracking via Ink's internal event emitter
  workspace.ts      — tmux workspace creation (new-window + helper splits)
  grid.ts           — grid view layout computation + tmux pane management
  zones.ts          — helper zone lifecycle (create/populate/depopulate/destroy)
  persistence.ts    — preview state save/load (survives HMR + restarts)
  multiplexer.ts    — Multiplexer interface + auto-detection (tmux vs zellij)
  mux-tmux.ts       — tmux Multiplexer backend
  mux-zellij.ts     — zellij Multiplexer backend (talks to bridge plugin via pipe)
  components/
    Dashboard.tsx    — main watch-mode UI (Ink/React), preview, grid, sidebar
    AgentTable.tsx   — responsive table with adaptive column widths
    Select.tsx       — interactive one-shot agent picker

extensions/
  codex/             — Codex hook scripts (wired via ~/.codex/hooks.json)
  copilot/           — Copilot CLI extension (extension.mjs, uses SDK events)
  pi/                — Pi extension (TypeScript, lives in dustbot repo)
  opencode/          — OpenCode plugin (index.mjs, installed as npm package)
  kiro/              — Kiro CLI hook script (wired via ~/.kiro/agents/agents-reporting.json and Kiro's default agent setting when unset)

bridge-plugin/       — Rust WASM plugin for zellij (see bridge-plugin/README.md)
docs/                — feature plans (zellij-support.md)
```

## Key concepts

**Agent detection**: The scanner walks pane process trees looking for known agent binaries (`claude`, `copilot`, `opencode`, `codex`, `cursor`, `pi`, `kiro-cli`). It also checks TTY sessions for agents that spawn under shells.

**Status detection** has two modes:
- **Hook-based** (claude, codex, copilot, pi, opencode, kiro): Authoritative state from `~/.agents/state/` files, written by agent hooks/extensions via `agents report`.
- **Process/runtime fallback** (cursor, others): Detects panes by process name and reports conservative activity-derived status without reading terminal content.

**Preview**: The dashboard swaps an agent pane into a split beside itself using `tmux swap-pane`. Pane IDs follow the process (not the position) after a swap. `filterAgents()` in scanner.ts handles re-adding swapped agents to the scan results.

**Grid view**: Shows multiple agent panes simultaneously in a dynamic grid layout. Layouts computed by `computeLayout()` (1-12 agents, tested). Grid panes are created via tmux splits with even distribution. The dashboard pane is part of the grid. Supports scoped (g = current session) and unscoped (G = all agents) modes. Session switching on j/k navigation.

**Helper zones**: Persistent tmux panes in the preview layout that show companion tools (lazygit, yazi, etc.) from the agent's original window. Managed by `zones.ts` — zones are created once and helpers are swapped in/out on agent switch.

**Multiplexer abstraction**: `multiplexer.ts` defines a shared interface. Auto-detects tmux (`$TMUX`) vs zellij (`$ZELLIJ_SESSION_NAME`). Zellij backend uses a WASM bridge plugin for operations the CLI can't do (focus by ID, cross-tab pane movement, PID lookup).

## Important patterns

- **Shell execution**: All `execSync`/`execAsync` calls go through `shell.ts`. Never import `child_process` directly in other modules.
- **Constants**: Magic numbers live in `constants.ts` (sidebar width, debounce ms, dashboard sizing). Use `calcDashboardCols()` instead of inline math.
- **Pane width sync**: `process.stdout.columns` is synced from actual tmux pane width via `getPaneWidth()` because the PTY size often doesn't match after tmux rearranges panes. A `prependListener("resize")` interceptor prevents SIGWINCH from restoring stale values.
- **Scan sequence**: Async scans use `scanSeq` to discard stale results. Any code that changes preview/grid state must call `doScan()` to invalidate in-flight scans.
- **Scan filtering**: `filterAgents()` is a pure function that handles self-exclusion, preview pane re-adding, and grid pane re-adding. It's tested independently in `scanner.test.ts`.
- **Mouse input**: Uses Ink's `internal_eventEmitter` (not `stdin.on("data")`) to avoid conflicts with Ink's paused-mode stdin handling.
- **tmux window naming**: Must set both `automatic-rename off` AND `allow-rename off` to prevent helper programs (yazi) from overwriting window names via escape sequences. Then explicitly `rename-window`.
- **tmux hooks**: The correct hook for pane focus changes is `after-select-pane` (NOT `pane-focus-in` which doesn't exist). Used for grid focus tracking.

## Adding a new agent

1. Add the binary name to `AGENT_PROCS` regex in `scanner.ts`
2. Create an extension in `extensions/<name>/` that calls `agents report --agent <name> --state <state> --session "$TMUX_PANE"`
3. Add a hook detector: `const myDetector = makeHookDetector("<name>")` and wire it into `getDetector()`
4. Add `setup<Name>()` / `uninstall<Name>()` in `setup.ts`, wire into `setup()` / `uninstall()` / `computeSetupHash()`

States: `working`, `idle`, `approval`, `question`

## Copilot extension

The copilot extension (`extensions/copilot/extension.mjs`) uses the `@github/copilot-sdk`:
- `onPermissionRequest: approveAll` — required by SDK, can't be omitted or it crashes
- SDK events for state reporting: `tool.execution_start` (working), `tool.execution_start` with `ask_user` (approval), `permission.requested` (approval), `session.idle` (idle)
- SDK docs: `~/.copilot/pkg/universal/1.0.3/copilot-sdk/` (types in `types.d.ts`, examples in `docs/examples.md`)
- `onPermissionRequest` replaces copilot's native approval UI — no way to "pass through"

## Build & test

```bash
npm run build        # tsc → dist/
npm run test         # vitest run (58 tests)
npm run dev          # tsc --watch
npm run dev:watch    # vite-node hot reload for watch mode
```

Test files: `src/*.test.ts` (excluded from tsc output via tsconfig.json).
- `grid.test.ts` — layout computation, geometry, tiling, contiguity (22 tests)
- `scanner.test.ts` — detector selection, generic detector regexes, filterAgents (27 tests)
- `state.test.ts` — priority logic, session filtering (9 tests)

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

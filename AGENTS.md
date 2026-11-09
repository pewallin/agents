# Agents — AI agent runtime for tmux

A CLI that finds AI agent panes in tmux, tracks their state through the agents' hooks, launches and restores agent workspaces, and serves each pane's ACP view. Agents Next is its UI; the CLI has no dashboard of its own.

## Quick start

```bash
npm run build          # compile TypeScript
agents ls              # one-shot agent list
agents history         # persisted session history across supported agent backends
agents ws              # create workspace window (uses default profile)
agents ws -p opencode  # create workspace using named profile
agents setup           # install hooks for all supported agents
```

## Architecture

```
src/
  cli.ts            — entry point, commander subcommands
  shell.ts          — shared exec/execAsync wrapper (single source of truth)
  constants.ts      — agent display colours for `agents ls`
  scanner.ts        — pane discovery, process detection, status detection
  state.ts          — read/write ~/.agents/state/ files (hook-reported state)
  setup.ts          — install/uninstall hooks and extensions for each agent
  config.ts         — ~/.agents/config.json (helpers, workspace layouts, profiles)
  workspace.ts      — tmux workspace creation (new-window + helper splits)
  pane-ops.ts       — switchToPane (through Agents Next, or this tmux client) for `agents ls`
  tmux-env.ts       — insideTmux()
  codex-session.ts  — a Codex pane's own app-server, shared live with its ACP view; starts its acp-session
  acp-host.ts       — an agent pane's ACP view host: static web client, one adapter per client
  acp-host-cli.ts   — `acp-session --agent <ACP registry id>` and its agent table (adapter, resume
                      command); the bundled `codex-acp` and `claude-acp` adapter commands
  app-control/      — `agents app-control`: Agents Next's control socket and the coordination of
                      agents (spawn, report, ask, send, supervisor, MCP server); the
                      agents-app-control skill's scripts/agents-app-control launcher runs it
                      (moved from that skill as JavaScript: its modules start `// @ts-nocheck`
                      until each is typed; `self.ts` is typed)
  acp-handoff.ts    — `acp-session --tui`: an agent without a shared session runs its TUI under
                      a supervisor that hands the session to the ACP view and back
  components/
    AgentTable.tsx   — responsive table with adaptive column widths
    Select.tsx       — interactive one-shot agent picker

extensions/
  codex/             — Codex hook scripts (wired via ~/.codex/hooks.json)
  copilot/           — Copilot CLI extension (extension.mjs, uses SDK events)
  pi/                — Pi extension (TypeScript, lives in dustbot repo)
  opencode/          — OpenCode plugin (index.mjs, installed as npm package)
  kiro/              — Kiro CLI hook script (wired via ~/.kiro/agents/agents-reporting.json and Kiro's default agent setting when unset)

web/acp-view/        — the agent-neutral ACP web view (React, @acp-components); `npm run build:web` → dist-web/
docs/                — feature plans and the ACP view client notes
```

## Key concepts

**Agent detection**: The scanner walks pane process trees looking for known agent binaries (`claude`, `copilot`, `opencode`, `codex`, `cursor`, `pi`, `kiro-cli`, `hermes`). It also checks TTY sessions for agents that spawn under shells.

**Status detection** has two modes:
- **Hook-based** (claude, codex, copilot, pi, opencode, kiro, hermes): Authoritative state from `~/.agents/state/` files, written by agent hooks/extensions via `agents report`.
- **Process/runtime fallback** (cursor, others): Detects panes by process name and reports conservative activity-derived status without reading terminal content.

## Important patterns

- **Shell execution**: All `execSync`/`execAsync` calls go through `shell.ts`. Never import `child_process` directly in other modules.
- **tmux window naming**: Must set both `automatic-rename off` AND `allow-rename off` to prevent helper programs (yazi) from overwriting window names via escape sequences. Then explicitly `rename-window`.
- **tmux hooks**: The correct hook for pane focus changes is `after-select-pane` (NOT `pane-focus-in` which doesn't exist).

## Adding a new agent

1. Add the binary name to `AGENT_PROC_NAMES` in `scanner-discovery.ts`
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
npm run build:binary # single executable via Bun → dist-bin/<platform>/ (--target all for every platform)
npm run build:web    # the ACP web view → dist-web/acp-view (build:binary runs it and ships acp-view/)
```

The compiled binary (`scripts/build-binary.ts`) runs without node or node_modules. Its code
lives in Bun's virtual file system, so anything that needs real files beside the code goes
through `getResourceRoot()` in `paths.ts` (extensions/, acp-view/), and anything
that starts this CLI again goes through `getSelfArgv()` (never `process.argv[1]`, which is a
virtual path in the binary). Ship the whole `dist-bin/<platform>/` directory, not just the
executable: `agents setup` points hooks at its `extensions/`, and `hook-runtime.env` records
the binary as `AGENTS_HOOK_BIN`. A binary outside `~/.agents/agents-cli/` (the app's install
location) never runs auto-setup, so trying out a fresh build leaves the user's hooks alone.
Auto-setup also stays away when another install owns the hooks (the CLI recorded in
`hook-runtime.env`, shown by `agents doctor`); only an explicit `agents setup` moves them.
It only refreshes hooks a setup installed: with no `.setup-hash` (never set up, or `agents
uninstall` took them out) it does nothing, so a user who turned the hooks off keeps them off.

Test files: `src/*.test.ts` (excluded from tsc output via tsconfig.json).
Run `npm test` for the current count; `scanner.test.ts` covers detection and parsing,
`state.test.ts` hook state and its priorities.

## Git workflow

Work directly on `main` by default and commit each completed, validated slice.
Do not leave finished work uncommitted merely to avoid changing history;
incorrect changes should normally be undone with a new `git revert` commit.

Use a branch or worktree only when parallel work, review isolation, or an
explicit user request makes it materially useful. Merge validated work back to
`main` promptly.

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

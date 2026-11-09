# agents

A CLI that finds AI coding agents running in tmux panes, tracks their state through the agents'
own hooks, launches and restores agent workspaces, and serves a per-pane ACP web view of each
agent's session. It is the runtime layer of the Agents Next app, which ships a compiled build of
it, and works on its own as a terminal dashboard.

tmux is the primary backend. zellij (0.44+) is in beta and needs the WASM bridge plugin in
`bridge-plugin/`; grid view and helper zones are tmux-only.

## Install

From source (Node 22+):

```bash
git clone https://github.com/pewallin/agents.git && cd agents
npm install && npm run build
npm run build:web     # only needed for the ACP view (dist-web/acp-view)
npm link
agents setup          # install hooks for the agents found on this machine
agents                # dashboard; outside tmux it creates/attaches an `agents` session
```

As a single executable (no Node needed at runtime):

```bash
npm run build:binary                     # this platform → dist-bin/<platform>/
npm run build:binary -- --target all     # darwin-arm64, darwin-x64, linux-x64, linux-arm64
```

Ship the whole `dist-bin/<platform>/` directory: hooks point at its `extensions/`, and the ACP
host serves its `acp-view/`. Agents Next installs this build to `~/.agents/agents-cli/app` and
links `~/.local/bin/agents` to it after the user agrees.

For remote hosts, see [Remote hosts](#remote-hosts).

## Supported agents

| Agent | `agents setup` installs | ACP view |
| --- | --- | --- |
| Claude Code | hooks in `~/.claude/settings.json` | hand-off, bundled `claude-agent-acp` |
| Codex | `~/.codex/hooks.json`, `[features] hooks = true` in `config.toml` | live, bundled `codex-acp` on the pane's app-server |
| Copilot CLI | extension in `~/.copilot/extensions/agents-reporting/` | hand-off, Copilot's ACP mode (needs a version with `session/load`) |
| Pi | extension in `~/.pi/agent/extensions/agents-reporting/` | hand-off, `pi-acp` from PATH or npx |
| OpenCode | plugin linked into `~/.config/opencode/`, entry in its `config.json` | hand-off, `opencode acp` |
| Kiro CLI | `~/.kiro/agents/agents-reporting.json`, made the default agent if none is set | hand-off, `kiro-cli acp` |
| Hermes | shell hooks in `~/.hermes/config.yaml`, allowlisted | none |
| Cursor | nothing (process detection only) | none |

`setup` skips an agent whose config directory doesn't exist. It is idempotent; `agents uninstall`
removes everything it added (including the Codex feature flag) and leaves other settings as
they were. Kiro reports only while the `agents-reporting` agent is active (`kiro-cli chat
--agent agents-reporting` if another default is configured).

## How status works

Hooks and extensions call `agents report --agent <name> --state <state> --session $TMUX_PANE`
with optional detail, intent, response preview, model, context-window and spend fields. Each
report lands in `~/.agents/agents-app/state/<agent>-<pane>.json`.

The scanner lists tmux panes, walks each pane's process tree for known agent binaries (also
behind `node`/`bun`/`npx` wrappers), and merges in the state files. It never reads terminal
content. Agents without hooks get an activity-only status from tmux's window activity.

| Indicator | Status | Meaning |
| --- | --- | --- |
| `⚠` | attention | permission prompt waiting |
| `?` | question | the agent asked the user something |
| `●` | working | turn in progress |
| `◐` | stalled | Codex stream disconnected, or a hookless agent with output in the last 2 min |
| `○` | idle | |

Hooks run the CLI recorded in `~/.agents/agents-app/hook-runtime.env` (a binary, or a node plus
`cli.js`) and log failures to `logs/hooks.log`. `agents doctor` checks each integration's
installed events against what it should have, runs the hook lookup with a minimal PATH, and warns
when another `agents` version shadows this one on PATH.

When the integration files change, any `agents` command re-runs `setup --quiet` in the
background, but only if `setup` was run before, this install is the one recorded in
`hook-runtime.env`, and it isn't a binary outside `~/.agents/agents-cli/`. An explicit `agents
setup` always takes the hooks over. `AGENTS_NO_AUTO_SETUP=1` turns auto-setup off.

## Commands

Dashboard and inspection:

```
agents [watch [seconds]]    Live dashboard (default command)
agents ls [--json]          One-shot list; interactive picker on a TTY
agents runtime --json       Reconciled runtime state per pane (--pane %N, repeatable)
agents history              Past sessions per agent and cwd (--agent, --cwd, --pane, --limit, --json);
                            with --pane, a session another pane has open says where (openIn)
agents usage --json         Provider quota windows (Codex, Claude, Copilot, Kiro)
agents doctor [--json]      Integration coverage and hook runtime checks
```

Workspaces and sessions:

```
agents ws [profile] [args...]   New tmux window: agent pane plus the profile's layout
                                (-n name, -l layout, --agent-only, --tmux-session, --json, --list-profiles)
agents back                     Jump back to where you were before the last jump from the dashboard
agents resume --pane %N         Respawn a pane's agent on a session: --session <id> | --session-path
                                | --new-session [--prompt]; --profile, --agent; --open-in acp-view|terminal
                                (where Agents Next shows it). Refuses a session another pane has open
                                (session-open-elsewhere, naming the pane) and an agent that is not idle,
                                unless --force
```

Integrations:

```
agents setup | uninstall    Install / remove hooks and extensions
agents setup --mcp | uninstall --mcp | doctor --mcp
                            Register / remove / check Agents Next's `agents` MCP server
agents report ...           State reporting, called by hooks
agents bundle <dir>         Write an app-installable bundle directory
```

ACP view (see [ACP view](#acp-view)):

```
agents codex-session --command '<codex cmd>'    Run Codex on a pane-local app-server plus its ACP host
agents acp-session --agent <id> --tui '<cmd>'   Run a TUI with a hand-off ACP host
agents acp-restart --pane %N [--check]          Move a running agent into its ACP wrapper, same session
agents acp-prompt --pane %N [--steer] < text    Prompt or steer the session the pane's host holds
agents review [--cwd <repo>] [--base <rev> | --commit <sha>] [--path <file>]... [--focus <file>]
                                                Read-only review page for changes no agent made
```

Also: `agents done list|record|update` (persisted Done events and pinned sessions, used by the
app), `agents target|checkout|session ...` (see [Remote hosts](#remote-hosts)) and `agents
resurrect ...` (see [tmux-resurrect](#tmux-resurrect)). Every command has `--help`.

### Dashboard keys

| Key | Action |
| --- | --- |
| `j`/`k`, `↑`/`↓` | Move selection |
| `enter` | Jump to the agent's window |
| `tab`, `space`, click | Focus the agent in preview or grid |
| `p` / `P` | Preview beside the dashboard (horizontal / vertical) |
| `g` / `G` | Grid of the session's agents / all agents |
| `h` | Cycle helper layouts in the preview |
| `s` | Collapse the dashboard to a narrow sidebar |
| `S` | Summary view |
| `n` | New workspace from the selected agent's cwd and session |
| `x` | Kill the selected workspace |
| `?` | Key help |
| `q` | Quit and put panes back |

The preview swaps the agent's pane into the dashboard's window (`tmux swap-pane`) and swaps it
back on exit. For a global jump-back key: `bind -n M-b run-shell "agents back || tmux
last-window"`.

## Configuration

`~/.agents/agents-app/config.json` (override with `AGENTS_CONFIG_PATH`). Everything is optional;
without a file there is one `claude` profile and built-in `default` and `small` layouts.

```json
{
  "defaultProfile": "claude",
  "profiles": {
    "claude": { "command": "claude", "workspace": "default" },
    "codex":  { "command": "codex", "workspace": "small", "env": { "FOO": "1" } },
    "kiro":   { "command": "kiro-cli chat --tui --agent agents-reporting" }
  },
  "workspace": {
    "default": [
      { "command": "lazygit", "split": "left", "size": "23%" },
      { "command": "yazi", "split": "below", "of": "lazygit", "size": "30%" },
      { "command": "$SHELL", "split": "right", "size": "25%" }
    ],
    "small": [{ "command": "lazygit", "split": "right", "size": "35%" }]
  },
  "helpers": {
    "default": [
      { "process": "lazygit", "split": "left", "size": "20%" },
      { "process": "yazi", "split": "below", "of": "lazygit", "size": "35%" }
    ]
  }
}
```

- **profiles**: `command`, `workspace` (layout name), `name` (window name), `env` (exported before
  the command), `resume_args`, `alternate_screen` (`false` turns off tmux's alternate screen for
  the pane). Nothing adds auto-approve flags; put them in `command` only if you accept that a
  prompt injection then runs commands as you.
- **workspace**: panes `agents ws` creates around the agent pane. `split` is relative to `of`
  (default: the agent pane); `size` is a tmux `-l` value.
- **helpers**: panes from the agent's own window, matched by `process`, that the dashboard shows
  around the preview (`h` cycles layouts).

`agents ws` starts the agent through the shell, so exiting it leaves a usable shell;
`--agent-only --direct-agent-launch` execs it directly instead.

## ACP view

Each agent pane can have an ACP host: a server on 127.0.0.1 that serves the React client in
`web/acp-view` and starts one ACP adapter process per WebSocket client. The WebSocket needs the
pane's token, a matching Origin and Host; the token and address are in a 0600 metadata file under
`~/.agents/agents-app/runtime/tmp`, which is where Agents Next finds them.

There are two modes:

- **Live (Codex).** `agents codex-session` starts `codex app-server` for the pane on a loopback
  WebSocket, runs the TUI against it with `--remote`, and gives `codex-acp` this CLI as
  `CODEX_PATH`, which proxies to the same app-server. TUI and view share one thread.
- **Hand-off (everyone else).** `agents acp-session --tui` runs the agent's TUI under a
  supervisor. When the view takes the session, the TUI stops (refused while the agent works) and
  the pane shows a plain transcript. Enter in the pane gives it back, and the TUI resumes the same
  session id with its original options.

The view's sessions follow the TUI command's options. Codex's and Copilot's adapters take them
themselves. For the others the host sets them on each session as it opens, through the
session's config options, so the view's pickers show them: the mode or agent (Claude's
`--permission-mode`, `--dangerously-skip-permissions` as bypassPermissions, and `--agent`;
Kiro's and OpenCode's `--agent`, for Kiro its `chat.defaultAgent` when none is named), the model
and the effort. Kiro's `-a` / `--trust-all-tools` and OpenCode's `--auto` make the host allow
each tool call the agent asks about.

`agents resume` wraps agents in these automatically; `agents acp-restart` converts an agent that
was started without one, on the same session. In the view, `/resume` (or `/chat`) lists the
folder's earlier conversations and `/new` starts one; Agents Next opens the one picked in the same
pane, which stays in the view (docs/acp-view-client.md).

The host also keeps a per-pane message queue that survives reloads, routes steering (ACP
`_session/steering` for Codex and Claude, the steer inbox for Pi, queued otherwise), and serves
file, commit and bead peeks restricted to the pane's directory. It snapshots each turn's changes
with a temporary git index, so the user's index, stashes and branches are untouched.

`agents review` opens the same review page the view shows beside an agent, for changes no
agent made: the working tree against `--base` (default `HEAD`, untracked files included) or one
commit. It is read-only and prints the page's URL (`--json` for `{ok, url}`). The page comes from one loopback server per user, started in the background on
first use and stopped after 30 minutes without a request; Agents Next's Changes panel uses it.

Details and per-agent parity: [docs/acp-view-client.md](docs/acp-view-client.md),
[docs/steer-inbox.md](docs/steer-inbox.md).

## Coordinator support

Agents Next's coordinator tooling (`agents-app-control`) lives in the app; this repo provides the
agent-side pieces:

- The Claude `PostToolUse` hook and the Pi extension read the pane's steer inbox, so a
  coordinator's `agent send --mode steer` reaches a working agent between tool calls without
  typing into the terminal.
- After a compaction, the Claude and Codex `SessionStart` hooks give a pane marked
  `@agents_role=coordinator` its protocol back as context.
- `agents setup --mcp` registers the app's `agents` MCP server (`agents-app-control mcp`, run
  through its stable launcher `~/.agents/agents-app/bin/agents-app-control`) with each harness
  found, so agents report, ask and send as tools, also where their shell is sandboxed. Claude
  Code: `claude mcp add --scope user` and `mcp__agents` in `permissions.allow`; Codex: a
  `[mcp_servers.agents]` table under a `# added by agents setup` line, with
  `default_tools_approval_mode = "approve"`; Kiro: `~/.kiro/settings/mcp.json`, allowed as
  `@agents` in our agents-reporting agent; Copilot: `~/.copilot/mcp-config.json` (its tools ask
  first); OpenCode: `mcp.agents` in `~/.config/opencode/config.json`; Pi: `~/.pi/agent/mcp.json`
  with direct exposure. Only entries it recognises as its own (name plus command, or the marker)
  are changed; a foreign `agents` server is kept. What it adds without a marker (the Claude rule,
  files and objects it created) is recorded in `~/.agents/agents-app/integration.json`, and
  `agents uninstall --mcp` takes back exactly that, leaving each file byte for byte as before.
  Agents Next runs both for its `agents-mcp` component.

## tmux-resurrect

tmux is the source of truth, so persistence across reboots goes through
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) and
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum):

```bash
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @continuum-restore 'on'

# Pin saved agent commands to explicit session ids where agents knows them.
set -g @resurrect-hook-post-save-layout 'agents resurrect normalize'

# Restore agent CLIs through agents (merge into an existing @resurrect-processes).
set -g @resurrect-processes '\
  "~claude -> agents resurrect agent claude *" \
  "~codex -> agents resurrect agent codex *" \
  "~copilot -> agents resurrect agent copilot *" \
  "~opencode -> agents resurrect agent opencode *" \
  "~pi -> agents resurrect agent pi *" \
  "~kiro-cli -> agents resurrect agent kiro *" \
  "~lazygit -> lazygit *" "~yazi -> yazi *"'
```

`agents resurrect agent` rebuilds the command from the saved argv plus agents state and resumes
a concrete session id when it can. When several Codex panes in one cwd were saved as `resume
--last`, the newest session goes to one pane and the others start fresh rather than share it.
The `capture-metadata`, `apply-metadata`, `reconcile-metadata` and `processes` subcommands do
the same from Agents Next's pane metadata sidecar.

## Remote hosts

`scripts/bootstrap-remote.sh` prepares a host. It plans by default and changes nothing until
`--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/pewallin/agents/main/scripts/bootstrap-remote.sh \
  | bash -s -- --dry-run [--json]      # then: --yes
```

It checks or installs tmux (≥ 3.3), Node, git, agents (cloned to `~/.agents/agents-cli/source`,
wrapper at `~/.local/bin/agents`) and, unless `--no-tools`, nvim, micro, lazygit and yazi, then
starts an `agents` tmux session if no server runs. It never uses sudo; without Homebrew it
reports blocked steps instead. The app passes `--expected-agents-commit <sha>` so a stale
remote is updated even when the semver matches.

`agents target list` returns `local` plus the SSH hosts in
`~/.agents/agents-app/app/config/remote-hosts.json` (written by the app). `agents checkout
create --name <seed>` makes a worktree at `<repo parent>/.shape-worktrees/<repo>/<name>` on a
`shape/<name>` branch, locally or on a target (with a local landing checkout when asked).
`agents session start|resume|list` run agents in those checkouts. All of them take `--json` and
return structured errors with the failing phase.

## Files and environment

Everything lives under `~/.agents/agents-app/` (`AGENTS_HOME`, or
`$AGENTS_SHARED_HOME/$AGENTS_PRODUCT_DIRNAME`, defaults `~/.agents` and `agents-app`):

| Path | Contents |
| --- | --- |
| `config.json` | profiles and layouts |
| `state/`, `state-contrib/` | per-pane agent state; auxiliary reporter state |
| `hook-runtime.env`, `.setup-hash` | which CLI the hooks run; setup fingerprint |
| `logs/hooks.log` | hook failures |
| `runtime/tmp/` | ACP host metadata, steer inboxes, Codex app-server endpoints |
| `state/review-server.json` | the review server's port and token |
| `runtime/state-events.jsonl` | state change events |
| `recent-done.json` | Done events and pinned sessions |

Each path also has its own override (`AGENTS_STATE_DIR`, `AGENTS_LOG_DIR`, `AGENTS_TMP_DIR`, …;
see `src/paths.ts`). `AGENTS_USAGE_PROVIDERS=codex,claude` limits `agents usage`, which otherwise
reads `~/.codexbar/config.json` and the CLIs on PATH.

## Library

```ts
import { listAgents, listAgentRuntimeStates, launchWorkspace } from "agents";

launchWorkspace({ profile: "codex", agentOnly: true, cwd: process.cwd() });
console.log(listAgents());
```

`src/lib.ts` also exports session history and resume, Done events, and the target / checkout /
session runtime.

## Development

```bash
npm run dev:watch     # dashboard with hot reload
npm test              # vitest
npm run build         # tsc → dist/
```

Architecture, conventions and how to add an agent: [AGENTS.md](AGENTS.md).

## License

MIT

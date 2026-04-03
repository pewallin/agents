# Infra Plan

## Goals

- Separate reusable infra from terminal UI concerns.
- Ensure desktop/iPhone app integrations do not pay the cost of loading Ink/React for non-UI operations.
- Improve scan-path performance where the dashboard spends time.
- Make the CLI a thin shell over a stable programmatic core.
- Support remote-host usage with lower attach/input latency where infra can help.
- Keep zellij support only where it stays low-cost.

## Principles

- Treat tmux as the primary backend.
- Keep Ink, React, and dashboard interaction out of the core runtime surface.
- Treat app-facing runtime/state/workspace behavior as a product contract even while internal module APIs move.
- Prefer explicit boundaries over convenience imports.
- Remove config and command behaviors that do not match what the tool claims to support.
- Preserve tmux as the source of truth for both local and remote sessions.
- Treat remote attach latency and remote input latency as separate problems.

## Current Findings

- Remote image submission appears to work in at least some iPhone-to-Mac scenarios.
- The same outcome has not been made to work reliably in the desktop app against a remote host.
- The current iPhone success may be influenced by Apple continuity/handoff behavior rather than by an explicit shared app transport.
- A code audit of `agents-app` did not find an explicit app-owned image clipboard/attachment path in either the macOS Ghostty bridge or the iOS SwiftTerm terminal bridge; current terminal clipboard integration is text-oriented.
- That means the product problem is not just "can the system support image payloads at all", but "what exact path is currently succeeding on iPhone, and is that path real infra support or an OS-level shortcut".
- The implementation work should start by identifying whether the difference is in transport, staging, terminal integration, or agent-specific submission behavior.

## Completed So Far

- `scanner.ts` has been split into focused modules for discovery, runtime inference, state-aware runtime reconciliation, detector/status logic, history, and pane operations.
- The tmux scan hot path now reuses captured pane content instead of repeatedly calling `tmux capture-pane` for the same pane in one scan.
- State/config/runtime paths are now centralized and can be overridden instead of being hard-wired to `~/.agents`.
- `agents ws` now supports the documented default-profile behavior.
- `LaunchProfile.env` is implemented.
- Workspace launch/restore correctness has been tightened so explicit commands do not accidentally inherit the current default profile, and env-wrapped launches still seed metadata under the real agent command.
- A source-level non-UI entrypoint now exists in `src/core.ts` as an internal boundary, but it is not yet a built library surface that the apps can consume directly.

## Workstreams

### 1. Define a Core/UI split

Status: in progress

Create two clear layers:

- `core`
  - pane discovery
  - process detection
  - runtime state reconciliation
  - workspace lifecycle
  - history/state persistence
  - integration setup/doctor
  - tmux operations
- `ui`
  - Ink dashboard
  - interactive list/select
  - keybindings
  - render formatting

Outcome:

- desktop/iPhone app can depend on core without inheriting Ink and React
- CLI commands become adapters over core APIs
- the built/runtime integration path used by the apps must not pull Ink into non-UI flows

### 2. Break up `scanner.ts`

Status: mostly completed

Split `scanner.ts` into focused modules:

- `discovery`
  - list panes
  - build process tree
  - identify agent panes
  - branch lookup
- `runtime`
  - status detection
  - hook-state merge
  - model/context inference
  - codex stale-working cleanup
- `history`
  - persisted session history readers
- `pane-ops`
  - jump
  - preview/swap
  - kill/resize/focus
  - placeholder handling

Outcome:

- smaller, testable modules
- fewer reasons for a single file to change
- easier reuse from app code
- remaining work is to finish consuming the extracted modules through a deliberate built core surface

### 3. Make tmux the design center

Status: active guideline

- Keep zellij support, but stop treating parity as a requirement for new architecture.
- Move zellij behind a compatibility layer with minimal surface area.
- If a core abstraction becomes worse because of zellij, prefer the tmux-first design and adapt zellij afterward.

Outcome:

- lower complexity in core interfaces
- less branching through the main code path

### 4. Fix the scan hot path

Status: partially completed

Refactor scan so pane content is captured at most once per pane per scan.

Reuse the same captured content for:

- status detection
- model inference
- context token inference
- codex stale-working cleanup

Additional rules:

- hook-based agents should not capture pane content unless a specific fallback needs it
- avoid repeated `tmux capture-pane` calls in both sync and async scan paths
- keep batch process-tree and batch branch lookup behavior

Outcome:

- lower scan latency
- better dashboard responsiveness at higher pane counts
- remaining work is to verify whether hook-based agents can skip even more capture in common paths

### 5. Expose a stable core API

Status: partially completed

Add programmatic APIs for app and CLI use, for example:

- `listAgents()`
- `getRuntimeStates()`
- `createWorkspace()`
- `getRestorableWorkspaces()`
- `installIntegrations()`
- `doctorIntegrations()`
- `getSessionHistory()`

CLI commands should call these APIs instead of containing business logic directly.

Outcome:

- the app can integrate with the tool as a library, not just as a shell command
- easier testing and future packaging
- next step is a built non-UI surface, not just a source file boundary

### 6. Centralize state/config/runtime paths

Status: completed

Replace hard-coded `~/.agents/...` usage with a path resolver.

Allow override through env and/or explicit options for:

- config path
- state directory
- contributor state directory
- temporary runtime files

Outcome:

- tests can run in temp directories
- app-managed installs can isolate data
- sandboxed environments become workable

### 7. Clean up the command/config contract

Status: partially completed

Fix or remove mismatches between docs, config, and behavior.

Immediate items:

- make `agents ws` use the default profile when no profile is provided
- either implement `LaunchProfile.env` or remove it until supported
- keep docs aligned with actual command behavior
- preserve restore/state behavior when explicit commands are passed by app or CLI code

Outcome:

- more predictable CLI ergonomics
- less hidden behavior for app consumers

### 8. Finish the execution boundary

Make one execution layer responsible for shell/process spawning.

- avoid direct `child_process` use outside the execution module unless necessary
- make command timing/logging possible in one place
- keep sync/async behavior explicit

Outcome:

- easier performance profiling
- simpler refactors around tmux operations

### 9. Add instrumentation

Measure performance before and after the scan refactor.

Useful metrics:

- total scan duration
- number of pane captures per scan
- process-tree build duration
- branch lookup duration
- dashboard refresh interval drift

Outcome:

- changes can be driven by observed cost, not guesswork

### 10. Incorporate remote latency infra work

Status: not started in earnest

Fold the infra parts of `agents-app/REMOTE_LATENCY_PLAN.md` into the core extraction.

The relevant split is:

- this repo owns shared infra primitives
- `agents-app` owns product-specific remote UI

Infra work that should live here:

- remote attach timing breakdowns where the CLI/core is involved
- reusable tmux pane submission primitives
- transport selection hooks for interactive remote panes
- reconnect/reattach state modeling where it depends on tmux/session semantics
- instrumentation for attach, switch, and first-usable-pane timing

App work that should stay in `agents-app`:

- iPhone compose UI
- mode switches like `Live Terminal` vs `Compose & Send`
- reconnect presentation
- host-level setup flows and product chrome

### 11. Add remote pane submission primitives

Status: next major app-facing infra task

Support prompt-style submission without requiring raw character-by-character typing.

Add a core capability for sending text payloads to tmux panes, with implementation options such as:

- literal `tmux send-keys -l`
- buffer + paste flow for larger payloads

Design goals:

- reliable multiline submission
- explicit choice about whether to append `Enter`
- safe handling of larger pasted payloads
- reusable from app code without going through Ink

Outcome:

- `agents-app` can build compose-and-send UX on top of stable infra
- prompt entry on high-latency links no longer depends entirely on SSH PTY typing behavior

### 12. Add remote rich-payload submission, including images

Status: blocked on investigation of the current iPhone success path

Text submission is not enough for the app's remote workflows. The core should also support sending image payloads to remote agent terminals in a way that maps onto how each agent actually accepts images.

This should be designed as a payload-submission layer rather than a text-only paste helper.

Supported payload types should include:

- plain text
- multiline prompt text
- local file references
- image payloads

For image payloads, the core should evaluate and support the least fragile path per agent/backend, for example:

- pasting local file paths when the remote agent can read a synced/shared workspace path
- uploading or staging files to the remote host, then inserting the resulting path/reference into the terminal flow
- agent-specific attachment flows if a terminal agent exposes one that can be automated safely

Design goals:

- do not assume raw terminal paste is enough for images
- treat images as staged assets plus a submission reference when necessary
- keep the submission API explicit about payload type, size, and delivery mode
- make failure states clear when a host or agent cannot accept image payloads
- explain the current iPhone/desktop behavior gap before designing a new abstraction

Initial investigation should answer:

- what exact path currently makes iPhone image paste work
- whether that path depends on Apple continuity/handoff rather than app-owned transport
- whether that path depends on mobile-specific UI behavior or a transport detail
- whether the remote host is receiving image data, file references, or pre-staged assets
- why desktop remote fails against the same or similar host

Outcome:

- `agents-app` can support remote image submission without inventing a separate ad hoc path
- the core transport layer becomes capable of more than text paste
- agent-specific image workflows can be added behind one shared abstraction

### 13. Add remote attach/reconnect instrumentation

Status: pending

Instrument remote session phases so latency work is measured instead of inferred.

Capture where applicable:

- readiness check
- SSH/TCP connect
- SSH auth
- tmux linked-session existence check
- tmux linked-session create/select
- PTY attach
- first rendered output
- first usable pane state

Outcome:

- attach and reconnect work in `agents-app` can target the right bottleneck
- core and app can compare cold attach, reattach, and agent-switch timings consistently

### 14. Prepare optional interactive transport selection

Status: later / optional

Do not productize `mosh` here, but shape the core so interactive remote panes are not permanently tied to one transport.

Guidelines:

- keep SSH exec as the path for scans, setup, and non-interactive commands
- allow interactive attach to remain transport-pluggable
- preserve tmux as the remote source of truth
- do not let optional transport work distort the local/tmux-first architecture

Initial outcome:

- the app can later choose between SSH PTY and another interactive transport without redesigning the core session model
- `mosh` stays an optional spike, not a current dependency

### 15. Rebuild the tests around the new boundaries

Status: in progress

Prioritize tests for core behavior:

- scan planning and pane-content reuse
- path injection for state/config
- workspace creation with default-profile fallback
- profile env handling if implemented
- tmux-first core modules
- pane submission primitives
- image payload staging/submission behavior
- remote attach timing instrumentation wiring

Keep UI tests light and push correctness down into pure modules.

Outcome:

- fewer environment-coupled failures
- stronger coverage where behavior actually matters

## Suggested Order

Completed:

1. Add path resolution and test-safe storage overrides.
2. Fix command/config contract issues (`agents ws`, profile env, workspace launch correctness).
3. Split `scanner.ts` and refactor the scan hot path.

Next:

1. Expose a built non-UI core surface that apps can use without paying the Ink/React load cost.
2. Add remote pane submission primitives for text and multiline payloads.
3. Investigate and explain the current iPhone image-paste success path before designing image support.
4. Add image-capable payload delivery based on the outcome of that investigation.
5. Add attach/reconnect instrumentation needed by `agents-app`.
6. Isolate Ink/dashboard fully into the UI layer.
7. Reassess zellij and trim support if it still adds disproportionate complexity.

## Recommendation

Separate infra from user-facing terminal features now. The desktop and iPhone apps should depend on a small, stable core package or module surface, not on the current CLI/UI shape.

Keep zellij support, but freeze scope. It should remain compatibility work, not a primary architectural constraint.

The remote latency plan should be treated as part of this infra effort where it concerns tmux primitives, transport boundaries, and timing instrumentation. The app should build UX on top of those shared capabilities rather than inventing a separate remote control path.

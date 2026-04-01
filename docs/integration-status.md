# Agents CLI Integration Status

Last updated: 2026-04-01

## Current state

The `agents` CLI is now the intended runtime source of truth for agent status.

Recent work focused on three problems:

1. Codex status flapping between `working`, `attention`, and `idle`
2. Split-brain status between `agents` and `agents-app`
3. Unclear ownership between native Pi reporting and Dustbot approval handling

The current model is:

- `agents` owns built-in detection and runtime reconciliation
- `agents-app` consumes reconciled runtime state from `agents`
- Dustbot can contribute supplemental Pi approval state, but does not own Pi lifecycle

## What landed

### Runtime ownership

- Added a clearer runtime contract in `agents`
- Added `agents runtime --json` for app/runtime consumers
- Moved the app toward using CLI runtime snapshots instead of independently reinterpreting raw state files

### Codex

- Codex detection is now hook-first for live status
- Approval prompt recognition was updated for current Codex wording
- Stale `working` cleanup was moved away from immediate screen-scrape override and into slower cleanup logic

### Pi

- Pi now has a stronger built-in reporter in `extensions/pi/dustbot-reporting.ts`
- The reporter tracks:
  - prompt lifecycle via `agent_start` / `agent_end`
  - active streaming via `message_update`
  - active tool work via `tool_execution_start` / `tool_execution_end`
  - user questions via ask-user tool calls
- Pi now writes stronger metadata again:
  - provider
  - model id / label
  - external session id
  - context usage

### Dustbot

- Dustbot no longer writes primary Pi lifecycle state
- Dustbot now reports approval as supplemental auxiliary state only
- This keeps Pi lifecycle ownership in `agents` while still allowing Dustbot approvals to elevate status

### Integration contract / doctor

- Added a shared integration contract in `src/integrations.ts`
- Added and expanded `agents doctor`
- `doctor` now checks:
  - install presence
  - configured event coverage
  - missing lifecycle/metadata capabilities
  - whether installed file-based integrations match the current repo version

## Current ownership model

### Fully owned by `agents`

- Claude native integration
- Codex native integration
- Copilot native integration
- OpenCode native integration
- Pi native integration, excluding approvals that Pi does not support itself

### Supplemental integrations

- Dustbot approval bridge for Pi

Supplemental integrations may raise attention state, but should not replace built-in lifecycle ownership.

## Related commits

### `agents`

- `abc3054` — `Harden agent integrations and Pi runtime reporting`

### `dustbot`

- `d45972d` — `Report Dustbot approvals as Pi auxiliary state`

### `agents-app`

- `a6d3167` — `Use CLI runtime snapshots for app refresh`

## What was verified

### Codex

- App flapping reduced after moving the app to CLI runtime snapshots
- Approval prompts now classify as attention instead of falling back to idle

### Pi

- Live verification against tmux pane `%4622`
- Sent prompts that executed long-running `sleep` commands
- Verified state transitions through the live state file and `agents ls --json`
- Observed:
  - `idle -> working(starting) -> working(thinking) -> working(tool detail) -> idle`

## Remaining concerns

The architecture is in a better place, but it still needs soak time.

Main things to keep watching:

- Codex still behaving correctly in real approval flows
- Pi staying `working` across long-running tool executions
- Dustbot approval overlays not fighting base Pi lifecycle
- App refresh path staying aligned with CLI runtime output

## Next likely steps

1. Soak the current setup in normal app usage and look for real flapping or stale-state regressions.
2. Surface `agents doctor --json` in the app so setup drift is visible where the user actually verifies behavior.
3. Make runtime/debug provenance easier to inspect, for example:
   - primary source
   - inferred metadata
   - auxiliary contributors
4. Continue metadata/recovery work only after the current setup proves stable.

## Architecture review follow-up

The current boundary is still the right one:

- `agents` should remain the runtime source of truth
- `agents-app` should consume the CLI contract, not rebuild detection
- Dustbot should remain a narrow auxiliary contributor for Pi approval

The main issue is not the boundary itself. The issue is that the current runtime path is still heavier and more duplicated than it should be.

### Main findings

1. `agents runtime --json` is not a cheap runtime-only API yet.
   - It still flows through the full scanner and then filters results.
   - This means the app pays for near-full inventory work even during "fast" status refreshes.

2. CLI state loading is repeated too many times within a single scan.
   - Primary and contributor state are reread and remerged through multiple helper paths.
   - This creates unnecessary disk churn and makes the scanner more expensive than needed.

3. The sync and async tmux scan paths have drifted.
   - The sync path has the newer batched process-tree optimization.
   - The async watch path still carries more legacy per-pane subprocess work.

4. The app is consuming only part of the CLI runtime contract.
   - It updates status and context window numbers, but not the fuller runtime/provenance surface.
   - This is better than the previous split-brain model, but still narrower than ideal.

5. Local app refresh does not fully align with contributor state.
   - The app watcher watches `~/.agents/state/`.
   - Auxiliary contributor state also lives in `~/.agents/state-contrib/`.
   - That means supplemental approval overlays may only show up on the slower poll path.

6. Reporter plumbing is duplicated across integrations.
   - `findAgentsBin()` and `agents report` argument assembly are repeated across Pi, Dustbot, Copilot, and OpenCode integrations.
   - This is not the highest-risk issue, but it is clear cleanup debt.

## Implementation checklist

This is the current intended order of work.

### 1. Make runtime cheap in `agents`

- [ ] Refactor state access into a single per-run snapshot/cache.
- [ ] Read primary state and contributor state once per invocation.
- [ ] Merge contributor overlays once and pass the merged view through the scanner/runtime code.
- [ ] Stop using repeated `getAgentState*()` calls that reread disk each time.

### 2. Split inventory from runtime

- [ ] Make `agents runtime --json` a true runtime-only path for known pane IDs.
- [ ] Avoid full inventory/title/model/history work when only status/context refresh is needed.
- [ ] Keep `agents ls --json` as the richer inventory path.
- [ ] Make the app's fast refresh call the cheap runtime path only.

### 3. Reduce scanner drift

- [ ] Unify or clearly centralize tmux scan logic so sync and async paths do not diverge.
- [ ] Preserve the newer batched process-tree optimization.
- [ ] Remove stale legacy helpers once one path is authoritative.

### 4. Tighten app consumption of CLI runtime state

- [ ] Expand the app runtime snapshot model beyond just status and token counts.
- [ ] At minimum consume `detail` and `context` in fast refresh.
- [ ] Consider carrying model/provenance fields through the app model even before UI exposure.

### 5. Fix local contributor-state refresh

- [ ] Update the macOS app watcher to observe both:
  - `~/.agents/state/`
  - `~/.agents/state-contrib/`
- [ ] Verify that auxiliary Pi approval overlays refresh immediately in the app without waiting for polling.

### 6. Deduplicate integration reporting primitives

- [ ] Introduce a shared helper/pattern for locating the `agents` binary in extension environments.
- [ ] Introduce a shared helper/pattern for emitting `agents report` calls.
- [ ] Keep Dustbot's Pi overlay reporting supplemental-only.

### 7. Re-measure before bigger architectural changes

- [ ] Measure local and remote app refresh cost after the runtime split.
- [ ] Measure CLI scan cost after the state snapshot refactor.
- [ ] Only consider a daemon / long-lived service if the simplified runtime path is still too expensive.

## Recommended next concrete slice

Start with step 1 inside `agents`:

1. introduce a single state snapshot/merge layer
2. thread it through scanner/runtime consumers
3. then build the true cheap runtime path on top of that

## Guiding principles going forward

- Hooks and explicit integrations should be authoritative when they exist.
- Screen scraping should be fallback or cleanup, not the primary real-time truth for supported agents.
- The app should consume `agents` runtime state, not invent its own independent status model.
- External tools should contribute narrow supplemental signals, not replace built-in detectors.

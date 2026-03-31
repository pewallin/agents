# Model + Provider Capture Plan

Date: 2026-03-31
Repo: `/Users/peter/code/agents`

## Context

We want the agents dashboard to expose the active **model** and **provider** for each agent pane.

Primary goal:
- capture this from agent-native hooks / SDKs / transcript/session files
- avoid tmux pane scraping whenever possible

Non-goal for now:
- Cursor support (explicitly out of scope for the next pass)

## Current state

The repo already has most of the plumbing for model display:

- `src/cli.ts` accepts `--model`
- `src/state.ts` persists model-like metadata in state files
- `src/scanner.ts` prefers state and falls back to `inferModelFromContent(...)`
- the dashboard UI already displays a model string

This means the next step is mostly about improving the **source of truth** and making the state more structured.

## Recommended metadata shape

Instead of only a single display string, store structured identity:

- `provider?: string`
- `modelId?: string`
- `modelLabel?: string`
- `modelSource?: "hook" | "sdk" | "transcript" | "session-log" | "inferred"`

Keep backward compatibility with the existing display field:
- `model?: string`

Suggested semantics:
- `provider + modelId` = canonical internal identity
- `modelLabel` = presentation-only label if the runtime provides one
- `model` = derived display string or backward-compatible field

Suggested display preference in UI:
1. `provider/modelId`
2. `modelLabel`
3. `modelId`
4. existing `model`

## CLI / state changes

Extend `agents report` to accept structured fields:

- `--provider <id>`
- `--model-id <id>`
- keep `--model <label>` for compatibility
- optionally `--model-source <source>`

Then extend:
- `src/state.ts`
- `src/cli.ts`
- `src/scanner.ts`
- any affected tests

## Capture strategy by agent

### Codex
Best source:
- hook stdin payload in `extensions/codex/report-state.sh`
- hook stdin payload in `extensions/codex/stop-hook.sh`

Status:
- already reports `.model`
- already reports `.session_id`
- likely best live source already exists

Plan:
- keep hook-based reporting as canonical
- capture provider too if available in payload
- if provider is not exposed, leave it blank rather than inventing one
- keep tmux/footer inference only as fallback

### Copilot
Best source:
- SDK events in `extensions/copilot/extension.mjs`

Observed live sources:
- `session.start` -> `selectedModel`
- `session.model_change` -> `newModel`

Observed persisted fallback:
- `~/.copilot/session-state/*/events.jsonl` contains model-bearing events

Plan:
- keep SDK event reporting as canonical
- report `modelId`
- report provider if available from SDK; otherwise leave blank or decide explicitly whether runtime provider should be `github-copilot`
- optional later: persist Copilot `sessionId` as `externalSessionId` to improve recovery/debugging

### Pi
Best source:
- extension context in `extensions/pi/dustbot-reporting.ts`

Observed live source:
- `ctx.model` currently exposes model info

Observed persisted fallback:
- `~/.pi/agent/sessions/...jsonl` contains `model_change` events with `provider` and `modelId`

Plan:
- update Pi reporting to emit structured `provider` + `modelId` + optional label
- if available, also keep `externalSessionId` so scanner recovery can map pane -> Pi session log
- session JSONL is a strong fallback / restart recovery source

### Claude
Best source:
- transcript JSONL keyed by Claude `session_id`

Current state:
- Claude hooks report state and `externalSessionId`
- current scanner already uses transcript JSONL for rename recovery
- current model fallback uses footer inference, which is weaker than transcript parsing

Observed evidence:
- Claude transcript entries contain assistant messages with `message.model`, e.g. `claude-opus-4-6`

Plan:
- add transcript-derived model/provider recovery in scanner using existing `externalSessionId` plumbing
- provider can likely be normalized to `anthropic`
- preferred resolution order for Claude:
  1. state file structured model metadata
  2. transcript-derived provider/model
  3. footer inference

### OpenCode
Best source:
- plugin event stream in `extensions/opencode/index.mjs`

Observed evidence from local SDK types:
- `UserMessage.model` has `{ providerID, modelID }`
- `AssistantMessage` has `providerID` and `modelID`
- `message.updated` events expose `properties.info`

Plan:
- extend OpenCode plugin to capture provider/model from `message.updated`
- report structured metadata through `agents report`
- this should eliminate the need for model scraping for OpenCode entirely

### Cursor
Out of scope for now.

Reason:
- no strong clean per-session source was found quickly
- user no longer uses Cursor as an agent

## Recommended implementation order

### Phase 1 — structured plumbing
1. Extend `agents report` CLI options to include provider/model-id/model-source
2. Extend state file schema in `src/state.ts`
3. Update scanner/UI logic to prefer structured fields and derive display text consistently
4. Add/update tests for state + display selection

### Phase 2 — native reporting sources
5. OpenCode plugin: report `providerID` + `modelID`
6. Pi extension: report structured provider/model
7. Copilot extension: report structured model and provider if available
8. Codex hook scripts: report structured provider/model if available

### Phase 3 — recovery / no-scrape fallbacks
9. Claude scanner: recover provider/model from transcript JSONL using `externalSessionId`
10. Optional: Pi scanner recovery from Pi session JSONL
11. Optional: Copilot scanner recovery from Copilot session-state JSONL

### Phase 4 — cleanup
12. Keep tmux/footer scraping only as a fallback for missing metadata
13. Update docs/tests accordingly

## Files likely to change next

Core:
- `src/cli.ts`
- `src/state.ts`
- `src/scanner.ts`
- `src/scanner.test.ts`
- possibly `src/components/AgentTable.tsx`
- possibly `src/components/Dashboard.tsx`

Hooks / extensions:
- `extensions/opencode/index.mjs`
- `extensions/pi/dustbot-reporting.ts`
- `extensions/copilot/extension.mjs`
- `extensions/codex/report-state.sh`
- `extensions/codex/stop-hook.sh`
- maybe `extensions/claude/state-hook.sh`
- maybe `extensions/claude/stop-hook.sh`

## Current working tree note before continuing

At the time this plan was written, `git status --short` showed:

- `M .beads/issues.jsonl`
- `M AGENTS.md`
- `M src/cli.ts`
- `M src/scanner.test.ts`
- `M src/scanner.ts`
- `M src/setup.ts`
- `?? extensions/codex/`

Before starting the model/provider work, commit the current in-progress metadata work first so the next session starts from a clean baseline.

## Continuation prompt

Use this in the next session:

```text
We just finished research for model/provider capture in the agents repo. Please read `docs/model-provider-capture-plan.md` and continue from there.

Important context:
- Cursor is out of scope for now.
- Provider capture is high priority, not just model display.
- We want agent-native metadata first, transcript/session-log recovery second, tmux scraping only as fallback.
- Before implementing the new work, check whether the current working tree has already been committed; if not, summarize the outstanding changes and pause for commit guidance.

Then implement Phase 1 and Phase 2 from the plan:
1. add structured provider/model fields to CLI + state + scanner
2. implement OpenCode structured provider/model reporting
3. implement Pi structured provider/model reporting
4. update Copilot/Codex reporting where practical
5. keep behavior backward compatible with existing `model` display

Run tests/build after the changes and summarize any follow-up work, especially Claude transcript recovery.
```
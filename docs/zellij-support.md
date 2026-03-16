# Zellij Support Plan

> Requires zellij 0.44+ (built from source at `~/.cargo/bin/zellij`).
> 0.44 adds `--pane-id` to most commands and `list-panes --json`.

## Architecture

Two possible approaches. Both use the same `Multiplexer` interface — only the backend differs.

### Option A: CLI-only (no WASM plugin)

With 0.44's `--pane-id` support on most commands, many operations work directly from the CLI. The missing pieces (focus-by-id, get-pane-pid) can be worked around.

```
Node.js dashboard ──exec──▶ zellij action ... --pane-id terminal_N
```

**Pros:** No Rust build dependency, simpler deployment, same pattern as tmux backend.
**Cons:** No push-based events (must poll), no `get_pane_pid` (use process tree heuristics), focus-by-id requires workaround.

### Option B: CLI + WASM bridge plugin

A small Rust plugin handles operations the CLI can't do. Node.js talks to it via `zellij action pipe`.

```
Node.js dashboard ──pipe──▶ WASM bridge plugin ──▶ zellij plugin API
                   ◀─stdout─                    ◀── events (PaneUpdate, etc.)
```

**Pros:** Push-based pane updates, `get_pane_pid`, focus-by-id, richer API.
**Cons:** Rust build dependency (mitigated by shipping pre-built WASM).

### Recommendation: Start with Option A, add plugin later if needed.

Option A covers discovery, screen capture, pane creation/destruction, and the preview model. The plugin can be added incrementally for PID access and push events.

### Multiplexer abstraction

```
src/
  multiplexer.ts        — interface definition + auto-detection
  mux-tmux.ts           — tmux backend (extract from scanner.ts)
  mux-zellij.ts         — zellij backend (CLI-based)
  bridge-plugin/        — (future) Rust WASM plugin source
```

## Multiplexer Interface

```typescript
interface PaneInfo {
  id: string;           // "%5" (tmux) or "terminal_5" (zellij)
  title: string;
  command: string;      // current foreground (tmux) or initial command (zellij)
  cwd: string;
  pid: number | null;   // pane process PID
  tab: string;          // window name (tmux) or tab name (zellij)
  session: string;
  focused: boolean;
  geometry: { x: number; y: number; width: number; height: number };
}

interface Multiplexer {
  // Discovery
  listPanes(): PaneInfo[]
  getPaneContent(paneId: string, lines?: number): string

  // Pane operations
  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string
  closePane(paneId: string): void
  focusPane(paneId: string): void
  resizePane(paneId: string, dimension: "width" | "height", value: number): void

  // Preview model
  // tmux: swap-pane + placeholder
  // zellij: new-pane --in-place (suppress/restore)
  replaceWithPlaceholder(paneId: string): string   // returns placeholder ID
  restoreFromPlaceholder(paneId: string): void

  // Tab/window management
  createTab(name: string, cmd: string, cwd?: string, session?: string): string
  closeTab(tabId: string): void
  renameTab(tabId: string, name: string): void

  // Session
  listSessions(): string[]
  ownPaneId(): string

  // Floating (zellij-specific, no-op on tmux)
  floatPane(paneId: string, coords?: { x: number; y: number; width: number; height: number }): void
  embedPane(paneId: string): void
}
```

## 0.44 CLI Feature Matrix

| Operation | CLI command | `--pane-id` support |
|-----------|-----------|-------------------|
| List panes | `list-panes --all --json` | N/A (lists all) |
| List tabs | `list-tabs --all --json` | N/A |
| Dump screen | `dump-screen --pane-id X` | ✅ |
| Close pane | `close-pane --pane-id X` | ✅ |
| Move pane | `move-pane --pane-id X <dir>` | ✅ |
| Resize pane | `resize --pane-id X increase/decrease <dir>` | ✅ (relative only) |
| Rename pane | `rename-pane --pane-id X <name>` | ✅ |
| Float/embed | `toggle-pane-embed-or-floating --pane-id X` | ✅ |
| Float coords | `change-floating-pane-coordinates --pane-id X` | ✅ |
| New pane | `new-pane --direction <dir>` | returns new pane ID |
| New pane in-place | `new-pane --in-place` | replaces focused pane |
| Focus pane | `move-focus <dir>` | ❌ (direction only) |
| Get PID | N/A | ❌ (plugin API only) |
| New tab | `new-tab --name X --cwd Y` | N/A |
| Close tab | `close-tab` | N/A |
| Query tabs | `query-tab-names` | N/A |
| Dump layout | `dump-layout` | N/A (KDL format) |
| List sessions | `list-sessions --short` | N/A |

## Concept Mapping

| Concept | tmux | zellij 0.44 |
|---------|------|-------------|
| Session | session | session |
| Window | window | tab |
| Pane ID | `%N` | `terminal_N` |
| Pane discovery | `list-panes -a -F ...` | `list-panes --all --json` |
| Pane PID | `#{pane_pid}` | Plugin only. Workaround: `ps -t <tty>` or walk process tree from tab command. |
| Screen capture | `capture-pane -t %N -p` | `dump-screen --pane-id terminal_N` (to stdout) |
| Create split | `split-window -h/-v -t %N` | `new-pane --direction right/down` (returns ID) |
| Close pane | `kill-pane -t %N` | `close-pane --pane-id terminal_N` |
| Focus by ID | `select-pane -t %N` | No CLI equivalent. Workaround: float then embed (`toggle-pane-embed-or-floating --pane-id`). |
| Swap/preview | `swap-pane -s A -t B` | `new-pane --in-place` (suppress/restore). Focus target first, then `--in-place` replaces it. |
| Absolute resize | `resize-pane -x W` | Not available. Use relative `resize increase/decrease` or layout override. |
| New window/tab | `new-window -n name` | `new-tab --name name --cwd path` |
| Kill window/tab | `kill-window -t X` | `close-tab` (focused tab only). |
| Env variables | `set-environment` / `show-environment` | Not available. Use temp files. |
| Mouse | SGR escape sequences | Same (passthrough when pane captures mouse). |

## Preview Model

### tmux (current)
1. Create placeholder pane via `split-window`
2. `swap-pane -s agent -t placeholder` — agent moves to dashboard, placeholder moves to agent's window
3. Show message in placeholder
4. Teardown: swap back, kill placeholder

### zellij
1. Focus the agent pane (workaround: float/embed cycle, or use `write-chars` to the pane)
2. `new-pane --in-place -- tail -f /dev/null` — suppresses agent, shows placeholder in its position
3. Agent is now suppressed (hidden but running)
4. In the dashboard tab, create a split and `dump-screen --pane-id terminal_N` to show agent content
5. Teardown: close the placeholder → agent auto-restores

**Alternative (simpler):** Use floating panes for preview.
1. `toggle-pane-embed-or-floating --pane-id terminal_N` — float the agent pane
2. `change-floating-pane-coordinates --pane-id terminal_N --x ... --y ... --width ... --height ...` — position it over the dashboard
3. Teardown: `toggle-pane-embed-or-floating --pane-id terminal_N` — embed it back

The floating approach is simpler and avoids suppress/restore entirely. The pane is live (not a screen dump), and positioning is exact. Downside: floating panes have a border/chrome.

## Grid View

### Floating pane approach
1. For each agent in the grid, float it: `toggle-pane-embed-or-floating --pane-id terminal_N`
2. Position with `change-floating-pane-coordinates` using the grid geometry from `computeGeometry()`
3. Pin them: `--pinned true`
4. Teardown: embed each pane back

This gives a true live grid — no content capture, actual panes. Each grid cell is a real pane the user can interact with.

### Screen capture approach (fallback)
If floating doesn't work well (z-ordering issues, etc.), fall back to periodic `dump-screen --pane-id` and render content in the dashboard's own pane.

## Open Questions

- **Focus by pane ID:** No direct CLI support. The float/embed toggle is a workaround but changes the pane's float state. An alternative: the plugin API's `focus_terminal_pane(id)` is the clean solution. Worth adding the bridge plugin just for this.
- **Absolute resize:** Only relative in CLI. For grid cells, compute the delta from current size and apply incremental resizes. Or use the floating pane approach which has absolute coordinates.
- **Cross-session scanning:** `list-panes` works per-session. Iterate `list-sessions --short` and run `zellij --session <name> action list-panes` for each.
- **PID detection:** Plugin API has `get_pane_pid`. Without the plugin, use `ps` + process tree heuristics matching `terminal_command` from `list-panes`.
- **Close tab by ID:** CLI only closes the focused tab. May need to `go-to-tab N` first, or use the plugin API.
- **Plugin distribution:** WASM is platform-independent — ship pre-built binary in the npm package.

## Implementation Phases

### Phase 1: Multiplexer interface + tmux extraction
1. Define `Multiplexer` interface in `src/multiplexer.ts`
2. Extract tmux operations from `scanner.ts`, `grid.ts`, `zones.ts`, `workspace.ts` into `mux-tmux.ts`
3. Auto-detect: `ZELLIJ_SESSION_NAME` → zellij, `TMUX` → tmux
4. Verify everything works unchanged with the tmux backend

### Phase 2: Zellij CLI backend (core)
1. Implement `mux-zellij.ts` using 0.44 CLI
2. `listPanes` → `list-panes --all --json`
3. `getPaneContent` → `dump-screen --pane-id`
4. `createSplit` → `new-pane --direction`
5. `closePane` → `close-pane --pane-id`
6. `createTab` / `renameTab` → `new-tab` / `rename-tab`
7. Test: basic agent discovery and status detection in zellij

### Phase 3: Preview in zellij
1. Implement `replaceWithPlaceholder` using `new-pane --in-place` OR floating pane approach
2. POC both approaches, pick the one that works better
3. Implement `restoreFromPlaceholder`
4. Test preview open/switch/close cycle

### Phase 4: Grid view in zellij
1. Implement grid using floating panes with `change-floating-pane-coordinates`
2. Use `computeGeometry()` (already tested) for positioning
3. Test with 2, 5, 12 agents
4. Handle teardown (embed all back)

### Phase 5: Workspace + polish
1. Adapt workspace creation for zellij (tabs instead of windows)
2. Handle helper zones (find sibling panes in same tab)
3. Agent PID detection — heuristic or bridge plugin
4. Edge cases: pane death, session disconnect, cross-session scanning

### Future: Bridge plugin
Add when CLI workarounds become too fragile:
- Focus pane by ID
- PID access
- Push-based pane updates (no polling)
- Close tab by ID

## Effort Estimate

| Phase | Effort |
|-------|--------|
| 1. Multiplexer interface + tmux extraction | 1-2 days |
| 2. Zellij CLI backend (core) | 1-2 days |
| 3. Preview in zellij (POC + implement) | 2-3 days |
| 4. Grid view in zellij | 1-2 days |
| 5. Workspace + polish | 1-2 days |
| **Total** | **~1.5 weeks** |

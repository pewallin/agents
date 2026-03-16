# Zellij Support Plan

## Architecture

```
Node.js dashboard ──pipe──▶ WASM bridge plugin ──▶ zellij plugin API
                   ◀─stdout─                    ◀── events (PaneUpdate, etc.)
```

The dashboard talks to a small Rust WASM plugin via `zellij action pipe`. The plugin handles all zellij-specific operations and exposes them as JSON request/response over the pipe interface.

### Multiplexer abstraction

Introduce a `Multiplexer` interface in the Node.js codebase. tmux and zellij backends implement it. The dashboard and scanner use the interface, never calling tmux/zellij directly.

```
src/
  multiplexer.ts        — interface definition
  multiplexer-tmux.ts   — tmux backend (extract from scanner.ts)
  multiplexer-zellij.ts — zellij backend (pipe to WASM plugin)
  bridge-plugin/        — Rust WASM plugin source
```

## Multiplexer Interface

```typescript
interface Multiplexer {
  // Discovery
  listPanes(): PaneInfo[]
  getPanePid(paneId: string): number | null
  getPaneContent(paneId: string, lines?: number): string
  
  // Pane operations  
  createSplit(targetPaneId: string, direction: string, size?: string): string
  closePane(paneId: string): void
  focusPane(paneId: string): void
  
  // Preview (swap model)
  suppressPane(paneId: string): string   // returns placeholder ID
  restorePane(paneId: string): void
  
  // Window/tab management
  createWindow(name: string, cmd: string, cwd?: string): string
  closeWindow(windowId: string): void
  
  // Metadata
  ownPaneId(): string
  getPaneWidth(paneId: string): number
  resizePane(paneId: string, width: number): void
}
```

## Concept Mapping

| Concept | tmux | zellij |
|---------|------|--------|
| Session | session | session |
| Window | window | tab |
| Pane | pane (`%N`) | pane (`terminal_N`) |
| Pane discovery | `list-panes -a -F ...` | Plugin `PaneUpdate` event → `PaneManifest` |
| Pane PID | `#{pane_pid}` | Plugin `get_pane_pid(pane_id)` |
| Screen capture | `capture-pane -p` | `dump-screen` CLI or plugin `PaneRenderReport` |
| Create split | `split-window -h/-v` | `new-pane --direction right/down` |
| Close pane | `kill-pane -t` | `close-pane` or plugin `close_pane_with_id` |
| Focus pane | `select-pane -t` | Plugin `focus_terminal_pane(id)` |
| Swap/preview | `swap-pane -s A -t B` | Plugin `open_command_pane_in_place_of_pane_id` (suppress/restore) |
| Hide pane | N/A | Plugin `hide_pane_with_id` |
| Show pane | N/A | Plugin `show_pane_with_id` |
| New window | `new-window -n name` | `new-tab --name name` |
| Kill window | `kill-window` | `close-tab` |
| Pane title | `#{pane_title}` | `PaneInfo.title` |
| Running command | `#{pane_current_command}` | `PaneInfo.terminal_command` (initial only) |
| Resize (absolute) | `resize-pane -x W` | Not available — relative only via CLI. Plugin workaround: `resize` in a loop or use layout override. |
| Env variables | `set-environment` / `show-environment` | Not available — use temp files. |
| Mouse | SGR escape sequences | Same (passthrough in locked mode or when pane captures mouse). |

## Preview Model Difference

**tmux:** Swap pane A into the dashboard window, put a placeholder where A was. Swap back on teardown.

**zellij:** Suppress pane A (it stays in its tab but becomes invisible). Open a placeholder in A's position. In the dashboard, either:
- Use `dump-screen --pane-id` to capture A's content and render it inline (picture-in-picture), or
- Float pane A over the dashboard area using `show_pane_with_id(floating=true)` with coordinates

To restore: close the placeholder → A auto-restores. Or `show_pane_with_id(floating=false)`.

The suppress/restore model is actually cleaner than tmux's swap — panes don't physically move between windows, they just get hidden/shown.

## Bridge Plugin

~200-300 lines of Rust. Subscribes to events, responds to pipe messages.

### Commands (Node.js → plugin via `zellij action pipe`)

```
list-panes              → JSON array of PaneInfo (all tabs)
get-pane-pid <id>       → pid (integer)
get-pane-content <id>   → pane text content
suppress-pane <id>      → placeholder pane ID
restore-pane <id>       → ok
focus-pane <id>         → ok
hide-pane <id>          → ok
show-pane <id> [float]  → ok
move-pane <id> <dir>    → ok
close-pane <id>         → ok
```

### Events (plugin → Node.js, streamed)

The plugin can push pane updates via pipe stdout when subscribed to `PaneUpdate` events. This enables reactive scanning instead of polling.

### Build

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/agents_bridge.wasm ~/.config/zellij/plugins/
```

### Invocation

```bash
# Launch plugin (once per session)
zellij action launch-plugin file:~/.config/zellij/plugins/agents_bridge.wasm

# Send commands
zellij action pipe --plugin file:agents_bridge.wasm --name cmd -- '{"op":"list-panes"}'

# Stream pane content
zellij action pipe --plugin file:agents_bridge.wasm --name subscribe -- '{"pane_id":"terminal_1"}'
```

## Implementation Phases

### Phase 1: Multiplexer abstraction
1. Define `Multiplexer` interface in `src/multiplexer.ts`
2. Extract tmux calls from `scanner.ts` into `multiplexer-tmux.ts`
3. Update scanner, grid, zones, workspace to use the interface
4. Verify everything works unchanged

### Phase 2: Bridge plugin
1. Scaffold Rust WASM plugin in `bridge-plugin/`
2. Implement `list-panes` (subscribe to `PaneUpdate`, respond to pipe)
3. Implement `get-pane-pid`
4. Implement `get-pane-content` (via `PaneRenderReport` subscription)
5. Implement suppress/restore/hide/show/focus/close
6. Build and test manually in a zellij session

### Phase 3: Zellij backend
1. Implement `multiplexer-zellij.ts` — talks to bridge plugin via `zellij action pipe`
2. Auto-detect multiplexer (`ZELLIJ_SESSION_NAME` vs `TMUX` env var)
3. Handle differences: relative resize, no env vars, tab vs window naming
4. Test pane discovery and status detection

### Phase 4: Preview and grid
1. Implement preview using suppress/restore model
2. Implement grid using zellij's `new-pane --direction` + suppress
3. Test helper zones (may need adaptation — suppress instead of swap)
4. Verify teardown restores all panes

### Phase 5: Workspace creation
1. Adapt `workspace.ts` to use multiplexer interface
2. Handle zellij layout files vs tmux split commands
3. Test `agents ws` in zellij

## Open Questions

- **Absolute resize:** Zellij only supports relative resize from CLI. The plugin API may have more options. Alternatively, use `dump-layout` / layout override to set exact sizes.
- **Cross-session scanning:** `zellij action pipe` targets the current session. Scanning all sessions requires either iterating `zellij list-sessions` or running one plugin per session.
- **Plugin distribution:** Ship pre-built WASM binary in the npm package, or require users to have Rust toolchain? Pre-built is strongly preferred.
- **Current foreground command:** `PaneInfo.terminal_command` is the initial command, not the current foreground process. PID-based detection (`get_pane_pid` → `pgrep`/`ps`) works but adds complexity.

## Effort Estimate

| Phase | Effort |
|-------|--------|
| 1. Multiplexer abstraction | 1-2 days |
| 2. Bridge plugin (Rust) | 2-3 days |
| 3. Zellij backend | 2-3 days |
| 4. Preview and grid | 2-3 days |
| 5. Workspace creation | 1 day |
| Testing and polish | 2-3 days |
| **Total** | **~2 weeks** |

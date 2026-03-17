# agents-bridge — Zellij WASM Plugin

Bridge plugin that exposes zellij's plugin API to the Node.js dashboard via the pipe mechanism.

## Why a plugin?

Zellij's CLI (0.44+) covers most operations, but some require the plugin API:
- **Focus pane by ID** — CLI only has directional focus (`move-focus left/right`)
- **Cross-tab pane movement** — `break_panes_to_tab_with_index` (the core preview mechanism)
- **Get pane PID** — `get_pane_pid` (needed for agent process detection)
- **Reactive pane updates** — `PaneUpdate` events (push-based instead of polling)

## Build

```bash
# Requires wasm32-wasip1 target
rustup target add wasm32-wasip1

cd bridge-plugin
cargo build --target wasm32-wasip1 --release
# Output: target/wasm32-wasip1/release/agents-bridge.wasm (~1.6MB)
```

## Plugin structure

Zellij plugins are **binaries** (not libraries):
- Use `src/main.rs` (NOT `src/lib.rs`)
- No `[lib]` or `crate-type` in Cargo.toml
- The `register_plugin!` macro generates `#[no_mangle]` exports: `load`, `update`, `pipe`, `render`, `plugin_version`

```rust
use zellij_tile::prelude::*;

#[derive(Default)]
struct MyPlugin;

register_plugin!(MyPlugin);

impl ZellijPlugin for MyPlugin {
    fn load(&mut self, _config: BTreeMap<String, String>) { /* ... */ }
    fn update(&mut self, event: Event) -> bool { false }
    fn pipe(&mut self, msg: PipeMessage) -> bool { false }
}
```

## Pipe communication

The Node.js dashboard sends commands via `zellij action pipe`:

```bash
zellij action pipe \
  --plugin file:/path/to/agents-bridge.wasm \
  --name <command> \
  -- <payload>
```

### Critical: pipe_id routing

The CLI generates a unique `pipe_id` per invocation. The plugin receives this in `PipeSource::Cli(pipe_id)`. When responding, you MUST use this `pipe_id` (not the message `name`) for both `cli_pipe_output` and `unblock_cli_pipe_input`:

```rust
fn pipe(&mut self, msg: PipeMessage) -> bool {
    // Extract the CLI's pipe_id — this is what routes the response back
    let pipe_id = match &msg.source {
        PipeSource::Cli(id) => id.clone(),
        _ => msg.name.clone(), // fallback
    };

    let response = handle_command(&msg.name, &msg.payload);

    cli_pipe_output(&pipe_id, &response);      // send response to CLI stdout
    unblock_cli_pipe_input(&pipe_id);           // let CLI exit
    false
}
```

If you use `msg.name` instead of the `pipe_id`, the CLI hangs forever — the response goes nowhere.

## Permissions

The plugin must request permissions in `load()`:

```rust
request_permission(&[
    PermissionType::ReadApplicationState,   // PaneUpdate, TabUpdate events
    PermissionType::ChangeApplicationState, // focus, break-pane, close-pane
    PermissionType::RunCommands,            // run shell commands
    PermissionType::ReadCliPipes,           // cli_pipe_output (REQUIRED for responses!)
]);
```

**On first load, zellij shows a y/n permission prompt in the UI.** The user must grant permissions before the plugin works. This means:
- The first `zellij action pipe` call will hang until permissions are granted
- Auto-granting is not supported in zellij config (as of 0.44)
- Workaround: launch the plugin explicitly first (`zellij action launch-plugin`) and grant permissions, then pipe commands work

## Commands

| Command | Payload | Args | Response |
|---------|---------|------|----------|
| `ping` | (empty) | — | `pong` |
| `list-panes` | (empty) | — | JSON array of pane objects |
| `get-pane-pid` | `terminal_N` | — | `{"pid": 12345}` |
| `focus-pane` | `terminal_N` | — | `{"ok": true}` |
| `break-pane-to-tab` | `terminal_N` | `tab_index=N,focus=true/false` | `{"ok": true}` |
| `close-pane` | `terminal_N` | — | `{"ok": true}` |

### Pane IDs

Format: `terminal_N` (for terminal panes) or `plugin_N` (for plugin panes). Bare integers are treated as terminal IDs.

### list-panes response

```json
[
  {
    "id": "terminal_0",
    "title": "Pane #1",
    "command": "/bin/zsh",
    "tab_index": 0,
    "tab_name": "Tab #1",
    "focused": true,
    "suppressed": false,
    "x": 1, "y": 1, "w": 83, "h": 69
  }
]
```

## Event subscriptions

The plugin subscribes to `PaneUpdate` and `TabUpdate` events. These are cached internally and returned by `list-panes`. Events fire whenever panes or tabs change (created, closed, resized, focused).

## Key zellij API patterns

### Cross-tab pane movement
```rust
break_panes_to_tab_with_index(&[PaneId::Terminal(id)], tab_index, should_focus)
```
Returns `Some(tab_index)` on success, `None` on failure. This physically moves the pane to another tab — it takes on the new geometry and is fully interactive. If the source tab becomes empty, it's automatically closed.

### Suppress/restore
```rust
// Open a new pane in place of an existing one (suppresses the original)
open_command_pane_in_place_of_pane_id(pane_id, command, close_replaced_pane: false)
// When the new pane closes, the original auto-restores
```

### Focus by ID
```rust
focus_terminal_pane(id, should_float_if_hidden: true, should_be_in_place_if_hidden: false)
```

## Development tips

- Use `--skip-plugin-cache` when iterating: `zellij action launch-plugin file:./target/...wasm --floating --skip-plugin-cache`
- Plugin stderr goes to zellij's log (check `~/Library/Caches/org.Zellij-Contributors.Zellij/`)
- The zellij-tile crate version must match the zellij binary version. For 0.44, use the git checkout: `zellij-tile = { git = "https://github.com/zellij-org/zellij", rev = "a1e2247" }`

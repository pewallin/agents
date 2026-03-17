use std::collections::BTreeMap;
use zellij_tile::prelude::*;

#[derive(Default)]
struct AgentsBridge {
    pane_manifest: Option<PaneManifest>,
    tab_info: Vec<TabInfo>,
}

register_plugin!(AgentsBridge);

impl ZellijPlugin for AgentsBridge {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::RunCommands,
            PermissionType::ReadCliPipes,
        ]);
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
        ]);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PaneUpdate(manifest) => {
                self.pane_manifest = Some(manifest);
            }
            Event::TabUpdate(tabs) => {
                self.tab_info = tabs;
            }
            _ => {}
        }
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        // Extract the CLI pipe_id from the source — this is what cli_pipe_output
        // and unblock_cli_pipe_input need to match against.
        let pipe_id = match &pipe_message.source {
            PipeSource::Cli(id) => id.clone(),
            _ => pipe_message.name.clone(), // fallback for non-CLI sources
        };

        let response = match pipe_message.name.as_str() {
            "ping" => "pong".to_string(),
            "list-panes" => self.list_panes_json(),
            "get-pane-pid" => {
                let payload = pipe_message.payload.unwrap_or_default();
                self.get_pane_pid_json(&payload)
            }
            "focus-pane" => {
                let payload = pipe_message.payload.unwrap_or_default();
                self.focus_pane_cmd(&payload)
            }
            "break-pane-to-tab" => {
                let payload = pipe_message.payload.unwrap_or_default();
                self.break_pane_cmd(&payload, &pipe_message.args)
            }
            "close-pane" => {
                let payload = pipe_message.payload.unwrap_or_default();
                self.close_pane_cmd(&payload)
            }
            "resize-pane" => {
                let payload = pipe_message.payload.unwrap_or_default();
                self.resize_pane_cmd(&payload, &pipe_message.args)
            }
            _ => format!("{{\"error\":\"unknown command: {}\"}}", pipe_message.name),
        };
        cli_pipe_output(&pipe_id, &response);
        unblock_cli_pipe_input(&pipe_id);
        false
    }
}

fn parse_terminal_id(s: &str) -> Option<u32> {
    let s = s.trim();
    if let Some(id) = s.strip_prefix("terminal_") {
        id.parse().ok()
    } else {
        s.parse().ok()
    }
}

impl AgentsBridge {
    fn list_panes_json(&self) -> String {
        let manifest = match &self.pane_manifest {
            Some(m) => m,
            None => return "[]".to_string(),
        };
        let mut parts: Vec<String> = Vec::new();
        for (tab_pos, panes) in &manifest.panes {
            let tab = self.tab_info
                .iter()
                .find(|t| t.position == *tab_pos);
            let tab_name = tab.map(|t| t.name.as_str()).unwrap_or("?");
            let tab_id = tab.map(|t| t.tab_id).unwrap_or(0);
            for p in panes {
                if p.is_plugin { continue; }
                let cmd = p.terminal_command.as_deref().unwrap_or("");
                // Include PID inline — avoids N separate get-pane-pid calls
                let pid = get_pane_pid(PaneId::Terminal(p.id))
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|_| "null".to_string());
                parts.push(format!(
                    "{{\"id\":\"terminal_{}\",\"title\":{},\"command\":{},\"pid\":{},\"tab_index\":{},\"tab_id\":{},\"tab_name\":{},\"focused\":{},\"suppressed\":{},\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}",
                    p.id,
                    json_str(&p.title),
                    json_str(cmd),
                    pid,
                    tab_pos,
                    tab_id,
                    json_str(tab_name),
                    p.is_focused,
                    p.is_suppressed,
                    p.pane_content_x, p.pane_content_y,
                    p.pane_content_columns, p.pane_content_rows,
                ));
            }
        }
        format!("[{}]", parts.join(","))
    }

    fn get_pane_pid_json(&self, payload: &str) -> String {
        let id = match parse_terminal_id(payload) {
            Some(id) => id,
            None => return format!("{{\"error\":\"bad pane id: {}\"}}", payload.trim()),
        };
        match get_pane_pid(PaneId::Terminal(id)) {
            Ok(pid) => format!("{{\"pid\":{}}}", pid),
            Err(e) => format!("{{\"error\":{}}}", json_str(&e)),
        }
    }

    fn focus_pane_cmd(&self, payload: &str) -> String {
        let id = match parse_terminal_id(payload) {
            Some(id) => id,
            None => return format!("{{\"error\":\"bad pane id\"}}"),
        };
        focus_terminal_pane(id, true, false);
        "{\"ok\":true}".to_string()
    }

    fn break_pane_cmd(&self, payload: &str, args: &BTreeMap<String, String>) -> String {
        let id = match parse_terminal_id(payload) {
            Some(id) => id,
            None => return format!("{{\"error\":\"bad pane id\"}}"),
        };
        let focus = args.get("focus").map(|s| s == "true").unwrap_or(false);

        // Prefer tab_id (stable) over tab_index (shifts when tabs are created/destroyed)
        let result = if let Some(tab_id) = args.get("tab_id").and_then(|s| s.parse::<u64>().ok()) {
            break_panes_to_tab_with_id(&[PaneId::Terminal(id)], tab_id as usize, focus)
        } else if let Some(tab_index) = args.get("tab_index").and_then(|s| s.parse::<usize>().ok()) {
            break_panes_to_tab_with_index(&[PaneId::Terminal(id)], tab_index, focus)
        } else {
            return format!("{{\"error\":\"missing tab_id or tab_index\"}}");
        };
        match result {
            Some(_) => "{\"ok\":true}".to_string(),
            None => "{\"error\":\"break_panes failed\"}".to_string(),
        }
    }

    fn close_pane_cmd(&self, payload: &str) -> String {
        let id = match parse_terminal_id(payload) {
            Some(id) => id,
            None => return format!("{{\"error\":\"bad pane id\"}}"),
        };
        close_terminal_pane(id);
        "{\"ok\":true}".to_string()
    }

    /// Resize a pane to an absolute width or height.
    /// Args: width=N and/or height=N (columns/rows).
    /// Uses the pane manifest to compute delta, then calls resize_pane_with_id in a loop.
    /// Deterministic resize: set exact pane width/height using a feedback loop.
    /// Args: width=N and/or height=N (target content columns/rows).
    /// Uses get_pane_info for synchronous geometry checks between resize steps.
    fn resize_pane_cmd(&self, payload: &str, args: &BTreeMap<String, String>) -> String {
        let id = match parse_terminal_id(payload) {
            Some(id) => id,
            None => return format!("{{\"error\":\"bad pane id\"}}"),
        };
        let pane_id = PaneId::Terminal(id);

        // Width resize with feedback loop
        if let Some(target_w) = args.get("width").and_then(|s| s.parse::<usize>().ok()) {
            for _ in 0..50 { // safety cap
                let info = match get_pane_info(pane_id) {
                    Some(info) => info,
                    None => break,
                };
                let cur = info.pane_content_columns;
                if cur == target_w { break; }
                let resize = if cur < target_w { Resize::Increase } else { Resize::Decrease };
                let strategy = ResizeStrategy {
                    resize,
                    direction: Some(Direction::Right),
                    invert_on_boundaries: true,
                };
                resize_pane_with_id(strategy, pane_id);
            }
        }

        // Height resize with feedback loop
        if let Some(target_h) = args.get("height").and_then(|s| s.parse::<usize>().ok()) {
            for _ in 0..50 {
                let info = match get_pane_info(pane_id) {
                    Some(info) => info,
                    None => break,
                };
                let cur = info.pane_content_rows;
                if cur == target_h { break; }
                let resize = if cur < target_h { Resize::Increase } else { Resize::Decrease };
                let strategy = ResizeStrategy {
                    resize,
                    direction: Some(Direction::Down),
                    invert_on_boundaries: true,
                };
                resize_pane_with_id(strategy, pane_id);
            }
        }

        format!("{{\"ok\":true}}")
    }

    fn get_pane_geometry(&self, terminal_id: u32) -> Option<(usize, usize)> {
        let manifest = self.pane_manifest.as_ref()?;
        for (_tab_pos, panes) in &manifest.panes {
            for p in panes {
                if !p.is_plugin && p.id == terminal_id {
                    return Some((p.pane_content_columns, p.pane_content_rows));
                }
            }
        }
        None
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < '\x20' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

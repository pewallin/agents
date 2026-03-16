use serde::Serialize;
use serde_json::{self, Value};
use std::collections::BTreeMap;
use zellij_tile::prelude::*;

#[derive(Default)]
struct AgentsBridge {
    /// Cached pane manifest from last PaneUpdate event
    pane_manifest: Option<PaneManifest>,
    /// Tab info from last TabUpdate event
    tab_info: Vec<TabInfo>,
    /// Our own pane ID
    own_pane_id: Option<u32>,
}

#[derive(Serialize)]
struct PaneInfoJson {
    id: String,
    title: String,
    command: Option<String>,
    tab_index: usize,
    tab_name: String,
    focused: bool,
    is_floating: bool,
    is_suppressed: bool,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

#[derive(Serialize)]
struct PidResponse {
    pane_id: String,
    pid: i32,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pane_id: Option<String>,
}

impl OkResponse {
    fn success() -> Self {
        Self { ok: true, error: None, pane_id: None }
    }
    fn with_pane_id(pane_id: String) -> Self {
        Self { ok: true, error: None, pane_id: Some(pane_id) }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, error: Some(msg.into()), pane_id: None }
    }
}

fn pane_id_str(id: u32, is_plugin: bool) -> String {
    if is_plugin {
        format!("plugin_{}", id)
    } else {
        format!("terminal_{}", id)
    }
}

fn parse_pane_id(s: &str) -> Option<PaneId> {
    if let Some(id) = s.strip_prefix("terminal_") {
        id.parse().ok().map(PaneId::Terminal)
    } else if let Some(id) = s.strip_prefix("plugin_") {
        id.parse().ok().map(PaneId::Plugin)
    } else {
        // Bare integer = terminal
        s.parse().ok().map(PaneId::Terminal)
    }
}

register_plugin!(AgentsBridge);

impl ZellijPlugin for AgentsBridge {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // Subscribe to pane and tab updates for discovery
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
        ]);
        // Request permission for all operations we need
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::RunCommands,
        ]);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PaneUpdate(manifest) => {
                self.pane_manifest = Some(manifest);
                false
            }
            Event::TabUpdate(tabs) => {
                self.tab_info = tabs;
                false
            }
            _ => false,
        }
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        let payload = pipe_message.payload.unwrap_or_default();
        let response = self.handle_command(&pipe_message.name, &payload, &pipe_message.args);
        // Send response back through the pipe
        cli_pipe_output(&pipe_message.name, &response);
        // Unblock the CLI pipe so `zellij action pipe` returns
        unblock_cli_pipe_input(&pipe_message.name);
        false
    }
}

impl AgentsBridge {
    fn handle_command(&mut self, name: &str, payload: &str, args: &BTreeMap<String, String>) -> String {
        match name {
            "list-panes" => self.cmd_list_panes(),
            "get-pane-pid" => self.cmd_get_pane_pid(payload),
            "focus-pane" => self.cmd_focus_pane(payload),
            "break-pane-to-tab" => self.cmd_break_pane_to_tab(payload, args),
            "close-pane" => self.cmd_close_pane(payload),
            "own-pane-id" => self.cmd_own_pane_id(),
            _ => serde_json::to_string(&OkResponse::err(format!("unknown command: {}", name))).unwrap(),
        }
    }

    fn cmd_list_panes(&self) -> String {
        let manifest = match &self.pane_manifest {
            Some(m) => m,
            None => return "[]".to_string(),
        };

        let mut result: Vec<PaneInfoJson> = Vec::new();

        for (tab_index, panes) in &manifest.panes {
            let tab_name = self.tab_info
                .iter()
                .find(|t| t.position == *tab_index)
                .map(|t| t.name.clone())
                .unwrap_or_else(|| format!("Tab #{}", tab_index));

            for pane in panes {
                // Skip plugin panes (status bar, tab bar, etc.)
                if pane.is_plugin {
                    continue;
                }
                result.push(PaneInfoJson {
                    id: pane_id_str(pane.id, pane.is_plugin),
                    title: pane.title.clone(),
                    command: pane.terminal_command.clone(),
                    tab_index: *tab_index,
                    tab_name: tab_name.clone(),
                    focused: pane.is_focused,
                    is_floating: pane.is_floating,
                    is_suppressed: pane.is_suppressed,
                    x: pane.pane_content_x,
                    y: pane.pane_content_y,
                    width: pane.pane_content_columns,
                    height: pane.pane_content_rows,
                });
            }
        }

        serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
    }

    fn cmd_get_pane_pid(&self, payload: &str) -> String {
        let pane_id = match parse_pane_id(payload.trim()) {
            Some(id) => id,
            None => return serde_json::to_string(&OkResponse::err("invalid pane_id")).unwrap(),
        };
        match get_pane_pid(pane_id) {
            Ok(pid) => serde_json::to_string(&PidResponse {
                pane_id: payload.trim().to_string(),
                pid,
            }).unwrap(),
            Err(e) => serde_json::to_string(&OkResponse::err(e)).unwrap(),
        }
    }

    fn cmd_focus_pane(&self, payload: &str) -> String {
        let pane_id = match parse_pane_id(payload.trim()) {
            Some(id) => id,
            None => return serde_json::to_string(&OkResponse::err("invalid pane_id")).unwrap(),
        };
        match pane_id {
            PaneId::Terminal(id) => focus_terminal_pane(id, true, false),
            PaneId::Plugin(id) => focus_plugin_pane(id, true, false),
        }
        serde_json::to_string(&OkResponse::success()).unwrap()
    }

    fn cmd_break_pane_to_tab(&self, payload: &str, args: &BTreeMap<String, String>) -> String {
        let pane_id = match parse_pane_id(payload.trim()) {
            Some(id) => id,
            None => return serde_json::to_string(&OkResponse::err("invalid pane_id")).unwrap(),
        };
        let tab_index: usize = match args.get("tab_index") {
            Some(s) => match s.parse() {
                Ok(v) => v,
                Err(_) => return serde_json::to_string(&OkResponse::err("invalid tab_index")).unwrap(),
            },
            None => return serde_json::to_string(&OkResponse::err("missing tab_index arg")).unwrap(),
        };
        let should_change_focus = args.get("focus").map(|s| s == "true").unwrap_or(false);

        let result = break_panes_to_tab_with_index(
            &[pane_id],
            tab_index,
            should_change_focus,
        );

        match result {
            Some(_tab_index) => {
                serde_json::to_string(&OkResponse::success()).unwrap()
            }
            None => {
                serde_json::to_string(&OkResponse::err("break_panes_to_tab failed")).unwrap()
            }
        }
    }

    fn cmd_close_pane(&self, payload: &str) -> String {
        let pane_id = match parse_pane_id(payload.trim()) {
            Some(id) => id,
            None => return serde_json::to_string(&OkResponse::err("invalid pane_id")).unwrap(),
        };
        close_terminal_pane(match pane_id {
            PaneId::Terminal(id) => id,
            PaneId::Plugin(_) => return serde_json::to_string(&OkResponse::err("can't close plugin panes")).unwrap(),
        });
        serde_json::to_string(&OkResponse::success()).unwrap()
    }

    fn cmd_own_pane_id(&self) -> String {
        // Return our plugin pane ID — the dashboard can use this for self-filtering
        serde_json::to_string(&OkResponse::success()).unwrap()
    }
}

/**
 * Zellij multiplexer backend.
 *
 * Uses a combination of:
 * - zellij 0.44 CLI (`list-panes --json`, `dump-screen --pane-id`, `new-pane`)
 * - WASM bridge plugin via `zellij action pipe` for operations the CLI can't do
 *   (focus by ID, break pane cross-tab, get PID)
 */
import { exec, execAsync } from "./shell.js";
import type { Multiplexer, MuxPaneInfo } from "./multiplexer.js";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Path to the bridge plugin WASM — shipped alongside the npm package
const PLUGIN_WASM = join(__dirname, "..", "bridge-plugin", "target", "wasm32-wasip1", "release", "agents_bridge.wasm");

/** Send a command to the bridge plugin via pipe and get JSON response. */
function pluginCmd(name: string, payload: string = "", args?: Record<string, string>): string {
  let cmd = `zellij action pipe --plugin file:${PLUGIN_WASM} --name ${JSON.stringify(name)}`;
  if (args) {
    const argsStr = Object.entries(args).map(([k, v]) => `${k}=${v}`).join(",");
    cmd += ` --args ${JSON.stringify(argsStr)}`;
  }
  cmd += ` -- ${JSON.stringify(payload)}`;
  return exec(cmd);
}

async function pluginCmdAsync(name: string, payload: string = "", args?: Record<string, string>): Promise<string> {
  let cmd = `zellij action pipe --plugin file:${PLUGIN_WASM} --name ${JSON.stringify(name)}`;
  if (args) {
    const argsStr = Object.entries(args).map(([k, v]) => `${k}=${v}`).join(",");
    cmd += ` --args ${JSON.stringify(argsStr)}`;
  }
  cmd += ` -- ${JSON.stringify(payload)}`;
  return execAsync(cmd);
}

interface ZellijPaneJson {
  id: string;
  title: string;
  command: string | null;
  tab_index: number;
  tab_name: string;
  focused: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

function parsePaneList(json: string): MuxPaneInfo[] {
  try {
    const panes: ZellijPaneJson[] = JSON.parse(json);
    const session = process.env.ZELLIJ_SESSION_NAME || "";
    return panes
      .filter(p => !p.is_suppressed)
      .map(p => ({
        id: p.id,
        title: p.title,
        command: p.command || "",
        pid: null, // filled in lazily via getPanePid
        tab: p.tab_name,
        session,
        focused: p.focused,
        tty: "",
        geometry: { x: p.x, y: p.y, width: p.width, height: p.height },
      }));
  } catch {
    return [];
  }
}

export class ZellijMux implements Multiplexer {
  readonly kind = "zellij" as const;

  listPanes(): MuxPaneInfo[] {
    const json = pluginCmd("list-panes");
    return parsePaneList(json);
  }

  async listPanesAsync(): Promise<MuxPaneInfo[]> {
    const json = await pluginCmdAsync("list-panes");
    return parsePaneList(json);
  }

  getPaneContent(paneId: string, lines?: number): string {
    // Use the 0.44 CLI dump-screen with --pane-id
    const linesFlag = lines ? "" : "-f"; // no line limit flag in zellij, use full or viewport
    return exec(`zellij action dump-screen --pane-id ${paneId}${lines ? "" : " -f"}`);
  }

  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string | null {
    // zellij new-pane returns the created pane ID
    let cmd = `zellij action new-pane --direction ${direction}`;
    if (size) cmd += ` --width ${size}`; // TODO: handle height for "down"
    cmd += ` -- tail -f /dev/null`;
    const result = exec(cmd);
    // Output is like "terminal_42"
    return result.startsWith("terminal_") || result.startsWith("plugin_") ? result.trim() : null;
  }

  closePane(paneId: string): void {
    exec(`zellij action close-pane --pane-id ${paneId}`);
  }

  focusPane(paneId: string): void {
    pluginCmd("focus-pane", paneId);
  }

  resizePaneWidth(paneId: string, width: number): void {
    // Zellij only supports relative resize — this is approximate
    const current = this.getPaneWidth(paneId);
    if (current <= 0) return;
    const delta = width - current;
    if (delta === 0) return;
    const dir = delta > 0 ? "increase" : "decrease";
    const side = "right";
    for (let i = 0; i < Math.abs(delta); i++) {
      exec(`zellij action resize --pane-id ${paneId} ${dir} ${side}`);
    }
  }

  getPaneWidth(paneId: string): number {
    // Get from pane list
    const panes = this.listPanes();
    const pane = panes.find(p => p.id === paneId);
    return pane?.geometry.width || 0;
  }

  breakPaneToTab(paneId: string, tabIndex: number): boolean {
    const result = pluginCmd("break-pane-to-tab", paneId, {
      tab_index: String(tabIndex),
      focus: "false",
    });
    try {
      return JSON.parse(result).ok === true;
    } catch {
      return false;
    }
  }

  createTab(name: string, cmd: string, opts?: { cwd?: string; session?: string }): string | null {
    let cmdStr = `zellij action new-tab --name ${JSON.stringify(name)}`;
    if (opts?.cwd) cmdStr += ` --cwd ${JSON.stringify(opts.cwd)}`;
    exec(cmdStr);
    // Send the command to the new tab's pane
    exec(`zellij action write-chars -- ${JSON.stringify(cmd + "\n")}`);
    return name;
  }

  closeTab(_tabId: string): void {
    // zellij can only close the focused tab
    exec("zellij action close-tab");
  }

  ownPaneId(): string {
    return process.env.ZELLIJ_PANE_ID || "";
  }

  ownTabIndex(): number {
    // Find our pane in the list and return its tab index
    const ownId = this.ownPaneId();
    const panes = this.listPanes();
    const own = panes.find(p => p.id === ownId || p.id === `terminal_${ownId}`);
    // Fallback: parse from list-tabs
    return own ? parseInt(own.tab, 10) || 0 : 0;
  }

  listSessions(): string[] {
    const raw = exec("zellij list-sessions --short --no-formatting");
    return raw.split("\n").filter(Boolean);
  }

  showPlaceholder(paneId: string, agentName: string, agentPane: string): void {
    const script = `#!/bin/bash
tput clear
c=$(tput cols); r=$(tput lines); l=$((r/2-3))
tput cup $l 0
msg="Pane previewing in Agent Dashboard"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo
msg="Agent: ${agentName}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
msg="From:  ${agentPane}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo; tput dim
msg="Press Ctrl-b b to return"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
tput sgr0
while true; do sleep 86400; done
`;
    const path = join(tmpdir(), `agents-ph-${paneId.replace(/[^a-z0-9]/gi, "")}.sh`);
    writeFileSync(path, script, { mode: 0o755 });
    // Open placeholder in place of the agent pane (suppresses it)
    exec(`zellij action new-pane --in-place -- bash ${path}`);
  }
}

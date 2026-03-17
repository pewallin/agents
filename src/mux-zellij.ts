/**
 * Zellij multiplexer backend.
 *
 * Uses a combination of:
 * - zellij 0.44 CLI (`list-panes --json`, `dump-screen --pane-id`, `new-pane`)
 * - WASM bridge plugin via `zellij action pipe` for operations the CLI can't do
 *   (focus by ID, break pane cross-tab, get PID)
 */
import { exec, execAsync, execInherit } from "./shell.js";
import type { Multiplexer, MuxPaneInfo } from "./multiplexer.js";
import { writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the bridge plugin WASM — shipped alongside the npm package
// Zellij caches WASM plugins by file path. To force reload after rebuilds,
// we copy the binary to a content-hash-named file on first load.
import { createHash } from "crypto";
const PLUGIN_DIR = join(__dirname, "..", "bridge-plugin", "target", "wasm32-wasip1", "release");
const PLUGIN_SRC = join(PLUGIN_DIR, "agents-bridge.wasm");
const PLUGIN_WASM = (() => {
  try {
    const hash = createHash("md5").update(readFileSync(PLUGIN_SRC)).digest("hex").slice(0, 8);
    const cached = join(PLUGIN_DIR, `agents-bridge-${hash}.wasm`);
    if (!existsSync(cached)) {
      // Clean old hash copies
      for (const f of readdirSync(PLUGIN_DIR)) {
        if (f.startsWith("agents-bridge-") && f.endsWith(".wasm") && f !== `agents-bridge-${hash}.wasm`) {
          try { unlinkSync(join(PLUGIN_DIR, f)); } catch {}
        }
      }
      copyFileSync(PLUGIN_SRC, cached);
    }
    return cached;
  } catch {
    return PLUGIN_SRC;
  }
})();

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

/** Raw JSON from zellij CLI list-panes --all --json */
interface ZellijCliPane {
  id: number;
  is_plugin: boolean;
  is_suppressed: boolean;
  is_floating: boolean;
  is_focused: boolean;
  title: string;
  pane_x: number;
  pane_y: number;
  pane_content_x: number;
  pane_content_y: number;
  pane_content_columns: number;
  pane_content_rows: number;
  terminal_command: string | null;
  plugin_url: string | null;
  tab_position: number;
  tab_name: string;
  pane_command?: string;
  pane_cwd?: string;
}

/** Raw JSON from bridge plugin list-panes */
interface ZellijPluginPane {
  id: string;
  title: string;
  command: string;
  tab_index: number;
  tab_name: string;
  focused: boolean;
  suppressed: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Parse CLI list-panes --all --json output. */
function parseCliPanes(json: string): MuxPaneInfo[] {
  try {
    const panes: ZellijCliPane[] = JSON.parse(json);
    const session = process.env.ZELLIJ_SESSION_NAME || "";
    return panes
      .filter(p => !p.is_plugin && !p.is_suppressed)
      .map(p => ({
        id: `terminal_${p.id}`,
        title: p.title,
        command: p.pane_command || p.terminal_command || "",
        pid: null, // filled in via plugin get-pane-pid
        tab: p.tab_name,
        tabIndex: p.tab_position,
        session,
        focused: p.is_focused,
        tty: "",
        cwd: p.pane_cwd,
        geometry: {
          x: p.pane_content_x,
          y: p.pane_content_y,
          width: p.pane_content_columns,
          height: p.pane_content_rows,
        },
      }));
  } catch {
    return [];
  }
}

/** Parse bridge plugin list-panes output. */
function parsePluginPanes(json: string): MuxPaneInfo[] {
  try {
    const panes: ZellijPluginPane[] = JSON.parse(json);
    const session = process.env.ZELLIJ_SESSION_NAME || "";
    return panes
      .filter(p => !p.suppressed)
      .map(p => ({
        id: p.id,
        title: p.title,
        command: p.command || "",
        pid: null,
        tab: p.tab_name,
        tabIndex: p.tab_index,
        session,
        focused: p.focused,
        tty: "",
        geometry: { x: p.x, y: p.y, width: p.w, height: p.h },
      }));
  } catch {
    return [];
  }
}

export class ZellijMux implements Multiplexer {
  readonly kind = "zellij" as const;

  private pluginReady = false;
  private floatingPanes = new Set<string>(); // track internally — list-panes is stale after toggle

  /** Ensure the bridge plugin is loaded and permissions granted.
   *  On first call, prints a hint if the plugin needs permission. */
  private ensurePlugin(): boolean {
    if (this.pluginReady) return true;
    // Quick test: ping the plugin
    const result = pluginCmd("ping");
    if (result === "pong") {
      this.pluginReady = true;
      return true;
    }
    // Plugin not responding — likely needs permission grant
    console.error(
      "agents-bridge plugin needs permission. In your zellij session:\n" +
      "  1. Grant the permission prompt (press 'y')\n" +
      "  2. Close the floating plugin pane\n" +
      "  3. Re-run agents"
    );
    return false;
  }

  listPanes(): MuxPaneInfo[] {
    // Try CLI list-panes first (0.44+ only)
    const cliJson = exec("zellij action list-panes --all --json 2>/dev/null");
    const panes = cliJson ? parseCliPanes(cliJson) : [];

    // If CLI didn't work, try plugin
    if (!panes.length && this.ensurePlugin()) {
      const pluginJson = pluginCmd("list-panes");
      const pluginPanes = parsePluginPanes(pluginJson);
      // Enrich with PIDs
      for (const p of pluginPanes) {
        const pidJson = pluginCmd("get-pane-pid", p.id);
        try { p.pid = JSON.parse(pidJson).pid || null; } catch {}
      }
      return pluginPanes;
    }

    // Enrich CLI panes with PIDs from plugin
    if (panes.length && this.ensurePlugin()) {
      for (const p of panes) {
        const pidJson = pluginCmd("get-pane-pid", p.id);
        try { p.pid = JSON.parse(pidJson).pid || null; } catch {}
      }
    }
    return panes;
  }

  async listPanesAsync(): Promise<MuxPaneInfo[]> {
    const cliJson = await execAsync("zellij action list-panes --all --json 2>/dev/null");
    const panes = cliJson ? parseCliPanes(cliJson) : [];

    if (!panes.length && this.ensurePlugin()) {
      const pluginJson = await pluginCmdAsync("list-panes");
      const pluginPanes = parsePluginPanes(pluginJson);
      await Promise.all(pluginPanes.map(async (p) => {
        const pidJson = await pluginCmdAsync("get-pane-pid", p.id);
        try { p.pid = JSON.parse(pidJson).pid || null; } catch {}
      }));
      return pluginPanes;
    }

    if (panes.length && this.ensurePlugin()) {
      await Promise.all(panes.map(async (p) => {
        const pidJson = await pluginCmdAsync("get-pane-pid", p.id);
        try { p.pid = JSON.parse(pidJson).pid || null; } catch {}
      }));
    }
    return panes;
  }

  getPaneContent(paneId: string, _lines?: number): string {
    // zellij dump-screen returns the viewport (no line count flag)
    // Use --pane-id to target specific pane without focus
    return exec(`zellij action dump-screen --pane-id ${paneId} 2>/dev/null`);
  }

  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string | null {
    // zellij new-pane returns the created pane ID
    let cmd = `zellij action new-pane --direction ${direction}`;
    if (size) {
      cmd += direction === "down" ? ` --height ${size}` : ` --width ${size}`;
    }
    cmd += ` -- tail -f /dev/null`;
    const result = exec(cmd);
    return result.startsWith("terminal_") || result.startsWith("plugin_") ? result.trim() : null;
  }

  closePane(paneId: string): void {
    exec(`zellij action close-pane --pane-id ${paneId}`);
  }

  focusPane(paneId: string): void {
    pluginCmd("focus-pane", paneId);
  }

  resizePaneWidth(paneId: string, width: number): void {
    // Bridge plugin handles the feedback loop internally using synchronous get_pane_info
    pluginCmd("resize-pane", paneId, { width: String(width) });
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
    const id = process.env.ZELLIJ_PANE_ID || "";
    // ZELLIJ_PANE_ID is a bare integer — normalize to terminal_N
    if (id && !id.startsWith("terminal_") && !id.startsWith("plugin_")) {
      return `terminal_${id}`;
    }
    return id;
  }

  ownTabIndex(): number {
    const ownId = this.ownPaneId();
    const panes = this.listPanes();
    const own = panes.find(p => p.id === ownId || p.id === `terminal_${ownId}`);
    return own?.tabIndex ?? 0;
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

  floatPane(paneId: string, coords?: { x: number; y: number; width: string; height: string }): void {
    if (!this.floatingPanes.has(paneId)) {
      // toggle-float needs TTY access to communicate with zellij server
      execInherit("zellij", ["action", "toggle-pane-embed-or-floating", "--pane-id", paneId]);
      this.floatingPanes.add(paneId);
    }
    if (coords) {
      execInherit("zellij", ["action", "change-floating-pane-coordinates",
        "--pane-id", paneId,
        "--x", String(coords.x), "--y", String(coords.y),
        "--width", coords.width, "--height", coords.height]);
    }
  }

  embedPane(paneId: string): void {
    if (this.floatingPanes.has(paneId)) {
      execInherit("zellij", ["action", "toggle-pane-embed-or-floating", "--pane-id", paneId]);
      this.floatingPanes.delete(paneId);
    }
  }

  isFloating(paneId: string): boolean {
    return this.floatingPanes.has(paneId);
  }

  sendKeys(paneId: string, keys: string): void {
    exec(`zellij action write-chars --pane-id ${paneId} ${JSON.stringify(keys)}`);
  }
}

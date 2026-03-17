/**
 * tmux multiplexer backend — thin wrapper around existing scanner.ts functions.
 * This keeps the POC non-destructive: the existing tmux code path is unchanged.
 */
import { exec, execAsync } from "./shell.js";
import { showPlaceholder as showPlaceholderImpl } from "./scanner.js";
import type { Multiplexer, MuxPaneInfo } from "./multiplexer.js";

export class TmuxMux implements Multiplexer {
  readonly kind = "tmux" as const;

  listPanes(): MuxPaneInfo[] {
    const raw = exec(
      `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
    );
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => {
      const [paneRef, pid, title, winName, fgCmd, _wact, tty, windowId, tmuxPaneId, cwd] = line.split("§");
      const session = paneRef.split(":")[0];
      return {
        id: tmuxPaneId,
        title,
        command: fgCmd,
        pid: parseInt(pid, 10) || null,
        tab: winName,
        tabIndex: 0, // tmux path uses windowId from scanner, not tabIndex
        session,
        focused: false, // tmux doesn't give this per-pane in list-panes -a
        tty,
        geometry: { x: 0, y: 0, width: 0, height: 0 }, // not used for tmux path
      } as MuxPaneInfo;
    });
  }

  async listPanesAsync(): Promise<MuxPaneInfo[]> {
    const raw = await execAsync(
      `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
    );
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => {
      const [paneRef, pid, title, winName, fgCmd, _wact, tty, windowId, tmuxPaneId, cwd] = line.split("§");
      const session = paneRef.split(":")[0];
      return {
        id: tmuxPaneId,
        title,
        command: fgCmd,
        pid: parseInt(pid, 10) || null,
        tab: winName,
        tabIndex: 0, // tmux path uses windowId from scanner, not tabIndex
        session,
        focused: false,
        tty,
        geometry: { x: 0, y: 0, width: 0, height: 0 },
      } as MuxPaneInfo;
    });
  }

  getPaneContent(paneId: string, lines?: number): string {
    const lineFlag = lines ? `-S -${lines}` : "";
    return exec(`tmux capture-pane -t ${paneId} -p ${lineFlag} 2>/dev/null`);
  }

  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string | null {
    const flag = direction === "right" ? "-h" : "-v";
    const sizeFlag = size ? ` -l ${size}` : "";
    const result = exec(`tmux split-window ${flag} -d${sizeFlag} -t ${targetPaneId} -P -F '#{pane_id}' 'tail -f /dev/null'`);
    return result || null;
  }

  closePane(paneId: string): void {
    exec(`tmux kill-pane -t ${paneId} 2>/dev/null`);
  }

  focusPane(paneId: string): void {
    exec(`tmux select-pane -t ${paneId}`);
  }

  resizePaneWidth(paneId: string, width: number): void {
    exec(`tmux resize-pane -t ${paneId} -x ${width} 2>/dev/null`);
  }

  getPaneWidth(paneId: string): number {
    return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_width}' 2>/dev/null`) || "0", 10);
  }

  breakPaneToTab(paneId: string, _tabIndex: number): boolean {
    // tmux uses swap-pane, not break-pane. This is handled by scanner.ts directly.
    return false;
  }

  createTab(name: string, cmd: string, opts?: { cwd?: string; session?: string }): string | null {
    let cmdStr = "tmux new-window";
    if (opts?.session) cmdStr += ` -t ${JSON.stringify(opts.session + ":")}`;
    cmdStr += ` -n ${JSON.stringify(name)} -P -F '#{pane_id}'`;
    if (opts?.cwd) cmdStr += ` -c ${JSON.stringify(opts.cwd)}`;
    const paneId = exec(cmdStr);
    if (!paneId) return null;
    exec(`tmux set-option -t ${paneId} -w automatic-rename off`);
    exec(`tmux set-option -t ${paneId} -w allow-rename off`);
    exec(`tmux rename-window -t ${paneId} ${JSON.stringify(name)}`);
    exec(`tmux send-keys -t ${paneId} ${JSON.stringify(cmd)} Enter`);
    return paneId;
  }

  closeTab(tabId: string): void {
    exec(`tmux kill-window -t ${JSON.stringify(tabId)} 2>/dev/null`);
  }

  ownPaneId(): string {
    return process.env.TMUX_PANE || exec("tmux display-message -p '#{pane_id}'");
  }

  ownTabIndex(): number {
    return parseInt(exec(`tmux display-message -t ${process.env.TMUX_PANE || ""} -p '#{window_index}'`) || "0", 10);
  }

  listSessions(): string[] {
    return exec("tmux list-sessions -F '#{session_name}' 2>/dev/null").split("\n").filter(Boolean);
  }

  showPlaceholder(paneId: string, agentName: string, agentPane: string): void {
    showPlaceholderImpl(paneId, agentName, agentPane);
  }

  floatPane(_paneId: string, _coords?: { x: number; y: number; width: string; height: string }): void {
    // No-op: tmux uses swap-pane model, not floating panes
  }

  embedPane(_paneId: string): void {
    // No-op: tmux uses swap-pane model, not floating panes
  }

  isFloating(_paneId: string): boolean {
    return false; // tmux doesn't have floating panes
  }

  sendKeys(paneId: string, keys: string): void {
    exec(`tmux send-keys -t ${paneId} ${JSON.stringify(keys)}`);
  }
}

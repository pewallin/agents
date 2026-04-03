import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { exec } from "./shell.js";
import { BACK_ENV } from "./back.js";
import { detectMultiplexer, getMux } from "./multiplexer.js";

export interface SiblingPane {
  tmuxPaneId: string;
  command: string;
  paneRef: string;
  width: number;
  height: number;
}

export interface WindowSnapshot {
  windowId: string;
  layout: string;
}

export function switchToPane(paneId: string, tmuxPaneId?: string): void {
  if (detectMultiplexer() === "zellij") {
    if (tmuxPaneId) {
      const mux = getMux();
      const panes = mux.listPanes();
      const target = panes.find(p => p.id === tmuxPaneId);
      if (target) {
        exec(`zellij action go-to-tab ${target.tabIndex + 1}`);
      }
      mux.focusPane(tmuxPaneId);
    }
    return;
  }
  const current = exec(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
  if (current) {
    exec(`tmux set-environment -g ${BACK_ENV} ${JSON.stringify(current)}`);
  }
  exec(`tmux select-window -t ${JSON.stringify(paneId)}`);
  if (tmuxPaneId) exec(`tmux select-pane -t ${tmuxPaneId}`);
  exec(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

export function createPreviewSplit(dashboardSize: number, vertical: boolean = false): string {
  if (detectMultiplexer() === "zellij") {
    const mux = getMux();
    const selfId = mux.ownPaneId();
    const curWidth = mux.getPaneWidth(selfId);
    const previewSize = vertical
      ? Math.max(20, curWidth - dashboardSize - 1)
      : Math.max(5, (process.stdout.rows || 24) - dashboardSize - 1);
    const dir = vertical ? "right" : "down";
    const splitId = mux.createSplit(selfId, dir, String(previewSize));
    return splitId || "";
  }
  const self = process.env.TMUX_PANE || "";
  const target = self ? ` -t ${self}` : "";
  if (vertical) {
    const curWidth = parseInt(exec(`tmux display-message -t ${self || ""} -p '#{pane_width}'`) || "120", 10);
    const previewCols = Math.max(20, curWidth - dashboardSize - 1);
    return exec(`tmux split-window -h -d${target} -l ${previewCols} -P -F '#{pane_id}' 'tail -f /dev/null'`);
  }
  const curHeight = parseInt(exec(`tmux display-message -t ${self || ""} -p '#{pane_height}'`) || "24", 10);
  const previewRows = Math.max(5, curHeight - dashboardSize - 1);
  return exec(`tmux split-window -v -d${target} -l ${previewRows} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

export function paneExists(paneId: string): boolean {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    return panes.some(p => p.id === paneId);
  }
  return exec(`tmux display-message -t ${paneId} -p '#{pane_id}' 2>/dev/null`) === paneId;
}

export function getPaneWidth(paneId: string): number {
  if (detectMultiplexer() === "zellij") return getMux().getPaneWidth(paneId);
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_width}' 2>/dev/null`) || "0", 10);
}

export function getPaneHeight(paneId: string): number {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    const pane = panes.find(p => p.id === paneId);
    return pane?.geometry.height || 0;
  }
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_height}' 2>/dev/null`) || "0", 10);
}

export function resizePaneWidth(paneId: string, width: number): void {
  if (detectMultiplexer() === "zellij") { getMux().resizePaneWidth(paneId, width); return; }
  exec(`tmux resize-pane -t ${paneId} -x ${width} 2>/dev/null`);
}

export function swapPanes(src: string, dst: string): void {
  if (detectMultiplexer() === "zellij") {
    const mux = getMux();
    const before = mux.listPanes();
    const srcPane = before.find(p => p.id === src);
    const dstPane = before.find(p => p.id === dst);
    if (!srcPane || !dstPane) return;
    if (srcPane.tabIndex === dstPane.tabIndex) return;

    const selfId = mux.ownPaneId();
    const selfInDstTab = before.some(p => p.id === selfId && p.tabIndex === dstPane.tabIndex);

    if (selfInDstTab) {
      mux.breakPanesToNewTab([dst], srcPane.tab || "agent");
      mux.breakPanesToNewTab([selfId, src], dstPane.tab || "dashboard");
    } else {
      mux.breakPanesToNewTab([dst], srcPane.tab || "");
      mux.breakPanesToNewTab([src], dstPane.tab || "");
    }
    return;
  }
  exec(`tmux swap-pane -d -s ${src} -t ${dst}`);
}

export function focusPane(tmuxPaneId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().focusPane(tmuxPaneId); return; }
  exec(`tmux select-pane -t ${tmuxPaneId}`);
}

export function ownPaneId(): string {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  if (process.env.ZELLIJ_PANE_ID) {
    const id = process.env.ZELLIJ_PANE_ID;
    return id.startsWith("terminal_") || id.startsWith("plugin_") ? id : `terminal_${id}`;
  }
  return exec(`tmux display-message -p '#{pane_id}'`);
}

export function killPane(id: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closePane(id); return; }
  exec(`tmux kill-pane -t ${id} 2>/dev/null`);
}

export function killWindow(windowId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closeTab(windowId); return; }
  exec(`tmux kill-window -t ${JSON.stringify(windowId)} 2>/dev/null`);
}

export function findSiblingPanes(windowId: string, excludePaneId: string): SiblingPane[] {
  const raw = exec(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}§#{pane_current_command}§#{session_name}:#{window_name}.#{pane_index}§#{pane_width}§#{pane_height}' 2>/dev/null`
  );
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [tmuxPaneId, command, paneRef, w, h] = line.split("§");
    return { tmuxPaneId, command, paneRef, width: parseInt(w, 10) || 0, height: parseInt(h, 10) || 0 };
  }).filter((p) => p.tmuxPaneId !== excludePaneId);
}

export function snapshotWindow(windowId: string): WindowSnapshot {
  const layout = exec(`tmux display-message -t ${JSON.stringify(windowId)} -p '#{window_layout}'`);
  return { windowId, layout };
}

function parsePaneIds(layout: string): string[] {
  const ids: string[] = [];
  const re = /\d+x\d+,\d+,\d+,(\d+)(?=[,\]\}])/g;
  let m;
  while ((m = re.exec(layout)) !== null) ids.push("%" + m[1]);
  return ids;
}

export function patchSnapshotId(snapshot: WindowSnapshot, oldId: string, newId: string): WindowSnapshot {
  const oldNum = oldId.replace("%", "");
  const newNum = newId.replace("%", "");
  const layout = snapshot.layout.replace(
    new RegExp(`(\\d+x\\d+,\\d+,\\d+,)${oldNum}(?=[,\\]\\}])`, "g"),
    `$1${newNum}`
  );
  return { ...snapshot, layout };
}

export function restoreWindowLayout(snapshot: WindowSnapshot): void {
  exec(`tmux select-layout -t ${JSON.stringify(snapshot.windowId)} '${snapshot.layout}' 2>/dev/null`);
  const targetOrder = parsePaneIds(snapshot.layout);
  const currentOrder = exec(`tmux list-panes -t ${JSON.stringify(snapshot.windowId)} -F '#{pane_id}' 2>/dev/null`).split("\n").filter(Boolean);

  for (let i = 0; i < targetOrder.length; i++) {
    if (currentOrder[i] !== targetOrder[i]) {
      const j = currentOrder.indexOf(targetOrder[i]);
      if (j >= 0) {
        exec(`tmux swap-pane -d -s ${targetOrder[i]} -t ${currentOrder[i]}`);
        [currentOrder[i], currentOrder[j]] = [currentOrder[j], currentOrder[i]];
      }
    }
  }
}

export function createSplitPane(targetPaneId: string, direction: string, size?: string): string {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  const sizeFlag = size ? ` -l ${size}` : "";
  return exec(`tmux split-window ${flags} -d${sizeFlag} -t ${targetPaneId} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

export function joinPane(srcPaneId: string, targetPaneId: string, direction: string): void {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  exec(`tmux join-pane -d ${flags} -s ${srcPaneId} -t ${targetPaneId}`);
}

export function returnPaneToWindow(paneId: string, windowId: string): void {
  const target = exec(`tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}' 2>/dev/null`).split("\n").filter(Boolean)[0];
  if (target) exec(`tmux join-pane -d -s ${paneId} -t ${target}`);
}

export function killPanes(ids: string[]): void {
  for (const id of ids) exec(`tmux kill-pane -t ${id} 2>/dev/null`);
}

export function showPlaceholder(paneId: string, agentName: string, agentPane: string): void {
  const script = `#!/bin/bash
tput clear
c=$(tput cols)
r=$(tput lines)
l=$((r/2-3))
tput cup $l 0
msg="Pane previewing in Agent Dashboard"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo
msg="Agent: ${agentName}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
msg="From:  ${agentPane}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo
tput dim
msg="Press Ctrl-b b to return"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
tput sgr0
while true; do sleep 86400; done
`;
  if (detectMultiplexer() === "zellij") return;
  const path = join(tmpdir(), `agents-ph-${paneId.replace("%", "")}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  exec(`tmux respawn-pane -k -t ${paneId} 'bash ${path}'`);
}

import { execSync, exec as execCb } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getAgentState, getAgentStateEntry } from "./state.js";

const execAsync = promisify(execCb);

export type AgentStatus = "attention" | "question" | "working" | "stalled" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  tmuxPaneId: string;  // %N format for swap operations
  title: string;
  agent: string;
  status: AgentStatus;
  detail?: string;
  windowId?: string;   // session:window_index for sibling lookup
  cwd?: string;
}

export interface SiblingPane {
  tmuxPaneId: string;  // %N
  command: string;     // pane_current_command
  paneRef: string;     // session:window.pane_index
  width: number;
  height: number;
}

// Agent process names to detect — extend this list for custom agents
const AGENT_PROCS = /^(claude|copilot|opencode|codex|cursor|pi)$/i;

// ── Per-agent detection ──────────────────────────────────────────────

interface AgentDetector {
  isWorking(content: string, title: string, tmuxPaneId?: string): boolean;
  isIdle(content: string, title: string, tmuxPaneId?: string): boolean;
  isApproval(content: string, tmuxPaneId?: string): boolean;
  isQuestion(content: string, tmuxPaneId?: string): boolean;
}
const claudeDetector = makeHookDetector("claude");
const copilotDetector = makeHookDetector("copilot");
const piDetector = makeHookDetector("pi");
const opencodeDetector = makeHookDetector("opencode");

// Hook-based detector: reads state from ~/.agents/state/ files
// written by `agents report` command (called from agent hooks).
// Hooks key by $TMUX_PANE so each pane has independent status.
// When no state file exists (null), agent hasn't started yet → treat as idle.
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function stateDuration(agent: string, paneId?: string): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId) : null;
  if (!entry) return undefined;
  const age = Math.floor(Date.now() / 1000) - entry.ts;
  return age >= 1 ? formatDuration(age) : undefined;
}

function makeHookDetector(agentName: string): AgentDetector {
  return {
    isWorking(_c, _t, paneId) { return getAgentState(agentName, paneId) === "working"; },
    isIdle(_c, _t, paneId) { const s = getAgentState(agentName, paneId); return s === "idle" || s === null; },
    isApproval(_c, paneId) { return getAgentState(agentName, paneId) === "approval"; },
    isQuestion(_content, paneId) { return getAgentState(agentName, paneId) === "question"; },
  };
}



// Generic screen-scrape detector for codex, cursor, opencode, etc.
// This is inherently brittle — only used for agents without hook/extension support.
const genericDetector: AgentDetector = {
  isWorking(content, title) {
    // Spinner chars in title (many TUIs set title to show progress)
    if (/[⠁-⠿⏳🔄]/.test(title)) return true;
    // Spinner chars or progress keywords in pane content
    // NOTE: ✢ intentionally excluded — it's Claude's static prompt marker
    return /Working\.\.\.|Thinking\.\.\.|Running\.\.\.|Generating|Searching|Compiling|[⠁-⠿]/.test(content);
  },
  isIdle(content) {
    const bottom = content.split("\n").slice(-10).join("\n");
    return /❯|›|➜|\$\s*$|>\s*$|press enter|waiting|tab agents.*ctrl\+p/i.test(bottom);
  },
  isApproval(content) {
    return /needs-approval|Allow .*—|Do you want to run|Allow this action|\(Y\/n\)|\(y\/N\)|↑↓ to select|↑↓ to navigate|△ Permission required|Allow once.*Allow always.*Reject/.test(content);
  },
  isQuestion(content) {
    // Check if the last visible block of agent output contains a question
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-8).join("\n");
    return /\?/.test(tail);
  },
};

function getDetector(agent: string): AgentDetector {
  switch (agent.toLowerCase()) {
    case "claude":   return claudeDetector;
    case "copilot":  return copilotDetector;
    case "pi":       return piDetector;
    case "opencode": return opencodeDetector;
    default:         return genericDetector;  // codex, cursor, etc.
  }
}

// Map binary names to display names (e.g. if your agent binary differs)
const FRIENDLY_NAMES: Record<string, string> = {};

// Sync exec for non-async contexts (switchToPane, switchBack)
function execSync_(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

async function run(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf-8", timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function friendlyName(name: string): string {
  return FRIENDLY_NAMES[name] ?? name;
}

async function findLeafProcess(pid: string): Promise<string> {
  let leaf = pid;
  for (;;) {
    const child = await run(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    // Check if current child is an agent before walking deeper —
    // agents like claude spawn sub-processes (e.g. pi) that would
    // incorrectly win if we always walk to the true leaf.
    const cmd = (await run(`ps -p ${child} -o comm= 2>/dev/null`)).replace(/.*\//, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
    leaf = child;
  }
  return (await run(`ps -p ${leaf} -o comm= 2>/dev/null`)).replace(/.*\//, "");
}

async function findAgentOnTty(tty: string): Promise<string | null> {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = await run(`ps -o comm= -t ${ttyShort} 2>/dev/null`);
  for (const line of procs.split("\n")) {
    const cmd = line.replace(/.*\//, "").replace(/^-/, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
  }
  return null;
}

async function detectStatus(
  paneRef: string,
  title: string,
  windowActivity: number,
  agent: string,
  tmuxPaneId?: string
): Promise<{ status: AgentStatus; detail?: string }> {
  const detector = getDetector(agent);

  const rawLines = await run(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -20 2>/dev/null`
  );
  const content = rawLines.replace(/\n{3,}/g, "\n\n");

  const dur = stateDuration(agent, tmuxPaneId);

  if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };

  // Check idle first — if the screen shows a prompt, the agent stopped
  // (even if the hook state is stale from a missed Stop event, e.g. Ctrl-C).
  if (detector.isIdle(content, title, tmuxPaneId)) {
    if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
    return { status: "idle" };
  }

  if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };

  const fullPane = await run(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`
  );
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "idle" };

  // No hook data, no screen match — window_activity fallback (per-window, not per-pane).
  // Never reports "working" — window_activity is polluted by helper panes.
  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
}

// Sync version for CLI commands that don't need async
export function scan(): AgentPane[] {
  return scanSync();
}

function scanSync(): AgentPane[] {
  const raw = execSync_(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  const results: AgentPane[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");

    const leafCmd = findLeafProcessSync(pid);
    let agentName: string | null = null;
    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = findAgentOnTtySync(tty);
    }
    if (!agentName) continue;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = detectStatusSync(pane, title, wact, agentName, tmuxPaneId);
    const paneShort = pane.replace(/\.0$/, "");
    const titleClean = title.replace(/^[\u2801-\u28FF] */u, "").slice(0, 30);
    const cwd = cwdRaw?.replace(/^\/Users\/[^/]+/, "~") || undefined;

    results.push({ pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail, windowId: paneId, cwd });
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane));
  return results;
}

function findLeafProcessSync(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = execSync_(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    const cmd = execSync_(`ps -p ${child} -o comm= 2>/dev/null`).replace(/.*\//, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
    leaf = child;
  }
  return execSync_(`ps -p ${leaf} -o comm= 2>/dev/null`).replace(/.*\//, "");
}

function findAgentOnTtySync(tty: string): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = execSync_(`ps -o comm= -t ${ttyShort} 2>/dev/null`);
  for (const line of procs.split("\n")) {
    const cmd = line.replace(/.*\//, "").replace(/^-/, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
  }
  return null;
}

function detectStatusSync(paneRef: string, title: string, windowActivity: number, agent: string, tmuxPaneId?: string): { status: AgentStatus; detail?: string } {
  const detector = getDetector(agent);

  const rawLines = execSync_(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -20 2>/dev/null`);
  const content = rawLines.replace(/\n{3,}/g, "\n\n");

  const dur = stateDuration(agent, tmuxPaneId);

  // 1. Detector checks (hooks for claude/copilot/pi, screen-scrape for others)
  if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };

  // Check idle first — if the screen shows a prompt, the agent stopped
  // (even if the hook state is stale from a missed Stop event, e.g. Ctrl-C).
  if (detector.isIdle(content, title, tmuxPaneId)) {
    if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
    return { status: "idle" };
  }

  if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };

  // 2. Fallback: only reached for generic (screen-scrape) agents when
  //    none of the patterns matched. Check if pane has any content at all.
  const fullPane = execSync_(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`);
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "idle" };

  // No patterns matched but pane has content — use window_activity as
  // last resort. NOTE: window_activity is per-window (not per-pane),
  // so this can be inaccurate when helper panes share the window.
  // Never reports "working" — window_activity is polluted by helper panes.
  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
}

// Async version for watch mode — doesn't block the Ink render loop
export async function scanAsync(): Promise<AgentPane[]> {
  const raw = await run(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);

  // Process all panes concurrently
  const promises = lines.map(async (line) => {
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");

    const leafCmd = await findLeafProcess(pid);
    let agentName: string | null = null;
    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = await findAgentOnTty(tty);
    }
    if (!agentName) return null;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = await detectStatus(pane, title, wact, agentName, tmuxPaneId);
    const paneShort = pane.replace(/\.0$/, "");
    const titleClean = title.replace(/^[\u2801-\u28FF] */u, "").slice(0, 30);
    const cwd = cwdRaw?.replace(/^\/Users\/[^/]+/, "~") || undefined;

    return { pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail, windowId: paneId, cwd } as AgentPane;
  });

  const results = (await Promise.all(promises)).filter((r): r is AgentPane => r !== null);

  results.sort((a, b) => a.pane.localeCompare(b.pane));
  return results;
}

const BACK_ENV = "AGENTS_BACK_PANE";

export function switchToPane(paneId: string, tmuxPaneId?: string): void {
  const current = execSync_(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
  if (current) {
    execSync_(`tmux set-environment -g ${BACK_ENV} ${JSON.stringify(current)}`);
  }
  execSync_(`tmux select-window -t ${JSON.stringify(paneId)}`);
  if (tmuxPaneId) {
    execSync_(`tmux select-pane -t ${tmuxPaneId}`);
  }
  execSync_(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

export function switchBack(): boolean {
  const back = execSync_(`tmux show-environment -g ${BACK_ENV} 2>/dev/null`).replace(`${BACK_ENV}=`, "");
  if (!back) return false;
  execSync_(`tmux select-window -t ${JSON.stringify(back)}`);
  execSync_(`tmux switch-client -t ${JSON.stringify(back)}`);
  // Signal the dashboard to exit fullscreen by sending 'f'
  // Find the node pane in the back window (the dashboard)
  const winRef = back.replace(/\.\d+$/, ""); // strip pane index
  const panes = execSync_(`tmux list-panes -t ${JSON.stringify(winRef)} -F '#{pane_id}§#{pane_width}' 2>/dev/null`);
  if (panes) {
    for (const line of panes.split("\n")) {
      const [paneId, width] = line.split("§");
      if (paneId && parseInt(width, 10) <= 5) {
        // Narrow pane = likely fullscreen dashboard, send 'f' to restore
        execSync_(`tmux send-keys -t ${paneId} s`);
        break;
      }
    }
  }
  return true;
}

// ── Preview / swap helpers ──────────────────────────────────────────

/** Create a split for preview. `dashboardSize` is rows (horizontal) or columns
 *  (vertical) reserved for the dashboard pane – the agent gets the rest.
 *  Always targets our own pane (via $TMUX_PANE) so focus doesn't matter. */
export function createPreviewSplit(dashboardSize: number, vertical: boolean = false): string {
  const self = process.env.TMUX_PANE || "";
  const target = self ? ` -t ${self}` : "";
  if (vertical) {
    // Query current pane width so we can compute the preview size directly.
    // Using -l at split time avoids resize-pane which can steal space from
    // neighboring panes outside the split.
    const curWidth = parseInt(execSync_(`tmux display-message -t ${self || ""} -p '#{pane_width}'`) || "120", 10);
    const previewCols = Math.max(20, curWidth - dashboardSize - 1);
    return execSync_(`tmux split-window -h -d${target} -l ${previewCols} -P -F '#{pane_id}' 'tail -f /dev/null'`);
  }
  const curHeight = parseInt(execSync_(`tmux display-message -t ${self || ""} -p '#{pane_height}'`) || "24", 10);
  const previewRows = Math.max(5, curHeight - dashboardSize - 1);
  return execSync_(`tmux split-window -v -d${target} -l ${previewRows} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

/** Check if a pane exists. */
export function paneExists(paneId: string): boolean {
  return execSync_(`tmux display-message -t ${paneId} -p '#{pane_id}' 2>/dev/null`) === paneId;
}

/** Get the current width of a pane. */
export function getPaneWidth(paneId: string): number {
  return parseInt(execSync_(`tmux display-message -t ${paneId} -p '#{pane_width}' 2>/dev/null`) || "0", 10);
}

/** Resize a pane to a specific width. */
export function resizePaneWidth(paneId: string, width: number): void {
  execSync_(`tmux resize-pane -t ${paneId} -x ${width} 2>/dev/null`);
}

/** Swap two panes by their %N ids. */
export function swapPanes(src: string, dst: string): void {
  execSync_(`tmux swap-pane -d -s ${src} -t ${dst}`);
}

/** Focus a pane by its %N id (select it without switching the dashboard away). */
export function focusPane(tmuxPaneId: string): void {
  execSync_(`tmux select-pane -t ${tmuxPaneId}`);
}

/** Get the current pane's %N id. */
export function ownPaneId(): string {
  // TMUX_PANE is set per-pane by tmux and stays correct regardless of focus.
  // display-message without -t returns the *focused* pane, which is wrong if
  // another pane has focus (e.g. during HMR remount).
  return process.env.TMUX_PANE || execSync_(`tmux display-message -p '#{pane_id}'`);
}

/** Kill a pane by its %N id. */
export function killPane(id: string): void {
  execSync_(`tmux kill-pane -t ${id} 2>/dev/null`);
}

/** Find sibling panes in the same tmux window, excluding the given pane. */
export function findSiblingPanes(windowId: string, excludePaneId: string): SiblingPane[] {
  const raw = execSync_(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}§#{pane_current_command}§#{session_name}:#{window_name}.#{pane_index}§#{pane_width}§#{pane_height}' 2>/dev/null`
  );
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [tmuxPaneId, command, paneRef, w, h] = line.split("§");
    return { tmuxPaneId, command, paneRef, width: parseInt(w, 10) || 0, height: parseInt(h, 10) || 0 };
  }).filter((p) => p.tmuxPaneId !== excludePaneId);
}

// ── Window snapshot / restore ────────────────────────────────────────

export interface WindowSnapshot {
  windowId: string;
  layout: string;      // tmux window_layout string (includes pane IDs)
}

/** Capture a window's layout so it can be restored later. */
export function snapshotWindow(windowId: string): WindowSnapshot {
  const layout = execSync_(
    `tmux display-message -t ${JSON.stringify(windowId)} -p '#{window_layout}'`
  );
  return { windowId, layout };
}

/** Extract ordered pane IDs from a tmux layout string.
 *  Leaf panes match: WxH,X,Y,<ID> followed by , ] or } */
function parsePaneIds(layout: string): string[] {
  const ids: string[] = [];
  const re = /\d+x\d+,\d+,\d+,(\d+)(?=[,\]\}])/g;
  let m;
  while ((m = re.exec(layout)) !== null) ids.push("%" + m[1]);
  return ids;
}

/** Return a copy of the snapshot with one pane ID replaced by another.
 *  Used when the agent pane replaces the placeholder before layout restore. */
export function patchSnapshotId(snapshot: WindowSnapshot, oldId: string, newId: string): WindowSnapshot {
  const oldNum = oldId.replace("%", "");
  const newNum = newId.replace("%", "");
  // Layout leaf format: WxH,X,Y,<ID> followed by , ] or }
  const layout = snapshot.layout.replace(
    new RegExp(`(\\d+x\\d+,\\d+,\\d+,)${oldNum}(?=[,\\]\\}])`, "g"),
    `$1${newNum}`
  );
  return { ...snapshot, layout };
}

/** Restore a window's layout and pane ordering from a snapshot. */
export function restoreWindowLayout(snapshot: WindowSnapshot): void {
  // Apply geometry
  execSync_(
    `tmux select-layout -t ${JSON.stringify(snapshot.windowId)} '${snapshot.layout}' 2>/dev/null`
  );
  // Fix pane ordering — select-layout sets geometry but doesn't reorder panes
  const targetOrder = parsePaneIds(snapshot.layout);
  const currentOrder = execSync_(
    `tmux list-panes -t ${JSON.stringify(snapshot.windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean);

  for (let i = 0; i < targetOrder.length; i++) {
    if (currentOrder[i] !== targetOrder[i]) {
      const j = currentOrder.indexOf(targetOrder[i]);
      if (j >= 0) {
        execSync_(`tmux swap-pane -d -s ${targetOrder[i]} -t ${currentOrder[i]}`);
        [currentOrder[i], currentOrder[j]] = [currentOrder[j], currentOrder[i]];
      }
    }
  }
}

/** Create a new placeholder pane by splitting an existing pane in the given direction.
 *  Returns the new pane's %N id. Used for swap-based helper pane management. */
export function createSplitPane(targetPaneId: string, direction: string, size?: string): string {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  const sizeFlag = size ? ` -l ${size}` : "";
  return execSync_(`tmux split-window ${flags} -d${sizeFlag} -t ${targetPaneId} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

/** Move a pane into another pane's window, splitting in the given direction. */
export function joinPane(srcPaneId: string, targetPaneId: string, direction: string): void {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  execSync_(`tmux join-pane -d ${flags} -s ${srcPaneId} -t ${targetPaneId}`);
}

/** Move a pane back into a window (joins to the first pane found there). */
export function returnPaneToWindow(paneId: string, windowId: string): void {
  const target = execSync_(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean)[0];
  if (target) {
    execSync_(`tmux join-pane -d -s ${paneId} -t ${target}`);
  }
}

/** Kill multiple panes by their %N ids. */
export function killPanes(ids: string[]): void {
  for (const id of ids) {
    execSync_(`tmux kill-pane -t ${id} 2>/dev/null`);
  }
}

/** Replace a pane's content with a centered placeholder message. */
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
  const path = join(tmpdir(), `agents-ph-${paneId.replace("%", "")}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  execSync_(`tmux respawn-pane -k -t ${paneId} 'bash ${path}'`);
}

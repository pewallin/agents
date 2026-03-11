import { execSync, exec as execCb } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getAgentState } from "./state.js";

const execAsync = promisify(execCb);

export type AgentStatus = "approval" | "working" | "stalled" | "waiting" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  tmuxPaneId: string;  // %N format for swap operations
  title: string;
  agent: string;
  status: AgentStatus;
  detail?: string;
}

// Agent process names to detect — extend this list for custom agents
const AGENT_PROCS = /^(claude|copilot|opencode|codex|cursor|pi)$/i;

// ── Per-agent detection ──────────────────────────────────────────────

interface AgentDetector {
  isWorking(content: string, title: string, tmuxPaneId?: string): boolean;
  isIdle(content: string, title: string, tmuxPaneId?: string): boolean;
  isApproval(content: string, tmuxPaneId?: string): boolean;
}
const claudeDetector = makeHookDetector("claude");
const copilotDetector = makeHookDetector("copilot");
const piDetector = makeHookDetector("pi");

// Hook-based detector: reads state from ~/.agents/state/ files
// written by `agents report` command (called from agent hooks).
// Uses tmuxPaneId as session key for per-pane status.
// Falls back to screen-scraping for approval since not all agents
// emit approval events via hooks.
function makeHookDetector(agentName: string): AgentDetector {
  return {
    isWorking(_c, _t, paneId) { return getAgentState(agentName, paneId) === "working"; },
    isIdle(_c, _t, paneId) { const s = getAgentState(agentName, paneId); return s === "idle" || s === null; },
    isApproval(content, paneId) {
      return getAgentState(agentName, paneId) === "approval" || genericDetector.isApproval(content);
    },
  };
}



// Generic fallback for codex, cursor, etc.
const genericDetector: AgentDetector = {
  isWorking(content, title) {
    return /[⠁-⠿⏳🔄]/.test(title) ||
      /Working\.\.\.|Thinking\.\.\.|Running\.\.\.|Generating|Searching|Compiling|[⠁-⠿]|✢/.test(content);
  },
  isIdle(content) {
    const bottom = content.split("\n").filter(Boolean).slice(-3).join("\n");
    return /❯|›|➜|\$\s*$|>\s*$|press enter|waiting/i.test(bottom);
  },
  isApproval(content) {
    return /needs-approval|Allow .*—|Do you want to run|Allow this|approve this|\(Y\/n\)|\(y\/N\)|↑↓ to select|↑↓ to navigate/.test(content);
  },
};

function getDetector(agent: string): AgentDetector {
  switch (agent.toLowerCase()) {
    case "copilot":
    case "opencode":
      return copilotDetector;
    case "pi":
      return piDetector;
    case "claude":
      return claudeDetector;
    default:
      return genericDetector;
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

  // 1. Approval — always highest priority
  if (detector.isApproval(content, tmuxPaneId)) {
    return { status: "approval" };
  }

  // 2. Working
  if (detector.isWorking(content, title, tmuxPaneId)) {
    return { status: "working" };
  }

  // 3. Idle prompt visible
  if (detector.isIdle(content, title, tmuxPaneId)) {
    return { status: "waiting" };
  }

  // 4. Fallback: activity-age based
  const fullPane = await run(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`
  );
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) {
    return { status: "waiting" };
  }

  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 30) {
    return { status: "working", detail: `${age}s` };
  }
  if (age < 120) {
    return { status: "stalled", detail: `${age}s` };
  }
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
}

// Sync version for CLI commands that don't need async
export function scan(): AgentPane[] {
  return scanSync();
}

function scanSync(): AgentPane[] {
  const raw = execSync_(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}' 2>/dev/null`
  );
  if (!raw) return [];

  const results: AgentPane[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId] = line.split("§");

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

    results.push({ pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail });
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

  if (detector.isApproval(content, tmuxPaneId)) return { status: "approval" };
  if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working" };
  if (detector.isIdle(content, title, tmuxPaneId)) return { status: "waiting" };

  const fullPane = execSync_(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`);
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "waiting" };

  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 30) return { status: "working", detail: `${age}s` };
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
}

// Async version for watch mode — doesn't block the Ink render loop
export async function scanAsync(): Promise<AgentPane[]> {
  const raw = await run(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}' 2>/dev/null`
  );
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);

  // Process all panes concurrently
  const promises = lines.map(async (line) => {
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId] = line.split("§");

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

    return { pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail } as AgentPane;
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
  return true;
}

// ── Preview / swap helpers ──────────────────────────────────────────

/** Create a split for preview. For horizontal (below), `dashboardSize` is rows
 *  reserved for the dashboard. For vertical (right), it splits 50/50. */
export function createPreviewSplit(dashboardSize: number, vertical: boolean = false): string {
  if (vertical) {
    return execSync_(`tmux split-window -h -d -P -F '#{pane_id}' 'tail -f /dev/null'`);
  }
  const paneId = execSync_(`tmux split-window -v -d -P -F '#{pane_id}' 'tail -f /dev/null'`);
  if (paneId) {
    execSync_(`tmux resize-pane -y ${dashboardSize}`);
  }
  return paneId;
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
  return execSync_(`tmux display-message -p '#{pane_id}'`);
}

/** Kill a pane by its %N id. */
export function killPane(id: string): void {
  execSync_(`tmux kill-pane -t ${id} 2>/dev/null`);
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

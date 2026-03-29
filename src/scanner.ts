import { writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { exec, execAsync } from "./shell.js";
import { getAgentState, getAgentStateEntry } from "./state.js";
import { getMux, detectMultiplexer } from "./multiplexer.js";
import { BACK_ENV, switchBack } from "./back.js";
import type { MuxPaneInfo } from "./multiplexer.js";

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
  branch?: string;     // git branch name for the cwd
  context?: string;    // workspace context description from state file
  contextTokens?: number;
  contextMax?: number;
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

export interface AgentDetector {
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

function stateDetail(agent: string, paneId?: string): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId) : null;
  return entry?.detail;
}

function stateContext(agent: string, paneId?: string): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId) : null;
  return entry?.context;
}

function stateTokens(agent: string, paneId?: string): { contextTokens?: number; contextMax?: number } {
  const entry = paneId ? getAgentStateEntry(agent, paneId) : null;
  if (!entry) return {};
  return {
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.contextMax !== undefined ? { contextMax: entry.contextMax } : {}),
  };
}

function makeHookDetector(agentName: string): AgentDetector {
  return {
    isWorking(_c, _t, paneId) { return getAgentState(agentName, paneId) === "working"; },
    isIdle(_c, _t, paneId) { const s = getAgentState(agentName, paneId); return s === "idle" || s === "question" || s === null; },
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

export function getDetector(agent: string): AgentDetector {
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



/** Sanitize pane title: strip spinner chars, control chars, and reject escape sequence leaks. */
function cleanTitle(raw: string): string {
  // Strip braille spinners
  let t = raw.replace(/^[\u2801-\u28FF] */u, "");
  // Strip control characters (except normal whitespace)
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Reject if it looks like a leaked escape sequence (DA response, etc.)
  if (/\x1b\[|[\x00-\x1f]/.test(raw)) return "";
  return t.slice(0, 30);
}

function friendlyName(name: string): string {
  return FRIENDLY_NAMES[name] ?? name;
}

async function findLeafProcess(pid: string): Promise<string> {
  let leaf = pid;
  for (;;) {
    const child = await execAsync(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    // Check if current child is an agent before walking deeper —
    // agents like claude spawn sub-processes (e.g. pi) that would
    // incorrectly win if we always walk to the true leaf.
    const cmd = (await execAsync(`ps -p ${child} -o comm= 2>/dev/null`)).replace(/.*\//, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
    leaf = child;
  }
  return (await execAsync(`ps -p ${leaf} -o comm= 2>/dev/null`)).replace(/.*\//, "");
}

async function findAgentOnTty(tty: string): Promise<string | null> {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = await execAsync(`ps -o comm= -t ${ttyShort} 2>/dev/null`);
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

  const rawLines = await execAsync(
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

  const fullPane = await execAsync(
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
  if (detectMultiplexer() === "zellij") {
    return processZellijPanes(getMux().listPanes());
  }
  return scanSync();
}

// ── Zellij scan path ────────────────────────────────────────────────
// Single implementation used by both sync and async entry points.

function processZellijPanes(panes: MuxPaneInfo[]): AgentPane[] {
  const mux = getMux();
  const results: AgentPane[] = [];

  for (const p of panes) {
    let agentName: string | null = null;

    if (p.pid) {
      // Check the PID itself first — in zellij the returned PID is often
      // the agent process directly (not a shell), and its children may be
      // non-agent subprocesses (e.g. caffeinate, node).
      const pidCmd = exec(`ps -p ${p.pid} -o comm= 2>/dev/null`).replace(/.*\//, "");
      if (AGENT_PROCS.test(pidCmd)) {
        agentName = pidCmd;
      } else {
        const leafCmd = findLeafProcessSync(String(p.pid));
        if (AGENT_PROCS.test(leafCmd)) {
          agentName = leafCmd;
        }
      }
    }

    // Fallback: check the command string from zellij (may include args)
    if (!agentName && p.command) {
      const cmd = p.command.replace(/.*\//, "").replace(/^-/, "").split(/\s+/)[0];
      if (AGENT_PROCS.test(cmd)) agentName = cmd;
    }

    if (!agentName) continue;

    const content = mux.getPaneContent(p.id, 20);
    const detector = getDetector(agentName);
    const dur = stateDuration(agentName, p.id);

    let status: AgentStatus;
    let detail: string | undefined = dur;

    if (detector.isApproval(content, p.id)) {
      status = "attention";
    } else if (detector.isIdle(content, p.title, p.id)) {
      status = detector.isQuestion(content, p.id) ? "question" : "idle";
      detail = status === "idle" ? undefined : dur;
    } else if (detector.isWorking(content, p.title, p.id)) {
      status = "working";
    } else {
      status = "idle";
      detail = undefined;
    }

    const paneRef = `${p.session}:${p.tab}`;
    const titleClean = cleanTitle(p.title);

    const zellijCwd = p.cwd?.replace(homedir(), "~") || undefined;
    const zellijBranch = p.cwd ? exec(`git -C ${JSON.stringify(p.cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null`) || undefined : undefined;

    // Prefer rich detail from state (e.g. "reading main.ts") over bare duration
    const richDetail = stateDetail(agentName, p.id);
    const finalDetail = richDetail || detail;

    results.push({
      pane: paneRef,
      paneId: paneRef,
      tmuxPaneId: p.id,
      title: titleClean,
      agent: friendlyName(agentName),
      status,
      detail: finalDetail,
      windowId: paneRef,
      cwd: zellijCwd,
      branch: zellijBranch,
      context: stateContext(agentName, p.id),
      ...stateTokens(agentName, p.id),
    });
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane));
  return results;
}

// ── Process tree snapshot ─────────────────────────────────────────────
// Single `ps` call builds an in-memory process tree. Used by scanSync()
// to avoid per-pane pgrep/ps forks (27 panes × ~4 execs → 1 exec).

interface ProcEntry { pid: number; ppid: number; comm: string; tty: string }

function buildProcessTree(): { byPid: Map<number, ProcEntry>; children: Map<number, number[]>; byTty: Map<string, ProcEntry[]> } {
  const raw = exec("ps -eo pid=,ppid=,comm=,tty= 2>/dev/null");
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)$/);
    if (!match) continue;
    const entry: ProcEntry = {
      pid: parseInt(match[1]),
      ppid: parseInt(match[2]),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
    };
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
    if (entry.tty !== "??" && entry.tty !== "?") {
      const list = byTty.get(entry.tty);
      if (list) list.push(entry);
      else byTty.set(entry.tty, [entry]);
    }
  }
  return { byPid, children, byTty };
}

function findLeafInTree(pid: number, tree: { byPid: Map<number, ProcEntry>; children: Map<number, number[]> }): string {
  let current = pid;
  for (;;) {
    const kids = tree.children.get(current);
    if (!kids || kids.length === 0) break;
    const child = kids[0];
    const entry = tree.byPid.get(child);
    if (entry && AGENT_PROCS.test(entry.comm)) return entry.comm;
    current = child;
  }
  return tree.byPid.get(current)?.comm || "";
}

function findAgentOnTtyInTree(tty: string, tree: { byTty: Map<string, ProcEntry[]> }): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = tree.byTty.get(ttyShort);
  if (!procs) return null;
  for (const p of procs) {
    const cmd = p.comm.replace(/^-/, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
  }
  return null;
}

function scanSync(): AgentPane[] {
  const raw = exec(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  // Build process tree once — replaces per-pane pgrep/ps calls
  const tree = buildProcessTree();
  // Cache git branch per directory
  const branchCache = new Map<string, string | undefined>();

  const results: AgentPane[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");

    // Skip panes from Agents app linked sessions
    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leafCmd = findLeafInTree(pidNum, tree);
    let agentName: string | null = null;
    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = findAgentOnTtyInTree(tty, tree);
    }
    if (!agentName) continue;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = detectStatusSync(pane, title, wact, agentName, tmuxPaneId);
    // Prefer rich detail from state (e.g. "reading main.ts") over bare duration
    const richDetail = stateDetail(agentName, tmuxPaneId);
    const finalDetail = richDetail || detail;
    const paneShort = pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(title);
    const cwd = cwdRaw?.replace(homedir(), "~") || undefined;

    let branch: string | undefined;
    if (cwdRaw) {
      if (branchCache.has(cwdRaw)) {
        branch = branchCache.get(cwdRaw);
      } else {
        branch = exec(`git -C ${JSON.stringify(cwdRaw)} rev-parse --abbrev-ref HEAD 2>/dev/null`) || undefined;
        branchCache.set(cwdRaw, branch);
      }
    }

    results.push({ pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail: finalDetail, windowId: paneId, cwd, branch, context: stateContext(agentName, tmuxPaneId), ...stateTokens(agentName, tmuxPaneId) } as AgentPane);
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

// Legacy per-process helpers — kept for async scan path
function findLeafProcessSync(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = exec(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    const cmd = exec(`ps -p ${child} -o comm= 2>/dev/null`).replace(/.*\//, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
    leaf = child;
  }
  return exec(`ps -p ${leaf} -o comm= 2>/dev/null`).replace(/.*\//, "");
}

function findAgentOnTtySync(tty: string): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = exec(`ps -o comm= -t ${ttyShort} 2>/dev/null`);
  for (const line of procs.split("\n")) {
    const cmd = line.replace(/.*\//, "").replace(/^-/, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
  }
  return null;
}

function detectStatusSync(paneRef: string, title: string, windowActivity: number, agent: string, tmuxPaneId?: string): { status: AgentStatus; detail?: string } {
  const detector = getDetector(agent);

  const rawLines = exec(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -20 2>/dev/null`);
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
  const fullPane = exec(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`);
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
  if (detectMultiplexer() === "zellij") {
    // Zellij scan uses sync subprocess calls (zellij pipe doesn't work
    // reliably with async exec — the process hangs until timeout).
    // Use the same code path as scan() for consistency.
    return processZellijPanes(getMux().listPanes());
  }
  const raw = await execAsync(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);

  // Process all panes concurrently (skip Agents app linked sessions)
  const promises = lines.filter(line => {
    const session = line.split("§")[0].split(":")[0];
    return !session.startsWith("_agents_");
  }).map(async (line) => {
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
    // Prefer rich detail from state (e.g. "reading main.ts") over bare duration
    const richDetail = stateDetail(agentName, tmuxPaneId);
    const finalDetail = richDetail || detail;
    const paneShort = pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(title);
    const cwd = cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = cwdRaw ? (await execAsync(`git -C ${JSON.stringify(cwdRaw)} rev-parse --abbrev-ref HEAD 2>/dev/null`))?.trim() || undefined : undefined;

    return { pane: paneShort, paneId, tmuxPaneId, title: titleClean, agent: friendlyName(agentName), status, detail: finalDetail, windowId: paneId, cwd, branch, context: stateContext(agentName, tmuxPaneId), ...stateTokens(agentName, tmuxPaneId) } as AgentPane;
  });

  const results = (await Promise.all(promises)).filter((r): r is AgentPane => r !== null);

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

export function switchToPane(paneId: string, tmuxPaneId?: string): void {
  if (detectMultiplexer() === "zellij") {
    if (tmuxPaneId) {
      // Switch to the agent's tab then focus the pane
      const mux = getMux();
      const panes = mux.listPanes();
      const target = panes.find(p => p.id === tmuxPaneId);
      if (target) {
        exec(`zellij action go-to-tab ${target.tabIndex + 1}`); // 1-based
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
  if (tmuxPaneId) {
    exec(`tmux select-pane -t ${tmuxPaneId}`);
  }
  exec(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

// ── Preview / swap helpers ──────────────────────────────────────────

/** Create a split for preview. `dashboardSize` is rows (horizontal) or columns
 *  (vertical) reserved for the dashboard pane – the agent gets the rest.
 *  Always targets our own pane (via $TMUX_PANE) so focus doesn't matter. */
export function createPreviewSplit(dashboardSize: number, vertical: boolean = false): string {
  if (detectMultiplexer() === "zellij") {
    const mux = getMux();
    const selfId = mux.ownPaneId();
    // Create split next to dashboard, sized to leave dashboardSize for dashboard
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

/** Check if a pane exists. */
export function paneExists(paneId: string): boolean {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    return panes.some(p => p.id === paneId);
  }
  return exec(`tmux display-message -t ${paneId} -p '#{pane_id}' 2>/dev/null`) === paneId;
}

/** Get the current width of a pane. */
export function getPaneWidth(paneId: string): number {
  if (detectMultiplexer() === "zellij") return getMux().getPaneWidth(paneId);
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_width}' 2>/dev/null`) || "0", 10);
}

/** Get the current height (rows) of a tmux pane. */
export function getPaneHeight(paneId: string): number {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    const pane = panes.find(p => p.id === paneId);
    return pane?.geometry.height || 0;
  }
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_height}' 2>/dev/null`) || "0", 10);
}

/** Resize a pane to a specific width. */
export function resizePaneWidth(paneId: string, width: number): void {
  if (detectMultiplexer() === "zellij") { getMux().resizePaneWidth(paneId, width); return; }
  exec(`tmux resize-pane -t ${paneId} -x ${width} 2>/dev/null`);
}

/** Swap two panes by their IDs.
 *  tmux: real bidirectional swap.
 *  zellij: move src to dst's tab via breakPaneToTab, then close dst.
 *  The caller must ensure dst is a disposable placeholder (tail -f /dev/null).
 */
export function swapPanes(src: string, dst: string): void {
  if (detectMultiplexer() === "zellij") {
    // Bidirectional swap: src and dst exchange tabs.
    // NOTE: zellij's break_panes_to_tab_with_id is buggy (treats id as position),
    // so we must use tab_index (position) and re-read positions between moves.
    //
    // Order: move dst to src's tab FIRST — this ensures src's tab has ≥2 panes,
    // so when we move src out next, the tab won't collapse and shift positions.
    const mux = getMux();
    const before = mux.listPanes();
    const srcPane = before.find(p => p.id === src);
    const dstPane = before.find(p => p.id === dst);
    if (!srcPane || !dstPane) return;
    if (srcPane.tabIndex === dstPane.tabIndex) return;

    // zellij 0.44 bug: break_panes_to_tab_with_index has a position/id mismatch.
    // Use break_panes_to_new_tab (reliable) to move panes.
    //
    // For preview open: src=agent, dst=split. Move split to agent's tab,
    // then move dashboard+agent together to a new tab.
    // For preview close: src=agent, dst=split. Move agent to its own new tab.
    //
    // We detect which case by checking if the dashboard is in dst's tab.
    const selfId = mux.ownPaneId();
    const selfInDstTab = before.some(p => p.id === selfId && p.tabIndex === dstPane.tabIndex);

    if (selfInDstTab) {
      // Preview OPEN: dashboard is in dst's tab (split was created here).
      // Move split to agent's tab name, move dashboard+agent together.
      mux.breakPanesToNewTab([dst], srcPane.tab || "agent");
      mux.breakPanesToNewTab([selfId, src], dstPane.tab || "dashboard");
    } else {
      // Preview CLOSE / general swap: just exchange the two panes.
      // Move each to a new tab with the OTHER's tab name.
      mux.breakPanesToNewTab([dst], srcPane.tab || "");
      mux.breakPanesToNewTab([src], dstPane.tab || "");
    }
    return;
  }
  exec(`tmux swap-pane -d -s ${src} -t ${dst}`);
}

/** Focus a pane by its %N id (select it without switching the dashboard away). */
export function focusPane(tmuxPaneId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().focusPane(tmuxPaneId); return; }
  exec(`tmux select-pane -t ${tmuxPaneId}`);
}

/** Get the current pane's %N id (tmux) or terminal_N id (zellij). */
export function ownPaneId(): string {
  // TMUX_PANE is set per-pane by tmux and stays correct regardless of focus.
  // display-message without -t returns the *focused* pane, which is wrong if
  // another pane has focus (e.g. during HMR remount).
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  if (process.env.ZELLIJ_PANE_ID) {
    const id = process.env.ZELLIJ_PANE_ID;
    return id.startsWith("terminal_") || id.startsWith("plugin_") ? id : `terminal_${id}`;
  }
  return exec(`tmux display-message -p '#{pane_id}'`);
}

/** Kill a pane by its %N id. */
export function killPane(id: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closePane(id); return; }
  exec(`tmux kill-pane -t ${id} 2>/dev/null`);
}

/** Kill an entire tmux window by session:window_index. */
export function killWindow(windowId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closeTab(windowId); return; }
  exec(`tmux kill-window -t ${JSON.stringify(windowId)} 2>/dev/null`);
}

/** Find sibling panes in the same tmux window, excluding the given pane. */
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

// ── Window snapshot / restore ────────────────────────────────────────

export interface WindowSnapshot {
  windowId: string;
  layout: string;      // tmux window_layout string (includes pane IDs)
}

/** Capture a window's layout so it can be restored later. */
export function snapshotWindow(windowId: string): WindowSnapshot {
  const layout = exec(
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
  exec(
    `tmux select-layout -t ${JSON.stringify(snapshot.windowId)} '${snapshot.layout}' 2>/dev/null`
  );
  // Fix pane ordering — select-layout sets geometry but doesn't reorder panes
  const targetOrder = parsePaneIds(snapshot.layout);
  const currentOrder = exec(
    `tmux list-panes -t ${JSON.stringify(snapshot.windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean);

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

/** Create a new placeholder pane by splitting an existing pane in the given direction.
 *  Returns the new pane's %N id. Used for swap-based helper pane management. */
export function createSplitPane(targetPaneId: string, direction: string, size?: string): string {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  const sizeFlag = size ? ` -l ${size}` : "";
  return exec(`tmux split-window ${flags} -d${sizeFlag} -t ${targetPaneId} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

/** Move a pane into another pane's window, splitting in the given direction. */
export function joinPane(srcPaneId: string, targetPaneId: string, direction: string): void {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  exec(`tmux join-pane -d ${flags} -s ${srcPaneId} -t ${targetPaneId}`);
}

/** Move a pane back into a window (joins to the first pane found there). */
export function returnPaneToWindow(paneId: string, windowId: string): void {
  const target = exec(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean)[0];
  if (target) {
    exec(`tmux join-pane -d -s ${paneId} -t ${target}`);
  }
}

// ── Scan result filtering ────────────────────────────────────────────

export interface PreviewFilter {
  agentTmuxId: string;
  splitPaneId: string;
  agentPane: string;
  agentPaneId: string;
}

export interface GridFilter {
  agents: { tmuxPaneId: string; pane: string; paneId?: string; windowId?: string }[];
  placeholderIds: string[];
}

/**
 * Filter scan results for the dashboard:
 * 1. Remove the dashboard's own pane and window
 * 2. Re-add previewed/gridded agents with their original pane names
 *
 * Pure function — no side effects, easy to test.
 */
export function filterAgents(
  scanned: AgentPane[],
  selfPaneId: string,
  selfWindowId: string,
  preview?: PreviewFilter | null,
  grid?: GridFilter | null,
): AgentPane[] {
  // 1. Remove self
  let list = scanned.filter((a) => a.tmuxPaneId !== selfPaneId && a.windowId !== selfWindowId);

  // 2. Preview: agent pane is swapped into dashboard window, re-add with original name
  if (preview) {
    const swapped = scanned.find((a) => a.tmuxPaneId === preview.agentTmuxId);
    list = list.filter(
      (a) => a.tmuxPaneId !== preview.agentTmuxId && a.tmuxPaneId !== preview.splitPaneId
    );
    if (swapped) {
      list.push({ ...swapped, pane: preview.agentPane, paneId: preview.agentPaneId });
    }
  }

  // 3. Grid: agents are swapped into dashboard window, re-add with original names
  if (grid) {
    const gridPaneIds = new Set(grid.agents.map((a) => a.tmuxPaneId));
    const placeholderIds = new Set(grid.placeholderIds);
    list = list.filter((a) => !gridPaneIds.has(a.tmuxPaneId) && !placeholderIds.has(a.tmuxPaneId));
    for (const ga of grid.agents) {
      const found = scanned.find((a) => a.tmuxPaneId === ga.tmuxPaneId);
      if (found) {
        list.push({
          ...found,
          pane: ga.pane,
          paneId: ga.paneId || found.paneId,
          windowId: ga.windowId || found.windowId,
        });
      }
    }
  }

  list.sort((a, b) => a.pane.localeCompare(b.pane));
  return list;
}

/** Kill multiple panes by their %N ids. */
export function killPanes(ids: string[]): void {
  for (const id of ids) {
    exec(`tmux kill-pane -t ${id} 2>/dev/null`);
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
  if (detectMultiplexer() === "zellij") {
    // In zellij, the split (tail -f /dev/null) is already in the agent's original tab
    // and serves as a visual placeholder. showPlaceholder uses --in-place which
    // targets the focused pane (dashboard), not the split in a remote tab.
    return;
  }
  const path = join(tmpdir(), `agents-ph-${paneId.replace("%", "")}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  exec(`tmux respawn-pane -k -t ${paneId} 'bash ${path}'`);
}

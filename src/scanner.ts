import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execCb);

export type AgentStatus = "approval" | "working" | "stalled" | "waiting" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  title: string;
  agent: string;
  status: AgentStatus;
  detail?: string;
}

// Agent process names to detect — extend this list for custom agents
const AGENT_PROCS = /^(claude|copilot|opencode|codex|aider|cursor|pi)$/i;

// ── Per-agent detection ──────────────────────────────────────────────

interface AgentDetector {
  // Lines above the status bar area
  isWorking(content: string, title: string): boolean;
  isIdle(content: string, title: string): boolean;
  isApproval(content: string): boolean;
}

// Copilot / opencode: status bar with ❯ and shift+tab is ALWAYS visible.
// Must look above it for progress indicators.
const copilotDetector: AgentDetector = {
  isWorking(content, title) {
    // 1. Title shows 🤖 when actively working
    if (/🤖/.test(title)) return true;
    // 2. "Esc to cancel" in status bar = actively processing
    if (/Esc to cancel/.test(content)) return true;
    // 3. If the idle prompt (❯ Type @, shift+tab) is NOT visible, copilot is busy
    //    (it may be in a sub-tool like diff viewer, file editor, etc.)
    const hasIdlePrompt = /❯.*Type @|shift.tab switch mode/.test(content);
    return !hasIdlePrompt && content.trim().length > 0;
  },
  isIdle(content) {
    // Idle only if the prompt is visible AND not actively processing
    return /❯.*Type @|shift.tab switch mode/.test(content) && !/Esc to cancel/.test(content);
  },
  isApproval(content) {
    return /↑↓ navigate.*enter select|Do you want to run|\(Y\/n\)|\(y\/N\)/.test(content);
  },
};

// Pi: shows ⠋ Working... but it stays on screen after completion.
// Reliable idle signal is the ↳ › prompt at the bottom.
const piDetector: AgentDetector = {
  isWorking(_content, title) {
    // Title spinner is the reliable signal for pi
    return /[⠁-⠿]/.test(title);
  },
  isIdle(content) {
    // Bottom prompt visible = idle
    const bottom = content.split("\n").filter(Boolean).slice(-3).join("\n");
    return /↳ ›|› /.test(bottom) || /claude-[0-9]|anthropic[\/)]|% left/.test(bottom);
  },
  isApproval(content) {
    return /Allow .*—|\(Y\/n\)|\(y\/N\)|needs-approval/.test(content);
  },
};

// Claude: the node process often lives on a different pane than the UI,
// so screen content is unreliable. Use title only.
const claudeDetector: AgentDetector = {
  isWorking(_content, title) {
    return /[⠁-⠿]/.test(title) || /✢/.test(title);
  },
  isIdle(_content, title) {
    return !/[⠁-⠿]/.test(title);
  },
  isApproval(_content) {
    // Can't reliably detect from screen — title doesn't indicate approval
    return false;
  },
};

// Generic fallback for codex, aider, cursor, etc.
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
    return /needs-approval|Allow .*—|Do you want to run|Allow this|approve this|\(Y\/n\)|\(y\/N\)/.test(content);
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
  agent: string
): Promise<{ status: AgentStatus; detail?: string }> {
  const detector = getDetector(agent);

  const rawLines = await run(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -20 2>/dev/null`
  );
  const content = rawLines.replace(/\n{3,}/g, "\n\n");

  // 1. Approval — always highest priority
  if (detector.isApproval(content)) {
    return { status: "approval" };
  }

  // 2. Working
  if (detector.isWorking(content, title)) {
    return { status: "working" };
  }

  // 3. Idle prompt visible
  if (detector.isIdle(content, title)) {
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
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}' 2>/dev/null`
  );
  if (!raw) return [];

  const results: AgentPane[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId] = line.split("§");

    const leafCmd = findLeafProcessSync(pid);
    let agentName: string | null = null;
    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = findAgentOnTtySync(tty);
    }
    if (!agentName) continue;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = detectStatusSync(pane, title, wact, agentName);
    const paneShort = pane.replace(/\.0$/, "");
    const titleClean = title.replace(/^[\u2801-\u28FF] */u, "").slice(0, 30);

    results.push({ pane: paneShort, paneId, title: titleClean, agent: friendlyName(agentName), status, detail });
  }

  const order: Record<AgentStatus, number> = { approval: 0, working: 1, stalled: 2, waiting: 3, idle: 4 };
  results.sort((a, b) => order[a.status] - order[b.status]);
  return results;
}

function findLeafProcessSync(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = execSync_(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
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

function detectStatusSync(paneRef: string, title: string, windowActivity: number, agent: string): { status: AgentStatus; detail?: string } {
  const detector = getDetector(agent);

  const rawLines = execSync_(`tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -20 2>/dev/null`);
  const content = rawLines.replace(/\n{3,}/g, "\n\n");

  if (detector.isApproval(content)) return { status: "approval" };
  if (detector.isWorking(content, title)) return { status: "working" };
  if (detector.isIdle(content, title)) return { status: "waiting" };

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
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}' 2>/dev/null`
  );
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);

  // Process all panes concurrently
  const promises = lines.map(async (line) => {
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId] = line.split("§");

    const leafCmd = await findLeafProcess(pid);
    let agentName: string | null = null;
    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = await findAgentOnTty(tty);
    }
    if (!agentName) return null;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = await detectStatus(pane, title, wact, agentName);
    const paneShort = pane.replace(/\.0$/, "");
    const titleClean = title.replace(/^[\u2801-\u28FF] */u, "").slice(0, 30);

    return { pane: paneShort, paneId, title: titleClean, agent: friendlyName(agentName), status, detail } as AgentPane;
  });

  const results = (await Promise.all(promises)).filter((r): r is AgentPane => r !== null);

  const order: Record<AgentStatus, number> = { approval: 0, working: 1, stalled: 2, waiting: 3, idle: 4 };
  results.sort((a, b) => order[a.status] - order[b.status]);
  return results;
}

const BACK_ENV = "AGENTS_BACK_PANE";

export function switchToPane(paneId: string): void {
  const current = execSync_(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
  if (current) {
    execSync_(`tmux set-environment -g ${BACK_ENV} ${JSON.stringify(current)}`);
  }
  execSync_(`tmux select-window -t ${JSON.stringify(paneId)}`);
  execSync_(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

export function switchBack(): boolean {
  const back = execSync_(`tmux show-environment -g ${BACK_ENV} 2>/dev/null`).replace(`${BACK_ENV}=`, "");
  if (!back) return false;
  execSync_(`tmux select-window -t ${JSON.stringify(back)}`);
  execSync_(`tmux switch-client -t ${JSON.stringify(back)}`);
  return true;
}

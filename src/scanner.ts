import { execSync } from "child_process";

export type AgentStatus = "working" | "stalled" | "waiting" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  title: string;
  agent: string;
  status: AgentStatus;
  detail?: string;
}

// Agent process names to detect — extend this list for custom agents
const AGENT_PROCS = /^(claude|copilot|opencode|codex|aider|cursor)$/i;

const IDLE_PATTERNS =
  /shift.tab|ctrl.q|press enter|waiting|❯|➜|\$\s*$|>\s*$|switch mode|enqueue|anthropic\/|openai\/|model.*\|.*main|claude-[0-9]|% \|/i;

const BRAILLE_SPINNER = /[⠁-⠿⏳🔄]/;

// Map binary names to display names (e.g. if your agent binary differs)
const FRIENDLY_NAMES: Record<string, string> = {};

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function friendlyName(name: string): string {
  return FRIENDLY_NAMES[name] ?? name;
}

function findLeafProcess(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = exec(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    leaf = child;
  }
  return exec(`ps -p ${leaf} -o comm= 2>/dev/null`).replace(/.*\//, "");
}

function findAgentOnTty(tty: string): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = exec(`ps -o comm= -t ${ttyShort} 2>/dev/null`);
  for (const line of procs.split("\n")) {
    const cmd = line.replace(/.*\//, "").replace(/^-/, "");
    if (AGENT_PROCS.test(cmd)) return cmd;
  }
  return null;
}

function detectStatus(
  paneRef: string,
  title: string,
  windowActivity: number
): { status: AgentStatus; detail?: string } {
  // 1. Title spinner = working
  if (BRAILLE_SPINNER.test(title)) {
    return { status: "working" };
  }

  // 2. Screen content analysis
  const lastLines = exec(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p -S -5 2>/dev/null`
  )
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .slice(-3)
    .join("\n");

  const fullPane = exec(
    `tmux capture-pane -t ${JSON.stringify(paneRef)} -p 2>/dev/null`
  );
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;

  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;

  if (isEmpty) {
    return { status: "waiting" };
  }
  if (IDLE_PATTERNS.test(lastLines)) {
    return { status: "waiting" };
  }
  if (age < 30) {
    return { status: "working", detail: `${age}s` };
  }
  if (age < 120) {
    return { status: "stalled", detail: `${age}s` };
  }
  const mins = Math.floor(age / 60);
  return { status: "idle", detail: `${mins}m` };
}

export function scan(): AgentPane[] {
  const raw = exec(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}' 2>/dev/null`
  );

  if (!raw) return [];

  const results: AgentPane[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, _winname, _fgcmd, wactStr, tty, paneId] =
      line.split("§");

    // Find agent process
    const leafCmd = findLeafProcess(pid);
    let agentName: string | null = null;

    if (AGENT_PROCS.test(leafCmd)) {
      agentName = leafCmd;
    } else if (tty) {
      agentName = findAgentOnTty(tty);
    }

    if (!agentName) continue;

    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = detectStatus(pane, title, wact);

    // Clean up display
    const paneShort = pane.replace(/\.0$/, "");
    const titleClean = title.replace(/^[⠁-⠿✳⏳🔄🤖π] */, "").slice(0, 30);

    results.push({
      pane: paneShort,
      paneId,
      title: titleClean,
      agent: friendlyName(agentName),
      status,
      detail,
    });
  }

  // Sort: working > stalled > waiting > idle
  const order: Record<AgentStatus, number> = {
    working: 0,
    stalled: 1,
    waiting: 2,
    idle: 3,
  };
  results.sort((a, b) => order[a.status] - order[b.status]);

  return results;
}

export function switchToPane(paneId: string): void {
  exec(`tmux select-window -t ${JSON.stringify(paneId)}`);
  exec(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

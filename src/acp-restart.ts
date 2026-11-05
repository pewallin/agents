// Restarts the agent of a pane in ACP mode (`agents acp-restart --pane %N`), for an agent that was
// started without its ACP view: before Agents Next had it, by hand in a shell, or outside the app.
// The agent leaves its TUI as it would on Ctrl-C, and starts again in the same pane on the same
// session, with its own options, under the wrapper that serves its ACP view: `codex-session` for
// Codex (the pane's app-server, shared live), `acp-session --tui` for the others (hand-off).
//
//   --check   says whether the pane can be restarted, and why not, without touching it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ACP_AGENTS } from "./acp-host-cli.js";
import { getSelfArgv, getStateDir } from "./paths.js";

/** Executables of the agents that have an ACP view, and how each gets it. */
const AGENTS: Record<string, { stateAgent: string; registryId: string; live: boolean }> = {
  codex: { stateAgent: "codex", registryId: "codex-acp", live: true },
  claude: { stateAgent: "claude", registryId: "claude-acp", live: false },
  opencode: { stateAgent: "opencode", registryId: "opencode", live: false },
  pi: { stateAgent: "pi", registryId: "pi-acp", live: false },
  copilot: { stateAgent: "copilot", registryId: "github-copilot-cli", live: false },
  "kiro-cli": { stateAgent: "kiro", registryId: "kiro", live: false },
};

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "-zsh", "-bash", "-sh", "-fish"]);
const RUNTIMES = new Set(["node", "bun", "deno"]);
const BUSY = new Set(["working", "approval", "question", "compacting"]);

export interface PaneProcess {
  pid: number;
  ppid: number;
  args: string;
}

export interface AgentState {
  state?: string;
  externalSessionId?: string;
}

export type RestartPlan =
  | {
    ok: true;
    agent: string;
    stateAgent: string;
    sessionId: string;
    agentPid: number;
    /** The agent runs in the pane's shell: the restart is typed there, so the shell stays. */
    viaShell: boolean;
    command: string;
  }
  | { ok: false; reason: string; agent?: string };

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An agent's command line as it was run: a script run by node names its agent by the script. */
export function agentWords(args: string): { name: string; words: string[] } | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  let start = 0;
  if (RUNTIMES.has(basename(words[0])) && words.length > 1) start = 1;
  const name = basename(words[start]).toLowerCase();
  if (!(name in AGENTS)) return undefined;
  return { name, words: [start === 1 ? name : words[0], ...words.slice(start + 1)] };
}

/** `codex … resume <session>`: the command's own options stay, a resume it had is replaced. */
export function codexResumeCommand(words: string[], sessionId: string): string {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "resume") {
      const next = words[index + 1];
      if (next && !next.startsWith("-")) index += 1;
      continue;
    }
    if (word === "--last") continue;
    kept.push(word);
  }
  return [...kept, "resume", sessionId].map(shellQuote).join(" ");
}

function descendants(processes: PaneProcess[], root: number): PaneProcess[] {
  const byParent = new Map<number, PaneProcess[]>();
  for (const process of processes) {
    const siblings = byParent.get(process.ppid) ?? [];
    siblings.push(process);
    byParent.set(process.ppid, siblings);
  }
  const found: PaneProcess[] = [];
  const self = processes.find((process) => process.pid === root);
  const queue = self ? [self] : [];
  while (queue.length > 0) {
    const next = queue.shift()!;
    found.push(next);
    queue.push(...(byParent.get(next.pid) ?? []));
  }
  return found;
}

/** What a restart of the pane's agent in ACP mode does, or why there is none. */
export function planAcpRestart(input: {
  paneId: string;
  panePid: number;
  processes: PaneProcess[];
  stateOf: (stateAgent: string) => AgentState | undefined;
  /** How to run this agents CLI, as shell words. */
  agentsCommand: string;
}): RestartPlan {
  const tree = descendants(input.processes, input.panePid);
  if (tree.some((process) => / (codex-session|acp-session)( |$)/.test(process.args))) {
    return { ok: false, reason: "The agent already runs with its ACP view, but the view's host is not running. Quit the agent and start it again from Agents Next." };
  }
  // The shallowest agent process: the agent itself, not the processes it runs.
  const agentProcess = tree.find((process) => agentWords(process.args) !== undefined);
  if (!agentProcess) return { ok: false, reason: "This pane runs no agent with an ACP view." };
  const { name, words } = agentWords(agentProcess.args)!;
  const agent = AGENTS[name];
  const state = input.stateOf(agent.stateAgent);
  if (state?.state && BUSY.has(state.state)) {
    return { ok: false, agent: name, reason: "The agent is working – restart it in ACP mode when it is done." };
  }
  const sessionId = state?.externalSessionId?.trim();
  if (!sessionId) {
    return { ok: false, agent: name, reason: "The agent has not reported its session yet; it does once it has run a turn. Restart it in ACP mode after that." };
  }
  const tuiCommand = words.map(shellQuote).join(" ");
  const resumed = agent.live
    ? codexResumeCommand(words, sessionId)
    : ACP_AGENTS[agent.registryId]?.resume?.(tuiCommand, sessionId);
  if (!resumed) return { ok: false, agent: name, reason: `There is no way to resume a ${name} session.` };
  const bin = input.agentsCommand;
  const command = agent.live
    ? `${bin} codex-session --command ${shellQuote(resumed)}`
    : `${bin} acp-session --agent ${agent.registryId} --tui ${shellQuote(resumed)}`;
  const parent = input.processes.find((process) => process.pid === agentProcess.ppid);
  const viaShell = agentProcess.pid !== input.panePid
    && parent !== undefined
    && SHELLS.has(basename(parent.args.trim().split(/\s+/)[0] ?? ""));
  return { ok: true, agent: name, stateAgent: agent.stateAgent, sessionId, agentPid: agentProcess.pid, viaShell, command };
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", timeout: 5_000 });
}

function listProcesses(): PaneProcess[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }));
}

function readState(stateAgent: string, paneId: string): AgentState | undefined {
  try {
    return JSON.parse(readFileSync(join(getStateDir(), `${stateAgent}-${paneId}.json`), "utf8")) as AgentState;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export async function runAcpRestart(args: string[]): Promise<number> {
  const paneIndex = args.indexOf("--pane");
  const paneId = paneIndex >= 0 ? args[paneIndex + 1] : process.env.TMUX_PANE;
  const check = args.includes("--check");
  const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!paneId || !/^%\d+$/.test(paneId)) {
    say({ ok: false, reason: "acp-restart needs --pane %N" });
    return 2;
  }
  let panePid: number;
  let cwd: string;
  let remainOnExit: string;
  try {
    const [pid, path] = tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}\t#{pane_current_path}"]).trim().split("\t");
    panePid = Number(pid);
    cwd = path;
    remainOnExit = tmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim();
  } catch (error) {
    say({ ok: false, reason: `No such pane: ${error instanceof Error ? error.message : String(error)}` });
    return 1;
  }
  const self = getSelfArgv();
  const plan = planAcpRestart({
    paneId,
    panePid,
    processes: listProcesses(),
    stateOf: (stateAgent) => readState(stateAgent, paneId),
    agentsCommand: self.map(shellQuote).join(" "),
  });
  if (check || !plan.ok) {
    say(plan);
    return plan.ok ? 0 : 1;
  }

  // A pane whose start command is the agent closes when the agent ends: it stays for the respawn.
  if (!plan.viaShell) tmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
  try {
    // The agent leaves as on Ctrl-C (twice: most TUIs ask once), then is told to, then made to.
    tmux(["send-keys", "-t", paneId, "C-c"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    tmux(["send-keys", "-t", paneId, "C-c"]);
    if (!await waitForExit(plan.agentPid, 6_000)) {
      try { process.kill(plan.agentPid, "SIGTERM"); } catch { /* gone */ }
      if (!await waitForExit(plan.agentPid, 3_000)) {
        try { process.kill(plan.agentPid, "SIGKILL"); } catch { /* gone */ }
        await waitForExit(plan.agentPid, 2_000);
      }
    }
    if (plan.viaShell) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      tmux(["send-keys", "-t", paneId, "-l", plan.command]);
      tmux(["send-keys", "-t", paneId, "Enter"]);
    } else {
      tmux(["respawn-pane", "-k", "-t", paneId, "-c", cwd, plan.command]);
    }
  } finally {
    if (!plan.viaShell) {
      tmux(remainOnExit && remainOnExit !== "off"
        ? ["set-option", "-p", "-t", paneId, "remain-on-exit", remainOnExit]
        : ["set-option", "-p", "-u", "-t", paneId, "remain-on-exit"]);
    }
  }
  say({ ...plan, restarted: true });
  return 0;
}

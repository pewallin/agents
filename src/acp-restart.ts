// Restarts the agent of a pane in ACP mode (`agents acp-restart --pane %N`), for an agent that was
// started without its ACP view: before Agents Next had it, by hand in a shell, or outside the app.
// The agent leaves its TUI as it would on Ctrl-C, and starts again in the same pane on the same
// session, with its own options, under the wrapper that serves its ACP view: `codex-session` for
// Codex (the pane's app-server, shared live), `acp-session --tui` for the others (hand-off).
//
//   --check   says whether the pane can be restarted, and why not, without touching it.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** The ACP registry id an agent's executable hands its session over with (`acp-session --agent`),
 *  for every agent with an ACP view but Codex, which shares its session live. */
export function handOffAgentId(executable: string | undefined): string | undefined {
  const name = basename(executable ?? "").toLowerCase();
  const agent = AGENTS[name];
  return agent && !agent.live ? agent.registryId : undefined;
}

/** A shell integration's pty wrapper (Kiro's "zsh (kiro-cli-term)", Amazon Q's and Fig's alike)
 *  names itself after the shell it wraps: it is no shell to type into. */
export function isPtyWrapper(args: string): boolean {
  return /^\S+ \([^)]+\)/.test(args.trim());
}

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
  // The executable as it ran (its path), not its name: the restarted pane may not find the name
  // on its PATH (a Kiro the app could not restart, 2026-11-06).
  return { name, words: [words[start], ...words.slice(start + 1)] };
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
  /** The session the agent's processes hold open (Kiro's lock files), for an agent that has one. */
  heldSession?: (registryId: string, pids: number[]) => string | undefined;
  /** How to run this agents CLI, as shell words. */
  agentsCommand: string;
  /** The tmux server's version (`#{version}`): a restart that respawns the pane needs 3.8. */
  tmuxVersion?: string;
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
  // The session the running agent holds is the one to resume; a reported one may be from the
  // agent before it in the pane. A command that names its session says it too.
  const held = input.heldSession?.(agent.registryId, descendants(input.processes, agentProcess.pid).map((process) => process.pid));
  const sessionId = held ?? state?.externalSessionId?.trim() ?? resumeIdOf(words);
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
  // Behind a shell integration's pty wrapper the agent's shell is the wrapper's child, and keys
  // reach it through the wrapper. An agent the wrapper runs itself ends the wrapper with it.
  const viaShell = agentProcess.pid !== input.panePid
    && parent !== undefined
    && !isPtyWrapper(parent.args)
    && SHELLS.has(basename(parent.args.trim().split(/\s+/)[0] ?? ""));
  if (!viaShell && !respawnIsSafe(input.tmuxVersion)) {
    return {
      ok: false,
      agent: name,
      reason: `The agent is this pane's own command, so a restart would respawn the pane, and tmux ${input.tmuxVersion} can crash its server doing that while Agents Next shows the pane (tmux issue 5498, fixed in tmux 3.8). Update tmux (brew upgrade tmux) and restart its server, or start the agent from a shell in the pane.`,
    };
  }
  return { ok: true, agent: name, stateAgent: agent.stateAgent, sessionId, agentPid: agentProcess.pid, viaShell, command };
}

/** Whether respawning a pane is safe with a control client (Agents Next) attached: tmux before
 *  3.8 keeps a lagging control client's offsets across the respawn, and its next read of the new
 *  process's output crashes the server in input_parse (tmux issue 5498; the mini's server,
 *  2026-11-06). A version tmux does not number (master, next-3.9) is taken as new. */
export function respawnIsSafe(version: string | undefined): boolean {
  const match = version?.match(/^(?:next-)?(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 3 || (major === 3 && minor >= 8);
}

/** `--resume-id <id>` or `--resume <id>` in an agent's command. */
function resumeIdOf(words: string[]): string | undefined {
  for (let index = 0; index < words.length - 1; index += 1) {
    if ((words[index] === "--resume-id" || words[index] === "--resume") && !words[index + 1].startsWith("-")) return words[index + 1];
  }
  return undefined;
}

/** The session whose lock file (`{"pid": …}`) one of `pids` holds. */
export function sessionHeldBy(locks: Array<{ sessionId: string; path: string }>, pids: number[]): string | undefined {
  const wanted = new Set(pids);
  // A stale lock may name a pid that is now one of these: the newest lock wins.
  let found: { session: string; at: number } | undefined;
  for (const lock of locks) {
    try {
      const pid = (JSON.parse(readFileSync(lock.path, "utf8")) as { pid?: unknown }).pid;
      const at = statSync(lock.path).mtimeMs;
      if (typeof pid === "number" && wanted.has(pid) && (!found || at > found.at)) found = { session: lock.sessionId, at };
    } catch { /* not a lock */ }
  }
  return found?.session;
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

/** Every process under `root` (not `root`), deepest last. */
export function descendantPids(processes: PaneProcess[], root: number): number[] {
  return descendants(processes, root).map((process) => process.pid).filter((pid) => pid !== root);
}

/** A process tree's processes still alive. */
function aliveOf(pids: number[]): number[] {
  return pids.filter(alive);
}

async function waitForAll(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (aliveOf(pids).length > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export async function runAcpRestart(args: string[], runtimeTempDir?: string): Promise<number> {
  const paneIndex = args.indexOf("--pane");
  const paneId = paneIndex >= 0 ? args[paneIndex + 1] : process.env.TMUX_PANE;
  const check = args.includes("--check");
  // Each step goes to the pane's ACP log (pane-N.log), also when no host ever starts there.
  const logPath = runtimeTempDir && paneId && /^%\d+$/.test(paneId)
    ? join(runtimeTempDir, "acp-session", `pane-${paneId.slice(1)}.log`)
    : undefined;
  const log = (message: string) => {
    if (!logPath || check) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} restart: ${message}\n`);
    } catch {}
  };
  const say = (value: unknown) => {
    if (!check) log(`result ${JSON.stringify(value)}`);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  if (!paneId || !/^%\d+$/.test(paneId)) {
    say({ ok: false, reason: "acp-restart needs --pane %N" });
    return 2;
  }
  let panePid: number;
  let cwd: string;
  let remainOnExit: string;
  let tmuxVersion: string;
  try {
    const [pid, path, version] = tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}\t#{pane_current_path}\t#{version}"]).trim().split("\t");
    panePid = Number(pid);
    cwd = path;
    tmuxVersion = version ?? "";
    remainOnExit = tmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim();
  } catch (error) {
    say({ ok: false, reason: `No such pane: ${error instanceof Error ? error.message : String(error)}` });
    return 1;
  }
  const self = getSelfArgv();
  const processes = listProcesses();
  const plan = planAcpRestart({
    paneId,
    panePid,
    processes,
    stateOf: (stateAgent) => readState(stateAgent, paneId),
    heldSession: (registryId, pids) => {
      const locks = ACP_AGENTS[registryId]?.sessionLocks?.();
      return locks ? sessionHeldBy(locks, pids) : undefined;
    },
    agentsCommand: self.map(shellQuote).join(" "),
    tmuxVersion,
  });
  if (check || !plan.ok) {
    say(plan);
    return plan.ok ? 0 : 1;
  }

  log(`${plan.agent} ${plan.agentPid} in ${paneId} on session ${plan.sessionId}: ${plan.command}`);
  try {
    return await restartAgent(plan, paneId, cwd, remainOnExit, processes, log, say);
  } catch (error) {
    // Whatever stops the restart is said, in the pane's log and to the app: never a silent end.
    const reason = `The restart stopped: ${error instanceof Error ? error.message : String(error)}`;
    say({ ok: false, agent: plan.agent, reason });
    return 1;
  }
}

async function restartAgent(
  plan: Extract<RestartPlan, { ok: true }>,
  paneId: string,
  cwd: string,
  remainOnExit: string,
  processes: PaneProcess[],
  log: (message: string) => void,
  say: (value: unknown) => void,
): Promise<number> {
  // The agent and every process it runs (Kiro v3: kiro-cli, kiro-cli-chat, its TUI and the ACP
  // child that holds the session's lock): all of them end before the agent starts again.
  const tree = [plan.agentPid, ...descendantPids(processes, plan.agentPid)];
  // A pane whose start command is the agent closes when the agent ends: it stays for the respawn.
  if (!plan.viaShell) tmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
  try {
    // The agent leaves as on Ctrl-C (twice: most TUIs ask once), then by its quit command, then
    // is told to, then made to.
    tmux(["send-keys", "-t", paneId, "C-c"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    tmux(["send-keys", "-t", paneId, "C-c"]);
    log("sent Ctrl-C twice");
    // The quit command only while the agent itself still has the pane: a shell would run it.
    if (!await waitForAll(tree, 3_000) && alive(plan.agentPid)) {
      tmux(["send-keys", "-t", paneId, "-l", "/quit"]);
      tmux(["send-keys", "-t", paneId, "Enter"]);
      log("still running; sent /quit");
    }
    // Once the agent itself has quit, what it leaves running (Kiro's ACP child) is ended at once.
    if (!await waitForAll(tree, alive(plan.agentPid) ? 4_000 : 500)) {
      log(`still running (${aliveOf(tree).join(" ")}); SIGTERM`);
      for (const pid of aliveOf(tree)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
      if (!await waitForAll(tree, 3_000)) {
        log(`still running (${aliveOf(tree).join(" ")}); SIGKILL`);
        for (const pid of aliveOf(tree)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        await waitForAll(tree, 2_000);
      }
    }
    log(aliveOf(tree).length === 0 ? "the agent ended" : `processes left running: ${aliveOf(tree).join(" ")}`);
    if (plan.viaShell) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      tmux(["send-keys", "-t", paneId, "-l", plan.command]);
      tmux(["send-keys", "-t", paneId, "Enter"]);
    } else {
      // The pane starts again with the PATH and agents settings this CLI runs with (the app's), not
      // only the tmux server's, which may not find the agent or this CLI.
      const environment = Object.entries(process.env)
        .filter(([name, value]) => value !== undefined && (name === "PATH" || name.startsWith("AGENTS_")) && name !== "AGENTS_APP_TMUX_PANE_ID")
        .flatMap(([name, value]) => ["-e", `${name}=${value}`]);
      tmux(["respawn-pane", "-k", "-t", paneId, "-c", cwd, ...environment, plan.command]);
      log("respawned the pane");
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

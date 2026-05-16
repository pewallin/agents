import { basename } from "path";
import { exec, execAsync } from "./shell.js";

const PROCESS_TREE_PS_COMMAND = "ps -eo pid=,ppid=,comm=,tty=,%cpu=,rss=,args= 2>/dev/null";

export interface ProcEntry {
  pid: number;
  ppid: number;
  comm: string;
  tty: string;
  cpuPercent: number;
  memoryMB: number;
  args: string;
}

export interface AgentLeafProcess {
  agentName: string;
  process: ProcEntry | null;
}

interface AgentProcessMatch extends AgentLeafProcess {
  depth: number;
}

const AGENT_PROC_NAMES = ["claude", "copilot", "opencode", "codex", "cursor", "pi", "kiro", "kiro-cli", "kiro-cli-chat"] as const;
const AGENT_PROCS = new RegExp(`^(${AGENT_PROC_NAMES.join("|")})$`, "i");
const WRAPPER_PROCS = new Set(["node", "bun", "bunx", "deno", "tsx", "ts-node", "env", "npm", "npx", "pnpm", "yarn"]);
const AGENT_PROC_ALIASES: Record<string, string> = {
  "kiro": "kiro",
  "kiro-cli": "kiro",
  "kiro-cli-chat": "kiro",
};

function normalizeProcessToken(token: string): string {
  if (!token) return "";
  const trimmed = token.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) return "";
  return basename(trimmed).replace(/^-/, "");
}

export function detectAgentProcess(comm: string, args: string): string | null {
  const rawTokens = [comm, ...args.trim().split(/\s+/)].filter(Boolean);
  const candidates: string[] = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const current = normalizeProcessToken(rawTokens[i]);
    if (!current) continue;
    candidates.push(current);
    if (WRAPPER_PROCS.has(current.toLowerCase()) && rawTokens[i + 1]) {
      const wrapped = normalizeProcessToken(rawTokens[i + 1]);
      if (wrapped) candidates.push(wrapped);
    }
  }

  for (const candidate of candidates) {
    if (!AGENT_PROCS.test(candidate)) continue;
    const normalized = candidate.toLowerCase();
    return AGENT_PROC_ALIASES[normalized] || normalized;
  }
  return null;
}

export interface ProcessTree {
  byPid: Map<number, ProcEntry>;
  children: Map<number, number[]>;
  byTty: Map<string, ProcEntry[]>;
}

function preferredAgentProcess(a: AgentProcessMatch | null, b: AgentProcessMatch | null): AgentProcessMatch | null {
  if (!a) return b;
  if (!b) return a;
  if (a.depth !== b.depth) return a.depth > b.depth ? a : b;
  const aMemory = a.process?.memoryMB ?? -1;
  const bMemory = b.process?.memoryMB ?? -1;
  if (aMemory !== bMemory) return aMemory > bMemory ? a : b;
  const aCpu = a.process?.cpuPercent ?? -1;
  const bCpu = b.process?.cpuPercent ?? -1;
  if (aCpu !== bCpu) return aCpu > bCpu ? a : b;
  return a;
}

function findBestAgentProcessInTree(pid: number, tree: ProcessTree, depth = 0): AgentProcessMatch | null {
  const entry = tree.byPid.get(pid);
  const agentName = entry ? detectAgentProcess(entry.comm, entry.args) : null;
  let best: AgentProcessMatch | null = agentName ? { agentName, process: entry ?? null, depth } : null;

  for (const child of tree.children.get(pid) || []) {
    best = preferredAgentProcess(best, findBestAgentProcessInTree(child, tree, depth + 1));
  }

  return best;
}

function parseProcessTree(raw: string): ProcessTree {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([-\d.,]+)\s+(\d+)\s*(.*)$/);
    if (!match) continue;

    const rssKB = parseInt(match[6], 10) || 0;
    const entry: ProcEntry = {
      pid: parseInt(match[1], 10),
      ppid: parseInt(match[2], 10),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
      cpuPercent: parseFloat(match[5].replace(",", ".")) || 0,
      memoryMB: Math.round(rssKB / 1024),
      args: match[7] || "",
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

export function buildProcessTree(): ProcessTree {
  return parseProcessTree(exec(PROCESS_TREE_PS_COMMAND));
}

export async function buildProcessTreeAsync(): Promise<ProcessTree> {
  return parseProcessTree(await execAsync(PROCESS_TREE_PS_COMMAND));
}

export function findAgentLeafInTree(pid: number, tree: ProcessTree): AgentLeafProcess | null {
  const best = findBestAgentProcessInTree(pid, tree);
  return best ? { agentName: best.agentName, process: best.process } : null;
}

export function findLeafInTree(pid: number, tree: ProcessTree): string {
  return findAgentLeafInTree(pid, tree)?.agentName || "";
}

export function findAgentOnTtyProcessInTree(tty: string, tree: ProcessTree): AgentLeafProcess | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = tree.byTty.get(ttyShort);
  if (!procs) return null;
  let best: AgentProcessMatch | null = null;
  for (const p of procs) {
    const agent = detectAgentProcess(p.comm, p.args);
    if (!agent) continue;
    let depth = 0;
    for (let parent = tree.byPid.get(p.ppid); parent && parent.tty === p.tty; parent = tree.byPid.get(parent.ppid)) {
      depth += 1;
    }
    best = preferredAgentProcess(best, { agentName: agent, process: p, depth });
  }
  return best ? { agentName: best.agentName, process: best.process } : null;
}

export function findAgentOnTtyInTree(tty: string, tree: ProcessTree): string | null {
  return findAgentOnTtyProcessInTree(tty, tree)?.agentName || null;
}

export function buildBranchCache(uniqueCwds: Set<string>): Map<string, string | undefined> {
  const branchCache = new Map<string, string | undefined>();
  if (uniqueCwds.size === 0) return branchCache;

  const cwdArr = [...uniqueCwds];
  const script = cwdArr.map(d => `git -C ${JSON.stringify(d)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`).join("\n");
  const branches = exec(`bash -c ${JSON.stringify(script)}`).split("\n");
  for (let i = 0; i < cwdArr.length; i++) {
    branchCache.set(cwdArr[i], branches[i] || undefined);
  }
  return branchCache;
}

export async function buildBranchCacheAsync(uniqueCwds: Set<string>): Promise<Map<string, string | undefined>> {
  const branchCache = new Map<string, string | undefined>();
  if (uniqueCwds.size === 0) return branchCache;

  const cwdArr = [...uniqueCwds];
  const script = cwdArr.map(d => `git -C ${JSON.stringify(d)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`).join("\n");
  const branches = (await execAsync(`bash -c ${JSON.stringify(script)}`)).split("\n");
  for (let i = 0; i < cwdArr.length; i++) {
    branchCache.set(cwdArr[i], branches[i] || undefined);
  }
  return branchCache;
}

export function findLeafProcessSync(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = exec(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    const agent = detectAgentProcess("", exec(`ps -p ${child} -o args= 2>/dev/null`));
    if (agent) return agent;
    leaf = child;
  }
  return detectAgentProcess("", exec(`ps -p ${leaf} -o args= 2>/dev/null`)) || "";
}

import { basename } from "path";
import { exec, execAsync } from "./shell.js";

interface ProcEntry { pid: number; ppid: number; comm: string; tty: string; args: string }

const AGENT_PROC_NAMES = ["claude", "copilot", "opencode", "codex", "cursor", "pi"] as const;
const AGENT_PROCS = new RegExp(`^(${AGENT_PROC_NAMES.join("|")})$`, "i");
const WRAPPER_PROCS = new Set(["node", "bun", "bunx", "deno", "tsx", "ts-node", "env", "npm", "npx", "pnpm", "yarn"]);

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
    if (AGENT_PROCS.test(candidate)) return candidate.toLowerCase();
  }
  return null;
}

export interface ProcessTree {
  byPid: Map<number, ProcEntry>;
  children: Map<number, number[]>;
  byTty: Map<string, ProcEntry[]>;
}

export function buildProcessTree(): ProcessTree {
  const raw = exec("ps -eo pid=,ppid=,comm=,tty=,args= 2>/dev/null");
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const entry: ProcEntry = {
      pid: parseInt(match[1]),
      ppid: parseInt(match[2]),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
      args: match[5] || "",
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

export async function buildProcessTreeAsync(): Promise<ProcessTree> {
  const raw = await execAsync("ps -eo pid=,ppid=,comm=,tty=,args= 2>/dev/null");
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const entry: ProcEntry = {
      pid: parseInt(match[1]),
      ppid: parseInt(match[2]),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
      args: match[5] || "",
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

export function findLeafInTree(pid: number, tree: ProcessTree): string {
  let current = pid;
  for (;;) {
    const kids = tree.children.get(current);
    if (!kids || kids.length === 0) break;
    const child = kids[0];
    const entry = tree.byPid.get(child);
    const agent = entry ? detectAgentProcess(entry.comm, entry.args) : null;
    if (agent) return agent;
    current = child;
  }
  const entry = tree.byPid.get(current);
  return entry ? (detectAgentProcess(entry.comm, entry.args) || "") : "";
}

export function findAgentOnTtyInTree(tty: string, tree: ProcessTree): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = tree.byTty.get(ttyShort);
  if (!procs) return null;
  for (const p of procs) {
    const agent = detectAgentProcess(p.comm, p.args);
    if (agent) return agent;
  }
  return null;
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

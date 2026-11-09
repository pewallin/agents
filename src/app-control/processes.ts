// @ts-nocheck
// Process tables: which agent a pane's keys reach.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// A question for the user goes to the user: the app shows it as the worker's attention.
export const PARENT_WAKING_STATES = new Set(["done", "blocked", "ask-coordinator"]);
export const SHELL_COMMANDS = new Set(["bash", "fish", "login", "nu", "sh", "tmux", "zsh"]);
// An agent that ended its turn, with or without a question for the user, waits at its prompt.
export const AT_PROMPT_STATES = new Set(["idle", "question"]);
// Report states that end when the worker works again.
export const SETTLED_REPORTS = new Set(["done", "blocked", "ask-coordinator", "ask-user"]);
export const COORDINATOR_ANSWER_PATIENCE_MS = 10 * 60 * 1000;

// tmux names a pane's command after the leader of the process group in the terminal's foreground,
// which for an agent started behind a shell can be a shell: a `zsh -c` wrapper, Kiro's TUI in a
// terminal of its own beneath the pane's zsh, or a terminal proxy such as Kiro's kiro-cli-term,
// which holds the pane's terminal and runs the user's shell and its agent on another. Keys typed
// into the pane reach a process when, on every terminal along the way from the pane's process down
// to it, the last process on that terminal is in that terminal's foreground group and not stopped:
// it reads the keys and passes them on to the next terminal. A shell at its prompt (behind a proxy
// or not), an editor in front of a background agent, or a stopped agent does not count.
export const AGENT_EXECUTABLES = new Set(["claude", "codex", "copilot", "hermes", "kiro", "kiro-cli", "kiro-cli-chat", "opencode", "pi"]);
export const SCRIPT_RUNTIMES = new Set(["bun", "deno", "node"]);
export const NO_TERMINAL = new Set(["", "?", "??", "-"]);

// `ps` rows: pid ppid pgid tpgid tty stat ucomm args. A ucomm with spaces, like kiro-cli-term's
// "zsh (kiro-cli-term)", keeps its first word; the rest runs into args. ps pads ucomm to its
// column, so args start after any number of spaces.
export function parseProcessTable(text) {
  const byPid = new Map();
  const children = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const entry = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), tty: match[5], stat: match[6], comm: match[7], args: match[8] };
    byPid.set(entry.pid, entry);
    children.set(entry.ppid, [...(children.get(entry.ppid) || []), entry.pid]);
  }
  return { byPid, children };
}

export function processTable() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,stat=,ucomm=,args="], { encoding: "utf8" });
  return parseProcessTable(result.stdout);
}

// By executable, the name it was started by (Claude Code's executable is named after its version,
// like 2.1.302), or the script a runtime runs: never by a shell's arguments, which may only name one.
export function agentExecutable(entry) {
  if (AGENT_EXECUTABLES.has(entry.comm)) return entry.comm;
  const words = entry.args.split(/\s+/);
  if (SCRIPT_RUNTIMES.has(entry.comm)) {
    const script = path.basename(words[1] || "");
    return AGENT_EXECUTABLES.has(script) ? script : undefined;
  }
  if (isShell(entry)) return undefined;
  const started = path.basename(words[0] || "");
  return AGENT_EXECUTABLES.has(started) ? started : undefined;
}

// Whether keys typed into the pane reach the last process of `chain`, the pane's process first.
export function keysReach(chain) {
  if (NO_TERMINAL.has(chain[chain.length - 1].tty)) return false;
  const lastOnTerminal = new Map();
  for (const entry of chain) {
    if (!NO_TERMINAL.has(entry.tty)) lastOnTerminal.set(entry.tty, entry);
  }
  return [...lastOnTerminal.values()].every(entry => entry.tpgid > 0 && entry.pgid === entry.tpgid && !entry.stat.includes("T"));
}

export function isShell(entry) {
  return SHELL_COMMANDS.has(entry.comm.replace(/^-/, ""));
}

// The agent in front of a pane whose command tmux names as a shell: { agent, pid }, or { reason }.
export function agentInFrontOfShell(record, table = processTable()) {
  const pane = `pane ${record.paneID}`;
  const root = table.byPid.get(record.panePid);
  if (!root) return { reason: `${pane} runs ${record.currentCommand} and its process is gone` };
  // The deepest process the keys reach, and the first agent they do not.
  let front = keysReach([root]) ? { entry: root, depth: 1 } : undefined;
  let unreached;
  const queue = [[root]];
  for (let index = 0; index < queue.length; index += 1) {
    const above = queue[index];
    for (const childPid of table.children.get(above[above.length - 1].pid) || []) {
      const entry = table.byPid.get(childPid);
      const chain = [...above, entry];
      const reached = keysReach(chain);
      const agent = agentExecutable(entry);
      if (agent && reached) return { agent, pid: entry.pid };
      if (agent && !unreached) unreached = { agent, entry };
      if (reached && (!front || chain.length > front.depth)) front = { entry, depth: chain.length };
      queue.push(chain);
    }
  }
  if (unreached?.entry.stat.includes("T")) {
    return { reason: `the agent ${unreached.agent} in ${pane} is stopped` };
  }
  if (!front) {
    return { reason: `${pane} runs ${record.currentCommand} and no agent holds its terminal` };
  }
  const inFront = isShell(front.entry) ? `${front.entry.comm.replace(/^-/, "")} at its own prompt` : front.entry.comm;
  if (unreached) {
    return { reason: `the agent ${unreached.agent} in ${pane} runs in the background, behind ${inFront}` };
  }
  return { reason: `${pane} runs ${inFront}, with no agent in front of it` };
}

// Whether typing into the pane reaches an agent rather than a shell: { ok } or { ok: false, reason }.
export function paneRunsAgent(record, table) {
  if (!SHELL_COMMANDS.has(record.currentCommand)) return { ok: true };
  const front = agentInFrontOfShell(record, table);
  return front.agent ? { ok: true, agent: front.agent } : { ok: false, reason: front.reason };
}

export function oneLine(text, limit = 300) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

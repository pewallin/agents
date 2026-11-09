// Which agent sessions are open in another pane, so a session is not opened twice: `agents
// resume` refuses one (session-open-elsewhere), and `agents history` marks each with the pane
// that has it, for Agents Next's Conversations and the ACP view's /resume to go to that pane.
//
// Most agents let a second process open a session another has open, and both then write it
// (docs/acp-view-client.md, "One session opened twice"), so this does not wait for the agent to
// refuse. What says a session is open:
//   - an agent pane reports it as its session (its hooks' state, as `agents ls` shows it)
//   - the agent's own record of a process that has it, while that process runs:
//       Kiro     its session lock, {"pid", "started_at"} (sessions/<hash>/<id>/.lock, cli/<id>.lock)
//       Codex    ~/.codex/thread-writer-locks/<thread>.lock, held open by the writing app-server
//       Claude   ~/.claude/sessions/<pid>.json of each interactive process ({pid, sessionId})
// A process is located to the pane whose process tree it is in; one outside every pane is still
// a holder (another app, a terminal outside tmux), named by its pid.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileCapture } from "./shell.js";
import { kiroSessionLocks } from "./kiro-sessions.js";
import { normalizeAgentName, sameAgent } from "./agent-registry.js";
import { liveLockHolder } from "./acp-handoff.js";
import type { AgentPane } from "./scanner-types.js";

/** Where a session is open. */
export interface SessionHolder {
  /** The tmux pane whose processes have it, if a pane does. */
  pane?: string;
  /** That pane's tmux session and window name, to say where it is. */
  session?: string;
  window?: string;
  /** The process that holds it, when the agent's own record names one. */
  pid?: number;
}

export interface HolderInputs {
  /** The agent panes, with the session each reports. */
  panes: Array<Pick<AgentPane, "tmuxPaneId" | "agent" | "externalSessionId">>;
  /** Every tmux pane: its id, its process and where it is. */
  tmuxPanes: Array<{ paneId: string; pid: number; session?: string; window?: string }>;
  /** The process table, to find the pane a process runs in. */
  processes: Array<{ pid: number; ppid: number }>;
  /** Live processes the agent's own records name as having a session. */
  records: Array<{ sessionId: string; pid: number }>;
}


/** The tmux pane a process runs in: the pane whose process is it or one of its ancestors. */
export function paneOfProcess(pid: number, inputs: Pick<HolderInputs, "tmuxPanes" | "processes">): HolderInputs["tmuxPanes"][number] | undefined {
  const parents = new Map(inputs.processes.map((row) => [row.pid, row.ppid]));
  const byPid = new Map(inputs.tmuxPanes.map((pane) => [pane.pid, pane]));
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < 64; depth += 1) {
    const pane = byPid.get(current);
    if (pane) return pane;
    current = parents.get(current);
  }
  return undefined;
}

/**
 * The holders of `sessionIds` of `agent` other than `ownPane`: a session `ownPane` has, or one
 * of its own processes holds, is not open elsewhere. Panes first (they say where), then the
 * agent's records.
 */
export function findSessionHolders(
  agent: string,
  sessionIds: string[],
  ownPane: string | undefined,
  inputs: HolderInputs,
): Map<string, SessionHolder> {
  const wanted = new Set(sessionIds.filter(Boolean));
  const holders = new Map<string, SessionHolder>();
  const where = (paneId: string) => inputs.tmuxPanes.find((pane) => pane.paneId === paneId);
  for (const pane of inputs.panes) {
    const id = pane.externalSessionId;
    if (!id || !wanted.has(id) || holders.has(id) || pane.tmuxPaneId === ownPane || !sameAgent(pane.agent, agent)) continue;
    const location = where(pane.tmuxPaneId);
    holders.set(id, { pane: pane.tmuxPaneId, ...(location?.session ? { session: location.session } : {}), ...(location?.window ? { window: location.window } : {}) });
  }
  for (const record of inputs.records) {
    if (!wanted.has(record.sessionId) || holders.has(record.sessionId)) continue;
    const pane = paneOfProcess(record.pid, inputs);
    if (pane && pane.paneId === ownPane) continue;
    holders.set(record.sessionId, pane
      ? { pane: pane.paneId, pid: record.pid, ...(pane.session ? { session: pane.session } : {}), ...(pane.window ? { window: pane.window } : {}) }
      : { pid: record.pid });
  }
  return holders;
}

/** One line on where a session is open, for a message. */
export function describeHolder(holder: SessionHolder): string {
  if (holder.pane) {
    const place = [holder.session, holder.window].filter(Boolean).join(" › ");
    return place ? `pane ${holder.pane} (${place})` : `pane ${holder.pane}`;
  }
  return holder.pid ? `another process (${holder.pid}) outside Agents Next's panes` : "another process";
}

// The live inputs.

function tmuxPanes(): HolderInputs["tmuxPanes"] {
  // tmux 3.7 prints control characters in -F output as "_": fields are joined by text.
  const separator = "⁣|⁣";
  const result = execFileCapture("tmux", ["list-panes", "-a", "-F", ["#{pane_id}", "#{pane_pid}", "#{session_name}", "#{window_name}"].join(separator)]);
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const [paneId, pid, session, window] = line.split(separator);
    return paneId && Number(pid) > 0 ? [{ paneId: paneId.trim(), pid: Number(pid), session, window }] : [];
  });
}

function processTable(): Array<{ pid: number; ppid: number; args: string }> {
  const result = execFileCapture("ps", ["-A", "-o", "pid=,ppid=,args="]);
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : [];
  });
}

/** Kiro's lock holders of `sessionIds`. */
function kiroRecords(sessionIds: Set<string>): HolderInputs["records"] {
  return kiroSessionLocks().flatMap((lock) => {
    if (!sessionIds.has(lock.sessionId)) return [];
    const pid = liveLockHolder(lock.path);
    return pid ? [{ sessionId: lock.sessionId, pid }] : [];
  });
}

/** The app-servers holding Codex threads' writer locks (lsof names the process with it open). */
function codexRecords(sessionIds: Set<string>): HolderInputs["records"] {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks");
  const files = [...sessionIds].map((id) => join(root, `${id}.lock`)).filter((file) => existsSync(file));
  if (files.length === 0) return [];
  const result = execFileCapture("lsof", ["-F", "pn", "--", ...files]);
  const records: HolderInputs["records"] = [];
  let pid = 0;
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) {
      const name = line.slice(1).split("/").pop() ?? "";
      if (name.endsWith(".lock")) records.push({ sessionId: name.slice(0, -".lock".length), pid });
    }
  }
  return records;
}

/** Claude Code's records of its interactive processes, those still running Claude. */
function claudeRecords(sessionIds: Set<string>, processes: Array<{ pid: number; args: string }>): HolderInputs["records"] {
  const directory = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const running = new Map(processes.map((row) => [row.pid, row.args]));
  return names.flatMap((name) => {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), "utf8")) as { pid?: unknown; sessionId?: unknown };
      const pid = Number(value.pid);
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
      // A pid the system gave another program since is not Claude's.
      return sessionIds.has(sessionId) && /claude/i.test(running.get(pid) ?? "") ? [{ sessionId, pid }] : [];
    } catch {
      return [];
    }
  });
}

/** The agent's own records of processes that have `sessionIds` open. */
function agentRecords(agent: string, sessionIds: Set<string>, processes: Array<{ pid: number; args: string }>): HolderInputs["records"] {
  if (sessionIds.size === 0) return [];
  switch (normalizeAgentName(agent)) {
    case "kiro":
      return kiroRecords(sessionIds);
    case "codex":
      return codexRecords(sessionIds);
    case "claude":
      return claudeRecords(sessionIds, processes);
    default:
      return [];
  }
}

/** What `findSessionHolders` needs, read from tmux, the process table and the agent's records. */
export function liveHolderInputs(agent: string, sessionIds: string[], panes: HolderInputs["panes"]): HolderInputs {
  const processes = processTable();
  return { panes, tmuxPanes: tmuxPanes(), processes, records: agentRecords(agent, new Set(sessionIds.filter(Boolean)), processes) };
}

export interface HistoryGroupLike {
  agent: string;
  tmuxPaneId?: string;
  sessions: Array<{ sessionId: string; current?: boolean; openIn?: SessionHolder }>;
}

/** Marks each session of `groups` that another pane (or process) has open with where it is
 *  (`openIn`), against the group's own pane. */
export function markOpenElsewhere(groups: HistoryGroupLike[], panes: HolderInputs["panes"]): void {
  if (groups.length === 0) return;
  const processes = processTable();
  const base = { panes, tmuxPanes: tmuxPanes(), processes };
  for (const group of groups) {
    const ids = group.sessions.filter((session) => !session.current).map((session) => session.sessionId);
    if (ids.length === 0) continue;
    const holders = findSessionHolders(group.agent, ids, group.tmuxPaneId, { ...base, records: agentRecords(group.agent, new Set(ids), processes) });
    for (const session of group.sessions) {
      const holder = session.current ? undefined : holders.get(session.sessionId);
      if (holder) session.openIn = holder;
    }
  }
}

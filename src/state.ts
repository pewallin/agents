import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ReportedState = "working" | "idle" | "approval" | "question";

export interface WorkspaceSnapshot {
  command: string;
  cwd: string;
  mux?: "tmux" | "zellij";
  sessionName?: string;
}

export interface StateEntry {
  state: ReportedState;
  ts: number;
  agent: string;
  session: string;
  detail?: string;         // transient activity detail (e.g. tool name, filename)
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  workspace?: WorkspaceSnapshot;
}

const STATE_DIR = join(homedir(), ".agents", "state");

function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** Write state for an agent session. Called by hook integrations. */
export interface ReportOptions {
  detail?: string;
  context?: string;
  workspace?: WorkspaceSnapshot;
  contextTokens?: number;
  contextMax?: number;
}

/** Write state for an agent session. Called by hook integrations. */
export function reportState(agent: string, session: string, state: ReportedState, optsOrContext?: ReportOptions | string, workspace?: WorkspaceSnapshot, contextTokens?: number, contextMax?: number): void {
  // Support both new options-object style and legacy positional args
  let opts: ReportOptions;
  if (typeof optsOrContext === "object" && optsOrContext !== null && !("command" in optsOrContext)) {
    opts = optsOrContext as ReportOptions;
  } else {
    opts = { context: optsOrContext as string | undefined, workspace, contextTokens, contextMax };
  }

  ensureDir();
  const filePath = join(STATE_DIR, `${agent}-${session}.json`);
  let existing: StateEntry | null = null;
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {}

  let { detail, context, workspace: ws, contextTokens: ctxTokens, contextMax: ctxMax } = opts;
  if (context === undefined) context = existing?.context;
  if (ctxTokens === undefined) ctxTokens = existing?.contextTokens;
  if (ctxMax === undefined) ctxMax = existing?.contextMax;
  // Preserve existing workspace if it has a sessionName (seeded by createWorkspace).
  // Hook-reported snapshots lack sessionName and should not overwrite authoritative data.
  if (ws === undefined || (existing?.workspace?.sessionName && !ws?.sessionName)) {
    ws = existing?.workspace;
  }

  const entry: StateEntry = {
    state,
    ts: Math.floor(Date.now() / 1000),
    agent,
    session,
    ...(detail ? { detail } : {}),
    ...(context ? { context } : {}),
    ...(ctxTokens !== undefined ? { contextTokens: ctxTokens } : {}),
    ...(ctxMax !== undefined ? { contextMax: ctxMax } : {}),
    ...(ws ? { workspace: ws } : {}),
  };
  writeFileSync(filePath, JSON.stringify(entry));
}

/** Update only the context field for an agent session, preserving state. */
export function reportContext(agent: string, session: string, context: string, workspace?: WorkspaceSnapshot, contextTokens?: number, contextMax?: number): void {
  ensureDir();
  const filePath = join(STATE_DIR, `${agent}-${session}.json`);
  let entry: StateEntry;
  try {
    entry = JSON.parse(readFileSync(filePath, "utf-8"));
    entry.context = context;
    if (contextTokens !== undefined) entry.contextTokens = contextTokens;
    if (contextMax !== undefined) entry.contextMax = contextMax;
    if (workspace !== undefined && !(entry.workspace?.sessionName && !workspace?.sessionName)) {
      entry.workspace = workspace;
    }
    entry.ts = Math.floor(Date.now() / 1000);
  } catch {
    entry = { state: "idle", ts: Math.floor(Date.now() / 1000), agent, session, context,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextMax !== undefined ? { contextMax } : {}),
      ...(workspace ? { workspace } : {}) };
  }
  writeFileSync(filePath, JSON.stringify(entry));
}

/** Read all fresh state entries (< maxAge seconds old).
 *  maxAge is only for disk cleanup of orphaned files (dead sessions).
 *  Active sessions update state via hooks; no hook = no expiry concern. */
export function readStates(maxAge: number = 86400): StateEntry[] {
  ensureDir();
  const now = Math.floor(Date.now() / 1000);
  const entries: StateEntry[] = [];
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data: StateEntry = JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8"));
        if (now - data.ts > maxAge) {
          // Clean up stale files
          try { unlinkSync(join(STATE_DIR, f)); } catch {}
          continue;
        }
        entries.push(data);
      } catch {}
    }
  } catch {}
  return entries;
}

/** Get the aggregate state for an agent type (e.g. "claude").
 *  If session is provided, only check that specific session.
 *  If ANY session is in approval → approval.
 *  If ANY session is working → working.
 *  Otherwise → idle (or null if no data). */

/** Get the state entry (with timestamp) for a specific agent session. */
export function getAgentStateEntry(agent: string, session?: string): StateEntry | null {
  let entries = readStates().filter((e) => e.agent === agent);
  if (session) {
    entries = entries.filter((e) => e.session === session);
  }
  if (entries.length === 0) return null;
  // Priority: approval > working > question > idle
  return entries.find((e) => e.state === "approval")
    || entries.find((e) => e.state === "working")
    || entries.find((e) => e.state === "question")
    || entries[0];
}

export function getAgentState(agent: string, session?: string): ReportedState | null {
  let entries = readStates().filter((e) => e.agent === agent);
  if (session) {
    entries = entries.filter((e) => e.session === session);
  }
  if (entries.length === 0) return null;
  if (entries.some((e) => e.state === "approval")) return "approval";
  if (entries.some((e) => e.state === "working")) return "working";
  if (entries.some((e) => e.state === "question")) return "question";
  return "idle";
}

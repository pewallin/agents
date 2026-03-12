import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ReportedState = "working" | "idle" | "approval";

export interface StateEntry {
  state: ReportedState;
  ts: number;
  agent: string;
  session: string;
}

const STATE_DIR = join(homedir(), ".agents", "state");

function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** Write state for an agent session. Called by hook integrations. */
export function reportState(agent: string, session: string, state: ReportedState): void {
  ensureDir();
  const entry: StateEntry = { state, ts: Math.floor(Date.now() / 1000), agent, session };
  writeFileSync(join(STATE_DIR, `${agent}-${session}.json`), JSON.stringify(entry));
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
export function getAgentState(agent: string, session?: string): ReportedState | null {
  let entries = readStates().filter((e) => e.agent === agent);
  if (session) {
    entries = entries.filter((e) => e.session === session);
  }
  if (entries.length === 0) return null;
  if (entries.some((e) => e.state === "approval")) return "approval";
  if (entries.some((e) => e.state === "working")) return "working";
  return "idle";
}

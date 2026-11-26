// Where a pane's session log chain goes on from, read from and kept in the pane's tmux options:
// @agents_session_log is the session the pane's host last wrote a log for (the previous one of
// the next), @agents_program and @agents_task name a worker's thread, and @agents_session_how
// says how the pane's next session begins (a respawn and why), once.
import { execFileSync } from "node:child_process";
import type { SessionLogOrigin } from "./session-log.js";

export const SESSION_LOG_OPTION = "@agents_session_log";
export const SESSION_HOW_OPTION = "@agents_session_how";

function paneOption(paneId: string, name: string): string | undefined {
  try {
    const value = execFileSync("tmux", ["show-options", "-p", "-q", "-v", "-t", paneId, name], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function setPaneOption(paneId: string, name: string, value?: string): void {
  try {
    const args = value === undefined ? ["set-option", "-p", "-u", "-t", paneId, name] : ["set-option", "-p", "-t", paneId, name, value];
    execFileSync("tmux", args, { timeout: 3_000, stdio: "ignore" });
  } catch {
    // The chain then starts again with the next session.
  }
}

/** What a pane's session log tap needs: where a new session's chain goes on from, and keeping
 *  the pane's last session as it changes. */
export function paneSessionLog(paneId: string): { origin: (sessionId: string) => SessionLogOrigin; onSession: (sessionId: string) => void } {
  return {
    origin: (sessionId) => {
      const previous = paneOption(paneId, SESSION_LOG_OPTION);
      let how: SessionLogOrigin["how"];
      const told = paneOption(paneId, SESSION_HOW_OPTION);
      if (told) {
        try {
          const value = JSON.parse(told) as { start?: unknown; why?: unknown };
          if (typeof value.start === "string") how = { start: value.start, ...(typeof value.why === "string" && value.why ? { why: value.why } : {}) };
        } catch { /* not ours */ }
        setPaneOption(paneId, SESSION_HOW_OPTION);
      }
      return {
        ...(previous && previous !== sessionId ? { previous } : {}),
        pane: paneId,
        ...(paneOption(paneId, "@agents_program") ? { program: paneOption(paneId, "@agents_program") } : {}),
        ...(paneOption(paneId, "@agents_task") ? { task: paneOption(paneId, "@agents_task") } : {}),
        ...(how ? { how } : {}),
      };
    },
    onSession: (sessionId) => setPaneOption(paneId, SESSION_LOG_OPTION, sessionId),
  };
}

/** The program a pane coordinates now (@agents_role coordinator, @agents_program), read at most
 *  every 10 s: a promote makes a pane coordinator while its host runs. */
export function paneCoordinatorProgram(paneId: string): () => string | undefined {
  let checkedAt = 0;
  let program: string | undefined;
  return () => {
    if (Date.now() - checkedAt > 10_000) {
      checkedAt = Date.now();
      program = paneOption(paneId, "@agents_role") === "coordinator" ? paneOption(paneId, "@agents_program") : undefined;
    }
    return program;
  };
}

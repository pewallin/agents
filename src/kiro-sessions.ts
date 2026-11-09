// Which Kiro session goes on from a session id we kept.
//
// Kiro 3 resumes a Kiro 2 session (a bare UUID) by copying it into a v3 session of its own,
// `cli_<uuid>_<suffix>`, and the v2 session stays as it was. Resumed by its UUID again, Kiro
// makes another copy from the old v2 session: what was done in the last copy is not in it. And
// when a v3 session with the bare UUID also exists (an ACP `session/load` of the UUID makes one),
// the TUI refuses the UUID: `Session id "<uuid>" is ambiguous (2 matches)`, since it matches a
// UUID-shaped id exactly against every session of the folder (Peter's MacBook, 2026-11-09).
//
// So a UUID goes on as the newest v3 copy Kiro made of it, when there is one.
import { execFileSync } from "node:child_process";

export interface KiroListedSession {
  sessionId: string;
  source: string;
  updatedAt: string;
}

/** Kiro's own test for an id it matches exactly rather than as a prefix (its TUI's `--resume-id`). */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}/i;

/** The sessions in `kiro-cli chat --list-sessions --format json` output (its last line). */
export function parseKiroSessionList(output: string): KiroListedSession[] {
  const last = output.split("\n").map((line) => line.trim()).filter(Boolean).pop();
  if (!last) return [];
  try {
    const envelopes = JSON.parse(last);
    if (!Array.isArray(envelopes)) return [];
    return envelopes.flatMap((envelope) => Array.isArray(envelope?.sessions) ? envelope.sessions : [])
      .filter((session: unknown): session is KiroListedSession => {
        const entry = session as Partial<KiroListedSession> | null;
        return typeof entry?.sessionId === "string" && typeof entry.source === "string" && typeof entry.updatedAt === "string";
      });
  } catch {
    return [];
  }
}

/** The session that goes on from `sessionId`: the newest v3 copy Kiro made of a v2 session, or
 *  `sessionId` itself. */
export function kiroContinuedSession(sessionId: string, sessions: KiroListedSession[]): string {
  if (!UUID_SHAPED.test(sessionId)) return sessionId;
  const copies = sessions
    .filter((session) => session.source === "v3" && session.sessionId.startsWith(`cli_${sessionId}_`))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return copies[0]?.sessionId ?? sessionId;
}

/** The sessions Kiro lists for `cwd`; none when it cannot say. */
export function listKiroSessions(cwd: string, executable = "kiro-cli"): KiroListedSession[] {
  try {
    const output = execFileSync(executable, ["chat", "--list-sessions", "--format", "json"], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseKiroSessionList(output);
  } catch {
    return [];
  }
}

/** The session to resume for `sessionId` in `cwd`. Kiro is asked only for a UUID-shaped id. */
export function kiroResumeSessionId(
  sessionId: string,
  cwd: string,
  list: (cwd: string) => KiroListedSession[] = listKiroSessions,
): string {
  return UUID_SHAPED.test(sessionId) ? kiroContinuedSession(sessionId, list(cwd)) : sessionId;
}

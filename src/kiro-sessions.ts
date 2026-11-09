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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/** A Kiro conversation of a folder, for `agents history`. */
export interface KiroHistoryEntry {
  sessionId: string;
  title: string;
  /** Seconds since 1970. */
  updatedAt: number;
  model?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function seconds(iso: unknown): number | undefined {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The first thing the user asked in a Kiro 3 session: its title until Kiro gives it one. */
function firstPrompt(messagesPath: string): string | undefined {
  try {
    for (const line of readFileSync(messagesPath, "utf8").split("\n").slice(0, 200)) {
      if (!line.includes('"type":"user"')) continue;
      const content = JSON.parse(line)?.payload?.content;
      if (typeof content === "string" && content.trim()) return content.trim().split("\n")[0];
    }
  } catch {}
  return undefined;
}

/**
 * The conversations Kiro has for `cwd`, newest first, as its TUI can resume them: Kiro 3's
 * sessions (<root>/<workspace hash>/<id>/session.json, with messages.jsonl once a turn ran) and
 * Kiro 2's (<root>/cli/<id>.json). A Kiro 2 session Kiro 3 has copied is left out for its newest
 * copy, which is where it goes on; so is a Kiro 3 session with a Kiro 2 session's id (an ACP load
 * makes one), which the TUI refuses as ambiguous.
 */
export function kiroHistoryForCwd(cwd: string, root: string = join(homedir(), ".kiro", "sessions")): KiroHistoryEntry[] {
  const folder = realPath(cwd);
  const v3: KiroHistoryEntry[] = [];
  for (const workspace of directories(root)) {
    if (workspace === "cli") continue;
    for (const name of directories(join(root, workspace))) {
      const directory = join(root, workspace, name);
      const messages = join(directory, "messages.jsonl");
      if (!existsSync(messages)) continue;
      const session = readJson(join(directory, "session.json"));
      const paths = session?.workspacePaths;
      if (!session || !Array.isArray(paths) || typeof paths[0] !== "string" || realPath(paths[0]) !== folder) continue;
      const stored = typeof session.title === "string" ? session.title.trim() : "";
      const title = stored && stored !== "New Session" ? stored : firstPrompt(messages) ?? (stored || "Kiro session");
      const updatedAt = seconds(session.lastModifiedAt) ?? seconds(session.createdAt) ?? Math.round(statSync(messages).mtimeMs / 1000);
      const model = typeof session.modelId === "string" ? session.modelId : undefined;
      v3.push({ sessionId: typeof session.id === "string" ? session.id : name, title, updatedAt, ...(model ? { model } : {}) });
    }
  }
  const v2: KiroHistoryEntry[] = [];
  try {
    for (const name of readdirSync(join(root, "cli"))) {
      if (!name.endsWith(".json")) continue;
      const session = readJson(join(root, "cli", name));
      if (!session || typeof session.cwd !== "string" || realPath(session.cwd) !== folder) continue;
      const sessionId = typeof session.session_id === "string" ? session.session_id : name.slice(0, -".json".length);
      const title = typeof session.title === "string" && session.title.trim() ? session.title.trim() : "Kiro session";
      v2.push({ sessionId, title, updatedAt: seconds(session.updated_at) ?? seconds(session.created_at) ?? 0 });
    }
  } catch {}
  const v2Ids = new Set(v2.map((session) => session.sessionId));
  const copied = (id: string) => v3.some((session) => session.sessionId.startsWith(`cli_${id}_`));
  const newestCopies = new Map<string, KiroHistoryEntry>();
  const kept = v3.filter((session) => !v2Ids.has(session.sessionId));
  for (const session of kept) {
    const original = /^cli_(.+)_[^_]+$/.exec(session.sessionId)?.[1];
    if (!original) continue;
    const newest = newestCopies.get(original);
    if (!newest || session.updatedAt > newest.updatedAt) newestCopies.set(original, session);
  }
  return [
    ...kept.filter((session) => {
      const original = /^cli_(.+)_[^_]+$/.exec(session.sessionId)?.[1];
      return !original || newestCopies.get(original) === session;
    }),
    ...v2.filter((session) => !copied(session.sessionId)),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}

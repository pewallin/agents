// Kiro's session store: where Kiro keeps its sessions, settings and locks, and which session
// goes on from an id we kept. Everything in the agents CLI that reads Kiro's files does it here.
//
//   Kiro 2   <root>/cli/<id>.json (its conversation), <id>.jsonl (the transcript), <id>.lock
//   Kiro 3   <root>/<workspace hash>/<id>/session.json, messages.jsonl once a turn ran, .lock
//            (<id> is sess_<uuid>, or cli_<uuid>_<suffix> for a copy of a Kiro 2 session)
//
// Kiro 3 resumes a Kiro 2 session (a bare UUID) by copying it into a session of its own,
// `cli_<uuid>_<suffix>`, and the Kiro 2 session stays as it was. Resumed by its UUID again, Kiro
// makes another copy from the old one: what was done in the last copy is not in it. And when a
// Kiro 3 session with the bare UUID also exists (an ACP `session/load` of the UUID makes one),
// the TUI refuses the UUID: `Session id "<uuid>" is ambiguous (2 matches)`, since it matches a
// UUID-shaped id exactly against every session of the folder (seen 2026-11-09).
//
// So a UUID goes on as the newest copy Kiro 3 made of it, when there is one. The copies are read
// from Kiro's files, as `agents history` reads them, so the list and a resume agree; asking
// `kiro-cli chat --list-sessions` instead took seconds and blocked the ACP host while it ran.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where Kiro keeps its sessions: AGENTS_KIRO_SESSIONS_DIR (tests, private instances), else
 *  ~/.kiro/sessions. */
export function kiroSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_KIRO_SESSIONS_DIR || join(homedir(), ".kiro", "sessions");
}

/** Kiro's own settings file, ~/.kiro/settings/cli.json. */
export function kiroSettingsPath(): string {
  return join(homedir(), ".kiro", "settings", "cli.json");
}

/** One of Kiro's settings (chat.defaultAgent, chat.agentEngine, …); none when it cannot say. */
export function kiroSetting(key: string, settingsPath: string = kiroSettingsPath()): string | undefined {
  try {
    const value = JSON.parse(readFileSync(settingsPath, "utf8"))?.[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Kiro's test for an id it matches exactly rather than as a prefix (its TUI's `--resume-id`). */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}/i;

function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The Kiro 3 workspace folders of the store (every folder but cli/). */
function workspaceFolders(root: string): string[] {
  return entries(root).filter((entry) => entry.isDirectory() && entry.name !== "cli" && !entry.name.startsWith(".")).map((entry) => join(root, entry.name));
}

/** Kiro's session locks (`{"pid": …}` while a process has the session open). */
export function kiroSessionLocks(root: string = kiroSessionsRoot()): Array<{ sessionId: string; path: string }> {
  const locks: Array<{ sessionId: string; path: string }> = [];
  for (const entry of entries(join(root, "cli"))) {
    if (entry.isFile() && entry.name.endsWith(".lock")) locks.push({ sessionId: entry.name.slice(0, -".lock".length), path: join(root, "cli", entry.name) });
  }
  for (const workspace of workspaceFolders(root)) {
    for (const session of entries(workspace)) {
      const path = join(workspace, session.name, ".lock");
      if (session.isDirectory() && !session.name.startsWith(".") && existsSync(path)) locks.push({ sessionId: session.name, path });
    }
  }
  return locks;
}

/** Where Kiro keeps a session's lock: beside the session in Kiro 3, in cli/ in Kiro 2. */
export function kiroSessionLock(sessionId: string, root: string = kiroSessionsRoot()): string {
  return kiroSessionLocks(root).find((lock) => lock.sessionId === sessionId)?.path
    ?? join(root, "cli", `${sessionId}.lock`);
}

/** A Kiro 3 session's folder, if the store has one. */
export function kiroV3SessionDirectory(sessionId: string, root: string = kiroSessionsRoot()): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  for (const workspace of workspaceFolders(root)) {
    const directory = join(workspace, sessionId);
    if (existsSync(join(directory, "session.json")) || existsSync(join(directory, "messages.jsonl"))) return directory;
  }
  return undefined;
}

/** The transcript Kiro keeps of a session, where it goes on (kiroContinuedSession): Kiro 3's
 *  messages.jsonl, else Kiro 2's <id>.jsonl. */
export function kiroSessionTranscript(sessionId: string, root: string = kiroSessionsRoot()): string | undefined {
  const v3 = kiroV3SessionDirectory(kiroContinuedSession(sessionId, root), root) ?? kiroV3SessionDirectory(sessionId, root);
  if (v3 && existsSync(join(v3, "messages.jsonl"))) return join(v3, "messages.jsonl");
  const v2 = join(root, "cli", `${sessionId}.jsonl`);
  return /^[\w.-]+$/.test(sessionId) && existsSync(v2) ? v2 : undefined;
}

/** When a Kiro 3 session was last used: its lastModifiedAt, else when its transcript or folder
 *  was last written. */
function lastUsed(directory: string): number {
  const session = readJson(join(directory, "session.json"));
  const at = typeof session?.lastModifiedAt === "string" ? Date.parse(session.lastModifiedAt) : NaN;
  if (Number.isFinite(at)) return at;
  for (const path of [join(directory, "messages.jsonl"), directory]) {
    try {
      return statSync(path).mtimeMs;
    } catch {}
  }
  return 0;
}

/** The session that goes on from `sessionId`: the newest copy Kiro 3 made of a Kiro 2 session,
 *  or `sessionId` itself. */
export function kiroContinuedSession(sessionId: string, root: string = kiroSessionsRoot()): string {
  if (!UUID_SHAPED.test(sessionId)) return sessionId;
  const prefix = `cli_${sessionId}_`;
  let newest: { id: string; at: number } | undefined;
  for (const workspace of workspaceFolders(root)) {
    for (const entry of entries(workspace)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const at = lastUsed(join(workspace, entry.name));
      if (!newest || at > newest.at) newest = { id: entry.name, at };
    }
  }
  return newest?.id ?? sessionId;
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
  return entries(path).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
}

/** The first thing the user asked in a Kiro 3 session: its title until Kiro gives it one. */
/** Whether a session's messages hold `marker`: a session only opened has no prompt. */
function hasLine(messagesPath: string, marker: string): boolean {
  try {
    return readFileSync(messagesPath, "utf8").includes(marker);
  } catch {
    return false;
  }
}

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
 * makes one), which the TUI refuses as ambiguous. A session only opened (no prompt in it) is left
 * out, unless it is `current`, the one a pane has open.
 */
export function kiroHistoryForCwd(cwd: string, root: string = kiroSessionsRoot(), current?: string): KiroHistoryEntry[] {
  const folder = realPath(cwd);
  const v3: KiroHistoryEntry[] = [];
  for (const workspace of directories(root)) {
    if (workspace === "cli") continue;
    for (const name of directories(join(root, workspace))) {
      const directory = join(root, workspace, name);
      const messages = join(directory, "messages.jsonl");
      if (!existsSync(messages)) continue;
      const session = readJson(join(directory, "session.json"));
      if ((session?.id ?? name) !== current && !hasLine(messages, '"type":"user"')) continue;
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
      if (sessionId !== current && !hasLine(join(root, "cli", `${name.slice(0, -".json".length)}.jsonl`), '"kind":"Prompt"')) continue;
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

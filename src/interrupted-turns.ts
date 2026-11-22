// Whether an agent's latest turn is one the user interrupted, read from its transcript.
//
// Claude Code and Codex run no Stop hook for a turn the user interrupts (Esc), so the pane's hooks
// leave it "working" while the agent waits at its prompt. Their transcripts say the turn ended:
// Claude writes a user entry "[Request interrupted by user]" (or "… for tool use") as the turn's
// last line (~/.claude/projects/<dir>/<id>.jsonl); Codex writes a turn_aborted event to its
// rollout (~/.codex/sessions/…/rollout-…-<id>.jsonl).

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TurnBoundary = { interrupted: boolean; at: number };

const TURN_TAIL_BYTES = 256 * 1024;
const boundaryCache = new Map<string, { size: number; mtimeMs: number; boundary?: TurnBoundary }>();

/** The latest line of a transcript's tail that `boundaryOf` reads as a turn's start or end. Cached
 *  by size and modification time, since a scan asks every second. */
function lastTurnBoundary(transcript: string, boundaryOf: (line: string) => TurnBoundary | undefined): TurnBoundary | undefined {
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(transcript));
  } catch {
    return undefined;
  }
  const cached = boundaryCache.get(transcript);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.boundary;
  let text = "";
  try {
    const length = Math.min(size, TURN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(transcript, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return undefined;
  }
  let boundary: TurnBoundary | undefined;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0 && !boundary; index -= 1) {
    try {
      boundary = boundaryOf(lines[index]);
    } catch {
      // A line cut by the start of the tail, or one being written.
    }
  }
  boundaryCache.set(transcript, { size, mtimeMs, boundary });
  return boundary;
}

function claudeProjectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

const transcriptCache = new Map<string, string>();

/** The transcript of a Claude session: in the project folder its cwd names (Claude writes each
 *  character that is not a letter or digit as "-"), else in whichever project folder holds it. */
export function claudeSessionTranscript(sessionId: string, cwd?: string, root: string = claudeProjectsRoot()): string | undefined {
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(sessionId)) return undefined;
  const key = `${root}\0${sessionId}`;
  const cached = transcriptCache.get(key);
  if (cached && existsSync(cached)) return cached;
  const file = `${sessionId}.jsonl`;
  let found: string | undefined;
  if (cwd) {
    const candidate = join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"), file);
    if (existsSync(candidate)) found = candidate;
  }
  if (!found) {
    let folders: string[] = [];
    try {
      folders = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const folder of folders) {
      const candidate = join(root, folder, file);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  if (found) transcriptCache.set(key, found);
  return found;
}

function isInterruptMarker(content: unknown): boolean {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? String(content[0].text ?? "") : "";
  return text.startsWith("[Request interrupted by user");
}

/** The latest user or assistant entry of Claude's main conversation: whether it is Claude's
 *  interrupt marker, and when it was written. */
export function claudeLastTurnBoundary(transcript: string): TurnBoundary | undefined {
  return lastTurnBoundary(transcript, (line) => {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return undefined;
    const record = JSON.parse(line);
    if ((record?.type !== "user" && record?.type !== "assistant") || record.isSidechain) return undefined;
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) return undefined;
    return { interrupted: record.type === "user" && isInterruptMarker(record.message?.content), at };
  });
}

const CODEX_TURN_EVENTS = new Set(["task_started", "task_complete", "turn_started", "turn_complete", "turn_aborted"]);

/** The latest turn event of a Codex rollout: whether the turn was aborted, and when. */
export function codexLastTurnBoundary(transcript: string): TurnBoundary | undefined {
  return lastTurnBoundary(transcript, (line) => {
    if (!line.includes('"event_msg"') || !/"(task|turn)_(started|complete|aborted)"/.test(line)) return undefined;
    const record = JSON.parse(line);
    const type = record?.payload?.type;
    if (record?.type !== "event_msg" || !CODEX_TURN_EVENTS.has(type)) return undefined;
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) return undefined;
    return { interrupted: type === "turn_aborted", at };
  });
}

// A coordinator's conversation with the user, kept apart from its agent sessions:
// <program>/thread.jsonl, only appended, one JSON line each, written under <program>/thread.lock.
//
//   message  {kind, id, at, from: "user", via, text, replyTo?}   what the user wrote to the
//            coordinator (`agent send --from user`, from the app)
//   turn     {kind, id, at, startedAt, agent, model?, session?, how: {start: fresh|continue, why?},
//            wokeBy?, ms, summary?, steps (≤30 titles), reply}   a coordinator run that ended:
//            its answer is what the user reads; how it started is in its details only
//
// A reply over 16 KB is kept in <program>/replies/<id>.md and the line names it (replyFile). The
// coordinator's pane shows this file, not its sessions' logs; a turn's Open session shows the run's
// session log (`agents session-log <session>`).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const THREAD_FILE = "thread.jsonl";
export const REPLY_INLINE_BYTES = 16 * 1024;
export const TURN_STEPS = 30;
/** A coordinator's live session goes on while it is warm: its last turn under an hour ago and
 *  its context under half full. Otherwise its next run starts fresh from its conversation. */
export const WARM_TURN_MS = 60 * 60 * 1000;
export const WARM_CONTEXT = 0.5;

export interface ThreadMessage {
  kind: "message";
  id: string;
  at: string;
  from: "user";
  via?: string;
  text: string;
  replyTo?: string;
}

export interface ThreadTurn {
  kind: "turn";
  id: string;
  at: string;
  startedAt: string;
  agent?: string;
  model?: string;
  session?: string;
  how: { start: "fresh" | "continue"; why?: string };
  wokeBy?: string;
  ms?: number;
  summary?: string;
  steps?: string[];
  reply?: string;
  replyFile?: string;
}

export type ThreadEntry = ThreadMessage | ThreadTurn;

export function threadFile(program: string): string {
  return path.join(program, THREAD_FILE);
}

function newEntryID(kind: "m" | "t", at: Date): string {
  return `${kind}-${at.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Runs `work` holding <program>/thread.lock; a lock older than 10 s is a writer that died. */
function withThreadLock<T>(program: string, work: () => T): T {
  const lock = path.join(program, "thread.lock");
  fs.mkdirSync(program, { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`${lock} is held`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function appendThreadMessage(program: string, message: { text: string; via?: string; replyTo?: string }, at = new Date()): ThreadMessage {
  const entry: ThreadMessage = {
    kind: "message",
    id: newEntryID("m", at),
    at: at.toISOString(),
    from: "user",
    ...(message.via ? { via: message.via } : {}),
    text: message.text.replace(/\r\n?/g, "\n").trim(),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  withThreadLock(program, () => fs.appendFileSync(threadFile(program), `${JSON.stringify(entry)}\n`, { mode: 0o600 }));
  return entry;
}

export function appendThreadTurn(program: string, turn: Omit<ThreadTurn, "kind" | "id" | "at" | "replyFile">, at = new Date()): ThreadTurn {
  const id = newEntryID("t", at);
  const entry: ThreadTurn = {
    kind: "turn",
    id,
    at: at.toISOString(),
    ...turn,
    ...(turn.summary ? { summary: oneLine(turn.summary, 300) } : {}),
    ...(turn.steps ? { steps: turn.steps.slice(-TURN_STEPS).map((step) => oneLine(step, 160)) } : {}),
  };
  if (entry.reply && Buffer.byteLength(entry.reply) > REPLY_INLINE_BYTES) {
    const dir = path.join(program, "replies");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.md`);
    fs.writeFileSync(file, `${entry.reply}\n`, { mode: 0o600 });
    delete entry.reply;
    entry.replyFile = file;
  }
  withThreadLock(program, () => fs.appendFileSync(threadFile(program), `${JSON.stringify(entry)}\n`, { mode: 0o600 }));
  return entry;
}

/** The conversation, entries after `after` (an id) only; a line that does not parse is skipped. */
export function readThread(program: string, options: { after?: string; withReplies?: boolean } = {}): ThreadEntry[] {
  let text = "";
  try { text = fs.readFileSync(threadFile(program), "utf8"); } catch { return []; }
  const entries: ThreadEntry[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as ThreadEntry;
      if (value && (value.kind === "message" || value.kind === "turn") && typeof value.id === "string") entries.push(value);
    } catch { /* a torn line */ }
  }
  const from = options.after ? entries.findIndex((entry) => entry.id === options.after) + 1 : 0;
  const shown = entries.slice(from);
  if (!options.withReplies) return shown;
  return shown.map((entry) => {
    if (entry.kind !== "turn" || !entry.replyFile) return entry;
    try { return { ...entry, reply: fs.readFileSync(entry.replyFile, "utf8").trimEnd() }; } catch { return entry; }
  });
}

/**
 * How a coordinator's next run starts: it goes on in its live session while that is warm (its last
 * turn under an hour ago, its context under half full), else it starts fresh from its conversation
 * and the program's memory. `context` is the share of the context window used, if known.
 */
export function nextRunStart(program: string, live: { session?: string; context?: number } | undefined, now = Date.now()): { start: "fresh" | "continue"; why: string } {
  if (!live?.session) return { start: "fresh", why: "no live session" };
  const last = [...readThread(program)].reverse().find((entry): entry is ThreadTurn => entry.kind === "turn");
  if (typeof live.context === "number" && live.context >= WARM_CONTEXT) {
    return { start: "fresh", why: `its context was ${Math.round(live.context * 100)} % full` };
  }
  const lastAt = last ? Date.parse(last.at) : NaN;
  if (Number.isFinite(lastAt) && now - lastAt >= WARM_TURN_MS) {
    return { start: "fresh", why: `its last turn was ${Math.round((now - lastAt) / 60_000)} minutes ago` };
  }
  return { start: "continue", why: "its session is warm" };
}

/** How the coordinator's next run started, as the supervisor set it when it started the run
 *  fresh (<program>/.run/next-run.json); taken once, by the turn that ends that run. */
export function noteNextRun(program: string, how: { start: "fresh" | "continue"; why?: string }): void {
  const dir = path.join(program, ".run");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "next-run.json"), `${JSON.stringify({ ...how, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function takeNextRun(program: string): { start: "fresh" | "continue"; why?: string } | undefined {
  const file = path.join(program, ".run", "next-run.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { start?: unknown; why?: unknown };
    fs.rmSync(file, { force: true });
    if (value.start !== "fresh" && value.start !== "continue") return undefined;
    return { start: value.start, ...(typeof value.why === "string" ? { why: value.why } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The conversation as the ACP updates a view draws it from (the coordinator's pane shows this,
 * not its sessions): the user's messages, and per turn its steps as settled tool calls and its
 * answer. A turn a wake began, with no message of the user's before it, begins with that wake as
 * the envelope line the view shows as one quiet row.
 */
export function threadUpdates(entries: ThreadEntry[]): Array<Record<string, unknown>> {
  const updates: Array<Record<string, unknown>> = [];
  let previous: ThreadEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === "message") {
      updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: entry.text } });
    } else {
      if (entry.wokeBy && previous?.kind !== "message") {
        const said = entry.wokeBy.replace(/</g, "‹");
        updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `<agents-event kind="wake" from="agents" words="data">${said}</agents-event>` } });
      }
      for (const [index, step] of (entry.steps ?? []).entries()) {
        const failed = step.startsWith("✗ ");
        updates.push({ sessionUpdate: "tool_call", toolCallId: `${entry.id}-${index}`, title: failed ? step.slice(2) : step, kind: "other", status: failed ? "failed" : "completed" });
      }
      if (entry.reply) updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.reply } });
    }
    previous = entry;
  }
  return updates;
}

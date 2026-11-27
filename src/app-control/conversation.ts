// A coordinator's conversation with the user, kept apart from its agent sessions:
// <program>/thread.jsonl, only appended, one JSON line each, written under <program>/thread.lock.
//
//   message  {kind, id, at, from: "user", via, text, replyTo?}   what the user wrote to the
//            coordinator (`agent send --from user`, from the app)
//   turn     {kind, id, at, startedAt, agent, model?, session?, how: {start: fresh|continue, why?},
//            wokeBy?, ms, summary?, steps (≤30 titles), reply, notify?: {why?, text}}   a
//            coordinator run that ended: its answer is what the user reads; how it started is in
//            its details only. `notify` is there when the coordinator chose to notify the user of
//            this turn (`agent notify`, R7); every other turn is quiet.
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
  notify?: TurnNotify;
}

/** Why a coordinator notifies the user of a turn (R7): a thread waits on them and it cannot answer
 *  for them, a goal is done, or something failed. */
export const NOTIFY_REASONS = ["waiting", "done", "failed"] as const;
export type NotifyReason = (typeof NOTIFY_REASONS)[number];

/** What a notification says: one line in the user's language, and why it is sent. */
export interface TurnNotify {
  why?: NotifyReason;
  text: string;
}

/** The coordinator pane's option that carries its last notifying turn, for the app: JSON
 *  {turn, at, why?, text}. The app notifies once per new `turn` and never for anything else of a
 *  project's panes. */
export const NOTIFY_OPTION = "@agents_notify";

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

function notifyFile(program: string): string {
  return path.join(program, ".run", "notify.json");
}

/** The coordinator's choice to notify the user of the turn it is in (`agent notify`); the turn
 *  that ends takes it. Marking again in the same turn replaces the line. */
export function markTurnNotify(program: string, notify: TurnNotify, at = new Date()): TurnNotify & { at: string } {
  const text = oneLine(notify.text, 300);
  const value = { at: at.toISOString(), ...(notify.why ? { why: notify.why } : {}), text };
  const dir = path.join(program, ".run");
  fs.mkdirSync(dir, { recursive: true });
  const file = notifyFile(program);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return value;
}

/** The notify mark as it stands, without taking it. */
export function pendingTurnNotify(program: string): (TurnNotify & { at: string }) | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(notifyFile(program), "utf8")) as { at?: unknown; why?: unknown; text?: unknown };
    if (typeof value.at !== "string" || typeof value.text !== "string" || !value.text.trim()) return undefined;
    const why = NOTIFY_REASONS.find((reason) => reason === value.why);
    return { at: value.at, ...(why ? { why } : {}), text: value.text };
  } catch {
    return undefined;
  }
}

/**
 * Takes the notify mark for a turn that started at `startedAt`: a mark from before the turn began
 * belongs to an earlier one that ended without taking it, and goes without notifying. Taken once.
 */
export function takeTurnNotify(program: string, startedAt: Date): TurnNotify | undefined {
  const pending = pendingTurnNotify(program);
  fs.rmSync(notifyFile(program), { force: true });
  if (!pending) return undefined;
  // A little slack: the turn's start is when its prompt was sent, the mark's own clock is the CLI's.
  if (Date.parse(pending.at) < startedAt.getTime() - 2_000) return undefined;
  return { ...(pending.why ? { why: pending.why } : {}), text: pending.text };
}

/** The value of NOTIFY_OPTION for a turn that notifies: JSON in ASCII (\u escapes), since a tmux
 *  client in a locale without UTF-8 stores other letters as "_". */
export function notifyOptionValue(turn: string | undefined, at: string, notify: TurnNotify): string {
  return JSON.stringify({ ...(turn ? { turn } : {}), at, ...(notify.why ? { why: notify.why } : {}), text: notify.text })
    .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The conversation as the ACP updates a view draws it from (the coordinator's pane shows this,
 * not its sessions): the user's messages, and per turn its steps as settled tool calls and its
 * answer. A turn a wake began, with no message of the user's before it, begins with that wake as
 * the envelope line the view shows as one quiet row. A wake that ended with nothing to say is not
 * shown at all (C1, C4): its steps stay in its session.
 */
export function threadUpdates(entries: ThreadEntry[]): Array<Record<string, unknown>> {
  const updates: Array<Record<string, unknown>> = [];
  let previous: ThreadEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === "turn" && entry.wokeBy && previous?.kind !== "message" && !entry.reply && !entry.replyFile) continue;
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

/** A session log's lines as the seed needs them (session-log.ts SessionLogLine). */
interface SeedLine { kind: string; at?: string; text?: unknown; title?: unknown; toolKind?: unknown; status?: unknown }

const ENVELOPE_START = /^<agents-event\b[^>]*>/;
const EARLIER_LINE = "⟢ agents · ";

/** What a wake line says: its summary, envelope or the line from before it. */
function wakeSummary(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith(EARLIER_LINE)) return trimmed.slice(EARLIER_LINE.length).replace(/ · read \S+\s*$/, "").trim();
  const opening = trimmed.match(ENVELOPE_START);
  if (!opening) return undefined;
  return trimmed.slice(opening[0].length).replace(/<\/agents-event>\s*$/, "").replace(/ · read \S+\s*$/, "").trim();
}

/**
 * A coordinator's conversation as its sessions' logs hold it (P4, open once and write the log
 * then): the user's messages, and per run what woke it, its steps and its answer (its last
 * message). For the conversation from before thread.jsonl was written.
 */
export function conversationFromLogs(logs: SeedLine[][]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let turn: { startedAt: string; wokeBy?: string; steps: string[]; reply?: string } | undefined;
  let count = 0;
  const id = (kind: "m" | "t") => `${kind}-seed-${(count++).toString(36)}`;
  const flush = (at: string) => {
    if (turn && (turn.reply || turn.steps.length || turn.wokeBy)) {
      entries.push({ kind: "turn", id: id("t"), at, startedAt: turn.startedAt, how: { start: "continue" }, ...(turn.wokeBy ? { wokeBy: turn.wokeBy } : {}), ...(turn.steps.length ? { steps: turn.steps.slice(-TURN_STEPS) } : {}), ...(turn.reply ? { reply: turn.reply } : {}) });
    }
    turn = undefined;
  };
  for (const lines of logs) {
    for (const line of lines) {
      const at = line.at ?? new Date(0).toISOString();
      if (line.kind === "user" && typeof line.text === "string") {
        flush(at);
        const woke = wakeSummary(line.text);
        if (woke === undefined && line.text.trim()) entries.push({ kind: "message", id: id("m"), at, from: "user", via: "session", text: line.text.trim() });
        turn = { startedAt: at, ...(woke !== undefined ? { wokeBy: woke } : {}), steps: [] };
      } else if (line.kind === "agent" && typeof line.text === "string" && line.text.trim()) {
        turn ??= { startedAt: at, steps: [] };
        turn.reply = line.text.trim();
      } else if (line.kind === "tool") {
        turn ??= { startedAt: at, steps: [] };
        turn.steps.push(`${line.status === "failed" ? "✗ " : ""}${String(line.title ?? line.toolKind ?? "tool")}`);
      } else if (line.kind === "turnEnd") {
        flush(at);
      }
    }
    flush(lines.at(-1)?.at ?? new Date(0).toISOString());
  }
  return entries;
}

/** What a reader sees of a conversation: the user's messages and the answers, by their words. */
function said(entries: ThreadEntry[]): string[] {
  return entries.flatMap((entry) => entry.kind === "message" ? [`m:${entry.text}`] : entry.reply ? [`t:${entry.reply}`] : []);
}

export function seedMarker(program: string): string {
  return path.join(program, ".run", "thread-seeded.json");
}

/**
 * Seeds thread.jsonl once with the conversation from before it was written, from the
 * coordinator's session logs (`logs`, oldest first): what thread.jsonl has already stays after it,
 * and what both hold is kept once (the seed ends where thread.jsonl's first entry is found in it).
 * Returns whether it seeded. A thread that would show less than the logs is not written.
 */
export function seedThread(program: string, logs: SeedLine[][], sessions: string[]): boolean {
  if (fs.existsSync(seedMarker(program))) return false;
  const seeded = conversationFromLogs(logs);
  if (seeded.length === 0) return false;
  return withThreadLock(program, () => {
    const existing = readThread(program);
    let upTo = seeded.length;
    const first = existing.find((entry) => entry.kind === "message" || entry.reply);
    if (first) {
      const key = said([first])[0];
      for (let index = seeded.length - 1; index >= 0; index--) {
        if (said([seeded[index]])[0] === key) { upTo = index; break; }
      }
    }
    const merged = [...seeded.slice(0, upTo), ...existing];
    // Never less: everything the logs say is in the seeded conversation.
    const shown = new Set(said(merged));
    if (!said(seeded).every((line) => shown.has(line))) return false;
    const file = threadFile(program);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, merged.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.mkdirSync(path.dirname(seedMarker(program)), { recursive: true });
    fs.writeFileSync(seedMarker(program), `${JSON.stringify({ at: new Date().toISOString(), sessions })}\n`, { mode: 0o600 });
    return true;
  });
}

/** Whether a conversation shows at least what the session history it stands for shows. */
export function showsAtLeast(thread: ThreadEntry[], logs: SeedLine[][]): boolean {
  const shown = new Set(said(thread));
  return said(conversationFromLogs(logs)).every((line) => shown.has(line));
}

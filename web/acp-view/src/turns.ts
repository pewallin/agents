// The session as turns, the way the view shows them: what you asked, the agent's work as quiet
// steps (thinking, tools, remarks along the way), what it answered at the end, and what it changed.
import { diffLines } from "diff";
import type { Item, SessionState, ToolCall } from "./session-state";

export type Step =
  | { type: "thought"; id: string; text: string }
  | { type: "remark"; id: string; text: string }
  | { type: "tool"; id: string; call: ToolCall };

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** Each change the agent made to the file, in order. An agent may report only the changed
   *  part of the file (Codex does), so they are shown one after another, not merged. */
  edits: Array<{ oldText: string | null; newText: string }>;
  /** For a change git saw (a shell edit, or the whole turn's count): the trees before and after
   *  the turn, which its hunks and its review are read from. */
  snapshot?: { from: string; to: string };
}

/** A file the turn changed, as git counts it between the snapshots taken at its start and end. */
export interface GitChange { path: string; added: number; removed: number; binary?: boolean }

/** The turn's changes: what the agent's diffs say, with git's counts where git saw the file
 *  (they include shell edits and count the turn once), and the files only git saw. */
export function mergeChanges(fromAgent: FileChange[], fromGit: GitChange[] | undefined, snapshot?: { from: string; to: string }): FileChange[] {
  if (!fromGit) return fromAgent;
  const merged = fromAgent.map((change) => ({ ...change }));
  for (const file of fromGit) {
    const existing = merged.find((change) => change.path === file.path);
    if (existing) {
      existing.added = file.added;
      existing.removed = file.removed;
      existing.snapshot = snapshot;
    } else {
      merged.push({ path: file.path, added: file.added, removed: file.removed, edits: [], snapshot });
    }
  }
  return merged;
}

export interface Turn {
  id: string;
  user?: Extract<Item, { type: "user" }>;
  steps: Step[];
  /** The agent's text after its last tool call: its answer. */
  answer: Array<Extract<Item, { type: "agent" }>>;
  changes: FileChange[];
  startedAt?: number;
  endedAt?: number;
}

export function countLines(oldText: string | null | undefined, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  // A line added after a last line without its newline adds one line and changes none.
  const withEnd = (text: string) => (text && !text.endsWith("\n") ? `${text}\n` : text);
  for (const part of diffLines(withEnd(oldText ?? ""), withEnd(newText))) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export function changesOf(calls: ToolCall[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const call of calls) {
    for (const entry of call.content) {
      if (entry.type !== "diff") continue;
      const change = byPath.get(entry.path) ?? { path: entry.path, added: 0, removed: 0, edits: [] };
      const { added, removed } = countLines(entry.oldText, entry.newText);
      change.added += added;
      change.removed += removed;
      change.edits.push({ oldText: entry.oldText ?? null, newText: entry.newText });
      byPath.set(entry.path, change);
    }
  }
  return [...byPath.values()];
}

export function buildTurns(state: Pick<SessionState, "items" | "toolCalls">): Turn[] {
  const turns: Turn[] = [];
  let open: { turn: Turn; tail: Array<Extract<Item, { type: "agent" }>> } | undefined;
  const close = () => {
    if (!open) return;
    open.turn.answer = open.tail;
    const calls = open.turn.steps.flatMap((step) => (step.type === "tool" ? [step.call] : []));
    open.turn.changes = changesOf(calls);
    turns.push(open.turn);
    open = undefined;
  };
  const begin = (user?: Extract<Item, { type: "user" }>) => {
    open = { turn: { id: user?.id ?? `turn-${turns.length}`, user, steps: [], answer: [], changes: [], startedAt: user?.at }, tail: [] };
  };
  const touch = (at: number | undefined) => {
    if (!open || at === undefined) return;
    open.turn.startedAt ??= at;
    open.turn.endedAt = Math.max(open.turn.endedAt ?? at, at);
  };

  for (const item of state.items) {
    if (item.type === "user") {
      close();
      begin(item);
      continue;
    }
    if (!open) begin();
    const current = open!;
    if (item.type === "agent") {
      current.tail.push(item);
      touch(item.at);
      continue;
    }
    // Text before more work was said along the way: it joins the steps.
    // Blank text (a thinking chunk of whitespace, a stray empty paragraph) makes no step.
    for (const remark of current.tail) if (remark.text.trim()) current.turn.steps.push({ type: "remark", id: remark.id, text: remark.text.trim() });
    current.tail = [];
    if (item.type === "thought") {
      if (item.text.trim()) current.turn.steps.push({ type: "thought", id: item.id, text: item.text.trim().replace(/\n{3,}/g, "\n\n") });
      touch(item.at);
    } else {
      const call = state.toolCalls[item.id];
      if (call) {
        current.turn.steps.push({ type: "tool", id: item.id, call });
        touch(call.startedAt);
        touch(call.endedAt);
      }
    }
  }
  close();
  return turns;
}

const VERBS: Record<string, string> = {
  read: "Read",
  edit: "Edited",
  delete: "Deleted",
  move: "Moved",
  search: "Searched",
  execute: "Ran",
  think: "Thought",
  fetch: "Fetched",
  switch_mode: "Switched mode",
};

/** A tool call as one line: a verb and what it acted on. */
export function describeCall(call: ToolCall, cwd?: string): { verb: string; target: string } {
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const command = Array.isArray(input.command) ? input.command.join(" ") : typeof input.command === "string" ? input.command : undefined;
  const paths = call.locations.map((location) => location.path);
  const diffPaths = call.content.flatMap((entry) => (entry.type === "diff" ? [entry.path] : []));
  const verb = call.kind ? VERBS[call.kind] : undefined;
  if (call.kind === "execute" && command) return { verb: "Ran", target: command };
  const files = [...new Set([...diffPaths, ...paths])];
  if (verb && files.length > 0) return { verb, target: files.map((path) => shortPath(path, cwd)).join("  ") };
  if (verb) return { verb, target: stripVerb(call.title) };
  return { verb: "", target: call.title };
}

function stripVerb(title: string): string {
  return title.replace(/^(Read|Reading|Edit|Editing|Search|Searching|Run|Running|Fetch|Fetching)\s+/i, "");
}

/** A path as people read it in a line: relative where it is under the working directory. */
/** One line of a command or title for a tool's row: whitespace runs as one space, cut at a
 *  character (never inside one) with an ellipsis. */
export function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  const characters = segmenter ? [...segmenter.segment(flat)].map((part) => part.segment) : [...flat];
  return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : flat;
}

export function shortPath(path: string, cwd?: string): string {
  if (cwd && path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return path.slice(cwd.length).replace(/^\//, "");
  const parts = path.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}

export function toolOutput(call: ToolCall): string {
  const text = call.content
    .map((entry) => (entry.type === "content" && entry.content.type === "text" ? entry.content.text : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  const output = call.rawOutput as { stdout?: unknown; output?: unknown; formatted_output?: unknown } | string | undefined;
  if (typeof output === "string") return output;
  for (const key of ["formatted_output", "stdout", "output"] as const) {
    const value = output?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** "2m 14s", "12s". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

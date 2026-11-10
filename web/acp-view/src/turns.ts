// The session as turns, the way the view shows them: what you asked, the agent's work as quiet
// steps (thinking, tools, remarks along the way), what it answered at the end, and what it changed.
import { diffLines } from "diff";
import type { Item, SessionState, ToolCall } from "./session-state";

export type Step =
  /** Thinking, with when it started and when the next thing the agent did started (a session
   *  replayed from its history has no times). */
  | { type: "thought"; id: string; text: string; startedAt?: number; endedAt?: number }
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

/** Every file the conversation changed, for one review of it all: a file changed in several
 *  turns spans git's snapshots from the first of them to the last when both have one (the span
 *  holds every edit between), else shows the agent's edits one after another. */
export function conversationChanges(turns: Array<Pick<Turn, "changes">>): FileChange[] {
  const byPath = new Map<string, FileChange[]>();
  for (const turn of turns) {
    for (const change of turn.changes) byPath.set(change.path, [...(byPath.get(change.path) ?? []), change]);
  }
  return [...byPath.values()].map((changes) => {
    if (changes.length === 1) return changes[0];
    const first = changes[0];
    const last = changes[changes.length - 1];
    const added = changes.reduce((sum, change) => sum + change.added, 0);
    const removed = changes.reduce((sum, change) => sum + change.removed, 0);
    if (first.snapshot && last.snapshot) {
      return { path: first.path, added, removed, edits: [], snapshot: { from: first.snapshot.from, to: last.snapshot.to } };
    }
    return { path: first.path, added, removed, edits: changes.flatMap((change) => change.edits) };
  });
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
  // The thinking last written: it ends when the agent does the next thing.
  let thinking: Extract<Step, { type: "thought" }> | undefined;
  const touch = (at: number | undefined) => {
    if (!open || at === undefined) return;
    if (thinking && thinking.startedAt !== undefined && at > thinking.startedAt) {
      thinking.endedAt = at;
      thinking = undefined;
    }
    open.turn.startedAt ??= at;
    open.turn.endedAt = Math.max(open.turn.endedAt ?? at, at);
  };

  for (const item of state.items) {
    if (item.type === "user") {
      thinking = undefined;
      close();
      begin(item);
      continue;
    }
    if (!open) { begin(); thinking = undefined; }
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
      touch(item.at);
      if (item.text.trim()) {
        thinking = { type: "thought", id: item.id, text: item.text.trim().replace(/\n{3,}/g, "\n\n"), startedAt: item.at };
        current.turn.steps.push(thinking);
      }
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

/** A run of tool calls in a row, shown as one line ("Ran 12 commands · read 3 files"); the
 *  thinking between them goes into the run too, and shows when it is opened. */
export type StepGroup = { type: "group"; id: string; calls: ToolCall[]; steps: Step[] };

/** The steps as they show: three or more groupable tool calls in a row become one group (its id
 *  the first call's, so opening it holds while the run grows), with any thinking between them.
 *  Anything else (an edit, what the agent says) ends a run; thinking after its last call stays
 *  outside it once the turn is done. */
export function groupSteps(steps: Step[], groupable: (call: ToolCall) => boolean, live = false, least = 3): Array<Step | StepGroup> {
  const out: Array<Step | StepGroup> = [];
  let run: Step[] = [];
  let thinking: Step[] = [];
  const flush = () => {
    const calls = run.flatMap((step) => (step.type === "tool" ? [step.call] : []));
    if (calls.length >= least) out.push({ type: "group", id: `group-${run[0].id}`, calls, steps: run });
    else out.push(...run);
    out.push(...thinking);
    run = [];
    thinking = [];
  };
  for (const step of steps) {
    if (step.type === "tool" && groupable(step.call)) {
      run.push(...thinking, step);
      thinking = [];
      continue;
    }
    if (step.type === "thought" && run.length > 0) { thinking.push(step); continue; }
    flush();
    out.push(step);
  }
  // In a turn under way, thinking after the run's last call is most likely followed by another
  // call: it waits in the run, so the run does not grow a line and lose it again at every call.
  if (live) { run.push(...thinking); thinking = []; }
  flush();
  return out;
}

/** What a group did, in a few words: "Ran 12 commands · read 3 files · 2 searches". */
export function groupSummary(calls: ToolCall[]): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const commands = calls.filter((call) => call.kind === "execute").length;
  const reads = calls.filter((call) => call.kind === "read").length;
  const searches = calls.filter((call) => call.kind === "search").length;
  const fetches = calls.filter((call) => call.kind === "fetch").length;
  const other = calls.length - commands - reads - searches - fetches;
  const parts = [
    commands ? `ran ${count(commands, "command", "commands")}` : "",
    reads ? `read ${count(reads, "file", "files")}` : "",
    searches ? `searched ${count(searches, "time", "times")}` : "",
    fetches ? `fetched ${count(fetches, "page", "pages")}` : "",
    other ? count(other, "other step", "other steps") : "",
  ].filter(Boolean);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Thinking as one line: Codex's own header (**Checking row counts**) when it starts with one,
 *  else its first line without markdown; and what opening it shows (the rest, after a header). */
export function thoughtSummary(text: string): { title: string; body: string } {
  const header = text.match(/^\*\*([^*\n]+)\*\*\s*(?:\n|$)/);
  if (header) return { title: header[1].trim(), body: text.slice(header[0].length).trim() };
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  const title = first.replace(/^\s*(?:[#>*-]+|\d+\.)\s+/, "").replace(/[*_`]+/g, "").trim();
  return { title, body: text };
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

/** Output an agent wrapped in one markdown fence (Claude's ```\n…\n```), without the fence. */
export function unfenced(text: string): string {
  const match = text.match(/^\s*(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)\n?\1\s*$/);
  return match && !match[2].includes(match[1]) ? match[2] : text;
}

export function toolOutput(call: ToolCall): string {
  const text = call.content
    .map((entry) => (entry.type === "content" && entry.content.type === "text" ? unfenced(entry.content.text) : ""))
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

/** A command's exit code, when the agent says it: Codex in its raw output, Claude in its text
 *  ("Exit code 1"). */
export function exitCode(call: ToolCall): number | null {
  const raw = call.rawOutput as { exit_code?: unknown; exitCode?: unknown; metadata?: { exit_code?: unknown } } | undefined;
  for (const value of [raw?.exit_code, raw?.exitCode, raw?.metadata?.exit_code]) {
    if (typeof value === "number") return value;
  }
  const match = toolOutput(call).match(/\bexit(?:ed with)?(?: code|\s+status)?:?\s+(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

/** "2m 14s", "12s". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

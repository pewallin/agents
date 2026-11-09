// @ts-nocheck
// Message queues and the lines that wake an agent.

import { appControlCommandText } from "./self.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { typeQueuedLines } from "./ask.js";
import { sharedCLIPath, writeStatusFile } from "./briefs.js";
import { protocolFile } from "./coordinator.js";
import { newMessageID } from "./delivery.js";
import { shellQuote } from "./launch.js";
import { SETTLED_REPORTS, oneLine } from "./processes.js";
import { readJSON, taskPaths, writeFileAtomic } from "./program.js";
import { appInputState, deliveredAt } from "./supervisor.js";
import { readFileOr } from "./supervisor-control.js";
import { clockText } from "./watch.js";

// A queued line carries its message and a few words on what it is about: the agent's prompt gets
// only those words and the file the message waits in (deliveryLine).
// Every queued line has an id, which names its delivery record (messageRecord); the queue file
// starts with the time, so lines go out in the order they came.
export function enqueueMessage(program, targetUUID, text, summary, id = newMessageID()) {
  const dir = path.join(program, ".queue", targetUUID);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { id, summary: oneLine(summary, SUMMARY_LIMIT), text: oneLine(text, 2000) };
  writeFileAtomic(path.join(dir, `${Date.now()}-${id}.txt`), `${JSON.stringify(entry)}\n`);
  return id;
}

// A line sent with --no-wake waits beside the queued lines as a rider: it wakes nobody, and goes
// out with the next line typed into that agent's prompt (typeQueuedLines).
export const RIDER_SUFFIX = ".info";

export function enqueueRider(program, targetUUID, text, summary, id) {
  const dir = path.join(program, ".queue", targetUUID);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { id, summary: oneLine(summary, SUMMARY_LIMIT), text: oneLine(text, 2000) };
  writeFileAtomic(path.join(dir, `${Date.now()}-${id}${RIDER_SUFFIX}`), `${JSON.stringify(entry)}\n`);
  return id;
}

export function queueNames(program, uuid, suffix) {
  try {
    return fs.readdirSync(path.join(program, ".queue", uuid)).filter(name => name.endsWith(suffix)).sort();
  } catch {
    return [];
  }
}

// A queue file: { id, summary, text } as JSON, or (written by an older CLI) the bare line.
export function readQueued(file) {
  const raw = readFileOr(file, "").trim();
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw);
    if (entry && typeof entry.text === "string" && entry.text.trim()) {
      return { id: entry.id, summary: oneLine(entry.summary || entry.text, SUMMARY_LIMIT), text: entry.text.trim() };
    }
  } catch {
    // The bare line.
  }
  const text = raw.replace(/^\[agents\]\s*/, "");
  return { summary: oneLine(text, SUMMARY_LIMIT), text };
}

// What a line typed into an agent's prompt is: one short row the user can read at a glance, that
// says what came and where the whole of it is. The marker says the line is the app's, not the
// user's; the messages themselves wait in a file under <program>/messages/.
export const DELIVERY_MARKER = "⟢ agents";
export const SUMMARY_LIMIT = 80;
export const MESSAGE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export function deliveryLine(program, entries, reminder) {
  const dir = path.join(program, "messages");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  // The app knows the line by this name (TerminalAgentsMessageScanner): <stamp>-<4 hex>.md.
  const file = path.join(dir, `${stamp}-${crypto.randomBytes(2).toString("hex")}.md`);
  const body = [...entries.map(entry => entry.text), ...(reminder ? [reminder] : [])].join("\n\n");
  writeFileAtomic(file, `${body}\n`);
  pruneMessages(dir);
  const joined = entries.map(entry => entry.summary).join("; ");
  const summary = entries.length === 1 || joined.length <= SUMMARY_LIMIT ? joined : `${entries.length} messages`;
  return `${DELIVERY_MARKER} · ${summary} · read ${file}`;
}

export function pruneMessages(dir) {
  const cutoff = Date.now() - MESSAGE_KEEP_MS;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    // Nothing to prune.
  }
}

// A done or blocked line carries the gist, not the findings: the worker tells the user those in
// its own pane, and the coordinator's context stays free for the whole.
export const WAKE_DETAIL_LIMIT = 200;

// What every delivery to a coordinator ends with, so the role outlasts a long or compacted
// conversation.
export function coordinatorReminder() {
  const protocol = protocolFile();
  return `(Reminder: you coordinate. Delegate new work to workers, keep replies to the user to a sentence or two that lead with the outcome, name the worker whose pane has the details instead of retelling them, and leave solutions to the workers.${protocol ? ` Protocol: ${protocol}` : ""})`;
}

// What every delivery to a worker ends with: a message from its coordinator is work to report
// on, also after an earlier done, since the coordinator does not read the worker's pane.
export function workerReminder(record) {
  return `(Reminder: you are worker ${record.task}. Your coordinator does not read your pane: when you have finished what this asks, report with ${shellQuote(sharedCLIPath())} agent report "<one-line status>" --done (or --blocked, --ask user), or the agents MCP report tool, also after an earlier done.)`;
}

export function deliveryReminder(record) {
  if (record.role === "coordinator") return coordinatorReminder();
  if (record.role === "worker" && record.task) return workerReminder(record);
  return undefined;
}

export function whenText(ms) {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString() ? clockText(ms) : `${date.toISOString().slice(0, 10)} ${clockText(ms)}`;
}

// A line that wakes a coordinator stands on its own: what happened, to which task, and where the
// details are, so it needs no lookup to act on. `context.done`: the worker's own done report, for a stop or close after it that new input
// started. The line keeps it, so the coordinator does not take a finished task for an unfinished one.
export function wakeLine(program, task, event, detail, parentUUID, context = {}) {
  const files = taskPaths(program, task);
  const done = context.done
    ? `It had reported done at ${whenText(Date.parse(context.done.at))}: "${oneLine(context.done.line, WAKE_DETAIL_LIMIT)}" `
    : "";
  switch (event) {
  case "done":
    return `Worker ${task} is done: ${oneLine(detail, WAKE_DETAIL_LIMIT)} Report: ${files.report}`;
  case "blocked":
    return `Worker ${task} is blocked: ${oneLine(detail, WAKE_DETAIL_LIMIT)} Report: ${files.report}`;
  case "ask-coordinator":
    return `Worker ${task} asks you: ${detail} Answer with: ${parentUUID ? shellQuote(sharedCLIPath()) : appControlCommandText()} agent send "<answer>" --to ${task}${context.questionId ? ` --reply-to ${context.questionId}` : ""}`;
  case "stopped":
    if (done) {
      return `Worker ${task} worked on new input after its done report and stopped without reporting on it. ${done}${detail ? `Its last reply began: "${oneLine(detail, 400)}" ` : "It left no reply text. "}Brief and report: ${files.dir}/`;
    }
    return detail
      ? `Worker ${task} stopped without a report. Its last reply began: "${oneLine(detail, 400)}" Brief and report: ${files.dir}/`
      : `Worker ${task} stopped without a report and left no reply text. Brief and report: ${files.dir}/`;
  case "closed":
    if (done) {
      return `Worker ${task}'s pane closed while it worked on new input after its done report, without reporting on that. ${done}Brief and report: ${files.dir}/`;
    }
    return `Worker ${task}'s pane closed before it reported done (last state: ${detail}). Brief and report: ${files.dir}/`;

  default:
    return `Worker ${task}: ${detail}`;
  }
}

// The few words a wake line shows in the coordinator's prompt.
export function wakeSummary(task, event) {
  switch (event) {
  case "done": return `Worker ${task} is done`;
  case "blocked": return `Worker ${task} is blocked`;
  case "ask-coordinator": return `Worker ${task} asks you`;
  case "stopped": return `Worker ${task} stopped without a report`;
  case "closed": return `Worker ${task}'s pane closed`;
  default: return `Worker ${task}`;
  }
}

export function waitsLine(task, paneID, choice) {
  return `Worker ${task} waits for a permission or a choice in pane ${paneID}${choice ? `: "${choice}"` : ""}. Tell the user what it asks; they answer it in that pane. Do not answer it yourself unless the user told you to.`;
}

// What a turn the user drove in a worker's pane leaves for its coordinator, which is not woken for
// it: one note per task, the latest. `context.done` as in wakeLine.
export function noteLine(program, task, event, detail, context = {}) {
  const files = taskPaths(program, task);
  switch (event) {
  case "done":
    return `Meanwhile, worker ${task} worked on with the user in its pane and reported done again: ${oneLine(detail, WAKE_DETAIL_LIMIT)} Report: ${files.report}`;
  case "blocked":
    return `Meanwhile, worker ${task} worked on with the user in its pane and reported blocked: ${oneLine(detail, WAKE_DETAIL_LIMIT)} Report: ${files.report}`;
  default: {
    const done = context.done
      ? ` It had reported done at ${whenText(Date.parse(context.done.at))}: "${oneLine(context.done.line, WAKE_DETAIL_LIMIT)}"`
      : "";
    return `Meanwhile, worker ${task} worked on with the user in its pane and stopped without a new report.${done}${detail ? ` Its last reply began: "${oneLine(detail, 400)}"` : ""} Brief and report: ${files.dir}/`;
  }
  }
}

// The worker's own last report that handed its task back: done, blocked or a question.
export function lastSettledReport(report) {
  const own = (report?.history || []).filter(entry => !entry.by && SETTLED_REPORTS.has(entry.state));
  return own[own.length - 1];
}

// Who set a worker's latest work going. "user" when, since the worker last handed its task back
// (done, blocked or a question), only the user did, typing into its pane in the app. "coordinator"
// otherwise: a line was typed in for it (from its coordinator, or its own watch or reminder),
// nobody did, or it still works on its first brief. The app sees only what is typed into it, so
// typing on iOS or in a tmux client of one's own wakes the coordinator as before.
export async function turnDriver(program, record, report) {
  const since = Date.parse(lastSettledReport(report)?.at || "") || 0;
  if (!since || deliveredAt(program, record.uuid) > since) return "coordinator";
  const input = await appInputState(record.paneID);
  const typed = typeof input?.secondsSinceInput === "number" ? Date.now() - input.secondsSinceInput * 1000 : 0;
  return typed > since ? "user" : "coordinator";
}

// Notes wait beside a coordinator's queued lines, one file per task, and go out only with the
// next line that wakes it (typeQueuedLines); STATUS.md lists them meanwhile.
export const NOTE_SUFFIX = ".note";

export function noteForCoordinator(program, targetUUID, task, text) {
  const dir = path.join(program, ".queue", targetUUID);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { task, at: new Date().toISOString(), summary: `Worker ${task} worked with the user`, text: oneLine(text, 2000) };
  writeFileAtomic(path.join(dir, `${task}${NOTE_SUFFIX}`), `${JSON.stringify(entry)}\n`);
  writeStatusFile(program);
}

export function queuedNotes(program, targetUUID) {
  const dir = path.join(program, ".queue", targetUUID);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith(NOTE_SUFFIX)).sort();
  } catch {
    return [];
  }
  return names
    .map(name => ({ file: path.join(dir, name), entry: readJSON(path.join(dir, name), undefined) }))
    .filter(note => note.entry && typeof note.entry.text === "string");
}

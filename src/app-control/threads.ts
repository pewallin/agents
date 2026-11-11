// @ts-nocheck
// Threads: each task of a program as the user follows it, from its brief until it is resolved.
//
// A thread is its task directory (<program>/tasks/<task>/), never a pane: tmux numbers panes anew
// after a restart, and a closed tab takes the pane away while the work goes on. Each thread keeps
// every agent session that worked on it in sessions.jsonl, one line per session, and a program
// keeps its coordinators' sessions in coordinators.jsonl. Lines are only appended, so the
// supervisor, `agent report`, `agent promote` and the repair pass write without a lock. Of a
// thread only `title` and `resolved` are stored (task.json); its state is derived.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskRows } from "./briefs.js";
import { programDirectories } from "./coordinator.js";
import { agentNameFromLaunchCommand } from "./launch.js";
import { coordinationPaneRecords, coordinatorLeads, programMeta, readJSON, runGit, taskPaths, writeFileAtomic } from "./program.js";
import { briefSummary, isRoleLine, lastWorkerReport, workerStatus } from "./report.js";
import { isWorkerRecord } from "./spawn-support.js";
import { agentStatuses } from "./supervisor-control.js";
import { agentResumeInvocation } from "../resume.js";
import { loadHistoryForAgent, sessionTranscriptPath } from "../scanner-history.js";

// Harness session ids: uuids, Codex's thread ids, Kiro 3's cli_<uuid>_02 copies.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{4,160}$/;

export function sessionsFile(program, task) {
  return path.join(taskPaths(program, task).dir, "sessions.jsonl");
}

export function coordinatorsFile(program) {
  return path.join(program, "coordinators.jsonl");
}

export function readSessionLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry.session === "string" ? [entry] : [];
    } catch {
      return [];
    }
  });
}

function sessionLine(entry) {
  const line = { at: entry.at || new Date().toISOString(), via: entry.via, agent: entry.agent, session: entry.session };
  if (entry.cwd) line.cwd = entry.cwd;
  if (entry.uuid) line.uuid = entry.uuid;
  return line;
}

// One line per session. "last": unless it is the session of the file's last line (a task's
// sessions follow one another, and one can come back: a resume after another); "any": unless a
// line has it (coordinators, the repair pass).
export function appendSessionLine(file, entry, dedupe = "last") {
  if (!entry?.agent || !entry?.session || !SESSION_ID_PATTERN.test(entry.session)) return false;
  const lines = readSessionLines(file);
  const known = dedupe === "last"
    ? lines.at(-1)?.session === entry.session
    : lines.some(line => line.session === entry.session);
  if (known) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(sessionLine(entry))}\n`);
  return true;
}

// A worker's session, as the supervisor or its report finds it. The first session of a task came
// with its spawn (or adopt); a new session in the same pane (@agents_uuid) is a /clear, a switch of
// agent or a resumed copy; one in another pane is a respawn.
export function recordTaskSession(program, task, { agent, session, uuid, cwd }) {
  if (!program || !task) return false;
  const files = taskPaths(program, task);
  if (!fs.existsSync(files.dir)) return false;
  const file = sessionsFile(program, task);
  const last = readSessionLines(file).at(-1);
  const meta = readJSON(files.meta, {});
  const via = !last ? (meta.adopted ? "adopt" : "spawn") : (uuid && last.uuid === uuid ? "changed" : "respawn");
  return appendSessionLine(file, { via, agent, session, uuid, cwd: cwd || meta.cwd }, "last");
}

export function recordCoordinatorSession(program, { agent, session, uuid, cwd, via }) {
  if (!program) return false;
  return appendSessionLine(coordinatorsFile(program), { via, agent, session, uuid, cwd }, "any");
}

// task.json, changed in place: every field another writer added stays.
export function updateTaskMeta(program, task, change) {
  const files = taskPaths(program, task);
  const meta = readJSON(files.meta, undefined);
  if (!meta) return undefined;
  const next = change({ ...meta });
  if (JSON.stringify(next) !== JSON.stringify(meta)) writeFileAtomic(files.meta, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Resolved: nothing is left for anyone. Kept with when it happened; marking it again keeps that.
export function markResolved(program, task, at = new Date().toISOString()) {
  return updateTaskMeta(program, task, meta => (meta.resolved ? meta : { ...meta, resolved: at }));
}

export function markUnresolved(program, task) {
  return updateTaskMeta(program, task, meta => {
    delete meta.resolved;
    return meta;
  });
}

// Closing the pane of a done thread resolves it: the user closes the tab of work they have looked
// at. A worker that works again after its done (report state progress) is not done.
export function resolvesOnClose(report) {
  return report?.state === "done" && lastWorkerReport(report)?.state === "done";
}

// What the user sees on a thread's row: working, needs-you (a question for them, a blocker, a
// permission in its pane), done (reported done, not yet resolved: ready for review), stopped (not
// done, and idle or without a pane) or resolved. A thread with a pane shows what it does there.
export function threadState({ live, agent, reportState, resolved }) {
  if (live) {
    // A worker whose agent has not reported yet is starting.
    if ((!agent || agent === "unknown") && (!reportState || reportState === "started")) return "working";
    const status = workerStatus(agent || "unknown", reportState);
    if (status === "working") return "working";
    if (status === "needs you") return "needs-you";
    return reportState === "done" ? "done" : "stopped";
  }
  if (resolved) return "resolved";
  return reportState === "done" ? "done" : "stopped";
}

// Where a session's transcript is, once per session and run. Claude Code's are found in the
// folder's own project directory first, without reading every project directory.
export function transcriptLookup(find = sessionTranscriptPath) {
  const cache = new Map();
  return (agent, session, cwd) => {
    const key = `${agent}\t${session}`;
    if (cache.has(key)) return cache.get(key);
    let file;
    if (agent === "claude" && cwd) {
      const direct = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);
      if (fs.existsSync(direct)) file = direct;
    }
    if (!file) {
      try {
        file = find(agent, session) || undefined;
      } catch {
        file = undefined;
      }
    }
    cache.set(key, file || null);
    return file || null;
  };
}

// How a session is resumed: by its id, or (Pi) by its transcript.
export function resumeTarget(session) {
  return session.agent === "pi"
    ? { targetKind: "session-path", target: session.transcript }
    : { targetKind: "session-id", target: session.session };
}

// The step reopening a thread without a pane takes: resume its latest session whose transcript is
// on disk, else start a worker again on its brief and report, else only read them.
export function reopenStep(meta, sessions, files) {
  const resumable = sessions.find(session => session.transcript
    && agentResumeInvocation(session.agent, resumeTarget(session)));
  if (resumable) {
    return { step: "resume", agent: resumable.agent, session: resumable.session, transcript: resumable.transcript, at: resumable.at };
  }
  if (meta?.launchCommand && fs.existsSync(files.brief)) return { step: "respawn" };
  return { step: "read" };
}

function harnessOf(meta, sessions) {
  if (sessions[0]?.agent) return sessions[0].agent;
  try {
    return meta.launchCommand ? agentNameFromLaunchCommand(meta.launchCommand) : undefined;
  } catch {
    return undefined;
  }
}

// "medium-tier-b-backend" as words: "Medium tier b backend".
export function humanizedTask(task) {
  const words = String(task).replace(/[-_.]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(task);
}

// A thread's title: the one its coordinator gave it, else what its brief says it is about, else
// its task name in words. Never an agent's first prompt ("ROLE: worker…").
export function threadTitleOf(program, row) {
  const given = typeof row.meta.title === "string" ? row.meta.title.trim() : "";
  if (given && !isRoleLine(given)) return given;
  return briefSummary(program, row.task) || humanizedTask(row.task);
}

// When a task's directory was last written, for a task with no time of its own.
function folderTime(dir) {
  try {
    const time = fs.statSync(dir).mtimeMs;
    return time > 0 ? new Date(time).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

// The tasks of a program: its directories under tasks/ that hold a brief or task.json. Anything
// else there (a folder a worker left, "_rollout") is no thread.
export function threadRows(program) {
  return taskRows(program).filter(row => fs.existsSync(row.files.meta) || fs.existsSync(row.files.brief));
}

// One thread as `agents threads` lists it. `record` is its live pane, if it has one.
export function threadEntry(program, row, record, status, transcriptOf) {
  const { meta, report, files } = row;
  const sessions = readSessionLines(sessionsFile(program, row.task)).reverse()
    .map(session => ({ ...session, transcript: transcriptOf(session.agent, session.session, session.cwd) }));
  const reportState = record ? (record.reportState || report?.state) : report?.state;
  const state = threadState({ live: Boolean(record), agent: status?.status, reportState, resolved: meta.resolved });
  const title = threadTitleOf(program, row);
  return {
    task: row.task,
    program,
    title,
    titled: Boolean(meta.title) || undefined,
    state,
    resolvedAt: meta.resolved || undefined,
    createdAt: meta.createdAt,
    updatedAt: report?.updatedAt || meta.createdAt || folderTime(files.dir),
    line: report?.line || undefined,
    reportState: report?.state || "started",
    outputs: report?.outputs?.length ? report.outputs : undefined,
    under: meta.parentTask || undefined,
    // The @agents_uuid of the coordinator that started it: an earlier one, when it differs from
    // the coordinator's pane now.
    parent: meta.parentUUID || undefined,
    harness: harnessOf(meta, sessions),
    pane: record ? record.paneID : null,
    paneUUID: record?.uuid || undefined,
    agent: record ? (status?.status || "unknown") : undefined,
    contextUsed: status?.contextUsed,
    sessions,
    reopen: record ? undefined : reopenStep(meta, sessions, files),
    brief: fs.existsSync(files.brief) ? files.brief : undefined,
    report: fs.existsSync(files.report) ? files.report : undefined,
    summary: fs.existsSync(files.summary) ? files.summary : undefined,
  };
}

// The folder a path belongs to, as programs name it: its repository's top level, else itself.
export function threadFolder(cwd) {
  let folder = path.resolve(cwd);
  const top = runGit(folder, ["rev-parse", "--show-toplevel"]);
  if (top) folder = top;
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
}

function inside(child, parent) {
  if (!child) return false;
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// The programs of a folder: those made for it, and those from before programs had folders whose
// tasks ran in it.
export function folderPrograms(folder) {
  return programDirectories().sort().filter(program => {
    const meta = programMeta(program);
    if (meta?.folder) return meta.folder === folder;
    return threadRows(program).some(row => inside(row.meta.cwd, folder));
  });
}

// A program's coordinator: the live one that leads it, and every session that led it.
export function coordinatorEntry(program, records, statuses, transcriptOf, openThreads) {
  const live = records.find(record => record.program === program && coordinatorLeads(record));
  const sessions = readSessionLines(coordinatorsFile(program)).reverse()
    .map(session => ({ ...session, transcript: transcriptOf(session.agent, session.session, session.cwd) }));
  if (!live && sessions.length === 0) return undefined;
  const status = live ? statuses.get(live.paneID) : undefined;
  return {
    pane: live ? live.paneID : null,
    paneUUID: live?.uuid || undefined,
    agent: live ? (status?.status || "unknown") : undefined,
    harness: sessions[0]?.agent,
    sessions,
    openThreads,
  };
}

export function programThreads(program, records, statuses, transcriptOf) {
  const live = records.filter(record => record.program === program && isWorkerRecord(record));
  const threads = threadRows(program).map(row => {
    const record = live.find(candidate => candidate.task === row.task);
    return threadEntry(program, row, record, record ? statuses.get(record.paneID) : undefined, transcriptOf);
  });
  // Open threads first, latest first; resolved ones by when they were resolved.
  threads.sort((a, b) => {
    const resolvedA = a.state === "resolved";
    const resolvedB = b.state === "resolved";
    if (resolvedA !== resolvedB) return resolvedA ? 1 : -1;
    const keyA = resolvedA ? a.resolvedAt : a.updatedAt;
    const keyB = resolvedB ? b.resolvedAt : b.updatedAt;
    return String(keyB || "").localeCompare(String(keyA || ""));
  });
  const openThreads = threads.filter(thread => thread.state !== "resolved").length;
  const meta = programMeta(program);
  return {
    program,
    folder: meta?.folder,
    coordinator: coordinatorEntry(program, records, statuses, transcriptOf, openThreads),
    threads,
  };
}

// What `agents threads --cwd <folder>` prints: every thread of the folder's programs. Programs met
// here for the first time are repaired once first (repairProgram).
export function listThreads(cwd, options = {}) {
  const folder = threadFolder(cwd);
  const programs = folderPrograms(folder);
  const strict = coordinationPaneRecords({ strict: true });
  const records = strict || [];
  for (const program of programs) threadsEpoch(program);
  if (strict) {
    for (const program of programs) {
      if (!isRepaired(program)) repairProgram(program, { records, initial: true, ...options.repair });
    }
  }
  const watched = records.filter(record => programs.includes(record.program)
    && (isWorkerRecord(record) || record.role === "coordinator")).map(record => record.paneID);
  const statuses = agentStatuses(watched);
  const transcriptOf = options.transcriptOf || transcriptLookup();
  return {
    folder,
    // Without tmux nothing is known live: every thread shows as it was left.
    tmux: Boolean(strict),
    programs: programs.map(program => programThreads(program, records, statuses, transcriptOf)),
  };
}

// --- The repair pass -------------------------------------------------------------------------
//
// Fills in the session lists of threads from before they were kept, and runs again on
// `agents threads --repair`. In order: the session report.json points at, then every transcript of
// the task's folder since the task was created whose prompt names the task's brief (every worker's
// first prompt is "ROLE: worker. … Read your brief at <program>/tasks/<task>/brief.md", and that
// path is the thread's alone); a coordinator's names "Program directory: <program>". The first
// pass also resolves every task without a pane: work from before is not left open.

const REPAIR_MARKER = ".threads-repaired";
const EPOCH_FILE = ".threads-since";

// When this code first touched a program. Tasks from before it are the ones the first repair pass
// resolves; a task made since is resolved only by its own close or `agent resolve`.
export function threadsEpoch(program) {
  const file = path.join(program, EPOCH_FILE);
  try {
    const at = Date.parse(fs.readFileSync(file, "utf8").trim());
    if (at) return at;
  } catch {
    // Not yet.
  }
  const now = new Date();
  try {
    fs.mkdirSync(program, { recursive: true });
    fs.writeFileSync(file, `${now.toISOString()}\n`, { flag: "wx" });
  } catch {
    // Another process wrote it first.
    const at = Date.parse(readFileOr(file).trim());
    if (at) return at;
  }
  return now.getTime();
}

function readFileOr(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
export const REPAIR_AGENTS = ["claude", "codex", "pi", "kiro", "copilot"];

export function isRepaired(program) {
  return fs.existsSync(path.join(program, REPAIR_MARKER));
}

// The strings of a transcript record that a user (or the harness for them) sent the agent: what a
// user or prompt record holds, not tool calls or their results.
export function userTexts(record) {
  const out = [];
  const walk = (value, user, tool) => {
    if (typeof value === "string") {
      if (user && !tool) out.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, user, tool);
      return;
    }
    const type = typeof value.type === "string" ? value.type : "";
    const isUser = user || value.role === "user" || ["user", "user_message", "user.message", "prompt"].includes(type);
    const isTool = tool || /tool|function/i.test(type) || value.role === "tool";
    for (const [key, child] of Object.entries(value)) {
      walk(child, isUser || key === "user" || key === "prompt", isTool || /tool|function/i.test(key));
    }
  };
  walk(record, false, false);
  return out;
}

// Each record of a transcript: JSON lines, or (Kiro 2) one JSON document.
export function transcriptRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Not a JSON line.
    }
  }
  if (records.length === 0) {
    try {
      records.push(JSON.parse(text));
    } catch {
      // Not JSON either.
    }
  }
  return records;
}

// The end of a brief's path that names it whichever way the program's folder was written (a
// symlinked home, ~/.agents through another path): <program name>/tasks/<task>/brief.md.
export function briefSuffix(program, task) {
  return `${path.basename(program)}/tasks/${task}/brief.md`;
}

export function isWorkerPromptFor(text, brief) {
  return text.includes("ROLE: worker") && text.includes(brief);
}

export function isCoordinatorPromptFor(text, program) {
  return text.includes("coordinator of this work") && text.includes(`Program directory: ${program}`);
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function readTranscript(file) {
  try {
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isoFromHistory(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}

// Merges found sessions into a session list in time order, each session once.
export function mergeSessionLines(file, found) {
  const lines = readSessionLines(file);
  const known = new Set(lines.map(line => line.session));
  const added = found.filter(entry => entry.session && SESSION_ID_PATTERN.test(entry.session) && !known.has(entry.session) && known.add(entry.session));
  if (added.length === 0) return 0;
  const merged = [...lines, ...added.map(sessionLine)].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  writeFileAtomic(file, merged.map(line => `${JSON.stringify(line)}\n`).join(""));
  return added.length;
}

// `history(agent, cwd, limit)` lists a harness's sessions of a folder (newest first, updatedAt in
// seconds); `transcriptOf(agent, session)` finds one's file. Both default to the real harnesses.
export function repairProgram(program, options = {}) {
  // One pass at a time: the app lists threads while an earlier listing still repairs.
  const lock = path.join(program, ".threads-repairing");
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      // Gone already.
    }
    if (age < 10 * 60_000) return { program, busy: true };
    fs.writeFileSync(lock, `${process.pid}\n`);
  }
  try {
    return repairProgramUnlocked(program, options);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function repairProgramUnlocked(program, options) {
  const history = options.history || loadHistoryForAgent;
  const transcriptOf = options.transcriptOf || sessionTranscriptPath;
  const agents = options.agents || REPAIR_AGENTS;
  const rows = threadRows(program);
  const found = new Map(rows.map(row => [row.task, []]));
  const coordinators = [];

  for (const row of rows) {
    const pointer = row.report?.session;
    if (pointer?.agent && pointer?.sessionId) {
      found.get(row.task).push({ at: row.report.updatedAt, via: "repair", agent: pointer.agent, session: pointer.sessionId, cwd: row.meta.cwd });
    }
  }

  // Transcripts are read once per folder and harness, for every task that ran in that folder.
  const byFolder = new Map();
  for (const row of rows) {
    const cwd = row.meta.cwd || programMeta(program)?.folder;
    if (!cwd) continue;
    if (!byFolder.has(cwd)) byFolder.set(cwd, []);
    byFolder.get(cwd).push(row);
  }
  for (const [cwd, folderRows] of byFolder) {
    const since = Math.min(...folderRows.map(row => Date.parse(row.meta.createdAt || "") || 0)) - 60_000;
    for (const agent of agents) {
      let items = [];
      try {
        items = history(agent, cwd, 2000) || [];
      } catch {
        items = [];
      }
      for (const item of items) {
        if (!item?.sessionId || (Number(item.updatedAt) || 0) * 1000 < since) continue;
        const file = transcriptOf(agent, item.sessionId);
        const text = file ? readTranscript(file) : undefined;
        if (!text) continue;
        const candidates = folderRows.filter(row => text.includes(briefSuffix(program, row.task)));
        const coordinated = text.includes(`Program directory: ${program}`);
        if (candidates.length === 0 && !coordinated) continue;
        const prompts = transcriptRecords(text).flatMap(userTexts);
        const at = isoFromHistory(item.updatedAt);
        for (const row of candidates) {
          if (prompts.some(prompt => isWorkerPromptFor(prompt, briefSuffix(program, row.task)))) {
            found.get(row.task).push({ at, via: "repair", agent, session: item.sessionId, cwd });
          }
        }
        if (coordinated && prompts.some(prompt => isCoordinatorPromptFor(prompt, program))) {
          coordinators.push({ at, via: "repair", agent, session: item.sessionId, cwd });
        }
      }
    }
  }

  let sessions = 0;
  for (const row of rows) sessions += mergeSessionLines(sessionsFile(program, row.task), found.get(row.task));
  const coordinatorSessions = mergeSessionLines(coordinatorsFile(program), coordinators);

  // The first pass: a task from before threads that has no pane is finished business, resolved at
  // its last report.
  let resolved = 0;
  if (options.initial && options.records) {
    const epoch = threadsEpoch(program);
    const live = new Set(options.records.filter(record => record.program === program && record.task).map(record => record.task));
    for (const row of rows) {
      if (live.has(row.task) || row.meta.resolved) continue;
      const lastAt = Date.parse(row.report?.updatedAt || row.meta.createdAt || "") || 0;
      if (lastAt >= epoch) continue;
      if (markResolved(program, row.task, row.report?.updatedAt || row.meta.createdAt || new Date().toISOString())) resolved += 1;
    }
  }
  writeFileAtomic(path.join(program, REPAIR_MARKER), `${new Date().toISOString()}\n`);
  return { program, tasks: rows.length, sessions, coordinatorSessions, resolved };
}

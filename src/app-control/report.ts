// @ts-nocheck
// agent report, status, wait and close.

import path from "node:path";
import { requestID } from "./app-socket.js";
import { sharedCLIPath, taskRows, writeStatusFile, writeTaskReport } from "./briefs.js";
import { deliveryState } from "./delivery.js";
import { shellQuote } from "./launch.js";
import { coordinatorReminder, enqueueMessage, noteForCoordinator, noteLine, turnDriver, wakeLine, wakeSummary } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, runTMuxRequired, setPaneOption } from "./panes.js";
import { sleep } from "./placement.js";
import { PARENT_WAKING_STATES, oneLine } from "./processes.js";
import { coordinationPaneRecords, notifyApp, ownCoordinationRecord, readJSON, taskPaths } from "./program.js";
import { closeOpenQuestions, questionView, questionsOf, recordQuestion } from "./questions.js";
import { isWorkerRecord } from "./spawn-support.js";
import { deliveredAt } from "./supervisor.js";
import { agentStatuses, ensureSupervisor, readFileOr, reportStateFromParams, writeOwnReport } from "./supervisor-control.js";
import { markResolved, resolvesOnClose } from "./threads.js";

export async function runAgentReport(command) {
  const params = command.params;
  const line = oneLine(command.text);
  if (!line) fail(64, "usage", "agent report requires a one-line status.");
  const state = reportStateFromParams(params);
  const record = ownCoordinationRecord(params, "agent report");
  if (!record.task || !record.program) {
    fail(2, "notAWorker", `Pane ${record.paneID} has no task. Only workers started with 'agent spawn' report.`);
  }
  let details;
  if (params["details-file"]) {
    details = readFileOr(path.resolve(params["details-file"]), undefined);
    if (details === undefined) fail(2, "fileUnavailable", `Could not read ${params["details-file"]}.`);
  } else if (params.details) {
    details = String(params.details);
  }
  const { files, previous, rendered } = writeOwnReport(record, state, line, { outputs: [].concat(params.output || []), details });
  // A finished task has no questions left to answer: a late answer comes as a late reply.
  if (state === "done") closeOpenQuestions(record.program, record.uuid, "the worker reported done");

  let queuedFor;
  let questionId;
  if (PARENT_WAKING_STATES.has(state) && record.parent) {
    // A done again, or a blocker, in work the user drove in this pane is theirs already: the
    // coordinator gets a note with its next line. A first done and a question always wake it.
    const again = state === "blocked" || (state === "done" && (previous.history || []).some(entry => !entry.by && entry.state === "done"));
    if (again && await turnDriver(record.program, record, previous) === "user") {
      noteForCoordinator(record.program, record.parent, record.task, noteLine(record.program, record.task, state, line));
      queuedFor = "note";
    } else if (state === "ask-coordinator") {
      questionId = recordQuestion(record.program, record, line, false);
      queuedFor = "parent";
    } else {
      enqueueMessage(record.program, record.parent, wakeLine(record.program, record.task, state, line, record.parent), wakeSummary(record.task, state));
      queuedFor = "parent";
    }
    ensureSupervisor(record.program);
  }
  // Sub-workers left open after done keep costing; the worker that led them closes them.
  const openSubWorkers = state === "done" && record.uuid
    ? coordinationPaneRecords().filter(candidate => candidate.parent === record.uuid && candidate.task).map(candidate => candidate.task)
    : [];
  const next = openSubWorkers.length
    ? `Your sub-workers ${openSubWorkers.join(", ")} are still open. Once their work is in, close them with ${shellQuote(sharedCLIPath())} agent close ${openSubWorkers.join(" ")}.`
    : undefined;
  return { id: requestID("cli"), ok: true, result: { task: record.task, state, line, report: files.report, summary: rendered === files.summary ? rendered : undefined, queuedFor, questionId, next } };
}

// A worker's status in a word, from what its agent does now and what it last reported: working
// while its agent is busy, "needs you" while it waits on the user (a question for them, a
// blocker, or a permission or choice in its pane), idle otherwise, finished or not.
export const BUSY_AGENT_STATES = new Set(["working", "compacting", "stalled", "pending"]);
export const NEEDS_YOU_REPORTS = new Set(["ask-user", "blocked"]);

export function workerStatus(agent, reportState) {
  if (agent === "closed") return "closed";
  if (BUSY_AGENT_STATES.has(agent)) return "working";
  if (agent === "attention" || agent === "question" || NEEDS_YOU_REPORTS.has(reportState)) return "needs you";
  return "idle";
}

// What the worker itself last reported: its report's history without the notes the supervisor
// and its coordinator add (`by`), such as "Working again." after a done. A task stays completed
// when its worker reported done and then only ran on.
export function lastWorkerReport(report) {
  const own = (report?.history || []).filter(entry => !entry.by);
  return own[own.length - 1];
}

// The state a task's report keeps when its pane closes: done when the worker's own last report
// was done, closed otherwise.
export function closedReportState(report) {
  return lastWorkerReport(report)?.state === "done" ? "done" : "closed";
}

// Changes what a live worker's report says it is (report.json, report.md, STATUS.md and the pane
// option the app shows) without waking anyone.
export function setWorkerReportState(program, record, state, note, by = "supervisor") {
  const files = taskPaths(program, record.task);
  const report = readJSON(files.reportJSON, undefined);
  if (report) {
    report.state = state;
    report.updatedAt = new Date().toISOString();
    report.history = [...(report.history || []), { at: report.updatedAt, state, line: note, by }].slice(-50);
    writeTaskReport(files, report);
    writeStatusFile(program);
  }
  setPaneOption(localPaneRef(record.paneID), "@agents_report_state", state);
  notifyApp(record.sessionName);
}

export function statusRows(records, program, filter) {
  const live = records.filter(record => record.program === program && record.task);
  const statuses = agentStatuses(live.map(record => record.paneID));
  const rows = [];
  const seen = new Set();
  for (const record of live.filter(filter.live)) {
    seen.add(record.task);
    const meta = readJSON(taskPaths(program, record.task).meta, {});
    const under = meta.parentTask;
    const report = readJSON(taskPaths(program, record.task).reportJSON, undefined);
    const questions = questionsOf(program, record.uuid);
    const subs = live.filter(candidate => record.uuid && candidate.parent === record.uuid);
    rows.push(statusRow(record.task, program, report, {
      title: meta.title,
      under,
      subWorkers: subs.length
        ? { total: subs.length, working: subs.filter(candidate => (statuses.get(candidate.paneID)?.status || "unknown") === "working").length }
        : undefined,
      pane: localPaneRef(record.paneID),
      agent: statuses.get(record.paneID)?.status || "unknown",
      contextUsed: statuses.get(record.paneID)?.contextUsed,
      reportState: record.reportState,
      question: questionView(questions[questions.length - 1]),
      openQuestions: questions.filter(question => question.state === "open").length || undefined,
      ...deliveryState(program, record.uuid),
    }));
  }
  for (const row of taskRows(program)) {
    if (seen.has(row.task) || !filter.closed(row)) continue;
    rows.push(statusRow(row.task, program, row.report, { pane: null, agent: "closed", under: row.meta.parentTask, title: row.meta.title, resolved: row.meta.resolved }));
  }
  return rows;
}

// Rows leave out paths: every report is at <program>/tasks/<task>/report.md.
export function statusRow(task, program, report, live) {
  return {
    task,
    // working, needs you, idle or closed: what the user sees on the worker's row.
    status: workerStatus(live.agent, live.reportState || report?.state),
    // The thread's title in the user's words, where the coordinator gave one; `about` otherwise.
    title: live.title,
    about: briefSummary(program, task),
    // When a closed task was resolved: nothing is left for anyone.
    resolved: live.resolved,
    // The worker that started this sub-worker, and a worker's own sub-workers.
    under: live.under,
    subWorkers: live.subWorkers,
    pane: live.pane,
    agent: live.agent,
    // Percent of its context window in use, where its harness reports it.
    contextUsed: live.contextUsed,
    state: report?.state || "started",
    line: report?.line || "",
    outputs: report?.outputs?.length ? report.outputs : undefined,
    updatedAt: report?.updatedAt,
    // Lines sent to it that have not reached its prompt yet, and why.
    queued: live.queued,
    riding: live.riding,
    // Its latest question for its coordinator: open, answered (and how) or closed.
    question: live.question,
    openQuestions: live.openQuestions,
    waiting: live.waiting,
    waitingSince: live.waitingSince,
    lastDeliveredAt: live.deliveredAt,
  };
}

// The first line of a task's brief: enough for a coordinator to see which worker fits a follow-up.
export function briefSummary(program, task) {
  const text = readFileOr(taskPaths(program, task).brief, "");
  const body = text.split(/^## Brief\s*$/m)[1] || "";
  const first = body.split("\n").map(line => line.trim()).find(line => line && !line.startsWith("## "));
  return first ? oneLine(first, 140) : undefined;
}

export async function runAgentStatus(command) {
  const params = command.params;
  const own = ownCoordinationRecord(params, "agent status");
  const records = coordinationPaneRecords();
  const program = params.program || own.program;
  if (!program) {
    return { id: requestID("cli"), ok: true, result: { program: null, tasks: [] } };
  }
  const filter = params.all
    ? { live: () => true, closed: () => true }
    : {
      live: record => Boolean(own.uuid) && record.parent === own.uuid,
      closed: row => Boolean(own.uuid) && row.meta.parentUUID === own.uuid,
    };
  return {
    id: requestID("cli"),
    ok: true,
    result: {
      reminder: own.role === "coordinator" ? coordinatorReminder() : undefined,
      program,
      reports: "tasks/<task>/report.md",
      tasks: statusRows(records, program, filter),
    },
  };
}

export async function runAgentWait(command) {
  const params = command.params;
  const until = params.until || "all";
  if (!["all", "any"].includes(until)) fail(64, "usage", "agent wait --until must be 'all' or 'any'.");
  const timeoutSeconds = Number(params.timeout || 1800);
  const own = ownCoordinationRecord(params, "agent wait");
  const program = params.program || own.program;
  if (!program) fail(2, "noProgram", "This pane has no workers to wait for.");
  const wanted = command.tasks.length > 0 ? new Set(command.tasks) : undefined;
  const settled = new Map();
  const startedAt = Date.now();
  for (;;) {
    const records = coordinationPaneRecords();
    const filter = {
      live: record => wanted ? wanted.has(record.task) : Boolean(own.uuid) && record.parent === own.uuid,
      closed: row => wanted ? wanted.has(row.task) : Boolean(own.uuid) && row.meta.parentUUID === own.uuid,
    };
    const rows = statusRows(records, program, filter);
    if (wanted) {
      const missing = [...wanted].filter(task => !rows.some(row => row.task === task));
      if (missing.length > 0) fail(2, "taskUnavailable", `Unknown task: ${missing.join(", ")}.`);
    }
    // A worker has settled when it reported an end state or its agent sat idle for two polls in a row.
    const done = rows.filter(row => {
      const quiet = row.agent !== "working" && row.agent !== "unknown";
      const count = quiet ? (settled.get(row.task) || 0) + 1 : 0;
      settled.set(row.task, count);
      return row.agent === "closed" || ["done", "blocked", "ask-coordinator", "ask-user"].includes(row.state) || count >= 2;
    });
    const finished = until === "any" ? done.length > 0 : done.length === rows.length;
    if (rows.length === 0 || finished) {
      return { id: requestID("cli"), ok: true, result: { program, tasks: rows } };
    }
    if (Date.now() - startedAt > timeoutSeconds * 1000) {
      return { id: requestID("cli"), ok: false, error: { code: "timedOut", message: `Workers still running after ${timeoutSeconds}s.` }, result: { program, tasks: rows } };
    }
    await sleep(3000);
  }
}

// Closes worker panes the coordinator is finished with. Briefs and reports stay in the program
// directory, so `agent status --all` still lists the tasks and `agent respawn` can bring one back.
export async function runAgentClose(command) {
  const params = command.params;
  const own = ownCoordinationRecord(params, "agent close");
  const program = params.program || own.program;
  if (!program) fail(2, "noProgram", "This pane has no workers.");
  const records = coordinationPaneRecords().filter(record => record.program === program && isWorkerRecord(record));
  let targets;
  if (command.tasks.length > 0) {
    const missing = command.tasks.filter(task => !records.some(record => record.task === task));
    if (missing.length > 0) fail(2, "taskUnavailable", `No live worker has task: ${missing.join(", ")}.`);
    targets = records.filter(record => command.tasks.includes(record.task));
  } else {
    targets = records.filter(record => record.parent === own.uuid && record.reportState === "done");
  }
  // A worker's sub-workers are part of its task: they close with it.
  const subWorkers = records.filter(record => record.parent && !targets.includes(record)
    && targets.some(target => target.uuid && target.uuid === record.parent));
  targets = [...targets, ...subWorkers];
  const resolved = [];
  for (const record of targets) {
    const files = taskPaths(program, record.task);
    const report = readJSON(files.reportJSON, { task: record.task, line: "Closed without a report.", outputs: [], history: [] });
    // A done thread closed is resolved; an unfinished one stays open, stopped, to reopen later.
    if (resolvesOnClose(report)) resolved.push(record.task);
    if (report.state !== "done") {
      report.state = closedReportState(report);
      report.updatedAt = new Date().toISOString();
      report.history = [...(report.history || []), { at: report.updatedAt, state: report.state, line: "Closed by the coordinator.", by: "coordinator" }];
      writeTaskReport(files, report);
    }
    closeOpenQuestions(program, record.uuid, "its pane was closed");
    runTMuxRequired(["kill-pane", "-t", record.paneID], "tmux kill-pane");
    if (resolved.includes(record.task)) markResolved(program, record.task);
  }
  if (targets.length > 0) {
    writeStatusFile(program);
    notifyApp(own.sessionName);
  }
  const stopped = targets.map(record => record.task).filter(task => !resolved.includes(task));
  return { id: requestID("cli"), ok: true, result: { closed: targets.map(record => record.task), resolved: resolved.length ? resolved : undefined, stopped: stopped.length ? stopped : undefined, ...(subWorkers.length ? { withSubWorkers: subWorkers.map(record => record.task) } : {}) } };
}

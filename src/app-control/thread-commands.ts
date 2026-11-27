// @ts-nocheck
// agent resolve, agent reopen and agent remove: a thread is finished, taken up again, or taken
// out of the list.

import fs from "node:fs";
import path from "node:path";
import { requestID } from "./app-socket.js";
import { threadTitle, writeStatusFile, writeTaskReport } from "./briefs.js";
import { agentNameFromLaunchCommand, normalizeAgentName, shellQuote } from "./launch.js";
import { fail } from "./output.js";
import { localPaneRef, resolveLocalSourcePane, runTMuxRequired, setPaneOption } from "./panes.js";
import { coordinationPaneRecords, coordinatorLeads, notifyApp, ownCoordinationRecord, programName, readJSON, setProgramName, taskPaths } from "./program.js";
import { runAgentPromote, runAgentRespawn } from "./promote.js";
import { closeOpenQuestions, closeUserQuestions } from "./questions.js";
import { closedReportState, closerOf, recordReopen } from "./report.js";
import { runAgentSpawn } from "./spawn.js";
import { isWorkerRecord } from "./spawn-support.js";
import { coordinatorsFile, isFinished, markResolved, markUnresolved, proposeClose, readSessionLines, removeProgram, removeThread, reopenStep, resumeTarget, sessionsFile, threadRows, titleWarning, transcriptLookup, updateTaskMeta } from "./threads.js";
import { agentResumeInvocation } from "../resume.js";
import { oneLine } from "./processes.js";

// The program a thread command acts on: --program (the app names it), else the program of the
// agent that runs the command.
function commandProgram(params, commandName) {
  if (params.program) return { program: path.resolve(params.program) };
  const own = ownCoordinationRecord(params, commandName);
  if (!own.program) fail(2, "noProgram", "This pane belongs to no program; pass --program.");
  return { program: own.program, own };
}

function knownTask(program, task) {
  const files = taskPaths(program, task);
  if (!fs.existsSync(files.meta)) fail(2, "taskUnavailable", `No task '${task}' in ${program}.`);
  return files;
}

// How a thread ends (B1): done, dropped with a line on why, or replaced by another thread. A done
// thread resolves as done; an unfinished one only with --dropped or --replaced-by.
export function resolveOutcome(program, task, params, who) {
  const report = readJSON(taskPaths(program, task).reportJSON, undefined);
  if (params["replaced-by"] !== undefined) {
    const by = String(params["replaced-by"]);
    if (by === task) fail(64, "usage", "agent resolve --replaced-by names another thread.");
    knownTask(program, by);
    return { kind: "replaced", by, who };
  }
  if (params.dropped !== undefined) return { kind: "dropped", why: params.dropped === true ? undefined : String(params.dropped), who };
  if (isFinished(report)) return { kind: "done", who };
  // The user accepting a proposal to drop it (the close card's Close as dropped, P8).
  const proposed = readJSON(taskPaths(program, task).meta, {})?.proposedClose;
  if (proposed?.as === "dropped") return { kind: "dropped", why: typeof proposed.why === "string" ? proposed.why : undefined, who };
  fail(2, "outcomeRequired", `${task} is not done. Say how it ends: agent resolve ${task} --dropped "<why>", or --replaced-by <task>. Closing its pane (agent close) keeps it open instead.`, { task });
}

// A sub-worker ends with the thread it was part of: done with a done one, dropped otherwise.
function subWorkerOutcome(outcome, task) {
  return { kind: outcome.kind === "done" ? "done" : "dropped", why: `part of ${task}`, who: outcome.who };
}

// Marks threads resolved, each with its outcome; a thread that still has a pane is closed with it
// (and its sub-workers). --propose only proposes closing, with why: a done thread as done, or with
// --as dropped any open one (P8); the user closes it.
export async function runAgentResolve(command) {
  const params = command.params;
  const { program, own } = commandProgram(params, "agent resolve");
  for (const task of command.tasks) knownTask(program, task);
  const who = closerOf(own);
  // The user keeps a thread its coordinator proposed to close (T8): the proposal goes.
  if (params["keep-open"]) {
    for (const task of command.tasks) updateTaskMeta(program, task, meta => { delete meta.proposedClose; return meta; });
    return { id: requestID("cli"), ok: true, result: { program, keptOpen: command.tasks } };
  }
  if (params.propose !== undefined) {
    const why = oneLine(params.propose === true ? "" : params.propose, 300);
    if (!why) fail(64, "usage", "agent resolve --propose needs why, e.g. --propose \"The PR is merged and the build is out\".");
    // Closing as done, or (a thread quiet for days whose goal is no longer wanted, P8) as dropped.
    const as = params.as === undefined ? "done" : String(params.as).toLowerCase();
    if (!["done", "dropped"].includes(as)) fail(64, "usage", "agent resolve --propose --as is done or dropped.");
    if (as === "done") {
      for (const task of command.tasks) {
        if (!isFinished(readJSON(taskPaths(program, task).reportJSON, undefined))) {
          fail(2, "notDone", `${task} is not done, so it cannot be proposed for closing as done. If it is no longer wanted, propose dropping it: agent resolve ${task} --propose "<why>" --as dropped.`, { task });
        }
      }
    }
    for (const task of command.tasks) proposeClose(program, task, why, undefined, as);
    writeStatusFile(program);
    for (const record of coordinationPaneRecords().filter(candidate => candidate.program === program)) notifyApp(record.sessionName);
    return { id: requestID("cli"), ok: true, result: { program, proposed: command.tasks, as, why, next: `The user sees a card in the thread proposing to close it as ${as}, and closes it or keeps it open. Nothing is resolved yet.` } };
  }
  const outcomes = new Map(command.tasks.map(task => [task, resolveOutcome(program, task, params, who)]));
  const records = coordinationPaneRecords().filter(record => record.program === program && isWorkerRecord(record));
  const closed = [];
  for (const task of command.tasks) {
    const record = records.find(candidate => candidate.task === task);
    const panes = record
      ? [record, ...records.filter(candidate => record.uuid && candidate.parent === record.uuid)]
      : [];
    for (const pane of panes) {
      const files = taskPaths(program, pane.task);
      const report = readJSON(files.reportJSON, { task: pane.task, line: "Closed without a report.", outputs: [], history: [] });
      if (report.state !== "done") {
        report.state = closedReportState(report);
        report.updatedAt = new Date().toISOString();
        report.history = [...(report.history || []), { at: report.updatedAt, state: report.state, line: "Resolved; its pane was closed.", by: "coordinator" }].slice(-50);
        writeTaskReport(files, report);
      }
      closeOpenQuestions(program, pane.uuid, "its thread was resolved");
      closeUserQuestions(program, pane.task, "its thread was resolved");
      runTMuxRequired(["kill-pane", "-t", pane.paneID], "tmux kill-pane");
      closed.push(pane.task);
      markResolved(program, pane.task, undefined, pane.task === task ? outcomes.get(task) : subWorkerOutcome(outcomes.get(task), task));
      notifyApp(pane.sessionName);
    }
    closeUserQuestions(program, task, "its thread was resolved");
    markResolved(program, task, undefined, outcomes.get(task));
  }
  writeStatusFile(program);
  return {
    id: requestID("cli"),
    ok: true,
    result: {
      program,
      resolved: command.tasks,
      outcomes: Object.fromEntries(outcomes),
      closed: closed.length ? closed : undefined,
      next: who === "coordinator" ? `Take ${command.tasks.join(", ")} out of Current state in MEMORY.md; ${command.tasks.length === 1 ? "its report.md keeps" : "their report.md files keep"} the detail.` : undefined,
    },
  };
}

// Deletes threads, or with no task a whole program (removeProgram, removeThread). Nothing live is
// removed: a thread with a pane is resolved first, a program is removed once no coordinator leads
// it and none of its threads has a pane. A whole program is named only by --program, never by the
// pane that runs the command.
export async function runAgentRemove(command) {
  const params = command.params;
  if (command.tasks.length === 0 && !params.program) fail(64, "usage", "agent remove needs task names, or --program <dir> to remove a whole program.");
  const { program } = commandProgram(params, "agent remove");
  if (!fs.existsSync(program)) fail(2, "programUnavailable", `No program ${program}.`);
  for (const task of command.tasks) knownTask(program, task);
  const records = coordinationPaneRecords().filter(record => record.program === program);
  const workers = records.filter(isWorkerRecord);
  const tasks = command.tasks.length ? command.tasks : threadRows(program).map(row => row.task);
  const live = workers.filter(record => tasks.includes(record.task));
  if (live.length) {
    fail(2, "threadLive", `${live.map(record => `${record.task} (pane ${localPaneRef(record.paneID)})`).join(", ")} still ${live.length === 1 ? "has its pane" : "have their panes"}; resolve ${live.length === 1 ? "it" : "them"} first.`);
  }
  if (command.tasks.length === 0) {
    const lead = records.find(coordinatorLeads);
    if (lead) fail(2, "programLed", `The coordinator in pane ${localPaneRef(lead.paneID)} still leads ${programName(program)}; close its pane first.`);
    const name = programName(program);
    removeProgram(program);
    return { id: requestID("cli"), ok: true, result: { program, name, removed: "program", threads: tasks.length } };
  }
  for (const task of command.tasks) removeThread(program, task);
  writeStatusFile(program);
  for (const record of records) notifyApp(record.sessionName);
  return { id: requestID("cli"), ok: true, result: { program, removed: "threads", threads: command.tasks } };
}

// Names a thread in the user's words: task.json's title, and the title its live pane shows. Any
// thread of the program, open or resolved.
export function setThreadTitle(program, task, title) {
  updateTaskMeta(program, task, meta => ({ ...meta, title }));
  const record = coordinationPaneRecords().find(candidate => candidate.program === program && candidate.task === task && isWorkerRecord(candidate));
  if (record) {
    setPaneOption(localPaneRef(record.paneID), "@agents_title", title);
    notifyApp(record.sessionName);
  }
  return record;
}

export async function runAgentTitle(command) {
  const params = command.params;
  const { program } = commandProgram(params, "agent title");
  knownTask(program, command.task);
  const title = threadTitle(command.title);
  const record = setThreadTitle(program, command.task, title);
  return { id: requestID("cli"), ok: true, result: { program, task: command.task, title, pane: record ? localPaneRef(record.paneID) : undefined, ...titleWarning(title) } };
}

// A program's name in the user's words, 2-4 words from their goal ("Security triage").
export function programNameOf(text) {
  const name = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) fail(64, "usage", "agent name needs a name, e.g. agent name \"Security triage\".");
  return name;
}

export async function runAgentName(command) {
  const params = command.params;
  const { program } = commandProgram(params, "agent name");
  const name = programNameOf(command.name);
  setProgramName(program, name);
  for (const record of coordinationPaneRecords().filter(candidate => candidate.program === program)) notifyApp(record.sessionName);
  const words = name.split(" ").length;
  return { id: requestID("cli"), ok: true, result: { program, name, ...(words > 4 ? { nameLong: true, nameHint: `The name has ${words} words; a program's name is 2-4 words from the user's goal.` } : {}) } };
}

// The pane a reopened thread's new tab opens beside: the coordinator that leads the program, else
// the agent (or the app's active pane, --pane) that runs the command.
function reopenParent(program, params, records) {
  const lead = records.find(record => record.program === program && coordinatorLeads(record));
  if (lead) return lead;
  const pane = resolveLocalSourcePane(params, "agent reopen");
  const own = records.find(record => localPaneRef(record.paneID) === pane);
  if (!own) fail(2, "paneUnavailable", `Could not find pane '${pane}' in local tmux.`);
  return own;
}

// Reopens a thread without a pane, by the step `agents threads` shows for it: resume its latest
// session whose transcript is on disk, else start a worker again on its brief and report (agent
// respawn), else nothing to start: the brief and report are there to read. Every step makes the
// thread open again.
export async function runAgentReopen(command, currentSocketPath) {
  const params = command.params;
  if (params.coordinator) return runAgentReopenCoordinator(command, currentSocketPath);
  const { program, own } = commandProgram(params, "agent reopen");
  const files = knownTask(program, command.task);
  // --title names the thread as it opens again.
  if (params.title !== undefined && !params["dry-run"]) setThreadTitle(program, command.task, threadTitle(params.title));
  const meta = readJSON(files.meta, {});
  const records = coordinationPaneRecords();
  const live = records.find(record => record.program === program && record.task === command.task && isWorkerRecord(record));
  // A done thread taken up again says so, with who and why; its done stays as an earlier round.
  if (!params["dry-run"] && (meta.resolved || isFinished(readJSON(files.reportJSON, undefined)))) {
    const who = closerOf(own);
    const why = oneLine(command.why || "", 300);
    recordReopen(program, command.task, who, why ? `Reopened by ${who}: ${why}` : `Reopened by ${who}.`);
  }
  if (!params["dry-run"]) markUnresolved(program, command.task);
  if (live) {
    return { id: requestID("cli"), ok: true, result: { program, task: command.task, step: "pane", pane: localPaneRef(live.paneID) } };
  }
  const transcriptOf = transcriptLookup();
  const sessions = readSessionLines(sessionsFile(program, command.task)).reverse()
    .map(session => ({ ...session, transcript: transcriptOf(session.agent, session.session, session.cwd) }));
  const step = reopenStep(meta, sessions, files);
  if (params["dry-run"] || step.step === "read") {
    return {
      id: requestID("cli"),
      ok: true,
      result: { program, task: command.task, ...step, brief: fs.existsSync(files.brief) ? files.brief : undefined, report: fs.existsSync(files.report) ? files.report : undefined, dryRun: params["dry-run"] || undefined },
    };
  }
  if (step.step === "respawn") {
    const parent = reopenParent(program, params, records);
    const response = await runAgentRespawn({ task: command.task, params: { ...params, program, pane: localPaneRef(parent.paneID) } }, currentSocketPath);
    return { ...response, result: { ...response.result, step: "respawn" } };
  }
  // Resume: the session's own harness, with the flags the task's launch command gave it.
  const session = sessions.find(candidate => candidate.session === step.session);
  let profile;
  try {
    if (meta.launchCommand && agentNameFromLaunchCommand(meta.launchCommand) === normalizeAgentName(session.agent)) {
      profile = { command: meta.launchCommand };
    }
  } catch {
    profile = undefined;
  }
  const invocation = agentResumeInvocation(session.agent, resumeTarget(session), { profile });
  const parent = reopenParent(program, params, records);
  const parentRef = localPaneRef(parent.paneID);
  const response = await runAgentSpawn({
    prompt: "",
    params: { ...params, pane: parentRef, parent: parentRef },
    respawn: {
      task: command.task,
      program,
      launchCommand: meta.launchCommand,
      cwd: session.cwd || meta.cwd,
      model: meta.model,
      resume: { argv: invocation.argv, agent: normalizeAgentName(session.agent) },
    },
  }, currentSocketPath);
  return { ...response, result: { ...response.result, step: "resume", agent: session.agent, session: session.session } };
}

// Reopens a program's coordinator as the same conversation (Peter, 2026-11-27: "the coordinator
// thread must be persistent and closable and reopenable like a worker's"): its latest session
// whose transcript is on disk, resumed in a new pane beside --pane, and given its role back
// without a start message. A live coordinator is shown instead.
export async function runAgentReopenCoordinator(command, currentSocketPath) {
  const params = command.params;
  if (!params.program || params.program === true) fail(64, "usage", "agent reopen --coordinator needs --program <dir>.");
  const program = path.resolve(String(params.program));
  const records = coordinationPaneRecords();
  const live = records.find(record => record.program === program && record.role === "coordinator" && !record.task && !record.dead);
  if (live) return { id: requestID("cli"), ok: true, result: { program, step: "pane", pane: localPaneRef(live.paneID) } };
  const transcriptOf = transcriptLookup();
  const sessions = readSessionLines(coordinatorsFile(program)).reverse()
    .map(session => ({ ...session, transcript: transcriptOf(session.agent, session.session, session.cwd) }));
  const session = sessions.find(candidate => candidate.transcript);
  if (!session) fail(2, "noCoordinatorSession", `${program} has no coordinator session to resume; start a new coordinator instead.`, { sessions: sessions.length });
  if (params["dry-run"]) return { id: requestID("cli"), ok: true, result: { program, step: "resume", agent: session.agent, session: session.session, dryRun: true } };
  const invocation = agentResumeInvocation(session.agent, resumeTarget(session), {});
  const spawned = await runAgentSpawn({
    prompt: "",
    params: { ...params, "no-parent": true, "launch-command": invocation.argv.map(shellQuote).join(" "), cwd: session.cwd },
    respawn: { cwd: session.cwd, resume: { argv: invocation.argv, agent: normalizeAgentName(session.agent) } },
  }, currentSocketPath);
  const newPane = spawned.result?.newPane;
  if (!newPane) return spawned;
  const promoted = await runAgentPromote({ params: { pane: newPane, program, restore: true } });
  return { id: requestID("cli"), ok: true, result: { program, step: "resume", pane: newPane, agent: session.agent, session: session.session, promoted: promoted.result } };
}

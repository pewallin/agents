// @ts-nocheck
// agent resolve and agent reopen: a thread is finished, or taken up again.

import fs from "node:fs";
import path from "node:path";
import { requestID } from "./app-socket.js";
import { threadTitle, writeStatusFile, writeTaskReport } from "./briefs.js";
import { agentNameFromLaunchCommand, normalizeAgentName } from "./launch.js";
import { fail } from "./output.js";
import { localPaneRef, resolveLocalSourcePane, runTMuxRequired, setPaneOption } from "./panes.js";
import { coordinationPaneRecords, coordinatorLeads, notifyApp, ownCoordinationRecord, readJSON, taskPaths } from "./program.js";
import { runAgentRespawn } from "./promote.js";
import { closeOpenQuestions } from "./questions.js";
import { closedReportState } from "./report.js";
import { runAgentSpawn } from "./spawn.js";
import { isWorkerRecord } from "./spawn-support.js";
import { markResolved, markUnresolved, readSessionLines, reopenStep, resumeTarget, sessionsFile, titleWarning, transcriptLookup, updateTaskMeta } from "./threads.js";
import { agentResumeInvocation } from "../resume.js";

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

// Marks threads resolved; a thread that still has a pane is closed with it (and its sub-workers).
export async function runAgentResolve(command) {
  const params = command.params;
  const { program } = commandProgram(params, "agent resolve");
  for (const task of command.tasks) knownTask(program, task);
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
      runTMuxRequired(["kill-pane", "-t", pane.paneID], "tmux kill-pane");
      closed.push(pane.task);
      markResolved(program, pane.task);
      notifyApp(pane.sessionName);
    }
    markResolved(program, task);
  }
  writeStatusFile(program);
  return { id: requestID("cli"), ok: true, result: { program, resolved: command.tasks, closed: closed.length ? closed : undefined } };
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
  const { program } = commandProgram(params, "agent reopen");
  const files = knownTask(program, command.task);
  // --title names the thread as it opens again.
  if (params.title !== undefined && !params["dry-run"]) setThreadTitle(program, command.task, threadTitle(params.title));
  const meta = readJSON(files.meta, {});
  const records = coordinationPaneRecords();
  const live = records.find(record => record.program === program && record.task === command.task && isWorkerRecord(record));
  markUnresolved(program, command.task);
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

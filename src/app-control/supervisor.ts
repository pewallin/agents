// @ts-nocheck
// A program's supervisor: delivering messages and watching agents.

import fs from "node:fs";
import path from "node:path";
import { requestID, sendRequest, socketPath, tokenPath } from "./app-socket.js";
import { settleStaleClaims, typeQueuedLines } from "./ask.js";
import { writeStatusFile, writeTaskReport } from "./briefs.js";
import { deliveryFile, deliveryHold, effectiveStatus, noteDelivery, paneContent, screenChoiceText, screenState, updateMessageRecord } from "./delivery.js";
import { RIDER_SUFFIX, deliveryReminder, enqueueMessage, noteForCoordinator, noteLine, queueNames, readQueued, turnDriver, waitsLine, wakeLine, wakeSummary } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, runTMux, setPaneOption } from "./panes.js";
import { sleep } from "./placement.js";
import { AT_PROMPT_STATES, COORDINATOR_ANSWER_PATIENCE_MS, SETTLED_REPORTS } from "./processes.js";
import { coordinationPaneRecords, notifyApp, readJSON, taskPaths, writeFileAtomic } from "./program.js";
import { isRespawning } from "./promote.js";
import { closeOpenQuestions } from "./questions.js";
import { closedReportState, lastWorkerReport, setWorkerReportState } from "./report.js";
import { isWorkerRecord } from "./spawn-support.js";
import { followOffers } from "./steer.js";
import { markResolved, markUnresolved, recordCoordinatorSession, recordTaskSession, resolvesOnClose, threadsEpoch } from "./threads.js";
import { agentStatuses, cliVersion, readFileOr, runningSupervisor, supervisorBeatFile } from "./supervisor-control.js";
import { processWatches, readWatches } from "./watch.js";

// Typing into a prompt the user is writing in would mix the line into their draft and send both.
// The app knows when the user last typed into a pane and whether that may still sit unsent.
export const USER_QUIET_MS = 8000;
export const DRAFT_HOLD_MS = 10 * 60 * 1000;

// An app-control request whose failure changes nothing: no app, an older app, or a slow one
// answer undefined.
export async function appRequestIfRunning(method, params) {
  const currentSocketPath = socketPath();
  if (!fs.existsSync(currentSocketPath)) return undefined;
  try {
    const token = process.env.AGENTS_APP_TOKEN || fs.readFileSync(tokenPath(), "utf8").trim();
    const line = await Promise.race([
      sendRequest(currentSocketPath, { id: requestID("cli"), method, params: { ...params, token } }),
      sleep(3000).then(() => { throw new Error("timed out"); }),
    ]);
    const response = JSON.parse(line);
    return response.ok === false ? undefined : (response.result ?? {});
  } catch {
    return undefined;
  }
}

// Without an answer the screen check alone decides.
export function appInputState(paneID) {
  return appRequestIfRunning("surface.input_state", { pane: localPaneRef(paneID) });
}

export function userIsWriting(input) {
  if (typeof input?.secondsSinceInput !== "number") return false;
  const quietMs = input.secondsSinceInput * 1000;
  return quietMs < USER_QUIET_MS || (input.mayHaveDraft === true && quietMs < DRAFT_HOLD_MS);
}

export function supervisorLog(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

// Ticks (2 s each) an agent must wait at its prompt before its turn counts as ended.
export const TURN_END_TICKS = 2;

// When lines last reached the agent with this @agents_uuid.
export function deliveredAt(program, uuid) {
  if (!uuid) return 0;
  return Date.parse(readJSON(deliveryFile(program, uuid), {}).deliveredAt || "") || 0;
}

// The latest input to a worker: a line typed in for it, or the user typing in its pane (as the
// app saw it; without the app, lines only).
export async function lastInputAt(program, record) {
  const input = await appInputState(record.paneID);
  const typed = typeof input?.secondsSinceInput === "number" ? Date.now() - input.secondsSinceInput * 1000 : 0;
  return Math.max(deliveredAt(program, record.uuid), typed);
}

export async function runSupervisor(command) {
  const program = command.params.program;
  if (!program) fail(64, "usage", "agent supervise requires --program.");
  const runDir = path.join(program, ".run");
  fs.mkdirSync(runDir, { recursive: true });
  const pidFile = path.join(runDir, "supervisor.pid");
  if (runningSupervisor(program)) return;
  // Started from inside an agent's sandbox (Codex's denies the tmux socket), it would see no pane
  // and keep a supervisor that can, started by the next command outside it, from running.
  if (runTMux(["display-message", "-p", "#{pid}"]) === undefined) {
    supervisorLog(`cannot reach tmux; not supervising ${program}`);
    return;
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  threadsEpoch(program);
  const beat = () => writeFileAtomic(supervisorBeatFile(program), `${JSON.stringify({ pid: process.pid, version: cliVersion(), beatAt: Date.now() })}\n`);
  beat();
  supervisorLog(`supervising ${program}`);

  // What the supervisor knows of each worker outlives the supervisor (a new version or a stuck one
  // replaces it): one that started afresh took a turn under way for new work, and the end of that
  // turn for a stop. Another tmux server (a restart, a restore) starts afresh: its panes are new.
  const stateFile = path.join(runDir, "workers.json");
  const saved = readJSON(stateFile, {});
  let server = runTMux(["display-message", "-p", "#{pid}"]);
  const workers = new Map(saved.server === server ? Object.entries(saved.workers || {}) : []);
  let savedState = "";
  // The stop each task's coordinator was last told of, by the report and the input it followed:
  // kept across tmux servers too, so nothing is told twice.
  const notifiedFile = path.join(runDir, "notified.json");
  const panes = new Map();
  let quietTicks = 0;
  let unreachableTicks = 0;
  for (;;) {
    if (Number(readFileOr(pidFile, "").trim()) !== process.pid) {
      supervisorLog("another supervisor took over; exiting");
      return;
    }
    beat();
    // Without an answer from tmux no pane is known gone or new: nothing is decided this tick.
    const currentServer = runTMux(["display-message", "-p", "#{pid}"]);
    const records = currentServer === undefined ? undefined : coordinationPaneRecords({ strict: true });
    if (!records) {
      unreachableTicks += 1;
      if (unreachableTicks === 1) supervisorLog("cannot reach tmux; waiting");
      if (unreachableTicks >= 150) {
        supervisorLog("tmux gone for 5 minutes; exiting");
        fs.rmSync(pidFile, { force: true });
        return;
      }
      await sleep(2000);
      continue;
    }
    unreachableTicks = 0;
    if (currentServer !== server) {
      supervisorLog(`tmux server ${currentServer} replaces ${server}; tracking its workers afresh`);
      server = currentServer;
      workers.clear();
      panes.clear();
    }
    const programWorkers = records.filter(record => record.program === program && isWorkerRecord(record));
    const queueDir = path.join(program, ".queue");
    let queued = [];
    try {
      queued = fs.readdirSync(queueDir).filter(name => !name.startsWith("."));
    } catch {
      queued = [];
    }
    const targets = queued
      .map(uuid => ({ uuid, record: records.find(record => record.uuid === uuid) }));
    const watched = [...new Set([
      ...programWorkers.map(record => record.paneID),
      ...targets.filter(target => target.record).map(target => target.record.paneID),
    ])];
    // The program's coordinators are asked about too, for the sessions that lead it.
    const coordinators = records.filter(record => record.program === program && record.role === "coordinator" && !record.dead && !watched.includes(record.paneID));
    const statuses = agentStatuses([...watched, ...coordinators.map(record => record.paneID)]);
    const now = Date.now();
    for (const record of coordinators) {
      const status = statuses.get(record.paneID);
      if (status?.sessionId && status.agent) {
        recordCoordinatorSession(program, { via: "changed", agent: status.agent, session: status.sessionId, uuid: record.uuid });
      }
    }

    for (const paneID of watched) {
      const { text, hash } = paneContent(paneID);
      const previous = panes.get(paneID) || {};
      panes.set(paneID, { text, hash, stableTicks: hash && hash === previous.hash ? (previous.stableTicks || 0) + 1 : 0, deliveredAt: previous.deliveredAt || 0 });
    }
    const statusOf = paneID => effectiveStatus(statuses.get(paneID)?.status, panes.get(paneID));
    const notified = readJSON(notifiedFile, {});
    let notifiedChanged = false;

    // Wake the parent when a worker stops without reporting, or its pane goes away unfinished.
    for (const record of programWorkers) {
      const status = statusOf(record.paneID);
      const key = record.uuid || record.paneID;
      const tracked = workers.get(key) || { status: undefined, workingSince: 0 };
      tracked.task = record.task;
      tracked.uuid = record.uuid;
      // Every session the worker runs, as its hooks name it: its first, a /clear, a resumed copy.
      const session = statuses.get(record.paneID);
      if (session?.sessionId && session.agent && session.sessionId !== tracked.session) {
        recordTaskSession(program, record.task, { agent: session.agent, session: session.sessionId, uuid: record.uuid });
        tracked.session = session.sessionId;
      }
      // A pane a tmux restore brought back without its thread's title gets it again.
      if (!record.title) {
        const title = readJSON(taskPaths(program, record.task).meta, {}).title;
        if (title) {
          setPaneOption(localPaneRef(record.paneID), "@agents_title", title);
          notifyApp(record.sessionName);
        }
      }
      // A coordinator that took over is the parent from now on.
      tracked.parent = record.parent;
      const report = readJSON(taskPaths(program, record.task).reportJSON, undefined);
      const own = lastWorkerReport(report);
      // When the worker last reported, or was started. report.json keeps it where a tmux restore
      // drops the pane's @agents_report_at.
      const reportedAt = Math.max(Date.parse(own?.at || "") || 0, record.reportAt * 1000);
      const settled = SETTLED_REPORTS.has(own?.state);
      if (status === "working" && tracked.status !== "working") {
        tracked.workingSince = now;
        // What set this turn going: a line typed in for the worker, or the user typing in its pane.
        tracked.inputAt = await lastInputAt(program, record);
        // An answered question, or new work after done or blocked: the worker works again, and its
        // row stops showing the state it left. Without input since that report it is the same work
        // running on (a turn that went on after its report, an agent restarted with its pane).
        if (settled && SETTLED_REPORTS.has(record.reportState) && tracked.inputAt > reportedAt) {
          setWorkerReportState(program, record, "progress", "Working again.");
          markUnresolved(program, record.task);
          record.reportState = "progress";
          supervisorLog(`${record.task} works again`);
        }
      }
      tracked.promptTicks = AT_PROMPT_STATES.has(status) ? (tracked.promptTicks || 0) + 1 : 0;
      // A question for the coordinator that stays unanswered waits on the user in the end.
      if (record.reportState === "ask-coordinator" && AT_PROMPT_STATES.has(status)
          && now > reportedAt + COORDINATOR_ANSWER_PATIENCE_MS) {
        setWorkerReportState(program, record, "blocked", "The coordinator has not answered.");
        record.reportState = "blocked";
        supervisorLog(`${record.task} waits on an answer from its coordinator`);
      }
      // A worker that waits on a permission or a choice in its pane waits on the user, who may
      // not be looking at it: its coordinator is told once, and can ask them.
      if (status !== undefined) {
        const waitsOnChoice = status === "attention";
        // In work the user drives in this pane, they see what it asks already.
        if (waitsOnChoice && !tracked.waitsOnChoice && record.parent && await turnDriver(program, record, report) === "user") {
          supervisorLog(`${record.task} waits on a choice in a turn the user drives`);
        } else if (waitsOnChoice && !tracked.waitsOnChoice && record.parent) {
          const pane = panes.get(record.paneID);
          const choice = screenState(pane?.text) === "choice" ? screenChoiceText(pane.text) : undefined;
          enqueueMessage(program, record.parent, waitsLine(record.task, record.paneID, choice), `Worker ${record.task} waits for a permission`);
          supervisorLog(`${record.task} waits on a choice`);
        }
        tracked.waitsOnChoice = waitsOnChoice;
      }
      // A turn ends when the agent has waited at its prompt for TURN_END_TICKS ticks in a row: a
      // state that flickers to idle and back mid-turn is no stop. A state nobody can tell
      // (undefined) changes nothing.
      if (tracked.status === "working" && AT_PROMPT_STATES.has(status)) {
        if (tracked.promptTicks < TURN_END_TICKS) {
          workers.set(key, tracked);
          continue;
        }
        const reportedThisTurn = reportedAt >= tracked.workingSince - 1000;
        // A worker that ended its turn on a watch or reminder of its own waits; that wakes it.
        const waitsOnWatch = readWatches(program).some(watch => watch.target === record.uuid)
          // So does one that leads sub-workers still at work: their reports wake it.
          || programWorkers.some(child => record.uuid && child.parent === record.uuid
            && !SETTLED_REPORTS.has(child.reportState) && statusOf(child.paneID) !== "idle");
        // After done, blocked or a question, a turn is new work only when new input started it.
        const newWork = !settled || (tracked.inputAt || 0) > reportedAt;
        // One line per stop: the same report and the same input make the same stop, however
        // often the agent stops again or the supervisor starts anew.
        const episode = `${reportedAt}:${tracked.inputAt || 0}`;
        if (!reportedThisTurn && !waitsOnWatch && newWork && record.parent) {
          if (notified[record.task] !== episode) {
            const done = own?.state === "done" ? own : undefined;
            const preview = statuses.get(record.paneID)?.responsePreview;
            // A turn the user drove in the pane: they saw it end, and the coordinator gets a note.
            if (await turnDriver(program, record, report) === "user") {
              noteForCoordinator(program, record.parent, record.task, noteLine(program, record.task, "stopped", preview, { done }));
              supervisorLog(`${record.task} stopped after a turn the user drove; noted for its coordinator`);
            } else {
              enqueueMessage(program, record.parent, wakeLine(program, record.task, "stopped", preview, undefined, { done }), wakeSummary(record.task, "stopped"));
              supervisorLog(`${record.task} stopped without a report`);
            }
            notified[record.task] = episode;
            notifiedChanged = true;
          } else {
            supervisorLog(`${record.task} stopped again without a report; its coordinator was told`);
          }
        }
      }
      if (status !== undefined) tracked.status = status;
      workers.set(key, tracked);
    }
    for (const [key, tracked] of workers) {
      if (programWorkers.some(record => (record.uuid || record.paneID) === key)) continue;
      workers.delete(key);
      closeOpenQuestions(program, tracked.uuid, "its pane closed");
      // A respawned task already runs in a new pane, or is about to.
      if (programWorkers.some(record => record.task === tracked.task) || isRespawning(program, tracked.task)) continue;
      const files = taskPaths(program, tracked.task);
      const report = readJSON(files.reportJSON, { task: tracked.task, line: "Closed without a report.", outputs: [], history: [] });
      const own = lastWorkerReport(report);
      const done = own?.state === "done" ? own : undefined;
      // `agent close` marks what it closes in the report first.
      const closedOnPurpose = ["done", "closed"].includes(report.state);
      // Closed after done, with no input since: the task was finished.
      const inputAt = Math.max(tracked.inputAt || 0, deliveredAt(program, tracked.uuid));
      const unfinished = !done || inputAt > (Date.parse(done.at) || 0);
      if (!closedOnPurpose && unfinished && tracked.parent) {
        enqueueMessage(program, tracked.parent, wakeLine(program, tracked.task, "closed", report.state || "started", undefined, { done }), wakeSummary(tracked.task, "closed"));
        supervisorLog(`${tracked.task} closed`);
      }
      if (!closedOnPurpose) {
        report.state = closedReportState(report);
        report.updatedAt = new Date().toISOString();
        report.history = [...(report.history || []), { at: report.updatedAt, state: report.state, line: "Its pane closed.", by: "supervisor" }].slice(-50);
        writeTaskReport(files, report);
        writeStatusFile(program);
      }
      // The user closed the tab of a done thread: they looked at the work, nothing is left. An
      // unfinished one stays open, stopped. (Panes gone with their tmux server never get here.)
      if (resolvesOnClose(report) && !unfinished) markResolved(program, tracked.task);
    }
    if (notifiedChanged) writeFileAtomic(notifiedFile, `${JSON.stringify(notified, null, 2)}\n`);
    const state = JSON.stringify({ server, workers: Object.fromEntries(workers) });
    if (state !== savedState) {
      writeFileAtomic(stateFile, `${state}\n`);
      savedState = state;
    }

    // Deliver queued lines into idle agents whose screen has been still for a few seconds.
    let pending = 0;
    for (const { uuid, record } of targets) {
      const dir = path.join(queueDir, uuid);
      settleStaleClaims(program, uuid);
      let messages = [];
      try {
        messages = fs.readdirSync(dir).filter(name => name.endsWith(".txt")).sort();
      } catch {
        messages = [];
      }
      if (messages.length === 0 && (!record || record.dead)) {
        for (const name of queueNames(program, uuid, RIDER_SUFFIX)) {
          updateMessageRecord(program, readQueued(path.join(dir, name))?.id, "undelivered", "its agent's pane is gone");
          fs.mkdirSync(path.join(program, ".queue", ".undelivered"), { recursive: true });
          fs.renameSync(path.join(dir, name), path.join(program, ".queue", ".undelivered", `${uuid}-${name}`));
        }
      }
      if (messages.length === 0) {
        // Only an empty directory: a promote may be typing claimed lines from it.
        try {
          fs.rmdirSync(dir);
        } catch {
          // Not empty, or gone.
        }
        continue;
      }
      if (!record || record.dead) {
        const undelivered = path.join(program, ".queue", ".undelivered");
        fs.mkdirSync(undelivered, { recursive: true });
        for (const name of messages) {
          updateMessageRecord(program, readQueued(path.join(dir, name))?.id, "undelivered", "its agent's pane is gone");
          fs.renameSync(path.join(dir, name), path.join(undelivered, `${uuid}-${name}`));
        }
        supervisorLog(`dropped ${messages.length} message(s) for missing pane ${uuid}`);
        continue;
      }
      pending += messages.length;
      const pane = panes.get(record.paneID) || {};
      let waiting = deliveryHold(record, statusOf(record.paneID), pane, now);
      if (!waiting) {
        const input = await appInputState(record.paneID);
        if (userIsWriting(input)) waiting = `the user ${input.mayHaveDraft ? "has an unsent draft" : "is typing"} in pane ${record.paneID}`;
      }
      if (waiting) {
        noteDelivery(program, uuid, record.paneID, { queued: messages.length, waiting }, now);
        continue;
      }
      // Claimed one by one: a promote typing them in itself may have taken some.
      if (!typeQueuedLines(program, uuid, record, messages, deliveryReminder(record))) continue;
      pane.deliveredAt = now;
      pending -= messages.length;
      noteDelivery(program, uuid, record.paneID, { queued: 0, delivered: messages.length }, now);
    }

    const offered = followOffers(program, records);
    const watching = processWatches(program);
    quietTicks = programWorkers.length === 0 && pending === 0 && watching === 0 && offered === 0 ? quietTicks + 1 : 0;
    if (quietTicks >= 10) {
      supervisorLog("no workers, watches or queued lines; exiting");
      fs.rmSync(pidFile, { force: true });
      return;
    }
    await sleep(2000);
  }
}

// @ts-nocheck
// agent ask, cancelling messages and typing queued lines.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requestID } from "./app-socket.js";
import { writeStatusFile } from "./briefs.js";
import { deliveryState, readMessageRecord, updateMessageRecord, writeMessageRecord } from "./delivery.js";
import { RIDER_SUFFIX, deliveryLine, queueNames, queuedNotes, readQueued } from "./messages.js";
import { fail, usage } from "./output.js";
import { runTMux } from "./panes.js";
import { sleep } from "./placement.js";
import { oneLine } from "./processes.js";
import { coordinationPaneRecords, ownCoordinationRecord, writeFileAtomic } from "./program.js";
import { readQuestion, recordQuestion, waitFile, writeQuestion } from "./questions.js";
import { announceToView, hostsSession, promptHosted } from "./spawn-support.js";
import { supervisorLog } from "./supervisor.js";
import { ensureSupervisor, writeOwnReport } from "./supervisor-control.js";
import { parseDuration } from "./watch.js";

// Exit status of an `agent ask` whose answer did not come in time: not a failure, the answer comes
// in the prompt.
export const ASK_TIMEOUT_STATUS = 4;
export const ASK_DEFAULT_TIMEOUT_MS = 50000;
export const ASK_MAX_TIMEOUT_MS = 10 * 60 * 1000;

export async function runAgentAsk(command) {
  const params = command.params;
  const line = oneLine(command.text);
  if (!line) fail(64, "usage", "agent ask requires the question.");
  const timeoutMs = params.timeout === undefined ? ASK_DEFAULT_TIMEOUT_MS : parseDuration(params.timeout, "agent ask --timeout");
  if (timeoutMs > ASK_MAX_TIMEOUT_MS) fail(64, "usage", "agent ask --timeout is at most 10m: wait longer by ending your turn; the answer comes in your prompt.");
  const record = ownCoordinationRecord(params, "agent ask");
  if (!record.task || !record.program) {
    fail(2, "notAWorker", `Pane ${record.paneID} has no task. Only workers started with 'agent spawn' ask their coordinator.`);
  }
  const records = coordinationPaneRecords();
  if (!record.parent || !records.some(candidate => candidate.uuid === record.parent)) {
    fail(2, "paneUnavailable", "This pane has no live coordinator to ask.");
  }
  const program = record.program;
  writeOwnReport(record, "ask-coordinator", line);
  const id = recordQuestion(program, record, line, true);
  const wait = waitFile(program, id);
  const until = Date.now() + timeoutMs;
  writeFileAtomic(wait, `${JSON.stringify({ pid: process.pid, until })}\n`);
  // A harness that kills the command at its own timeout: the answer then goes to the prompt.
  const giveUp = () => {
    try {
      fs.renameSync(wait, `${wait}.expired`);
      fs.rmSync(`${wait}.expired`, { force: true });
    } catch {
      // Claimed by the answer, which then waits on a dead ask: it is queued instead.
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      giveUp();
      process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]));
    });
  }
  ensureSupervisor(program);

  const answered = () => {
    const question = readQuestion(program, id);
    return question?.state === "answered" && question.answer?.via === "ask" ? question : undefined;
  };
  let question;
  while (!(question = answered()) && Date.now() < until) await sleep(300);
  if (!question) {
    let expired = false;
    try {
      fs.renameSync(wait, `${wait}.expired`);
      fs.rmSync(`${wait}.expired`, { force: true });
      expired = true;
    } catch {
      // The answer claimed it a moment ago and is being written.
    }
    if (!expired) {
      const grace = Date.now() + 15000;
      while (!(question = answered()) && Date.now() < grace) await sleep(200);
    }
  }
  if (!question) {
    const payload = {
      id: requestID("cli"),
      ok: false,
      error: {
        code: "askTimedOut",
        message: `No answer within ${Math.round(timeoutMs / 1000)}s. The question stays open: the coordinator's answer comes in your prompt as a ⟢ agents line. Go on with what does not depend on it, or end your turn.`,
      },
      result: { questionId: id, answered: false, state: "open", task: record.task },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(ASK_TIMEOUT_STATUS);
  }
  // The worker goes on in the same turn: its row says so, and a stop without a report after this
  // wakes its coordinator as any stop does.
  writeOwnReport(record, "progress", `Got the coordinator's answer to: ${oneLine(line, 120)}`);
  return {
    id: requestID("cli"),
    ok: true,
    result: { questionId: id, answered: true, task: record.task, from: question.answer.from, answer: question.answer.text, file: question.answer.file, messageId: question.answer.messageId },
  };
}

// Cancels a message that has not reached its agent: a queued line or rider, an offer not taken
// yet, a steer that was not possible. One that reached the agent (typed, steered, answered) cannot
// be taken back: its record notes that cancellation was asked for, and nothing is removed.
export const REACHED_STATES = new Set(["typing", "delivered", "uncertain", "steering", "steered", "acknowledged", "answered"]);

export function cancelMessage(program, record, why) {
  const view = state => ({ messageId: record.id, cancelled: state === "cancelled", state });
  const cancel = () => {
    const done = writeMessageRecord(program, record, "cancelled", why, { cancelledAt: new Date().toISOString(), supersededBy: /^superseded by /.test(why) ? why.slice(14) : undefined });
    // A cancelled question is withdrawn; a cancelled answer leaves its question open again.
    if (record.question) {
      const question = readQuestion(program, record.id);
      if (question?.state === "open") writeQuestion(program, { ...question, state: "closed", closedAt: done.updatedAt, closedReason: "the worker withdrew it" });
    }
    if (record.replyTo) {
      const question = readQuestion(program, record.replyTo);
      if (question?.state === "answered" && question.answer?.messageId === record.id) {
        writeQuestion(program, { ...question, state: "open", answer: undefined });
      }
    }
    return view("cancelled");
  };
  if (record.state === "cancelled") return view("cancelled");
  if (record.state === "queued" && record.target) {
    const dir = path.join(program, ".queue", record.target);
    let removed = false;
    for (const name of [...queueNames(program, record.target, ".txt"), ...queueNames(program, record.target, RIDER_SUFFIX)]) {
      const file = path.join(dir, name);
      if (readQueued(file)?.id !== record.id) continue;
      try {
        // Renamed first: a supervisor that claims it to type it wins or loses as a whole.
        fs.renameSync(file, `${file}.cancelled`);
        fs.rmSync(`${file}.cancelled`, { force: true });
        removed = true;
      } catch {
        // Claimed for typing just now.
      }
    }
    if (removed) return cancel();
    record = readMessageRecord(program, record.id) || record;
  }
  if (record.state === "offered" && record.inbox) {
    try {
      fs.renameSync(path.join(record.inbox, `${record.id}.msg`), path.join(record.inbox, `${record.id}.withdrawn`));
      fs.rmSync(path.join(program, ".run", "offered", record.id), { force: true });
      return cancel();
    } catch {
      record = readMessageRecord(program, record.id) || record; // Taken just now.
    }
  }
  if (record.state === "notSent") return cancel();
  if (REACHED_STATES.has(record.state) || record.state === "offered") {
    const at = new Date().toISOString();
    writeMessageRecord(program, record, record.state, `cancellation requested (${why}); it had reached the agent already, so nothing was removed`, { cancellationRequested: at });
    return { ...view(record.state), cancellationRequested: at };
  }
  // undelivered, or a state this CLI does not know: nothing to take back.
  return view(record.state);
}

// What `agent send` and `agent delivery` show of a record.
export function deliveryView(record) {
  if (!record) return undefined;
  const view = { messageId: record.id, mode: record.mode, state: record.state, to: record.task || record.pane, updatedAt: record.updatedAt };
  if (record.harness) view.harness = record.harness;
  if (record.turnId) view.turnId = record.turnId;
  if (record.reason) view.reason = record.reason;
  if (record.replyTo) view.replyTo = record.replyTo;
  if (record.late) view.late = true;
  if (record.supersedes) view.supersedes = record.supersedes;
  if (record.supersededBy) view.supersededBy = record.supersededBy;
  if (record.cancellationRequested) view.cancellationRequested = record.cancellationRequested;
  if (record.wake === false) view.wakes = false;
  if (record.state === "queued" && record.wake === false) {
    view.waiting = "it wakes nobody: it goes out with the next line typed into the agent's prompt";
  } else if (record.state === "queued") {
    const held = record.program && record.target ? deliveryState(record.program, record.target) : {};
    if (held.waiting) view.waiting = held.waiting;
    if (held.waitingSince) view.waitingSince = held.waitingSince;
  }
  return view;
}

// Types queued lines (file names in the pane's queue directory) into the agent's prompt as one
// line. Each is claimed first by renaming it to .sending, so a supervisor and a promote that run
// at once never type the same line, and its record says `typing` before a key is sent: a CLI that
// dies while typing leaves `typing` behind, which the next supervisor marks uncertain instead of
// typing it again. True when the line was typed.
export function typeQueuedLines(program, uuid, record, names, reminder) {
  const dir = path.join(program, ".queue", uuid);
  const claimed = [];
  for (const name of names) {
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, `${name}.sending`));
    } catch {
      continue; // Another process took it.
    }
    const entry = readQueued(path.join(dir, `${name}.sending`));
    if (!entry) {
      fs.rmSync(path.join(dir, `${name}.sending`), { force: true });
      continue;
    }
    claimed.push({ name, entry });
  }
  if (claimed.length === 0) return false;
  // Riders go with the first line that wakes the agent, after the lines themselves.
  for (const name of queueNames(program, uuid, RIDER_SUFFIX)) {
    try {
      fs.renameSync(path.join(dir, name), path.join(dir, `${name}.sending`));
    } catch {
      continue; // Cancelled, or taken by another process.
    }
    const entry = readQueued(path.join(dir, `${name}.sending`));
    if (entry) claimed.push({ name, entry });
    else fs.rmSync(path.join(dir, `${name}.sending`), { force: true });
  }
  for (const { entry } of claimed) updateMessageRecord(program, entry.id, "typing", `into pane ${record.paneID}`);
  const notes = queuedNotes(program, uuid);
  const line = deliveryLine(program, [...claimed.map(item => item.entry), ...notes.map(note => note.entry)], reminder);
  const hosted = hostsSession(record.paneID);
  const typed = hosted ? promptHosted(record.paneID, line) : runTMux(["send-keys", "-t", record.paneID, "-l", line]) !== undefined;
  if (typed && !hosted) {
    // The pane's ACP view (a Codex sharing its session live) shows the line with the turn it
    // starts: Codex does not pass on a prompt typed into its terminal.
    announceToView(record.paneID, line);
    // Some agent TUIs treat Enter that follows typed text too closely as part of a paste.
    spawnSync("sleep", ["0.6"]);
    runTMux(["send-keys", "-t", record.paneID, "Enter"]);
  }
  for (const { name, entry } of claimed) {
    const sending = path.join(dir, `${name}.sending`);
    if (typed) {
      updateMessageRecord(program, entry.id, "delivered", hosted
        ? `prompted through the ACP host of pane ${record.paneID}`
        : `typed into pane ${record.paneID} and submitted`);
      fs.rmSync(sending, { force: true });
    } else {
      // Nothing reached the pane: the line waits again.
      updateMessageRecord(program, entry.id, "queued", `tmux could not type into pane ${record.paneID}`);
      try {
        fs.renameSync(sending, path.join(dir, name));
      } catch {
        // Gone with its directory.
      }
    }
  }
  if (typed && notes.length > 0) {
    for (const note of notes) fs.rmSync(note.file, { force: true });
    writeStatusFile(program);
  }
  return typed;
}

// Claims left by a CLI that died while typing (older than a typing can take). The line may have
// reached the prompt, so it is set aside as uncertain, never typed a second time.
export const STALE_CLAIM_MS = 60000;

export function settleStaleClaims(program, uuid) {
  const dir = path.join(program, ".queue", uuid);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith(".sending"));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let age = 0;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_CLAIM_MS) continue;
    const entry = readQueued(file);
    const undelivered = path.join(program, ".queue", ".undelivered");
    fs.mkdirSync(undelivered, { recursive: true });
    fs.renameSync(file, path.join(undelivered, `${uuid}-${name}`));
    updateMessageRecord(program, entry?.id, "uncertain", "the CLI typing it stopped midway; it may have reached the prompt, so it is not typed again");
    supervisorLog(`set aside a line whose typing into ${uuid} did not finish`);
  }
}

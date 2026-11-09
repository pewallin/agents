// @ts-nocheck
// Questions a worker asks and their answers.

import fs from "node:fs";
import path from "node:path";
import { newMessageID, writeMessageRecord } from "./delivery.js";
import { enqueueMessage, wakeLine, wakeSummary } from "./messages.js";
import { ensurePaneUUID, readJSON, writeFileAtomic } from "./program.js";
import { setWorkerReportState } from "./report.js";
import { processAlive } from "./supervisor-control.js";

// Questions. A worker's question for its coordinator (`agent ask`, or `agent report --ask
// coordinator`) keeps a record under the id of the line that asks it, so an answer is threaded to
// it: `agent send --reply-to <id>`, or by itself when the worker has one open question for the
// sender. States:
//   open      asked, not answered yet
//   answered  an answer went to the worker: to its waiting `agent ask`, or queued or steered
//   closed    the worker reported done, or its pane closed, before an answer came
// A blocking `agent ask` leaves <id>.wait beside the record while it waits. The answering send
// claims it by renaming it, and the ask gives up by renaming it too, so only one of them wins: an
// answer either reaches the waiting ask or goes the usual way, never both and never neither.
export function questionsDirectory(program) {
  return path.join(program, ".run", "questions");
}

export function questionFile(program, id) {
  return path.join(questionsDirectory(program), `${id}.json`);
}

export function readQuestion(program, id) {
  return readJSON(questionFile(program, id), undefined);
}

export function writeQuestion(program, question) {
  fs.mkdirSync(questionsDirectory(program), { recursive: true });
  writeFileAtomic(questionFile(program, question.id), `${JSON.stringify(question, null, 2)}\n`);
  return question;
}

// A worker's questions, oldest first.
export function questionsOf(program, workerUUID) {
  let names = [];
  try {
    names = fs.readdirSync(questionsDirectory(program)).filter(name => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map(name => readJSON(path.join(questionsDirectory(program), name), undefined))
    .filter(question => question && question.from === workerUUID)
    .sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));
}

// The worker's open questions that a sender may answer: asked of it, or of the coordinator it
// took over from.
export function openQuestionsFor(program, target, own) {
  return questionsOf(program, target.uuid)
    .filter(question => question.state === "open" && (question.to === own.uuid || target.parent === own.uuid));
}

// Asks the worker's coordinator: the report says so, the question gets its record, and the
// coordinator gets the wake line, whose id is the question's.
export function recordQuestion(program, record, line, blocking) {
  const id = newMessageID();
  const askedAt = new Date().toISOString();
  record.uuid = ensurePaneUUID(record);
  writeQuestion(program, { id, task: record.task, from: record.uuid, to: record.parent, text: line, askedAt, blocking, state: "open" });
  enqueueMessage(program, record.parent, wakeLine(program, record.task, "ask-coordinator", line, record.parent, { questionId: id }), wakeSummary(record.task, "ask-coordinator"), id);
  writeMessageRecord(program, { id, program, target: record.parent, task: undefined, from: record.uuid, mode: "queue", question: true, createdAt: askedAt }, "queued", "the question, for the coordinator's prompt");
  return id;
}

export function closeOpenQuestions(program, workerUUID, reason) {
  if (!workerUUID) return;
  for (const question of questionsOf(program, workerUUID).filter(item => item.state === "open")) {
    writeQuestion(program, { ...question, state: "closed", closedAt: new Date().toISOString(), closedReason: reason });
  }
}

// An answer went to the worker: its row stops showing the question once none is open.
export function answerQuestion(program, question, target, answer) {
  writeQuestion(program, { ...question, state: "answered", answer: { ...answer, at: new Date().toISOString() } });
  const open = questionsOf(program, target.uuid).some(item => item.state === "open");
  if (target.reportState === "ask-coordinator" && !open) {
    setWorkerReportState(program, target, "progress", "The coordinator answered.", "coordinator");
  }
}

export function questionView(question) {
  if (!question) return undefined;
  return {
    id: question.id,
    text: question.text,
    state: question.state,
    askedAt: question.askedAt,
    answeredAt: question.answer?.at,
    answer: question.answer ? { messageId: question.answer.messageId, via: question.answer.via } : undefined,
    closedReason: question.closedReason,
  };
}

export function waitFile(program, id) {
  return path.join(questionsDirectory(program), `${id}.wait`);
}

// For an answering send: true when it took the claim of a blocking ask that still waits.
export function claimWaitingAsk(program, id) {
  const file = waitFile(program, id);
  const taken = `${file}.taken`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return false;
  }
  const wait = readJSON(taken, {});
  fs.rmSync(taken, { force: true });
  return processAlive(wait.pid) && Number(wait.until) > Date.now();
}

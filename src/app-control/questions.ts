// @ts-nocheck
// Questions a worker asks and their answers.

import fs from "node:fs";
import path from "node:path";
import { newMessageID, writeMessageRecord } from "./delivery.js";
import { enqueueMessage, wakeLine, wakeSummary } from "./messages.js";
import { ensurePaneUUID, readJSON, writeFileAtomic } from "./program.js";
import { setWorkerReportState } from "./report.js";
import { processAlive } from "./supervisor-control.js";

// Questions. A worker's question for its coordinator (`agent ask`) keeps a record under the id of
// the line that asks it, so an answer is threaded to it: `agent send --reply-to <id>`, or by
// itself when the worker has one open question for the sender. A question for the user (`agent
// ask --user`) has `to: "user"`: it wakes nobody, and closes with the user's next prompt in the
// worker's pane or view (the supervisor sees it), or a coordinator's answer. States:
//   open      asked, not answered yet
//   answered  an answer went to the worker: to its waiting `agent ask`, queued or steered, or the
//             user prompted it (`answer.via` "user")
//   closed    the worker reported done or its thread was resolved before an answer came; a
//             question for the coordinator also closes with the worker's pane. One for the user
//             outlasts the pane: reopening the thread shows it again.
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

// The worker's open questions that a sender answers without naming one: asked of it, or of the
// coordinator it took over from. A question for the user is answered by a coordinator only with
// --reply-to: a message on something else must not take it off the user's list.
export function openQuestionsFor(program, target, own) {
  return questionsOf(program, target.uuid)
    .filter(question => question.state === "open" && !isUserQuestion(question) && (question.to === own.uuid || target.parent === own.uuid));
}

// Asks the worker's coordinator: the report says so, the question gets its record, and the
// coordinator gets the wake line, whose id is the question's.
export function recordQuestion(program, record, line, blocking) {
  const id = newMessageID();
  const askedAt = new Date().toISOString();
  record.uuid = ensurePaneUUID(record);
  writeQuestion(program, { id, task: record.task, from: record.uuid, to: record.parent, text: line, askedAt, blocking, state: "open" });
  enqueueMessage(program, record.parent, wakeLine(program, record.task, "ask-coordinator", line, record.parent, { questionId: id }), wakeSummary(record.task, "ask-coordinator"), id, { event: { kind: "question", from: `worker:${record.task}`, thread: record.task } });
  writeMessageRecord(program, { id, program, target: record.parent, task: undefined, from: record.uuid, mode: "queue", question: true, createdAt: askedAt }, "queued", "the question, for the coordinator's prompt");
  return id;
}

// A question for the user: the worker's report says `ask-user` (writeOwnReport), and the record
// keeps the question until they answer. Nobody is woken: the app shows it to the user.
export function recordUserQuestion(program, record, line) {
  const id = newMessageID();
  record.uuid = ensurePaneUUID(record);
  writeQuestion(program, { id, task: record.task, from: record.uuid, to: "user", text: line, askedAt: new Date().toISOString(), blocking: false, state: "open" });
  return id;
}

export function isUserQuestion(question) {
  return question?.to === "user";
}

// A thread's open questions for the user, from whichever pane asked them: closed when its worker
// reports on past them, or the thread is resolved.
export function closeUserQuestions(program, task, reason) {
  if (!task) return;
  for (const question of (questionsByTask(program).get(task) || []).filter(item => item.state === "open" && isUserQuestion(item))) {
    writeQuestion(program, { ...question, state: "closed", closedAt: new Date().toISOString(), closedReason: reason });
  }
}

// `keepUser`: a pane that closes leaves the user's questions open; the thread still waits on them.
export function closeOpenQuestions(program, workerUUID, reason, { keepUser = false } = {}) {
  if (!workerUUID) return;
  const closes = item => item.state === "open" && !(keepUser && isUserQuestion(item));
  for (const question of questionsOf(program, workerUUID).filter(closes)) {
    writeQuestion(program, { ...question, state: "closed", closedAt: new Date().toISOString(), closedReason: reason });
  }
}

// Every question of a program, read once for a listing: by task, oldest first.
export function questionsByTask(program) {
  let names = [];
  try {
    names = fs.readdirSync(questionsDirectory(program)).filter(name => name.endsWith(".json"));
  } catch {
    return new Map();
  }
  const byTask = new Map();
  for (const question of names.map(name => readJSON(path.join(questionsDirectory(program), name), undefined))) {
    if (!question?.task) continue;
    byTask.set(question.task, [...(byTask.get(question.task) || []), question]);
  }
  for (const list of byTask.values()) list.sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));
  return byTask;
}

// The oldest question for the user a thread still waits on, with or without its pane.
export function openUserQuestion(questions) {
  return (questions || []).find(question => question.state === "open" && isUserQuestion(question));
}

// The report states a worker leaves when its last question is answered: the question it asked, or
// (a pane that closed while it waited) `closed`.
const ANSWERABLE_REPORTS = new Set(["ask-coordinator", "ask-user", "closed"]);

// An answer went to the worker: its row stops showing the question once none is open.
export function answerQuestion(program, question, target, answer) {
  writeQuestion(program, { ...question, state: "answered", answer: { ...answer, at: new Date().toISOString() } });
  const open = questionsOf(program, target.uuid).some(item => item.state === "open");
  if (ANSWERABLE_REPORTS.has(target.reportState) && !open) {
    setWorkerReportState(program, target, "progress", "The coordinator answered.", "coordinator");
  }
}

// The user prompted the worker (in its pane or its view) at `userAt`: each question for them asked
// before that is answered, and once none is open the worker's report says progress again. The
// questions answered; none when there was nothing to answer.
// By task, not pane: a thread reopened in a new pane answers what was asked in its old one.
export function answerUserQuestions(program, record, userAt) {
  if (!record?.task || !userAt) return [];
  const at = new Date().toISOString();
  const answered = (questionsByTask(program).get(record.task) || [])
    .filter(question => question.state === "open" && isUserQuestion(question) && (Date.parse(question.askedAt) || 0) < userAt);
  for (const question of answered) {
    writeQuestion(program, { ...question, state: "answered", answer: { via: "user", from: "user", at } });
  }
  if (answered.length === 0) return [];
  const open = (questionsByTask(program).get(record.task) || []).some(item => item.state === "open");
  if (ANSWERABLE_REPORTS.has(record.reportState) && !open) {
    setWorkerReportState(program, record, "progress", "The user answered.", "user");
    record.reportState = "progress";
  }
  return answered;
}

export function questionView(question) {
  if (!question) return undefined;
  return {
    id: question.id,
    text: question.text,
    state: question.state,
    askedAt: question.askedAt,
    answeredAt: question.answer?.at,
    to: isUserQuestion(question) ? "user" : undefined,
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

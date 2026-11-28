// @ts-nocheck
// An agent edits one of its own earlier answers (Projects and Threads, "Editing an answer"): the
// coordinator or a thread corrects a reply in place, as in Claude's project threads. The app does
// not say when or why. The edit is kept in the thread's record beside its session log, which stays
// an exact record of what the agent said (Show Session shows the original): a coordinator's in its
// conversation (<program>/thread.jsonl, an `edit` entry), a thread's in
// <program>/tasks/<task>/edits.jsonl. A view shows the new text where the answer was, with
// "edited" after its time; it finds the answer by its original text.
//
// An edit never notifies the user. A thread's edit wakes its coordinator with one short line, as
// any message in its threads does; the coordinator's own edit wakes nobody.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requestID } from "./app-socket.js";
import { appendThreadEdit, readThread } from "./conversation.js";
import { answerKey, editsFile } from "./answer-edits-store.js";

export { answerKey, editsFile, readAnswerEdits, shownEdits } from "./answer-edits-store.js";
import { enqueueMessage, THREAD_PREVIEW_LIMIT } from "./messages.js";
import { fail } from "./output.js";
import { ownCoordinationRecord, recordedCoordinatorProgram } from "./program.js";
import { oneLine } from "./processes.js";
import { readSessionLines, sessionsFile } from "./threads.js";
import { ensureSupervisor } from "./supervisor-control.js";
import { sessionLogEntries } from "../session-log.js";
import { shellQuote } from "./launch.js";

export const EDIT_TEXT_LIMIT = 64 * 1024;

/** A thread's answers to the user in its session logs, oldest first: per turn (a user line begins
 *  one), the agent's text after its last step, as the view takes a turn's answer (turns.ts). */
export function sessionLogAnswers(entries) {
  const answers = [];
  for (const entry of entries) {
    if (entry.missing) continue;
    let tail = [];
    let turnAt;
    const close = (endedAt) => {
      const text = tail.join("\n").trim();
      if (text) answers.push({ session: entry.session, at: endedAt || turnAt, text });
      tail = [];
    };
    for (const line of entry.lines) {
      if (line.kind === "user") { close(); turnAt = line.at; continue; }
      if (line.kind === "agent") { if (typeof line.text === "string") tail.push(line.text); continue; }
      if (line.kind === "turnEnd") { close(line.at); continue; }
      if (line.kind === "tool" || line.kind === "thought") tail = [];
    }
    close();
  }
  return answers;
}

/** The answers the pane's agent gave the user, oldest first, each with what an edit names it by. */
export function agentAnswers(program, role, task, { root } = {}) {
  if (role === "coordinator") {
    return readThread(program, { withReplies: true })
      .filter(entry => entry.kind === "turn" && entry.reply && entry.reply.trim())
      .map(entry => ({ turn: entry.id, at: entry.at, text: entry.reply }));
  }
  const sessions = readSessionLines(sessionsFile(program, task)).map(line => ({ session: line.session, via: line.via }));
  return sessionLogAnswers(sessionLogEntries(sessions, { root }));
}

/** Which answer an edit is for: the latest that holds `match` (any case, any spacing), else the
 *  `turn`th (1 the first, -1 the latest), else the latest. */
export function pickAnswer(answers, { match, turn } = {}) {
  if (answers.length === 0) return { error: "You have no answer to the user to edit yet." };
  if (match !== undefined && match !== true) {
    const wanted = answerKey(match).toLowerCase();
    if (!wanted) return { error: "--match needs words from the answer." };
    for (let index = answers.length - 1; index >= 0; index -= 1) {
      if (answerKey(answers[index].text).toLowerCase().includes(wanted)) return { answer: answers[index], number: index + 1 };
    }
    return { error: `None of your ${answers.length} answers holds "${oneLine(String(match), 80)}".` };
  }
  if (turn !== undefined && turn !== true) {
    const value = String(turn).trim().toLowerCase();
    const number = value === "last" ? -1 : Number(value);
    if (!Number.isInteger(number) || number === 0) return { error: "--turn is a number: 1 for your first answer, -1 (or last) for your latest, -2 the one before." };
    const index = number > 0 ? number - 1 : answers.length + number;
    if (index < 0 || index >= answers.length) return { error: `You have ${answers.length} answers; --turn ${turn} names none of them.` };
    return { answer: answers[index], number: index + 1 };
  }
  return { answer: answers[answers.length - 1], number: answers.length };
}

function appendTaskEdit(program, task, edit) {
  const file = editsFile(program, task);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(edit)}\n`, { mode: 0o600 });
}

/** The line that wakes a coordinator when one of its threads edits an answer. */
export function threadEditEvent(program, task, number, text) {
  const preview = oneLine(text || "", THREAD_PREVIEW_LIMIT);
  const summary = `Worker ${task} edited its answer ${number} to the user: "${preview}"`;
  return {
    summary,
    text: `${summary}. The user sees the new text where the old one was, marked edited; nobody was notified. The whole thread: agents session-log --task ${shellQuote(task)} --program ${shellQuote(program)} --json. If it changes nothing for you, end your turn without a reply.`,
    event: { kind: "thread", thread: task, from: `worker:${task}` },
  };
}

/**
 * Records an edit of one of the agent's answers. `record` is the pane's coordination record;
 * `answers` the answers it gave (agentAnswers). A thread's edit wakes its coordinator.
 */
export function editAnswer({ program, record, answers, text, match, turn, at = new Date() }) {
  const picked = pickAnswer(answers, { match, turn });
  if (picked.error) return { error: picked.error };
  const { answer, number } = picked;
  const id = `e-${at.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const edit = {
    kind: "edit",
    id,
    at: at.toISOString(),
    by: record.role === "coordinator" ? "coordinator" : "worker",
    ...(answer.turn ? { turn: answer.turn } : {}),
    ...(answer.session ? { session: answer.session } : {}),
    original: answer.text,
    text,
  };
  if (record.role === "coordinator") {
    appendThreadEdit(program, edit);
    return { edit, number, woke: false };
  }
  appendTaskEdit(program, record.task, edit);
  let woke = false;
  if (record.parent) {
    const event = threadEditEvent(program, record.task, number, text);
    enqueueMessage(program, record.parent, event.text, event.summary, undefined, { event: event.event });
    woke = true;
  }
  return { edit, number, woke };
}

function editText(command) {
  const params = command.params;
  if (params.file !== undefined) {
    try { return fs.readFileSync(path.resolve(String(params.file)), "utf8"); } catch { fail(2, "fileUnavailable", `Could not read ${params.file}.`); }
  }
  return command.text;
}

export async function runAgentEdit(command) {
  const params = command.params;
  const record = ownCoordinationRecord(params, "agent edit");
  let program;
  if (record.role === "coordinator") program = recordedCoordinatorProgram(record);
  else if (record.role === "worker" && record.task) program = record.program;
  if (!program) fail(2, "notThread", "Only a project's coordinator or one of its threads edits its answers.");
  const text = String(editText(command) || "").replace(/\r\n?/g, "\n").trim();
  if (!text) fail(64, "usage", "agent edit needs the answer's new text: agent edit \"<new text>\" [--match \"<words from the answer>\" | --turn <n>], or --file <file>.");
  if (Buffer.byteLength(text) > EDIT_TEXT_LIMIT) fail(64, "usage", `The new text is over ${EDIT_TEXT_LIMIT / 1024} KB.`);
  const answers = agentAnswers(program, record.role, record.task);
  const done = editAnswer({ program, record, answers, text, match: params.match, turn: params.turn });
  if (done.error) fail(2, "noAnswer", done.error);
  if (done.woke) ensureSupervisor(program);
  return {
    id: requestID("cli"),
    ok: true,
    result: {
      program,
      ...(record.task ? { task: record.task } : {}),
      edited: { number: done.number, of: answers.length, was: oneLine(done.edit.original, 120), at: done.edit.at },
      next: "The user sees the new text where that answer was, marked edited; nobody is notified. A new result or question still goes in a new answer, so the user sees it at the bottom.",
    },
  };
}

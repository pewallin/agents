// @ts-nocheck
// Questions for the user: recorded beside the coordinator's, answered by the user's prompt, kept
// when the pane closes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { answerUserQuestions, closeOpenQuestions, closeUserQuestions, openQuestionsFor, openUserQuestion, questionsByTask, readQuestion, recordUserQuestion, writeQuestion } from "./questions.js";

function newProgram() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "questions-test-"));
}

const worker = { task: "export", uuid: "11111111-1111-4111-8111-111111111111", parent: "22222222-2222-4222-8222-222222222222", paneID: "%1", reportState: "progress" };

test("a question for the user is answered by their prompt after it, not by one before", () => {
  const program = newProgram();
  const id = recordUserQuestion(program, { ...worker }, "Which bucket?");
  const asked = readQuestion(program, id);
  assert.equal(asked.to, "user");
  assert.equal(asked.state, "open");
  assert.equal(openUserQuestion(questionsByTask(program).get("export"))?.id, id);
  const askedAt = Date.parse(asked.askedAt);
  assert.deepEqual(answerUserQuestions(program, { ...worker }, askedAt - 1000), []);
  assert.deepEqual(answerUserQuestions(program, { ...worker }, 0), []);
  assert.equal(answerUserQuestions(program, { ...worker }, askedAt + 1000).length, 1);
  const answered = readQuestion(program, id);
  assert.equal(answered.state, "answered");
  assert.equal(answered.answer.via, "user");
  assert.equal(openUserQuestion(questionsByTask(program).get("export")), undefined);
});

test("a reopened thread's new pane answers the question its old pane asked", () => {
  const program = newProgram();
  const id = recordUserQuestion(program, { ...worker }, "Ship now?");
  const reopened = { ...worker, uuid: "33333333-3333-4333-8333-333333333333", paneID: "%9" };
  assert.equal(answerUserQuestions(program, reopened, Date.now() + 1000).length, 1);
  assert.equal(readQuestion(program, id).state, "answered");
});

test("a closing pane keeps the user's questions; done, resolve or a later report closes them", () => {
  const program = newProgram();
  const forUser = recordUserQuestion(program, { ...worker }, "Which bucket?");
  writeQuestion(program, { id: "c1", task: "export", from: worker.uuid, to: worker.parent, text: "Keep v1?", askedAt: new Date().toISOString(), state: "open" });
  closeOpenQuestions(program, worker.uuid, "its pane closed", { keepUser: true });
  assert.equal(readQuestion(program, forUser).state, "open");
  assert.equal(readQuestion(program, "c1").state, "closed");
  closeUserQuestions(program, "export", "the worker reported progress");
  assert.equal(readQuestion(program, forUser).state, "closed");
});

test("a coordinator's message on something else does not answer a question for the user", () => {
  const program = newProgram();
  recordUserQuestion(program, { ...worker }, "Which bucket?");
  const own = { uuid: worker.parent };
  assert.deepEqual(openQuestionsFor(program, worker, own), []);
  writeQuestion(program, { id: "c2", task: "export", from: worker.uuid, to: worker.parent, text: "Keep v1?", askedAt: new Date().toISOString(), state: "open" });
  assert.deepEqual(openQuestionsFor(program, worker, own).map(question => question.id), ["c2"]);
});

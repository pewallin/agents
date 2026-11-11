// Threads: session lists, derived states and the repair pass, on fake programs and transcripts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { writeTaskMeta } from "./briefs.js";
import { taskPaths } from "./program.js";
import {
  appendSessionLine, markResolved, markUnresolved, readSessionLines, recordTaskSession, reopenStep, repairProgram,
  resolvesOnClose, sessionsFile, threadState, transcriptRecords, userTexts,
} from "./threads.js";

function newProgram() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "threads-test-"));
}

function newTask(program: string, task: string, meta: Record<string, unknown> = {}) {
  const files = taskPaths(program, task);
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.brief, `# Task: ${task}\n\n## Brief\n\nDo ${task}.\n`);
  fs.writeFileSync(files.meta, JSON.stringify({ task, createdAt: "2026-11-01T10:00:00.000Z", spawns: 1, ...meta }));
  return files;
}

function workerPrompt(task: string, brief: string) {
  return `ROLE: worker. You were started by a coordinator for task "${task}". Read your brief at ${brief} and do the task.`;
}

test("a respawn keeps the thread's title and other fields, and opens a resolved thread again", () => {
  const program = newProgram();
  writeTaskMeta(program, "fix-export", { launchCommand: "claude", cwd: "/repo", title: "Fix Safari export button" });
  markResolved(program, "fix-export", "2026-11-02T10:00:00.000Z");
  const files = taskPaths(program, "fix-export");
  const before = JSON.parse(fs.readFileSync(files.meta, "utf8"));
  assert.equal(before.resolved, "2026-11-02T10:00:00.000Z");
  fs.writeFileSync(files.meta, JSON.stringify({ ...before, addedLater: 1 }));
  writeTaskMeta(program, "fix-export", { launchCommand: "codex", cwd: "/repo" });
  const after = JSON.parse(fs.readFileSync(files.meta, "utf8"));
  assert.equal(after.title, "Fix Safari export button");
  assert.equal(after.addedLater, 1);
  assert.equal(after.launchCommand, "codex");
  assert.equal(after.spawns, 2);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.resolved, undefined);
});

test("resolving keeps when it first happened; reopening clears it", () => {
  const program = newProgram();
  newTask(program, "a");
  markResolved(program, "a", "2026-11-02T10:00:00.000Z");
  markResolved(program, "a", "2026-11-03T10:00:00.000Z");
  assert.equal(JSON.parse(fs.readFileSync(taskPaths(program, "a").meta, "utf8")).resolved, "2026-11-02T10:00:00.000Z");
  markUnresolved(program, "a");
  assert.equal(JSON.parse(fs.readFileSync(taskPaths(program, "a").meta, "utf8")).resolved, undefined);
});

test("a thread's sessions: spawn, a new session in the same pane, a respawn in another, each once in a row", () => {
  const program = newProgram();
  newTask(program, "t", { cwd: "/repo" });
  assert.equal(recordTaskSession(program, "t", { agent: "codex", session: "019a-one", uuid: "pane-1" }), true);
  assert.equal(recordTaskSession(program, "t", { agent: "codex", session: "019a-one", uuid: "pane-1" }), false);
  assert.equal(recordTaskSession(program, "t", { agent: "claude", session: "c-two", uuid: "pane-1" }), true);
  assert.equal(recordTaskSession(program, "t", { agent: "kiro", session: "k-three", uuid: "pane-2" }), true);
  // A session can come back after another (a resume): a new line.
  assert.equal(recordTaskSession(program, "t", { agent: "codex", session: "019a-one", uuid: "pane-2" }), true);
  const lines = readSessionLines(sessionsFile(program, "t"));
  assert.deepEqual(lines.map(line => line.via), ["spawn", "changed", "respawn", "changed"]);
  assert.deepEqual(lines.map(line => line.session), ["019a-one", "c-two", "k-three", "019a-one"]);
  assert.equal(lines[0].cwd, "/repo");
  assert.equal(appendSessionLine(sessionsFile(program, "t"), { agent: "x", session: "bad id with spaces" }), false);
  assert.equal(recordTaskSession(program, "missing", { agent: "codex", session: "019a-one" }), false);
});

test("states: working, needs you, done (ready for review), stopped, resolved", () => {
  assert.equal(threadState({ live: true, agent: "working", reportState: "progress" }), "working");
  assert.equal(threadState({ live: true, agent: undefined, reportState: "started" }), "working");
  assert.equal(threadState({ live: true, agent: "idle", reportState: "ask-user" }), "needs-you");
  assert.equal(threadState({ live: true, agent: "idle", reportState: "blocked" }), "needs-you");
  assert.equal(threadState({ live: true, agent: "attention", reportState: "progress" }), "needs-you");
  assert.equal(threadState({ live: true, agent: "idle", reportState: "done" }), "done");
  assert.equal(threadState({ live: true, agent: "idle", reportState: "progress" }), "stopped");
  assert.equal(threadState({ live: false, reportState: "done" }), "done");
  assert.equal(threadState({ live: false, reportState: "blocked" }), "stopped");
  assert.equal(threadState({ live: false, reportState: "done", resolved: "2026-11-02T10:00:00Z" }), "resolved");
  // A pane shows what the thread does there, resolved or not.
  assert.equal(threadState({ live: true, agent: "working", reportState: "progress", resolved: "x" }), "working");
});

test("closing resolves a thread only while its worker's own last report is done", () => {
  assert.equal(resolvesOnClose({ state: "done", history: [{ state: "done", line: "Fixed" }] }), true);
  assert.equal(resolvesOnClose({ state: "progress", history: [{ state: "done", line: "Fixed" }, { state: "progress", line: "Working again.", by: "supervisor" }] }), false);
  assert.equal(resolvesOnClose({ state: "closed", history: [{ state: "progress", line: "Half way" }] }), false);
  assert.equal(resolvesOnClose(undefined), false);
});

test("reopen resumes the latest session with a transcript, else respawns from the brief, else reads", () => {
  const program = newProgram();
  const files = newTask(program, "t", { launchCommand: "claude --dangerously-skip-permissions" });
  const sessions = [
    { agent: "claude", session: "gone", transcript: null },
    { agent: "codex", session: "019a", transcript: "/x/rollout-019a.jsonl" },
  ];
  assert.equal(reopenStep({ launchCommand: "claude" }, sessions, files).step, "resume");
  assert.equal(reopenStep({ launchCommand: "claude" }, sessions, files).session, "019a");
  assert.equal(reopenStep({ launchCommand: "claude" }, [sessions[0]], files).step, "respawn");
  assert.equal(reopenStep({}, [sessions[0]], files).step, "read");
});

test("user texts leave out tool calls and their results", () => {
  const claudePrompt = { type: "user", message: { role: "user", content: "ROLE: worker. Read your brief at /p/tasks/a/brief.md" } };
  const claudeToolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ROLE: worker. Read your brief at /p/tasks/a/brief.md" }] }, toolUseResult: { stdout: "ROLE: worker /p/tasks/a/brief.md" } };
  const codexOutput = { type: "response_item", payload: { type: "function_call_output", output: "ROLE: worker /p/tasks/a/brief.md" } };
  const codexPrompt = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ROLE: worker /p/tasks/a/brief.md" }] } };
  assert.ok(userTexts(claudePrompt).some(text => text.includes("/p/tasks/a/brief.md")));
  assert.ok(!userTexts(claudeToolResult).some(text => text.includes("/p/tasks/a/brief.md")));
  assert.ok(!userTexts(codexOutput).some(text => text.includes("/p/tasks/a/brief.md")));
  assert.ok(userTexts(codexPrompt).some(text => text.includes("/p/tasks/a/brief.md")));
  // Kiro 2 keeps a session as one JSON document.
  assert.equal(transcriptRecords(JSON.stringify({ history: [{ user: { content: { Prompt: { prompt: "hi" } } } }] }, null, 2)).length, 1);
});

test("the repair pass finds each thread's sessions by its brief, its coordinators by the program, and resolves old tasks once", () => {
  const program = newProgram();
  const transcripts = fs.mkdtempSync(path.join(os.tmpdir(), "threads-transcripts-"));
  const export_ = newTask(program, "safari-export", { cwd: "/repo" });
  const perf = newTask(program, "measure-perf", { cwd: "/repo" });
  const live = newTask(program, "still-running", { cwd: "/repo" });
  // measure-perf reported, and its report points at a session.
  fs.writeFileSync(perf.reportJSON, JSON.stringify({ task: "measure-perf", state: "done", line: "Measured", updatedAt: "2026-11-05T12:00:00.000Z", session: { agent: "kiro", sessionId: "kiro-77", file: "/gone" }, history: [{ state: "done", line: "Measured" }] }));
  const files: Record<string, string> = {};
  const write = (agent: string, id: string, records: unknown[] | string) => {
    const file = path.join(transcripts, `${agent}-${id}.jsonl`);
    fs.writeFileSync(file, typeof records === "string" ? records : records.map(record => JSON.stringify(record)).join("\n"));
    files[`${agent}\t${id}`] = file;
  };
  // A Claude worker on safari-export, and a later Codex respawn of it.
  write("claude", "claude-c1", [
    { type: "user", message: { role: "user", content: workerPrompt("safari-export", export_.brief) } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
  ]);
  write("codex", "codex-x1", [
    { type: "session_meta", payload: { cwd: "/repo" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `ROLE: worker. You take over task "safari-export" from an earlier worker. Read your brief at ${export_.brief} and the earlier worker's report.` }] } },
  ]);
  // The coordinator: its line names the program; its spawn output names the brief, which is no
  // worker prompt of its own.
  write("claude", "claude-lead", [
    { type: "user", message: { role: "user", content: `[agents] You are now also the coordinator of this work. Read the coordinator protocol. Program directory: ${program}; run the CLI as agents-app-control.` } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: JSON.stringify({ launch: { command: `claude '${workerPrompt("safari-export", export_.brief)}'` } }) }] } },
  ]);
  // A session from before the tasks existed is not read.
  write("claude", "claude-old", [{ type: "user", message: { role: "user", content: workerPrompt("safari-export", export_.brief) } }]);
  const history = (agent: string) => ({
    claude: [
      { sessionId: "claude-c1", updatedAt: Date.parse("2026-11-02T10:00:00Z") / 1000 },
      { sessionId: "claude-lead", updatedAt: Date.parse("2026-11-03T10:00:00Z") / 1000 },
      { sessionId: "claude-old", updatedAt: Date.parse("2026-10-01T10:00:00Z") / 1000 },
    ],
    codex: [{ sessionId: "codex-x1", updatedAt: Date.parse("2026-11-04T10:00:00Z") / 1000 }],
  } as Record<string, unknown[]>)[agent] || [];
  const transcriptOf = (agent: string, id: string) => files[`${agent}\t${id}`];
  const records = [{ program, task: "still-running", paneID: "%3", role: "worker" }];
  const result = repairProgram(program, { history, transcriptOf, records, initial: true });
  assert.equal(result.sessions, 3);
  assert.equal(result.coordinatorSessions, 1);
  assert.equal(result.resolved, 2);
  assert.deepEqual(readSessionLines(sessionsFile(program, "safari-export")).map(line => `${line.agent}:${line.session}`), ["claude:claude-c1", "codex:codex-x1"]);
  assert.deepEqual(readSessionLines(sessionsFile(program, "measure-perf")).map(line => `${line.agent}:${line.session}`), ["kiro:kiro-77"]);
  assert.deepEqual(readSessionLines(path.join(program, "coordinators.jsonl")).map(line => line.session), ["claude-lead"]);
  assert.equal(JSON.parse(fs.readFileSync(perf.meta, "utf8")).resolved, "2026-11-05T12:00:00.000Z");
  assert.equal(JSON.parse(fs.readFileSync(export_.meta, "utf8")).resolved, "2026-11-01T10:00:00.000Z");
  assert.equal(JSON.parse(fs.readFileSync(live.meta, "utf8")).resolved, undefined);
  // Again: nothing new, and a later pass resolves nothing.
  markUnresolved(program, "safari-export");
  const again = repairProgram(program, { history, transcriptOf, records });
  assert.equal(again.sessions, 0);
  assert.equal(again.resolved, 0);
  assert.equal(JSON.parse(fs.readFileSync(export_.meta, "utf8")).resolved, undefined);
});

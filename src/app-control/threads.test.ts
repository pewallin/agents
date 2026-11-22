// Threads: session lists, derived states and the repair pass, on fake programs and transcripts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { writeTaskMeta } from "./briefs.js";
import { permissionSummary } from "./delivery.js";
import { programMeta, recordCoordinatorFolders, taskPaths } from "./program.js";
import {
  appendSessionLine, derivedTitle, folderPrograms, removeProgram, removeThread, threadWaitingOn, markResolved, markUnresolved, programThreads, titleWarning, readSessionLines, recordTaskSession, reopenStep, repairProgram,
  resolvesOnClose, sessionsFile, threadState, transcriptRecords, userTexts,
  isFinished, proposeClose, reopenedAfterDone, threadOutcome, threadRounds,
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
  // A question for the user outlasts its pane: the thread still needs them.
  assert.equal(threadState({ live: false, reportState: "closed", askingUser: true }), "needs-you");
  assert.equal(threadState({ live: true, agent: "idle", reportState: "closed", askingUser: true }), "needs-you");
  assert.equal(threadState({ live: false, reportState: "closed", askingUser: true, resolved: "2026-11-02T10:00:00Z" }), "resolved");
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

// Peter's Conversations on 2026-11-11: rows titled "ROLE: worker", a "_rollout" row from 2027
// years ago, and a Kiro worker's session left out of its thread.
test("a thread is titled by its title, else its brief's subject, never a worker prompt, else its task in words", () => {
  const program = newProgram();
  newTask(program, "titled", { title: "Fix Safari export button" });
  const role = newTask(program, "medium-tier-b-backend");
  fs.writeFileSync(role.brief, `# Task: medium-tier-b-backend\n\n## Brief\n\nROLE: worker. You were started by a coordinator for task "medium-tier-b-backend". Read your brief at ${role.brief}\n\nMove the medium tier's backend to the new queue.\n`);
  const onlyRole = newTask(program, "only-role");
  fs.writeFileSync(onlyRole.brief, `# Task: only-role\n\n## Brief\n\n[agents] ROLE: worker. Read your brief.\n`);
  newTask(program, "role-title", { title: "ROLE: worker" });
  const listed = programThreads(program, [], new Map(), () => null).threads;
  const title = (task: string) => listed.find(thread => thread.task === task)?.title;
  assert.equal(title("titled"), "Fix Safari export button");
  assert.equal(title("medium-tier-b-backend"), "Move the medium tier's backend to the new");
  assert.equal(title("only-role"), "Only role");
  assert.equal(title("role-title"), "Do role-title");
});

test("only task directories are threads, and a thread without times takes its folder's", () => {
  const program = newProgram();
  fs.mkdirSync(path.join(program, "tasks", "_rollout", "chunks"), { recursive: true });
  const bare = taskPaths(program, "no-times");
  fs.mkdirSync(bare.dir, { recursive: true });
  fs.writeFileSync(bare.brief, "# Task: no-times\n\n## Brief\n\nCheck the times.\n");
  const listed = programThreads(program, [], new Map(), () => null).threads;
  assert.deepEqual(listed.map(thread => thread.task), ["no-times"]);
  assert.ok(Date.parse(listed[0].updatedAt) > Date.parse("2026-01-01"), listed[0].updatedAt);
});

test("the repair pass finds a worker whose prompt names its brief through another path to the program", () => {
  const program = newProgram();
  const transcripts = fs.mkdtempSync(path.join(os.tmpdir(), "threads-kiro-"));
  newTask(program, "medium-tier-b-backend", { cwd: "/code" });
  // Kiro 3's messages.jsonl, the prompt naming the program by a symlinked home.
  const other = `/Users/peter/.agents/programs/${path.basename(program)}/tasks/medium-tier-b-backend/brief.md`;
  const file = path.join(transcripts, "messages.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ id: "1", payload: { type: "user", content: workerPrompt("medium-tier-b-backend", other) } })}\n`);
  const history = (agent: string) => agent === "kiro" ? [{ sessionId: "sess_5f0c1b8e-7a3f-4c2e-9b1d-0e6f2a4c8d10", updatedAt: Date.parse("2026-11-10T12:00:00Z") / 1000 }] : [];
  const result = repairProgram(program, { history, transcriptOf: () => file });
  assert.equal(result.sessions, 1);
  assert.deepEqual(readSessionLines(sessionsFile(program, "medium-tier-b-backend")).map(line => line.session), ["sess_5f0c1b8e-7a3f-4c2e-9b1d-0e6f2a4c8d10"]);
});

// Peter's thread list at work (2026-11-12): titles that were the brief's first line, "Goal: …".
test("a title made from a brief drops its label and stops at the first clause, eight words at most", () => {
  assert.equal(derivedTitle("Goal: follow-up after Peter merged all 11 MRs from the Medium triage (2026-11-10 ~16:14 CET). Verify, …"), "Follow-up after Peter merged all 11 MRs from");
  assert.equal(derivedTitle("Goal (phase 1 of a larger triage): build one complete, deduplicated inventory of all MEDIUM and LOW vuln…"), "Build one complete, deduplicated inventory of all MEDIUM");
  assert.equal(derivedTitle("Task: fix the Safari export button; keep the old path for Chrome"), "Fix the Safari export button");
  assert.equal(derivedTitle("Mål: gör om README — kortare och tydligare"), "Gör om README");
  assert.equal(derivedTitle("objective: add a restore test for Kiro. Then pin it."), "Add a restore test for Kiro");
  assert.equal(derivedTitle("Uppgift (fas 2): mät kallstarten"), "Mät kallstarten");
  assert.deepEqual(titleWarning("Fix Safari export button"), {});
  assert.equal(titleWarning("Follow up after Peter merged all eleven MRs from the triage").titleLong, true);
});

test("a permission in an agent's screen in a few words: Claude Code's prompt, Codex's command, a bare question", () => {
  const claude = [
    "⏺ I'll push the branch now.",
    "────────────────────────────────────────────",
    " Bash command",
    "",
    "   git push origin main",
    "   Push the release commit",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for git push commands in /repo",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
  assert.equal(permissionSummary(claude), "Bash command: git push origin main");
  const boxed = ["╭──────────────────────╮", "│ Edit file            │", "│ src/app.ts           │", "│ Do you want to make this edit? │", "│ ❯ 1. Yes │", "╰──────────────────────╯"].join("\n");
  assert.equal(permissionSummary(boxed), "Edit file: src/app.ts");
  const codex = ["  Would you like to run the following command?", "", "  Reason: push the fix", "", "  $ git push origin main", "", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)"].join("\n");
  assert.equal(permissionSummary(codex), "git push origin main");
  assert.equal(permissionSummary(["──────", "Allow this action?", "❯ 1. Yes", "  2. No"].join("\n")), "Allow this action?");
  assert.equal(permissionSummary("❯ ready for input"), undefined);
});

test("a thread that needs you says what it waits on: the question for the user, else the blocker, else the permission", () => {
  const report = { line: "Working again.", history: [
    { at: "1", state: "ask-user", line: "Ship to TestFlight now or after the review?" },
    { at: "2", state: "progress", line: "Working again.", by: "supervisor" },
  ] };
  assert.deepEqual(threadWaitingOn("ask-user", report, undefined, ""), { kind: "question", text: "Ship to TestFlight now or after the review?", since: "1" });
  // The question's record names it, and when it was asked.
  const question = { id: "q1", text: "Which bucket?", askedAt: "2026-11-22T10:00:00.000Z", to: "user", state: "open" };
  assert.deepEqual(threadWaitingOn("ask-user", report, undefined, "", question), { kind: "question", id: "q1", text: "Which bucket?", since: "2026-11-22T10:00:00.000Z" });
  // A permission waits since its agent's hooks said so.
  assert.equal(threadWaitingOn("progress", report, { status: "attention" }, "", undefined, { state: "approval", ts: 1700000000 }).since, "2023-11-14T22:13:20.000Z");
  assert.equal(threadWaitingOn("progress", report, { status: "attention" }, "", undefined, { state: "working", ts: 1700000000 }).since, undefined);
  assert.deepEqual(threadWaitingOn("blocked", { line: "No access to the staging database." }, undefined, ""), { kind: "blocker", text: "No access to the staging database." });
  const screen = ["─────", "Bash command", "  git push origin main", "Do you want to proceed?", "❯ 1. Yes"].join("\n");
  assert.deepEqual(threadWaitingOn("progress", report, { status: "attention" }, screen), { kind: "permission", text: "Waiting for permission: Bash command: git push origin main" });
  // An ACP view's host names the tool call where the pane's screen shows none.
  assert.deepEqual(threadWaitingOn("progress", report, { status: "attention", detail: "git push origin main" }, ""), { kind: "permission", text: "Waiting for permission: git push origin main" });
  assert.deepEqual(threadWaitingOn("progress", report, { status: "attention" }, ""), { kind: "permission", text: "Waiting for permission" });
  assert.deepEqual(threadWaitingOn("progress", report, { status: "question", detail: "Which branch should I use?" }, ""), { kind: "question", text: "Which branch should I use?" });
});

test("a removed thread or program is deleted and leaves the list", () => {
  const program = newProgram();
  newTask(program, "a");
  newTask(program, "b");
  removeThread(program, "a");
  assert.equal(fs.existsSync(taskPaths(program, "a").dir), false);
  assert.deepEqual(programThreads(program, [], new Map(), () => null).threads.map(entry => entry.task), ["b"]);
  removeProgram(program);
  assert.equal(fs.existsSync(program), false);
});

test("a folder lists only the programs made for it, never one whose workers ran in it or below it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "threads-home-"));
  const previous = process.env.AGENTS_SHARED_HOME;
  process.env.AGENTS_SHARED_HOME = home;
  try {
    const programs = path.join(home, "programs");
    const made = (name: string, folder?: string) => {
      const program = path.join(programs, name);
      fs.mkdirSync(program, { recursive: true });
      if (folder) fs.writeFileSync(path.join(program, "program.json"), JSON.stringify({ folder }));
      return program;
    };
    const agents = made("agents", "/code/agents");
    const product = made("product-master", "/code/product");
    // A worker of the product's coordinator ran in the agents repository.
    newTask(product, "touch-agents", { cwd: "/code/agents" });
    // A program from before programs had folders, whose workers ran in the agents repository.
    const old = made("product-old");
    newTask(old, "touch-agents", { cwd: "/code/agents/sub" });
    assert.deepEqual(folderPrograms("/code/agents"), [agents]);
    assert.deepEqual(folderPrograms("/code"), []);
    assert.deepEqual(folderPrograms("/code/product"), [product]);

    // Its coordinator gives the old program the folder it works in; then it lists there.
    recordCoordinatorFolders(
      [{ paneID: "%1", role: "coordinator", program: old }, { paneID: "%2", role: "worker", program: agents }],
      record => (record.paneID === "%1" ? { folder: "/code/product" } : { folder: "/elsewhere" }),
    );
    assert.equal(programMeta(old).folder, "/code/product");
    assert.equal(programMeta(agents).folder, "/code/agents");
    assert.deepEqual(folderPrograms("/code/product"), [product, old]);
    assert.deepEqual(folderPrograms("/code/agents"), [agents]);
  } finally {
    if (previous === undefined) delete process.env.AGENTS_SHARED_HOME;
    else process.env.AGENTS_SHARED_HOME = previous;
  }
});

test("a resolved thread keeps how it ended; reopening takes the outcome and any proposal away", () => {
  const program = newProgram();
  newTask(program, "a");
  proposeClose(program, "a", "The PR is merged");
  const meta = () => JSON.parse(fs.readFileSync(taskPaths(program, "a").meta, "utf8"));
  assert.equal(meta().proposedClose.why, "The PR is merged");
  markResolved(program, "a", "2026-11-22T10:00:00.000Z", { kind: "dropped", why: "  Not needed\n any more ", who: "user" });
  assert.deepEqual(meta().outcome, { kind: "dropped", at: "2026-11-22T10:00:00.000Z", why: "Not needed any more", who: "user" });
  assert.equal(meta().proposedClose, undefined);
  // Resolving again keeps the first outcome.
  markResolved(program, "a", "2026-11-23T10:00:00.000Z", { kind: "done", who: "coordinator" });
  assert.equal(meta().outcome.kind, "dropped");
  markUnresolved(program, "a");
  assert.equal(meta().outcome, undefined);
  assert.equal(meta().resolved, undefined);
  assert.deepEqual(threadOutcome({ kind: "replaced", by: "b", who: "user" }, "t"), { kind: "replaced", at: "t", by: "b", who: "user" });
  assert.throws(() => threadOutcome({ kind: "maybe" }));
});

test("work after done is a visible reopen, and the done before it an earlier round", () => {
  const done = { at: "1", state: "done", line: "PR is up" };
  const report = { state: "done", history: [{ at: "0", state: "progress", line: "Working" }, done] };
  assert.equal(isFinished(report), true);
  assert.equal(threadRounds(report), 1);
  assert.equal(resolvesOnClose(report), true);
  const reopened = { ...report, history: [...report.history, { at: "2", state: "reopened", line: "Reopened by coordinator: also iOS", by: "coordinator" }] };
  assert.equal(reopenedAfterDone(reopened).by, "coordinator");
  assert.equal(isFinished(reopened), false);
  assert.equal(resolvesOnClose(reopened), false);
  const again = { ...reopened, history: [...reopened.history, { at: "3", state: "done", line: "iOS too" }] };
  assert.equal(reopenedAfterDone(again), undefined);
  assert.equal(isFinished(again), true);
  assert.equal(threadRounds(again), 2);
});

test("a thread lists its outcome, a proposal to close it, its rounds and its reopen", () => {
  const program = newProgram();
  const files = newTask(program, "a");
  fs.writeFileSync(files.reportJSON, JSON.stringify({ task: "a", state: "done", line: "Done", history: [{ at: "2026-11-22T10:00:00.000Z", state: "done", line: "Done" }] }));
  proposeClose(program, "a", "Merged and released");
  let entry = programThreads(program, [], new Map(), () => null).threads[0];
  assert.equal(entry.state, "done");
  assert.equal(entry.proposedClose.why, "Merged and released");
  assert.equal(entry.rounds, 1);
  assert.equal(entry.outcome, undefined);
  fs.writeFileSync(files.reportJSON, JSON.stringify({ task: "a", state: "done", line: "Done", history: [
    { at: "2026-11-22T10:00:00.000Z", state: "done", line: "Done" },
    { at: "2026-11-22T11:00:00.000Z", state: "reopened", line: "Reopened by coordinator: one more", by: "coordinator" },
  ] }));
  entry = programThreads(program, [], new Map(), () => null).threads[0];
  // Reopened, not yet at work again: no longer done.
  assert.equal(entry.state, "stopped");
  assert.deepEqual(entry.reopened, { at: "2026-11-22T11:00:00.000Z", by: "coordinator", line: "Reopened by coordinator: one more" });
  markResolved(program, "a", undefined, { kind: "done", who: "user" });
  entry = programThreads(program, [], new Map(), () => null).threads[0];
  assert.equal(entry.state, "resolved");
  assert.equal(entry.outcome.kind, "done");
  assert.equal(entry.proposedClose, undefined);
});

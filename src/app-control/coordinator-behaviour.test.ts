// Coordinator behaviour in a project (Projects and Threads, step 6): per-turn notify (R7), titles
// in the user's language with a hidden slug (C7), quiet-thread close proposals (P8) and project
// memory from every thread (M1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerGuideLines } from "./briefs.js";
import { appendThreadTurn, markTurnNotify, notifyOptionValue, pendingTurnNotify, takeTurnNotify, threadUpdates, type ThreadEntry } from "./conversation.js";
import { slug, taskPaths, uniqueTaskName } from "./program.js";
import { quietThreadLine, quietThreadMs, threadActivityAt, wakeForQuietThreads } from "./quiet-threads.js";
import { proposeClose, titleSeed } from "./threads.js";

let program: string;
beforeEach(() => { program = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-behaviour-")); });
afterEach(() => { fs.rmSync(program, { recursive: true, force: true }); });

function newTask(task: string, meta: Record<string, unknown> = {}, report?: Record<string, unknown>) {
  const files = taskPaths(program, task);
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.brief, `# Task: ${task}\n\n## Brief\n\nDo ${task}.\n`);
  fs.writeFileSync(files.meta, JSON.stringify({ task, createdAt: "2026-11-01T10:00:00.000Z", spawns: 1, ...meta }));
  if (report) fs.writeFileSync(files.reportJSON, JSON.stringify({ task, outputs: [], history: [], ...report }));
  return files;
}

function queued(uuid: string) {
  const dir = path.join(program, ".queue", uuid);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  } catch {
    return [];
  }
}

describe("a turn notifies only when the coordinator marks it (R7)", () => {
  it("is taken by the turn it was marked in, once", () => {
    const startedAt = new Date("2026-11-27T10:00:00.000Z");
    markTurnNotify(program, { text: "  auth-fix is done\nand its PR is up ", why: "done" }, new Date("2026-11-27T10:00:05.000Z"));
    expect(pendingTurnNotify(program)).toEqual({ at: "2026-11-27T10:00:05.000Z", why: "done", text: "auth-fix is done and its PR is up" });
    expect(takeTurnNotify(program, startedAt)).toEqual({ why: "done", text: "auth-fix is done and its PR is up" });
    expect(takeTurnNotify(program, startedAt)).toBeUndefined();
    expect(pendingTurnNotify(program)).toBeUndefined();
  });

  it("does not carry a mark from an earlier turn into a later one", () => {
    markTurnNotify(program, { text: "Waits on you" }, new Date("2026-11-27T09:00:00.000Z"));
    expect(takeTurnNotify(program, new Date("2026-11-27T10:00:00.000Z"))).toBeUndefined();
    expect(pendingTurnNotify(program)).toBeUndefined();
  });

  it("keeps the choice on the turn, and says it to the app with the turn's id", () => {
    const turn = appendThreadTurn(program, { startedAt: "2026-11-27T10:00:00.000Z", how: { start: "continue" }, reply: "auth-fix är klar.", notify: { why: "done", text: "auth-fix är klar" } });
    expect(turn.notify).toEqual({ why: "done", text: "auth-fix är klar" });
    expect(JSON.parse(notifyOptionValue(turn.id, turn.at, turn.notify!))).toEqual({ turn: turn.id, at: turn.at, why: "done", text: "auth-fix är klar" });
    expect(JSON.parse(notifyOptionValue(undefined, "2026-11-27T10:00:00.000Z", { text: "x" }))).toEqual({ at: "2026-11-27T10:00:00.000Z", text: "x" });
  });

  it("never shows a wake that ended with nothing to say (C1, C4)", () => {
    const entries: ThreadEntry[] = [
      { kind: "turn", id: "t-1", at: "2026-11-27T10:00:10.000Z", startedAt: "2026-11-27T10:00:00.000Z", how: { start: "continue" }, wokeBy: "Worker a stopped", steps: ["Read report"] },
      { kind: "turn", id: "t-2", at: "2026-11-27T10:01:10.000Z", startedAt: "2026-11-27T10:01:00.000Z", how: { start: "continue" }, wokeBy: "Worker a is done", reply: "a är klar." },
      { kind: "message", id: "m-1", at: "2026-11-27T10:02:00.000Z", from: "user", text: "Och b?" },
      { kind: "turn", id: "t-3", at: "2026-11-27T10:02:10.000Z", startedAt: "2026-11-27T10:02:00.000Z", how: { start: "continue" }, steps: ["agent status"] },
    ];
    const updates = threadUpdates(entries);
    expect(updates.some((update) => JSON.stringify(update).includes("Worker a stopped"))).toBe(false);
    expect(updates.some((update) => JSON.stringify(update).includes("Read report"))).toBe(false);
    expect(updates.some((update) => JSON.stringify(update).includes("Worker a is done"))).toBe(true);
    // A turn the user's message began stays, answer or not.
    expect(updates.some((update) => JSON.stringify(update).includes("agent status"))).toBe(true);
  });
});

describe("a thread's task name is a hidden slug of its title (C7)", () => {
  it("makes ASCII of a title in any language", () => {
    expect(slug("Bygg tjänsteskelett för WI-03")).toBe("bygg-tjansteskelett-for-wi-03");
    expect(slug("Ærø færge-økonomi")).toBe("aero-faerge-okonomi");
    expect(slug("Straße prüfen")).toBe("strasse-prufen");
  });

  it("takes the title over the brief, and a free name when the slug is taken", () => {
    expect(titleSeed({ title: "Fixa Safaris exportknapp" }, "Goal: the export button does nothing")).toBe("Fixa Safaris exportknapp");
    expect(titleSeed({}, "Goal: the export button")).toBe("Goal: the export button");
    expect(titleSeed({ title: true }, "brief")).toBe("brief");
    expect(uniqueTaskName("Fixa Safaris exportknapp", [], program, undefined)).toBe("fixa-safaris-exportknapp");
    newTask("fixa-safaris-exportknapp");
    expect(uniqueTaskName("Fixa Safaris exportknapp", [], program, undefined)).toBe("fixa-safaris-exportknapp-2");
  });
});

describe("quiet threads get a close proposal (P8)", () => {
  const coordinator = { paneID: "%1", uuid: "c-1", program: "", role: "coordinator", task: "", reportAt: 0 };
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-27T12:00:00.000Z");

  it("are two days without activity", () => {
    expect(quietThreadMs()).toBe(2 * day);
    const files = newTask("a", {}, { state: "progress", updatedAt: "2026-11-24T10:00:00.000Z", history: [{ at: "2026-11-25T10:00:00.000Z", state: "progress", line: "x" }] });
    const row = { task: "a", files, meta: JSON.parse(fs.readFileSync(files.meta, "utf8")), report: JSON.parse(fs.readFileSync(files.reportJSON, "utf8")) };
    expect(threadActivityAt(program, row)).toBe(Date.parse("2026-11-25T10:00:00.000Z"));
    const live = { uuid: "w-1", reportAt: Date.parse("2026-11-26T10:00:00.000Z") / 1000 };
    expect(threadActivityAt(program, row, { live, deliveredAt: () => Date.parse("2026-11-27T08:00:00.000Z") })).toBe(Date.parse("2026-11-27T08:00:00.000Z"));
  });

  it("wake the coordinator once per quiet spell, never for a resolved, proposed or working thread", () => {
    const records = [{ ...coordinator, program }, { paneID: "%5", uuid: "w-busy", program, role: "worker", task: "busy", reportAt: 0 }];
    newTask("quiet", { title: "Bygg tjänsteskelett" }, { state: "progress", line: "Halfway", updatedAt: "2026-11-24T10:00:00.000Z" });
    newTask("recent", {}, { state: "progress", updatedAt: "2026-11-26T10:00:00.000Z" });
    newTask("resolved", { resolved: "2026-11-25T10:00:00.000Z" }, { state: "done", updatedAt: "2026-11-20T10:00:00.000Z" });
    newTask("proposed", {}, { state: "done", updatedAt: "2026-11-20T10:00:00.000Z" });
    proposeClose(program, "proposed", "Merged");
    newTask("busy", {}, { state: "progress", updatedAt: "2026-11-20T10:00:00.000Z" });
    const notified: Record<string, unknown> = {};
    const options = { now, notified, leads: (record: { role: string }) => record.role === "coordinator", isWorker: (record: { role: string }) => record.role === "worker", statusOf: (pane: string) => (pane === "%5" ? "working" : undefined) };
    expect(wakeForQuietThreads(program, records, options)).toEqual(["quiet"]);
    const lines = queued("c-1");
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toMatchObject({ kind: "wake", thread: "quiet" });
    expect(lines[0].text).toContain("agent resolve quiet --propose");
    expect(lines[0].text).toContain("--as dropped");
    expect(lines[0].text).toContain("Bygg tjänsteskelett");
    // Told once for this quiet spell, whatever the supervisor does next.
    expect(wakeForQuietThreads(program, records, options)).toEqual([]);
    // Without a coordinator that leads the program nobody is told, and it is told later.
    expect(wakeForQuietThreads(program, [], { ...options, notified: {} })).toEqual([]);
  });

  it("say how to propose it as done or as dropped", () => {
    const line = quietThreadLine(program, "quiet", "Bygg tjänsteskelett", 3, "Halfway there");
    expect(line).toMatch(/^Thread quiet \("Bygg tjänsteskelett"\) has had no activity for 3 days\. Its last report: "Halfway there"\./);
    expect(line).toContain("end your turn without a reply");
  });

  it("are proposed with how they close", () => {
    newTask("x");
    proposeClose(program, "x", "Ingen rörelse på två dagar", "2026-11-27T12:00:00.000Z", "dropped");
    expect(JSON.parse(fs.readFileSync(taskPaths(program, "x").meta, "utf8")).proposedClose).toEqual({ why: "Ingen rörelse på två dagar", at: "2026-11-27T12:00:00.000Z", as: "dropped" });
  });
});

describe("every thread keeps the project's memory (M1)", () => {
  it("is told so in WORKER.md, and never to change the screen", () => {
    const text = workerGuideLines(program, "agents-app-control").join("\n");
    expect(text).toContain("## Project memory");
    expect(text).toContain(path.join(program, "MEMORY.md"));
    expect(text).toMatch(/in the user's language, one subject per section/);
    expect(text).not.toMatch(/open a file or preview for the user, split a pane/);
  });
});

// An agent edits one of its own earlier answers (Projects and Threads, "Editing an answer").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAnswers, editAnswer, editsFile, pickAnswer, readAnswerEdits, sessionLogAnswers, shownEdits, threadEditEvent } from "./answer-edits.js";
import { workerGuideLines } from "./briefs.js";
import { appendThreadMessage, appendThreadTurn, readThread, threadUpdates } from "./conversation.js";
import { mcpArguments, MCP_TOOLS } from "./mcp.js";
import { taskPaths } from "./program.js";

let program: string;
beforeEach(() => { program = fs.mkdtempSync(path.join(os.tmpdir(), "answer-edits-")); });
afterEach(() => { fs.rmSync(program, { recursive: true, force: true }); });

function queued(uuid: string) {
  const dir = path.join(program, ".queue", uuid);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  } catch {
    return [];
  }
}

const line = (n: number, kind: string, extra: Record<string, unknown> = {}) => ({ v: 1, n, at: `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`, kind, ...extra });

describe("a thread's answers, from its session logs", () => {
  it("are per turn the agent's text after its last step", () => {
    const answers = sessionLogAnswers([{ session: "s1", lines: [
      line(1, "start"),
      line(2, "user", { text: "Bygg TEST-steget" }),
      line(3, "agent", { text: "Jag tittar först." }),
      line(4, "tool", { id: "t1", title: "Read deploy.yml" }),
      line(5, "agent", { text: "Klart: steget är skrivet." }),
      line(6, "agent", { text: "PR:en är uppe." }),
      line(7, "turnEnd"),
      line(8, "user", { text: "Kör testerna" }),
      line(9, "tool", { id: "t2", title: "npm test" }),
      line(10, "turnEnd"),
      line(11, "user", { text: "Och?" }),
      line(12, "agent", { text: "Alla gröna." }),
    ] }, { session: "s0", missing: true, lines: [] }]);
    expect(answers).toEqual([
      { session: "s1", at: "2026-11-28T10:00:07.000Z", text: "Klart: steget är skrivet.\nPR:en är uppe." },
      { session: "s1", at: "2026-11-28T10:00:11.000Z", text: "Alla gröna." },
    ]);
  });

  it("are picked by words from them, by number, or the latest", () => {
    const answers = [{ text: "Första svaret om login" }, { text: "Andra svaret" }, { text: "Tredje  svaret om\nlogin" }];
    expect(pickAnswer(answers, {})).toMatchObject({ number: 3 });
    expect(pickAnswer(answers, { match: "SVARET OM login" })).toMatchObject({ number: 3 });
    expect(pickAnswer(answers, { match: "andra" })).toMatchObject({ number: 2 });
    expect(pickAnswer(answers, { turn: "1" })).toMatchObject({ number: 1 });
    expect(pickAnswer(answers, { turn: "-2" })).toMatchObject({ number: 2 });
    expect(pickAnswer(answers, { turn: "last" })).toMatchObject({ number: 3 });
    expect(pickAnswer(answers, { turn: "4" }).error).toMatch(/You have 3 answers/);
    expect(pickAnswer(answers, { match: "deploy" }).error).toMatch(/None of your 3 answers/);
    expect(pickAnswer([], {}).error).toMatch(/no answer/);
  });
});

describe("the coordinator edits its own answer", () => {
  it("keeps the turn as said, shows the new text to the next session, and wakes nobody", () => {
    appendThreadMessage(program, { text: "Hur går det?" });
    const turn = appendThreadTurn(program, { startedAt: "2026-11-28T10:00:00.000Z", how: { start: "continue" }, reply: "auth-fix är klar." });
    const record = { role: "coordinator", paneID: "%1", uuid: "c-1" };
    const answers = agentAnswers(program, "coordinator", undefined);
    expect(answers).toEqual([{ turn: turn.id, at: turn.at, text: "auth-fix är klar." }]);
    const done = editAnswer({ program, record, answers, text: "auth-fix är klar, men CI är röd.", at: new Date("2026-11-28T11:00:00.000Z") });
    expect(done).toMatchObject({ number: 1, woke: false });
    // The view draws the conversation as said; it finds the answer by that text and shows the edit.
    expect(JSON.stringify(threadUpdates(readThread(program, { withReplies: true })))).toContain("auth-fix är klar.\"");
    expect(shownEdits(readAnswerEdits(program))).toEqual([{ original: "auth-fix är klar.", text: "auth-fix är klar, men CI är röd.", at: "2026-11-28T11:00:00.000Z" }]);
    expect(readThread(program, { withReplies: true, withEdits: true }).at(-1)).toMatchObject({ reply: "auth-fix är klar, men CI är röd.", edited: "2026-11-28T11:00:00.000Z" });
    expect(readThread(program)).toHaveLength(2);
    expect(fs.existsSync(path.join(program, ".queue"))).toBe(false);
  });
});

describe("a thread edits its own answer", () => {
  it("keeps the edit beside its session log and wakes its coordinator with one short line", () => {
    fs.mkdirSync(taskPaths(program, "fix").dir, { recursive: true });
    const record = { role: "worker", task: "fix", paneID: "%5", uuid: "w-1", parent: "c-1", program };
    const answers = [{ session: "s1", text: "Inloggningen fungerar igen." }, { session: "s1", text: "PR:en är mergad." }];
    const done = editAnswer({ program, record, answers, text: "Inloggningen fungerar igen, utom med SSO.", match: "inloggningen", at: new Date("2026-11-28T11:00:00.000Z") });
    expect(done).toMatchObject({ number: 1, woke: true });
    const [edit] = readAnswerEdits(program, "fix");
    expect(edit).toMatchObject({ kind: "edit", by: "worker", session: "s1", original: "Inloggningen fungerar igen.", text: "Inloggningen fungerar igen, utom med SSO." });
    expect(fs.existsSync(editsFile(program, "fix"))).toBe(true);
    const lines = queued("c-1");
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toMatchObject({ kind: "thread", thread: "fix", from: "worker:fix" });
    expect(lines[0].text).toContain("Worker fix edited its answer 1 to the user: \"Inloggningen fungerar igen, utom med SSO.\"");
    expect(lines[0].text).toContain("nobody was notified");
    // A later edit of the same answer replaces the earlier one on the page.
    editAnswer({ program, record, answers, text: "Fungerar, även med SSO.", turn: "1", at: new Date("2026-11-28T12:00:00.000Z") });
    expect(shownEdits(readAnswerEdits(program, "fix"))).toEqual([{ original: "Inloggningen fungerar igen.", text: "Fungerar, även med SSO.", at: "2026-11-28T12:00:00.000Z" }]);
  });

  it("says in its wake line which thread and answer, with the start of the new text", () => {
    const event = threadEditEvent("/p", "fix", 2, `Ny text ${"x".repeat(400)}`);
    expect(event.summary).toMatch(/^Worker fix edited its answer 2 to the user: "Ny text x+…"$/);
    expect(event.text).toContain("end your turn without a reply");
  });
});

describe("agents learn that they may edit (prompts only name the tool)", () => {
  it("is in WORKER.md and the MCP tools", () => {
    const text = workerGuideLines(program, "agents-app-control").join("\n");
    expect(text).toContain("## Editing an answer");
    expect(text).toContain("agents-app-control agent edit");
    expect(text).toMatch(/A new result or question\s+still goes in a new answer/);
    expect(MCP_TOOLS.map((tool) => tool.name)).toContain("edit");
    expect(mcpArguments("edit", { text: "Ny text", match: "login" })).toEqual({ argv: ["agent", "edit", "Ny text", "--match", "login"] });
    expect(mcpArguments("edit", { text: "Ny text", turn: -2 })).toEqual({ argv: ["agent", "edit", "Ny text", "--turn", "-2"] });
    expect(mcpArguments("edit", { text: "x", turn: 1, match: "y" }).error).toMatch(/not both/);
  });
});

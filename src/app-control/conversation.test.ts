import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendThreadMessage, appendThreadTurn, conversationFromLogs, nextRunStart, readThread, REPLY_INLINE_BYTES, seedMarker, seedThread, showsAtLeast, threadFile } from "./conversation.js";

describe("a coordinator's conversation", () => {
  let program: string;
  beforeEach(() => { program = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-")); });
  afterEach(() => { fs.rmSync(program, { recursive: true, force: true }); });

  it("keeps the user's messages and the runs' answers in order, and reads after an id", () => {
    const message = appendThreadMessage(program, { text: "  Fix the login\r\nplease ", via: "pane" });
    const turn = appendThreadTurn(program, { startedAt: message.at, agent: "claude", session: "s1", how: { start: "continue", why: "its session is warm" }, ms: 4200, steps: Array.from({ length: 40 }, (_, i) => `step ${i}`), reply: "Started a worker." });
    expect(readThread(program).map((entry) => entry.kind)).toEqual(["message", "turn"]);
    expect(readThread(program)[0]).toMatchObject({ from: "user", via: "pane", text: "Fix the login\nplease" });
    expect(readThread(program, { after: message.id })).toEqual([turn]);
    expect(turn.steps).toHaveLength(30);
    expect(turn.steps?.[0]).toBe("step 10");
    expect(fs.existsSync(path.join(program, "thread.lock"))).toBe(false);
  });

  it("keeps a long answer beside the conversation", () => {
    const reply = "x".repeat(REPLY_INLINE_BYTES + 1);
    const turn = appendThreadTurn(program, { startedAt: new Date().toISOString(), how: { start: "fresh" }, reply });
    expect(turn.reply).toBeUndefined();
    expect(fs.readFileSync(turn.replyFile!, "utf8").trimEnd()).toBe(reply);
    expect((readThread(program, { withReplies: true })[0] as { reply?: string }).reply).toBe(reply);
  });

  it("skips a torn line", () => {
    appendThreadMessage(program, { text: "one" });
    fs.appendFileSync(threadFile(program), '{"kind":"turn","id":');
    expect(readThread(program).map((entry) => entry.kind)).toEqual(["message"]);
  });

  it("goes on in a warm session and starts fresh from a cold or full one", () => {
    const now = Date.now();
    expect(nextRunStart(program, undefined, now)).toMatchObject({ start: "fresh" });
    appendThreadTurn(program, { startedAt: new Date(now - 70 * 60_000).toISOString(), how: { start: "fresh" } }, new Date(now - 61 * 60_000));
    expect(nextRunStart(program, { session: "s" }, now)).toEqual({ start: "fresh", why: "its last turn was 61 minutes ago" });
    appendThreadTurn(program, { startedAt: new Date(now - 60_000).toISOString(), how: { start: "continue" } }, new Date(now - 30_000));
    expect(nextRunStart(program, { session: "s", context: 0.2 }, now)).toEqual({ start: "continue", why: "its session is warm" });
    expect(nextRunStart(program, { session: "s", context: 0.6 }, now)).toEqual({ start: "fresh", why: "its context was 60 % full" });
  });

  const logs = [[
    { kind: "start", at: "2026-11-25T09:00:00Z" },
    { kind: "user", at: "2026-11-25T09:00:00Z", text: "Plan the release" },
    { kind: "tool", at: "2026-11-25T09:01:00Z", title: "Read OVERVIEW.md", status: "completed" },
    { kind: "agent", at: "2026-11-25T09:02:00Z", text: "I started a worker." },
    { kind: "user", at: "2026-11-25T10:00:00Z", text: "⟢ agents · Worker ui is done · read /p/messages/20261125T100000-ab12.md" },
    { kind: "agent", at: "2026-11-25T10:01:00Z", text: "ui is done." },
    { kind: "user", at: "2026-11-26T09:00:00Z", text: '<agents-event kind="wake" from="agents" words="data">Worker api is done · read /p/m.md</agents-event>' },
    { kind: "tool", at: "2026-11-26T09:00:10Z", title: "Read report.md", status: "failed" },
    { kind: "turnEnd", at: "2026-11-26T09:00:20Z" },
    { kind: "user", at: "2026-11-26T11:00:00Z", text: "Ship it" },
    { kind: "agent", at: "2026-11-26T11:01:00Z", text: "Shipped." },
  ]];

  it("reads a coordinator's conversation from its sessions' logs: messages, and per run what woke it, its steps and its answer", () => {
    const entries = conversationFromLogs(logs);
    expect(entries.map((entry) => entry.kind === "message" ? `m:${entry.text}` : `t:${entry.wokeBy ?? ""}|${(entry.steps ?? []).join(",")}|${entry.reply ?? ""}`)).toEqual([
      "m:Plan the release",
      "t:|Read OVERVIEW.md|I started a worker.",
      "t:Worker ui is done||ui is done.",
      "t:Worker api is done|✗ Read report.md|",
      "m:Ship it",
      "t:||Shipped.",
    ]);
  });

  it("seeds thread.jsonl once from the logs, keeps what it had after the seed once, and never shows less", () => {
    // thread.jsonl began today, with the last message and answer the logs also hold.
    appendThreadMessage(program, { text: "Ship it", via: "pane" });
    appendThreadTurn(program, { startedAt: "x", how: { start: "continue" }, reply: "Shipped." });
    expect(showsAtLeast(readThread(program), logs)).toBe(false);
    expect(seedThread(program, logs, ["s1"])).toBe(true);
    const thread = readThread(program);
    expect(thread.filter((entry) => entry.kind === "message").map((entry) => (entry as { text: string }).text)).toEqual(["Plan the release", "Ship it"]);
    expect(thread.filter((entry) => entry.kind === "turn" && entry.reply === "Shipped.")).toHaveLength(1);
    expect(showsAtLeast(thread, logs)).toBe(true);
    expect(fs.existsSync(seedMarker(program))).toBe(true);
    // Once only.
    expect(seedThread(program, logs, ["s1"])).toBe(false);
  });
});

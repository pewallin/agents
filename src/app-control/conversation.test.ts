import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendThreadMessage, appendThreadTurn, nextRunStart, readThread, REPLY_INLINE_BYTES, threadFile } from "./conversation.js";

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
});

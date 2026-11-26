import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSessionLog,
  readSessionLog,
  sessionLogChain,
  sessionLogEntries,
  sessionLogFilesDir,
  sessionLogPath,
  sessionLogText,
  SessionLogTap,
  TOOL_OUTPUT_LINES,
} from "./session-log.js";

const update = (sessionId: string, value: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const request = (id: number | string, method: string, params: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const answer = (id: number | string, result: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id, result });
const chunk = (sessionId: string, kind: string, text: string) => update(sessionId, { sessionUpdate: kind, content: { type: "text", text } });

describe("session log", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "session-log-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const lines = (session: string, harness = "claude") => parseSessionLog(readFileSync(sessionLogPath(harness, session, root), "utf8"));

  function newSession(tap: SessionLogTap, stream: string, session: string) {
    tap.clientLine(stream, request(1, "session/new", { cwd: "/w", mcpServers: [] }));
    tap.agentLine(stream, answer(1, { sessionId: session, configOptions: [{ id: "mode", category: "mode", currentValue: "default" }] }));
  }

  it("writes a turn as the view drew it: the prompt, joined chunks, a settled tool, its end", () => {
    const tap = new SessionLogTap({ harness: "claude", cwd: "/w", root, origin: () => ({ pane: "%3", program: "/p", task: "fix" }) });
    newSession(tap, "view-1", "s1");
    tap.clientLine("view-1", request(2, "session/set_config_option", { sessionId: "s1", configId: "mode", value: "plan" }));
    tap.clientLine("view-1", request(3, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "Fix the bug" }] }));
    tap.agentLine("view-1", chunk("s1", "agent_thought_chunk", "Looking"));
    tap.agentLine("view-1", chunk("s1", "agent_thought_chunk", " around"));
    tap.agentLine("view-1", chunk("s1", "agent_message_chunk", "I will "));
    tap.agentLine("view-1", chunk("s1", "agent_message_chunk", "edit it."));
    tap.agentLine("view-1", update("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit a.ts", kind: "edit", status: "pending" }));
    tap.agentLine("view-1", update("s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }));
    tap.agentLine("view-1", update("s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] }));
    tap.agentLine("view-1", update("s1", { sessionUpdate: "plan", entries: [{ content: "Fix", status: "completed", priority: "high" }] }));
    tap.agentLine("view-1", update("s1", { sessionUpdate: "plan", entries: [{ content: "Fix", status: "completed", priority: "high" }] }));
    tap.agentLine("view-1", chunk("s1", "agent_message_chunk", "Done."));
    tap.agentLine("view-1", answer(3, { stopReason: "end_turn" }));

    const log = lines("s1");
    expect(log.map((line) => line.kind)).toEqual(["start", "user", "thought", "agent", "tool", "plan", "agent", "turnEnd"]);
    expect(log.map((line) => line.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(log[0]).toMatchObject({ v: 1, session: "s1", harness: "claude", cwd: "/w", pane: "%3", program: "/p", task: "fix" });
    expect(log[1]).toMatchObject({ text: "Fix the bug" });
    expect(log[2]).toMatchObject({ text: "Looking around" });
    expect(log[3]).toMatchObject({ text: "I will edit it." });
    expect(log[4]).toMatchObject({ id: "t1", title: "Edit a.ts", toolKind: "edit", status: "completed", content: [{ type: "diff", path: "a.ts" }] });
    expect(log[7]).toMatchObject({ stopReason: "end_turn", tools: 1, edits: 1, failed: 0, config: { mode: "plan" } });
    expect(typeof log[7].ms).toBe("number");
  });

  it("writes a permission question and the choice made", () => {
    const tap = new SessionLogTap({ harness: "kiro", root });
    newSession(tap, "host-1", "s2");
    tap.clientLine("host-1", request("host-2", "session/prompt", { sessionId: "s2", prompt: [{ type: "text", text: "push" }] }));
    tap.agentLine("host-1", update("s2", { sessionUpdate: "tool_call", toolCallId: "t9", title: "git push", kind: "execute", status: "pending" }));
    tap.agentLine("host-1", request(7, "session/request_permission", { sessionId: "s2", toolCall: { toolCallId: "t9", title: "git push" }, options: [{ optionId: "a", name: "Allow once", kind: "allow_once" }, { optionId: "d", name: "Deny", kind: "reject_once" }] }));
    tap.clientLine("host-1", answer(7, { outcome: { outcome: "selected", optionId: "d" } }));
    tap.agentLine("host-1", update("s2", { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "failed" }));
    tap.agentLine("host-1", answer("host-2", { stopReason: "end_turn" }));
    const log = lines("s2", "kiro");
    expect(log.map((line) => line.kind)).toEqual(["start", "user", "permission", "choice", "tool", "turnEnd"]);
    expect(log[2]).toMatchObject({ toolCallId: "t9", title: "git push", options: [{ optionId: "a", kind: "allow_once" }, { optionId: "d", kind: "reject_once" }] });
    expect(log[3]).toMatchObject({ outcome: "selected", optionId: "d", optionKind: "reject_once", toolCallId: "t9" });
    expect(log[5]).toMatchObject({ failed: 1, tools: 1 });
  });

  it("keeps the end of a tool's output and pictures as references beside the log", () => {
    const tap = new SessionLogTap({ harness: "claude", root });
    newSession(tap, "v", "s3");
    tap.clientLine("v", request(2, "session/prompt", { sessionId: "s3", prompt: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }] }));
    const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    tap.agentLine("v", update("s3", { sessionUpdate: "tool_call", toolCallId: "t", title: "ls", status: "completed", content: [{ type: "content", content: { type: "text", text: long } }], rawOutput: long }));
    tap.agentLine("v", answer(2, { stopReason: "end_turn" }));
    const log = lines("s3");
    const user = log.find((line) => line.kind === "user")!;
    const ref = (user.attachments as Array<{ ref: string }>)[0].ref;
    expect(ref).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(readFileSync(join(sessionLogFilesDir(sessionLogPath("claude", "s3", root)), ref), "utf8")).toBe("png");
    expect(JSON.stringify(user)).not.toContain(Buffer.from("png").toString("base64"));
    const tool = log.find((line) => line.kind === "tool")!;
    const text = (tool.content as Array<{ content: { text: string } }>)[0].content.text.split("\n");
    expect(text).toHaveLength(TOOL_OUTPUT_LINES + 1);
    expect(text[0]).toBe("… 300 lines before");
    expect(text.at(-1)).toBe("line 499");
    expect((tool.rawOutput as string).split("\n").at(-1)).toBe("line 499");
  });

  it("writes an old session's replay the first time it opens, and not again", () => {
    const replay = (tap: SessionLogTap, id: number) => {
      tap.clientLine("v", request(id, "session/load", { sessionId: "old", cwd: "/w", mcpServers: [] }));
      tap.agentLine("v", chunk("old", "user_message_chunk", "hello"));
      tap.agentLine("v", chunk("old", "agent_message_chunk", "hi "));
      tap.agentLine("v", chunk("old", "agent_message_chunk", "there"));
      tap.agentLine("v", update("old", { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read", status: "completed" }));
      tap.agentLine("v", answer(id, {}));
    };
    replay(new SessionLogTap({ harness: "claude", root }), 1);
    const first = lines("old");
    expect(first.map((line) => [line.kind, line.text ?? line.title])).toEqual([["start", undefined], ["user", "hello"], ["agent", "hi there"], ["tool", "Read"]]);
    expect(first[1].replay).toBe(true);
    replay(new SessionLogTap({ harness: "claude", root }), 1);
    expect(lines("old")).toEqual(first);
  });

  it("adds the turns a replay has after the log's last prompt (the TUI had the session)", () => {
    const tap = new SessionLogTap({ harness: "claude", root });
    tap.clientLine("v", request(1, "session/load", { sessionId: "tui", cwd: "/w", mcpServers: [] }));
    tap.agentLine("v", chunk("tui", "user_message_chunk", "one"));
    tap.agentLine("v", chunk("tui", "agent_message_chunk", "first"));
    tap.agentLine("v", answer(1, {}));
    const later = new SessionLogTap({ harness: "claude", root });
    later.clientLine("v", request(1, "session/load", { sessionId: "tui", cwd: "/w", mcpServers: [] }));
    for (const [kind, text] of [["user_message_chunk", "one"], ["agent_message_chunk", "first"], ["user_message_chunk", "two"], ["agent_message_chunk", "second"]]) {
      later.agentLine("v", chunk("tui", kind, text));
    }
    later.agentLine("v", answer(1, {}));
    expect(lines("tui").filter((line) => line.kind !== "start").map((line) => line.text)).toEqual(["one", "first", "two", "second"]);
  });

  it("goes on after a torn last line, and a reader skips it", () => {
    const tap = new SessionLogTap({ harness: "claude", root });
    newSession(tap, "v", "s4");
    appendFileSync(sessionLogPath("claude", "s4", root), '{"v":1,"n":1,"kind":"ag');
    const again = new SessionLogTap({ harness: "claude", root });
    again.clientLine("v", request(1, "session/load", { sessionId: "s4", cwd: "/w", mcpServers: [] }));
    again.agentLine("v", answer(1, {}));
    again.clientLine("v", request(2, "session/prompt", { sessionId: "s4", prompt: [{ type: "text", text: "next" }] }));
    expect(lines("s4").map((line) => [line.n, line.kind])).toEqual([[0, "start"], [1, "user"]]);
    expect(readSessionLog("s4", { root, after: 0 })?.lines.map((line) => line.text)).toEqual(["next"]);
  });

  it("follows a pane's sessions back through previous, and a respawn's why reaches its first turn", () => {
    let last: string | undefined;
    const tap = new SessionLogTap({
      harness: "kiro",
      root,
      origin: () => ({ previous: last, pane: "%1", ...(last === "a" ? { how: { start: "respawn", why: "context 91 % full" } } : {}) }),
      onSession: (session) => { last = session; },
    });
    newSession(tap, "v", "a");
    newSession(tap, "w", "b");
    tap.clientLine("w", request(5, "session/prompt", { sessionId: "b", prompt: [{ type: "text", text: "go" }] }));
    tap.agentLine("w", answer(5, { stopReason: "end_turn" }));
    expect(lines("b", "kiro")[0]).toMatchObject({ previous: "a", how: { start: "respawn", why: "context 91 % full" } });
    expect(lines("b", "kiro").at(-1)).toMatchObject({ kind: "turnEnd", how: { start: "respawn" } });
    expect(sessionLogChain("b", root)).toEqual(["a", "b"]);
    const entries = sessionLogEntries([{ session: "b", via: "respawn" }, { session: "gone" }], { root });
    expect(entries.map((entry) => [entry.session, entry.via, entry.missing])).toEqual([["a", undefined, undefined], ["b", "respawn", undefined], ["gone", undefined, true]]);
    expect(sessionLogText(lines("b", "kiro")[0])).toBe("— session b (kiro) after a: context 91 % full");
  });

  it("writes a steer the agent took as a message of the user's, and not one it refused", () => {
    const tap = new SessionLogTap({ harness: "claude", root });
    newSession(tap, "v", "s5");
    tap.clientLine("v", request(2, "session/prompt", { sessionId: "s5", prompt: [{ type: "text", text: "work" }] }));
    tap.clientLine("v", request(3, "_session/steering", { sessionId: "s5", prompt: [{ type: "text", text: "also this" }] }));
    tap.agentLine("v", answer(3, { outcome: "steered" }));
    tap.clientLine("v", request(4, "_session/steering", { sessionId: "s5", prompt: [{ type: "text", text: "late" }] }));
    tap.agentLine("v", answer(4, { outcome: "promptRequired" }));
    expect(lines("s5").filter((line) => line.kind === "user").map((line) => [line.text, line.steered])).toEqual([["work", undefined], ["also this", true]]);
  });

  it("leaves no log for a load the agent refused", () => {
    const tap = new SessionLogTap({ harness: "claude", root, onSession: () => { throw new Error("no session"); } });
    tap.clientLine("v", request(1, "session/load", { sessionId: "never", cwd: "/w", mcpServers: [] }));
    tap.agentLine("v", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Session not found" } }));
    expect(existsSync(sessionLogPath("claude", "never", root))).toBe(false);
  });

  it("refuses ids that are not a session's and makes nothing for them", () => {
    expect(() => sessionLogPath("claude", "../x", root)).toThrow();
    const tap = new SessionLogTap({ harness: "claude", root });
    tap.clientLine("v", request(1, "session/load", { sessionId: "../../etc", cwd: "/w" }));
    expect(existsSync(join(root, "claude")) ? readdirSync(join(root, "claude")) : []).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { attention, emptySession, reduce, type SessionAction, type SessionState } from "./session-state";

const run = (actions: SessionAction[], start: SessionState = emptySession()) => actions.reduce(reduce, start);
const text = (t: string) => ({ type: "text" as const, text: t });

describe("session state", () => {
  it("joins chunks of one message and starts a new one on another message id", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Hej "), messageId: "m1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("där"), messageId: "m1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Nytt"), messageId: "m2" } },
    ]);
    expect(state.items.map((item) => item.type === "agent" && item.text)).toEqual(["Hej där", "Nytt"]);
  });

  it("keeps a tool call by id and merges its updates, timing a live call", () => {
    const state = run([
      { type: "update", at: 1_000, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "in_progress" } },
      { type: "update", at: 3_500, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: text("ok") }] } },
    ]);
    expect(state.items).toEqual([{ type: "tool", id: "t1", at: 1_000 }]);
    expect(state.toolCalls.t1).toMatchObject({ title: "Run tests", kind: "execute", status: "completed", startedAt: 1_000, endedAt: 3_500 });
    expect(state.toolCalls.t1.content).toHaveLength(1);
  });

  it("gives a replayed history no times", () => {
    const state = run([
      { type: "loading" },
      { type: "update", at: 5, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "completed" } },
      { type: "loaded" },
    ]);
    expect(state.toolCalls.t1.startedAt).toBeUndefined();
    expect(state.replaying).toBe(false);
  });

  it("shows a prompt at once and takes the agent's echo of it as the same message", () => {
    const state = run([
      { type: "promptSent", text: "Kör testerna", at: 10 },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Kör testerna"), messageId: "u1" } },
    ]);
    expect(state.items).toEqual([{ type: "user", id: "u1", text: "Kör testerna", images: 0, local: false, at: 10 }]);
    expect(state.prompting).toBe(true);
  });

  it("needs you while a permission waits, works during a turn, idles after", () => {
    let state = run([{ type: "promptSent", text: "x" }]);
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "permissionRequested", request: { id: "p1", toolCall: { toolCallId: "t" }, options: [] } });
    expect(attention(state)).toBe("needs-you");
    state = reduce(state, { type: "permissionAnswered", id: "p1" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "promptEnded" });
    expect(attention(state)).toBe("idle");
  });

  it("follows a turn another client runs, as Codex reports it", () => {
    let state = run([{ type: "update", update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } } }]);
    expect(state.activity).toBe("working");
    state = reduce(state, { type: "update", update: { sessionUpdate: "session_info_update", title: "Fix", _meta: { codex: { threadStatus: { type: "idle" } } } } });
    expect(state.activity).toBe("idle");
    expect(state.title).toBe("Fix");
  });

  it("keeps plans, usage, commands and config options", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "plan", entries: [{ content: "A", priority: "high", status: "completed" }] } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
      { type: "update", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review", input: null }] } },
    ]);
    expect(state.plan).toHaveLength(1);
    expect(state.usage).toMatchObject({ used: 10, size: 100 });
    expect(state.commands[0].name).toBe("review");
  });
});

describe("the agent's own state", () => {
  it("makes a turn the pane's TUI runs work in the view too, and nothing else", () => {
    let state = reduce(emptySession(), { type: "agentState", state: "working" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "agentState", state: "approval" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "agentState", state: "idle" });
    expect(attention(state)).toBe("idle");
    state = reduce(state, { type: "agentState", state: null });
    expect(attention(state)).toBe("idle");
  });
});

describe("a turn the pane's TUI starts", () => {
  const active = { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } } as never;
  const idle = { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } } as never;
  const tool = { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" } as never;
  const prompt = { sessionUpdate: "user_message_chunk", content: { type: "text", text: "from the tui" } } as never;

  it("gets a marker of where it began when its prompt does not come, before its first work", () => {
    let state = reduce(emptySession(), { type: "update", update: active, at: 1 });
    expect(attention(state)).toBe("working");
    expect(state.items).toEqual([]);
    state = reduce(state, { type: "update", update: tool, at: 2 });
    expect(state.items.map((item) => item.type)).toEqual(["user", "tool"]);
    expect(state.items[0]).toMatchObject({ external: true, at: 2 });
  });

  it("starts with its own prompt when Codex passes it on, before or after saying the thread is active", () => {
    let after = reduce(emptySession(), { type: "update", update: active, at: 1 });
    after = reduce(after, { type: "update", update: prompt, at: 2 });
    after = reduce(after, { type: "update", update: tool, at: 3 });
    expect(after.items.map((item) => item.type === "user" && item.external ? "external" : item.type)).toEqual(["user", "tool"]);
    let before = reduce(emptySession(), { type: "update", update: prompt, at: 1 });
    before = reduce(before, { type: "update", update: active, at: 2 });
    before = reduce(before, { type: "update", update: tool, at: 3 });
    expect(before.items.map((item) => item.type === "user" && item.external ? "external" : item.type)).toEqual(["user", "tool"]);
  });

  it("gets no marker when Codex says the thread is active after the turn's first events", () => {
    let state = reduce(emptySession(), { type: "update", update: prompt, at: 1 });
    state = reduce(state, { type: "update", update: tool, at: 2 });
    state = reduce(state, { type: "update", update: active, at: 3 });
    state = reduce(state, { type: "update", update: { ...(tool as object), sessionUpdate: "tool_call_update", status: "completed" } as never, at: 4 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(0);
    // The next turn, after the thread was idle, starts afresh.
    state = reduce(state, { type: "update", update: idle, at: 5 });
    state = reduce(state, { type: "update", update: active, at: 6 });
    state = reduce(state, { type: "update", update: { ...(tool as object), toolCallId: "t2" } as never, at: 7 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(1);
  });

  it("gets no marker for a turn of ours", () => {
    let state = reduce(emptySession(), { type: "promptSent", text: "hi", at: 1 });
    state = reduce(state, { type: "update", update: active, at: 2 });
    state = reduce(state, { type: "update", update: tool, at: 3 });
    state = reduce(state, { type: "update", update: idle, at: 4 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(0);
  });
});

describe("a turn the view stops", () => {
  it("is marked stopped by its user item, once", () => {
    let state = reduce(emptySession(), { type: "promptSent", text: "go", at: 1 });
    const id = state.items[0].id;
    state = reduce(state, { type: "stopped" });
    state = reduce(state, { type: "stopped" });
    expect(state.stoppedTurns).toEqual([id]);
  });
});

describe("what the agent sends besides text", () => {
  it("shows a resource link as a link in its text and keeps an image under it", () => {
    let state = reduce(emptySession(), { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "See" } } });
    state = reduce(state, { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "resource_link", uri: "file:///r/shot.png", name: "shot.png" } } });
    state = reduce(state, { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "image", mimeType: "image/png", data: "AAAA" } } });
    expect(state.items).toEqual([{ type: "agent", id: "m1", text: "See [shot.png](file:///r/shot.png) ", images: [{ mimeType: "image/png", data: "AAAA" }] }]);
  });
});
